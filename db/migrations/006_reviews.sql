-- ============================================================================
-- 006_reviews.sql
-- Reviews of completed orders, and the seller rating aggregate they maintain.
--
-- A review in a marketplace is not a review of a *product*: it is a review of a
-- specific, completed, paid transaction. That is why `order_id` is NOT NULL and
-- unique per author, and why eligibility is enforced in the database rather
-- than in the API route that happens to offer the form.
-- ============================================================================

CREATE TABLE reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT NULL and unique per author: a review is a statement about one
  -- transaction, so it must always point at the transaction it describes.
  order_id       UUID NOT NULL REFERENCES orders (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  author_id      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Denormalised: the reviewed seller. Always equal to the order's seller, and
  -- asserted as such below. Stored rather than joined so that a seller's
  -- review page is one indexed lookup instead of a join through orders, and so
  -- that the rating aggregate can be maintained without joining.
  subject_seller_id UUID NOT NULL
                      REFERENCES seller_profiles (user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  rating        rating_t NOT NULL,
  body          TEXT
                  CONSTRAINT reviews_body_length CHECK (body IS NULL OR length(body) <= 4000),

  -- ---- Denormalised snapshot ---------------------------------------------
  -- The seller's average *at the moment this review was written*, before this
  -- review moved it. Two uses, both real: it lets the UI show a buyer the
  -- delta their review caused ("you rated 5; the average moved from 4.1 to
  -- 4.2"), and it makes a later moderation removal auditable -- if a review is
  -- soft-deleted and the average shifts, the snapshot proves what the buyer
  -- originally saw. It is the one place where a historical copy of a derived
  -- value is worth more than a recomputation.
  subject_rating_average_bp_snapshot INTEGER
                      CONSTRAINT reviews_snapshot_range
                      CHECK (subject_rating_average_bp_snapshot IS NULL
                             OR subject_rating_average_bp_snapshot BETWEEN 0 AND 500),
  subject_rating_count_snapshot INTEGER
                      CONSTRAINT reviews_count_snapshot_range
                      CHECK (subject_rating_count_snapshot IS NULL
                             OR subject_rating_count_snapshot >= 0),

  -- Soft-deleted, and the only financial-adjacent table that is. A review can
  -- be removed for moderation reasons, but the *fact* that it was removed must
  -- survive: a seller disputing a rating, or an audit of how a displayed
  -- average was reached, both depend on the row still existing. `deleted_at`
  -- removes it from aggregates and listings; it does not erase it.
  deleted_at    TIMESTAMPTZ,
  deleted_reason TEXT
                  CONSTRAINT reviews_deleted_reason_required
                  CHECK ((deleted_at IS NULL) = (deleted_reason IS NULL)),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One review per buyer per order. Not nullable, so the constraint does the
  -- work and the application never has to pre-check for a race.
  CONSTRAINT reviews_one_per_order_per_author UNIQUE (order_id, author_id),

  CONSTRAINT reviews_author_is_not_subject CHECK (author_id <> subject_seller_id),

  CONSTRAINT reviews_deleted_at_after_created CHECK (
    (deleted_at IS NULL) OR (deleted_at >= created_at)
  ),

  -- A review needs a reason or a rating to be worth anything. Rejecting the
  -- empty review is cheaper than moderating it later.
  CONSTRAINT reviews_not_empty CHECK (
    rating IS NOT NULL OR length(btrim(coalesce(body, ''))) > 0
  )
);

COMMENT ON TABLE reviews IS
  'Reviews of completed orders. Eligibility (order completed, author is the '
  'buyer, subject is the order''s seller, within the review window) is enforced '
  'by trigger, not by the API.';

CREATE TRIGGER reviews_set_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Eligibility. All four rules need the parent order, so they are a trigger.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_review_eligibility()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ord         orders%ROWTYPE;
  window_days CONSTANT INT := 30;
BEGIN
  SELECT * INTO ord FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Eligibility is "the order reached completed", not "the order is currently
  -- completed". The distinction matters: a buyer who receives a wrong item,
  -- complains, and gets a refund has still had a real experience, and the
  -- seller needs that signal. Blocking the review because the order was later
  -- refunded would suppress exactly the feedback that a refund is meant to
  -- generate. `completed_at IS NOT NULL` expresses the honest rule and is
  -- checkable from the order row alone.
  --
  -- It also correctly excludes an order refunded *before* delivery, which has a
  -- completed_at of NULL and therefore no experience to describe.
  IF ord.completed_at IS NULL THEN
    RAISE EXCEPTION
      'order % is %; a review requires an order that reached ''completed''',
      ord.public_code, ord.status
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'reviews_order_must_be_completed',
            DETAIL = 'Review unlocks after the buyer confirms delivery (or auto-confirmation elapses). '
                     'An order refunded before delivery is not reviewable.';
  END IF;

  IF NEW.author_id <> ord.buyer_id THEN
    RAISE EXCEPTION
      'only the buyer of order % may review it', ord.public_code
      USING ERRCODE = 'insufficient_privilege',
            CONSTRAINT = 'reviews_author_must_be_buyer',
            DETAIL = format('Order %s belongs to buyer %s.', ord.public_code, ord.buyer_id);
  END IF;

  IF NEW.subject_seller_id <> ord.seller_id THEN
    RAISE EXCEPTION
      'review subject % does not match order seller %',
      NEW.subject_seller_id, ord.seller_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'reviews_subject_must_be_order_seller';
  END IF;

  IF ord.completed_at IS NOT NULL
     AND now() > ord.completed_at + make_interval(days => window_days) THEN
    RAISE EXCEPTION
      'the %-day review window for order % closed at %',
      window_days, ord.public_code, ord.completed_at + make_interval(days => window_days)
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'reviews_window_closed';
  END IF;
  -- Capture the seller's pre-review aggregate. Done here, in the same
  -- transaction as the insert, so the snapshot cannot race with a concurrent
  -- review.
  IF NEW.subject_rating_average_bp_snapshot IS NULL
     OR NEW.subject_rating_count_snapshot IS NULL THEN
    SELECT sp.rating_average_bp, sp.rating_count
      INTO NEW.subject_rating_average_bp_snapshot, NEW.subject_rating_count_snapshot
      FROM seller_profiles sp
     WHERE sp.user_id = NEW.subject_seller_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER reviews_assert_eligibility
  BEFORE INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION assert_review_eligibility();

-- ---------------------------------------------------------------------------
-- The rating aggregate.
--
-- Recomputed from scratch on every change rather than incremented. That is the
-- right call at this size: a review insert is a rare, human-paced event, and a
-- full recompute is immune to the drift that accumulates when an aggregate is
-- adjusted by deltas. It is also self-healing -- any manual correction of
-- `rating_count` is overwritten by the next review rather than compounding.
-- ---------------------------------------------------------------------------
CREATE FUNCTION refresh_seller_rating()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target UUID;
BEGIN
  -- Fires on INSERT and UPDATE, where NEW is always populated. Still guarded
  -- rather than using COALESCE(NEW.x, OLD.x): a pattern that appears to work on
  -- an unassigned record is a latent error the moment someone widens the trigger
  -- to include DELETE.
  IF NEW IS NOT NULL THEN
    target := NEW.subject_seller_id;
  ELSE
    target := OLD.subject_seller_id;
  END IF;
  UPDATE seller_profiles sp
     SET rating_average_bp = COALESCE((
           SELECT round(avg(r.rating)::numeric * 100)::int
             FROM reviews r
            WHERE r.subject_seller_id = target
              AND r.deleted_at IS NULL
         ), 0),
         rating_count = (
           SELECT count(*)::int FROM reviews r
            WHERE r.subject_seller_id = target AND r.deleted_at IS NULL
         )
   WHERE sp.user_id = target;

  RETURN NULL;
END;
$$;

CREATE TRIGGER reviews_refresh_seller_rating
  AFTER INSERT OR UPDATE OF rating, subject_seller_id, deleted_at
    ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_seller_rating();
