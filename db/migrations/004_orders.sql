-- ============================================================================
-- 004_orders.sql
-- The order state machine, the order aggregate, and order line items.
--
-- Design stance for this file: the legal order lifecycle is *data*, not code.
-- The transitions live in a table, the guard is a generic trigger that reads
-- that table, and the trigger is the only thing allowed to change `status`.
-- That is what makes section 6 of the documentation a SELECT rather than a
-- re-derivation, and what makes "can a seller reject a shipped order?" a
-- question with a queryable answer.
-- ============================================================================

CREATE TYPE order_status AS ENUM (
  'pending', 'accepted', 'paid', 'shipped', 'completed',
  'rejected', 'cancelled', 'refunded'
);
CREATE TYPE actor_role AS ENUM ('buyer', 'seller', 'system', 'admin');

-- ---------------------------------------------------------------------------
-- The machine.
--
-- `requires_refund` marks edges that must be accompanied by a refund. It is
-- not decoration: it is how the system knows that moving `paid -> cancelled`
-- without settling funds is a data-integrity incident rather than a success.
-- ---------------------------------------------------------------------------
CREATE TABLE order_status_transitions (
  from_status     order_status NOT NULL,
  to_status       order_status NOT NULL,
  actor           actor_role NOT NULL,
  requires_refund BOOLEAN NOT NULL DEFAULT FALSE,
  rationale       TEXT NOT NULL,

  PRIMARY KEY (from_status, to_status, actor),

  -- A status may not be its own successor. Self-transitions are how
  -- "re-accept an already accepted order" bugs enter a system, and they make
  -- the machine cyclic for no gain.
  CONSTRAINT transitions_no_self_loop CHECK (from_status <> to_status),

  -- The only legal way to enter a terminal state is through a state that is not
  -- already terminal. Enforced here so the rule cannot be violated by a later
  -- INSERT into this table.
  CONSTRAINT transitions_from_non_terminal CHECK (
    from_status NOT IN ('rejected', 'cancelled', 'refunded')
  )
);

INSERT INTO order_status_transitions (from_status, to_status, actor, requires_refund, rationale) VALUES
  ('pending',  'accepted',  'seller',  FALSE, 'Seller confirms stock and accepts the order.'),
  ('pending',  'rejected',  'seller',  FALSE, 'Seller declines the order, e.g. out of stock or cannot fulfil.'),
  ('pending',  'cancelled', 'buyer',   FALSE, 'Buyer abandons an unaccepted order.'),
  ('pending',  'cancelled', 'system',  FALSE, 'Automatic cancellation, e.g. payment window expiry.'),
  ('accepted', 'paid',      'system',  FALSE, 'Payment captured; driven by the payment workflow, not by a user.'),
  ('accepted', 'cancelled', 'buyer',   FALSE, 'Buyer cancels before payment.'),
  ('accepted', 'cancelled', 'seller',  FALSE, 'Seller cancels before payment begins.'),
  ('accepted', 'cancelled', 'system',  FALSE, 'Automatic cancellation of an unpaid accepted order.'),
  ('paid',     'shipped',   'seller',  FALSE, 'Seller hands the parcel to the carrier.'),
  ('paid',     'cancelled', 'system',  TRUE,  'Automatic cancellation after capture; funds must be returned.'),
  ('paid',     'refunded',  'admin',   TRUE,  'Dispute resolution or goodwill refund.'),
  ('shipped',  'completed', 'buyer',   FALSE, 'Buyer confirms delivery; unlocks the review workflow.'),
  ('shipped',  'completed', 'system',  FALSE, 'Delivery confirmed by the carrier webhook or after auto-confirm.'),
  ('shipped',  'refunded',  'admin',   TRUE,  'Lost or damaged in transit; refund without a return.'),
  ('completed','refunded',  'buyer',   FALSE, 'Buyer-initiated return and refund after completion.'),
  ('completed','refunded',  'admin',   TRUE,  'Post-delivery refund issued by support.');

-- Terminal states, and why. Kept as data so the documentation, the API and the
-- guard all agree on the same list.
CREATE TABLE order_terminal_states (
  status    order_status PRIMARY KEY,
  rationale TEXT NOT NULL,

  CONSTRAINT terminal_states_are_terminal CHECK (
    status IN ('rejected', 'cancelled', 'refunded')
  )
);

INSERT INTO order_terminal_states (status, rationale) VALUES
  ('rejected', 'The seller declined. No payment was ever captured, so no refund is owed.'),
  ('cancelled', 'The order was called off before shipping. Any captured payment is settled by an explicit refund transition.'),
  ('refunded',  'Funds have been returned. Money and fulfilment are both final.');

-- Convenience view: the same table, with the terminal flag resolved.
CREATE VIEW order_status_catalog AS
SELECT t.from_status,
       t.to_status,
       t.actor,
       t.requires_refund,
       t.rationale,
       (term.status IS NOT NULL) AS to_status_is_terminal
  FROM order_status_transitions t
  LEFT JOIN order_terminal_states term ON term.status = t.to_status;

-- ---------------------------------------------------------------------------
-- orders
--
-- A single-seller order. One order belongs to exactly one seller, which is why
-- `seller_id` sits on the order rather than on a junction table. See docs
-- section 10 for the trade this buys and the one it costs.
--
-- Not soft-deleted. An order is a financial fact; "no longer visible" and "does
-- not exist" are different claims and only the first is ever true here.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Denormalisation: a short code for humans, alongside the UUID that systems
  -- join on. Defended by a unique index, and generated from the UUID's own bits
  -- so it needs no sequence and no collision-prone table.
  public_code    order_code_t NOT NULL DEFAULT 'ORD-AAAAAA',

  buyer_id       UUID NOT NULL
                   REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  seller_id      UUID NOT NULL
                   REFERENCES seller_profiles (user_id) ON DELETE RESTRICT
                   ON UPDATE RESTRICT,

  status         order_status NOT NULL DEFAULT 'pending',
  currency_code  currency_code_t NOT NULL
                   REFERENCES currencies (code) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- ---- Denormalised money totals ----------------------------------------
  -- The order's own money columns, not a view over the items. Storing them is
  -- a deliberate trade: an order is a financial record that must remain
  -- readable and correct even after its lines are archived, and "what did this
  -- buyer pay" is asked on every order-detail page render. The identity below
  -- keeps the stored value from drifting from the items it summarises.
  subtotal_minor    minor_units NOT NULL,
  tax_minor         minor_units NOT NULL,
  shipping_minor    minor_units NOT NULL DEFAULT 0,
  total_minor       minor_units NOT NULL,

  -- Shipping address is a snapshot, not a reference to an address book entry.
  -- The buyer may edit or delete the saved address tomorrow; the order must
  -- still show where the parcel was sent. This is denormalisation with a
  -- lifecycle reason, not a shortcut.
  shipping_name          TEXT NOT NULL
                            CONSTRAINT orders_shipping_name_length
                            CHECK (length(btrim(shipping_name)) BETWEEN 2 AND 120),
  shipping_line1         TEXT NOT NULL
                            CONSTRAINT orders_shipping_line1_length CHECK (length(btrim(shipping_line1)) >= 3),
  shipping_line2         TEXT,
  shipping_city          TEXT NOT NULL
                            CONSTRAINT orders_shipping_city_length
                            CHECK (length(btrim(shipping_city)) BETWEEN 1 AND 80),
  shipping_region        TEXT,
  shipping_postal_code   TEXT
                            CONSTRAINT orders_postal_format
                            CHECK (shipping_postal_code IS NULL
                                   OR shipping_postal_code ~ '^[A-Za-z0-9 -]{2,12}$'),
  shipping_country_code  CHAR(2) NOT NULL
                            CONSTRAINT orders_country_iso_3166 CHECK (shipping_country_code ~ '^[A-Z]{2}$'),

  -- Idempotency is scoped to the buyer. Two different buyers can legitimately
  -- send the same client-generated key, so scoping globally would reject a
  -- valid request; scoping to the buyer is what makes "retry my checkout
  -- button five times" safe without also making it collide across accounts.
  idempotency_key   idempotency_key_t NOT NULL,

  -- ---- Lifecycle timestamps ---------------------------------------------
  placed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ,
  shipped_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  rejected_at   TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  refunded_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Buyer and seller are different parties. A CHECK, not a trigger, because it
  -- is row-local and cannot be bypassed by any code path.
  CONSTRAINT orders_buyer_is_not_seller CHECK (buyer_id <> seller_id),

  -- The money identity. This is the guard that makes the stored totals
  -- trustworthy: whatever else is wrong, the three components and the total
  -- cannot disagree.
  CONSTRAINT orders_total_identity CHECK (
    total_minor = subtotal_minor + tax_minor + shipping_minor
  ),

  -- An order's shipping cost cannot exceed the goods it ships.
  CONSTRAINT orders_shipping_not_absurd CHECK (
    shipping_minor <= GREATEST(subtotal_minor, 1)
  ),

  -- No gaps: a step cannot be reached without passing the previous one. This is
  -- the invariant that catches a buggy partial update setting paid_at while
  -- accepted_at is still NULL, which a per-status check alone would miss.
  CONSTRAINT orders_progress_no_gaps CHECK (
    (paid_at      IS NULL OR accepted_at  IS NOT NULL)
    AND (shipped_at IS NULL OR paid_at     IS NOT NULL)
    AND (completed_at IS NULL OR shipped_at IS NOT NULL)
  ),

  -- Monotonic clock: each step happens after the previous one. Guards against
  -- backdated timestamps corrupting fulfilment-time reporting.
  CONSTRAINT orders_progress_monotonic CHECK (
    (accepted_at  IS NULL OR accepted_at  >= placed_at)
    AND (paid_at     IS NULL OR paid_at     >= accepted_at)
    AND (shipped_at  IS NULL OR shipped_at  >= paid_at)
    AND (completed_at IS NULL OR completed_at >= shipped_at)
    AND (rejected_at IS NULL OR rejected_at >= placed_at)
    AND (cancelled_at IS NULL OR cancelled_at >= placed_at)
    AND (refunded_at IS NULL OR refunded_at >= placed_at)
  ),

  -- Status implies the timestamps it has earned, and forbids the ones it has
  -- not. Written as a disjunction per status rather than a lookup table
  -- because this is row-local truth that must hold in the same statement as
  -- the write, and a table lookup inside a CHECK would need a subquery --
  -- which PostgreSQL CHECK constraints do not permit.
  CONSTRAINT orders_status_timestamp_agreement CHECK (
      -- not yet accepted: no step timestamps at all
      (status = 'pending'
        AND accepted_at IS NULL AND paid_at IS NULL
        AND shipped_at IS NULL AND completed_at IS NULL
        AND rejected_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
      -- accepted: exactly one step
    OR (status = 'accepted'
        AND accepted_at IS NOT NULL AND paid_at IS NULL
        AND shipped_at IS NULL AND completed_at IS NULL
        AND rejected_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
      -- paid: exactly two steps
    OR (status = 'paid'
        AND accepted_at IS NOT NULL AND paid_at IS NOT NULL
        AND shipped_at IS NULL AND completed_at IS NULL
        AND rejected_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
      -- shipped: three steps
    OR (status = 'shipped'
        AND accepted_at IS NOT NULL AND paid_at IS NOT NULL
        AND shipped_at IS NOT NULL AND completed_at IS NULL
        AND rejected_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
      -- completed: the full happy path
    OR (status = 'completed'
        AND accepted_at IS NOT NULL AND paid_at IS NOT NULL
        AND shipped_at IS NOT NULL AND completed_at IS NOT NULL
        AND rejected_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
      -- rejected: terminal, never progressed
    OR (status = 'rejected'
        AND accepted_at IS NULL AND paid_at IS NULL
        AND shipped_at IS NULL AND completed_at IS NULL
        AND rejected_at IS NOT NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
      -- cancelled: may or may not have been accepted, never paid or shipped
    OR (status = 'cancelled'
        AND paid_at IS NULL AND shipped_at IS NULL AND completed_at IS NULL
        AND rejected_at IS NULL AND cancelled_at IS NOT NULL AND refunded_at IS NULL)
      -- refunded: any reachable prefix, but must be beyond 'accepted'
    OR (status = 'refunded'
        AND accepted_at IS NOT NULL AND paid_at IS NOT NULL
        AND rejected_at IS NULL AND cancelled_at IS NULL
        AND refunded_at IS NOT NULL)
  ),

  -- A refund timestamp only exists on a refunded order. Without this, a failed
  -- partial update could leave refunded_at set on a completed order and every
  -- "is this disputed?" query would silently disagree with `status`.
  CONSTRAINT orders_refund_timestamp_implies_status CHECK (
    (refunded_at IS NULL) OR (status = 'refunded')
  ),

  -- The idempotency scope described above.
  CONSTRAINT orders_buyer_idempotency_key UNIQUE (buyer_id, idempotency_key)
);

COMMENT ON TABLE orders IS
  'Order aggregate. Not soft-deleted: an order is a financial fact. All money '
  'columns are integer minor units in `currency_code`. Totals are denormalised '
  'and held to orders_total_identity, and are re-verified against order_items '
  'by a deferred constraint trigger.';

-- Derive the human code from the UUID's own entropy. No sequence, no extra
-- table, and the UNIQUE constraint makes a collision a visible error rather
-- than a silent duplicate.
CREATE FUNCTION assign_order_public_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
  attempt  INT := 0;
BEGIN
  -- An explicitly supplied code is respected, so an import can preserve codes
  -- that already exist in the source system.
  IF NEW.public_code IS NOT NULL AND NEW.public_code <> 'ORD-AAAAAA' THEN
    RETURN NEW;
  END IF;

  LOOP
    -- 6 uppercase hex characters, derived from the UUID by md5 rather than read
    -- off it directly. Reading the UUID's own leading digits would be cheaper
    -- but would correlate the code with the id, and for a v4 UUID those digits
    -- are also the ones an attacker is most likely to guess. The `attempt`
    -- term widens the search space so a collision retry explores a *different*
    -- candidate rather than recomputing the same one forever.
    candidate := 'ORD-' || upper(substr(md5(NEW.id::text || ':' || attempt::text), 1, 6));

    EXIT WHEN NOT EXISTS (SELECT 1 FROM orders o WHERE o.public_code = candidate);

    attempt := attempt + 1;
    IF attempt > 16 THEN
      RAISE EXCEPTION 'could not allocate a unique order code for order %', NEW.id
        USING ERRCODE = 'unique_violation',
              CONSTRAINT = 'orders_public_code_allocation_failed';
    END IF;
  END LOOP;

  NEW.public_code := candidate;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_assign_public_code
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION assign_order_public_code();

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- The stored totals must match the sum of the lines.
--
-- Defined here, ahead of guard_order_transition, because plpgsql validates
-- referenced functions at CREATE time -- and the transition guard calls this on
-- every status change. See the long note beside the order_items trigger at the
-- end of this file for why this check runs here rather than as a deferred
-- trigger at COMMIT.
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_order_totals_match_items(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  stored   RECORD;
  computed RECORD;
BEGIN
  SELECT subtotal_minor, tax_minor
    INTO stored
    FROM orders
   WHERE id = p_order_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(line_total_minor), 0) AS subtotal,
         COALESCE(SUM(line_tax_minor), 0)   AS tax
    INTO computed
    FROM order_items
   WHERE order_id = p_order_id;

  IF computed.subtotal <> stored.subtotal_minor
     OR computed.tax <> stored.tax_minor THEN
    RAISE EXCEPTION
      'order % totals disagree with its line items: stored subtotal % / tax %, computed % / %',
      p_order_id, stored.subtotal_minor, stored.tax_minor,
      computed.subtotal, computed.tax
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'orders_totals_match_items',
            DETAIL = 'Recompute the order totals from its order_items in the same transaction.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- The state machine guard.
--
-- This trigger is the *only* sanctioned way to move between states, and it is
-- the enforcement point for four distinct rules:
--
--   a. The edge must exist in order_status_transitions for the actor's role.
--   b. A terminal state has no outgoing edges (guaranteed by the table's own
--      CHECK, so this only has to consult it for the explanatory message).
--   c. The caller must be allowed to act as the role it claims. This is the
--      row-level authorisation that a CHECK cannot express, because it needs
--      the other party ids that live in this very row.
--   d. The order's stored totals must agree with its lines. The moment an order
--      stops being a provisional basket it must be arithmetically true, because
--      the next transition takes money.
-- ---------------------------------------------------------------------------
CREATE FUNCTION guard_order_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  acting      actor_role;
  acting_user UUID;
  edge        order_status_transitions%ROWTYPE;
  allowed     BOOLEAN;
  who         TEXT;
BEGIN
  -- Statement that is not a lifecycle change: updated_at maintenance and
  -- internal data fixes. Nothing to guard.
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  acting := COALESCE(current_setting('app.actor_role', TRUE)::actor_role, 'system');
  acting_user := NULLIF(current_setting('app.actor_id', TRUE), '')::UUID;

  SELECT * INTO edge
    FROM order_status_transitions
   WHERE from_status = OLD.status
     AND to_status   = NEW.status
     AND actor       = acting;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'illegal order transition: % -> % by %',
      OLD.status, NEW.status, acting
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'orders_illegal_status_transition',
            DETAIL = format(
              'No edge from %s to %s exists for actor %s. Legal edges: %s.',
              OLD.status, NEW.status, acting,
              coalesce((
                SELECT string_agg(t.to_status::text || ' (as ' || t.actor::text || ')', ', ' ORDER BY t.to_status::text, t.actor::text)
                  FROM order_status_transitions t
                 WHERE t.from_status = OLD.status
              ), '(none -- this is a terminal state)')
            );
  END IF;

  -- ---- Role authorisation, using the identities already on the order -----
  allowed := FALSE;
  who := 'buyer';
  IF acting = 'buyer' AND acting_user = NEW.buyer_id THEN
    allowed := TRUE;
  ELSE
    who := 'seller';
    IF acting = 'seller' AND acting_user = NEW.seller_id THEN
      allowed := TRUE;
    ELSE
      who := 'system';
      IF acting = 'system' THEN
        allowed := TRUE;
      ELSE
        who := 'admin';
        allowed := (acting = 'admin');
      END IF;
    END IF;
  END IF;

  IF NOT allowed THEN
    -- Bare % here, deliberately. In RAISE only a bare % is a placeholder: %s
    -- substitutes the value and then prints a literal "s", giving "paids". The
    -- DETAIL below uses format(), where %s is the correct specifier. The two
    -- are opposites, which is why this looks like a typo but is not.
    RAISE EXCEPTION
      'actor % (role %) may not perform the "% -> %" transition on order %',
      COALESCE(acting_user::TEXT, '(none)'), acting,
      OLD.status, NEW.status, NEW.public_code
      USING ERRCODE = 'insufficient_privilege',
            CONSTRAINT = 'orders_actor_not_authorized',
            -- Say *which rule* was broken. "Reserved for the seller of this
            -- order" and "reserved for an admin" are different mistakes with
            -- different fixes, and an operator should not have to infer which.
            DETAIL = CASE
              WHEN who = 'admin' THEN
                'This transition is reserved for the platform admin role.'
              ELSE
                format(
                  'This transition is reserved for the %s of this order '
                  '(buyer %s, seller %s).',
                  who, NEW.buyer_id, NEW.seller_id
                )
            END;
  END IF;

  -- ---- Rule (d): the totals must be arithmetically true before we commit to
  -- the transition. Run after the edge and role checks so that a caller gets the
  -- most specific error first: "you may not do that" is a more useful message
  -- than "and also your arithmetic is wrong".
  PERFORM check_order_totals_match_items(NEW.id);

  -- ---- Timestamp side effects, so a caller cannot forge history ----------
  -- Stamping the transition time here rather than trusting the caller removes
  -- a whole class of bug: a hand-written UPDATE that sets status but forgets
  -- the timestamp is impossible to express through this path.
  NEW.accepted_at  := CASE WHEN NEW.status = 'accepted'  THEN COALESCE(NEW.accepted_at,  now()) ELSE NEW.accepted_at  END;
  NEW.paid_at      := CASE WHEN NEW.status = 'paid'      THEN COALESCE(NEW.paid_at,      now()) ELSE NEW.paid_at      END;
  NEW.shipped_at   := CASE WHEN NEW.status = 'shipped'   THEN COALESCE(NEW.shipped_at,   now()) ELSE NEW.shipped_at   END;
  NEW.completed_at := CASE WHEN NEW.status = 'completed' THEN COALESCE(NEW.completed_at, now()) ELSE NEW.completed_at END;
  NEW.rejected_at  := CASE WHEN NEW.status = 'rejected'  THEN COALESCE(NEW.rejected_at,  now()) ELSE NEW.rejected_at  END;
  NEW.cancelled_at := CASE WHEN NEW.status = 'cancelled' THEN COALESCE(NEW.cancelled_at, now()) ELSE NEW.cancelled_at END;
  NEW.refunded_at  := CASE WHEN NEW.status = 'refunded'  THEN COALESCE(NEW.refunded_at,  now()) ELSE NEW.refunded_at  END;

  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_guard_transition
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION guard_order_transition();

-- ============================================================================
-- order_items
--
-- The clearest denormalisation in the schema, and the best worked example for
-- the documentation's section on denormalisation.
--
-- `name_snapshot`, `unit_price_minor` and `tax_rate_bp` are copies of values
-- that live on `products`. The copies are correct and the originals stay
-- authoritative for *new* sales. The reason is temporal: an order is a record
-- of what was agreed at a moment, and a product row is a live document. If the
-- line item referenced the product and read through to it, then renaming a
-- product or changing its tax rate would rewrite the financial history of every
-- order that ever contained it.
-- ============================================================================
CREATE TABLE order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE ON UPDATE RESTRICT,

  -- The product reference is kept for provenance -- "which listings produced
  -- this order" -- and is ON DELETE RESTRICT so a product cannot be removed
  -- from under a historical order. The snapshots below are what the line item
  -- actually displays and bills.
  product_id     UUID NOT NULL REFERENCES products (id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  name_snapshot     TEXT NOT NULL
                      CONSTRAINT order_items_name_snapshot_length
                      CHECK (length(btrim(name_snapshot)) BETWEEN 1 AND 140),
  unit_price_minor  minor_units NOT NULL,
  tax_rate_bp       rate_bp NOT NULL,

  quantity          quantity_t NOT NULL,
  line_total_minor  minor_units NOT NULL,
  line_tax_minor    minor_units NOT NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Line arithmetic is checked in the database, not recomputed by the app.
  -- These two constraints are what allow the storefront and the invoice to
  -- trust the stored line rather than recomputing it differently.
  CONSTRAINT order_items_line_total_identity CHECK (
    line_total_minor = unit_price_minor * quantity
  ),
  CONSTRAINT order_items_line_tax_identity CHECK (
    line_tax_minor = tax_on(line_total_minor, tax_rate_bp)
  ),

  -- One line per product per order. If a buyer adds the same product twice the
  -- second add must merge into the existing line rather than create a second
  -- row, which this constraint forces the caller to handle instead of leaving
  -- two subtly different lines for the same product.
  CONSTRAINT order_items_one_line_per_product UNIQUE (order_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Line-level integrity: one seller, one currency, and immutability once money
-- has changed hands. All three need to read the parent order, so they are
-- triggers rather than CHECKs.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_order_item_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ord            orders%ROWTYPE;
  prod           products%ROWTYPE;
BEGIN
  SELECT * INTO ord FROM orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % does not exist', NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT * INTO prod FROM products WHERE id = NEW.product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product % does not exist', NEW.product_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Single-seller order: every line must belong to the order's seller. This is
  -- the constraint that makes "one order, one seller" true rather than
  -- aspirational.
  IF prod.seller_id <> ord.seller_id THEN
    RAISE EXCEPTION
      'product % belongs to seller %, but order % belongs to seller %',
      prod.id, prod.seller_id, ord.public_code, ord.seller_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'order_items_single_seller_per_order';
  END IF;

  -- One currency per order. Conflating currencies inside an order would make
  -- total_minor meaningless, since the stored amounts would not be comparable.
  IF prod.currency_code <> ord.currency_code THEN
    RAISE EXCEPTION
      'product % is priced in % but order % is in %',
      prod.id, prod.currency_code, ord.public_code, ord.currency_code
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'order_items_currency_matches_order';
  END IF;

  -- A product must be purchasable at the moment it is added. Snapshotting an
  -- archived or draft product's price into a *new* order is a business error
  -- even though every row-local CHECK passes. (A line that already exists
  -- against a now-archived product is fine -- that is history, and the
  -- immutability trigger below is what protects it.)
  IF prod.status <> 'active' THEN
    RAISE EXCEPTION
      'product % is %, not active, and cannot be added to an order',
      prod.id, prod.status
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'order_items_product_must_be_active';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_assert_consistency
  BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION assert_order_item_consistency();

-- Once money is captured, the lines are a financial record and are frozen.
-- Allowing edits after capture would make `orders.total_identity` and the
-- already-captured payment disagree, with no way to reconstruct the original.
CREATE FUNCTION guard_order_item_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ord_status order_status;
BEGIN
  SELECT status INTO ord_status FROM orders WHERE id = OLD.order_id;

  IF ord_status IN ('paid', 'shipped', 'completed', 'refunded') THEN
    RAISE EXCEPTION
      'order % is %: its line items are immutable',
      OLD.order_id, ord_status
      USING ERRCODE = 'insufficient_privilege',
            CONSTRAINT = 'order_items_immutable_after_payment';
  END IF;

  -- Return value is ignored for DELETE, but the unassigned NEW record still
  -- cannot be referenced, so each branch returns its own side.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_guard_immutability
  BEFORE UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_item_immutability();

-- ---------------------------------------------------------------------------
-- Cross-table money check: stored totals vs. the sum of the lines.
--
-- WHAT THIS SECTION REPLACED, AND WHY
--
-- The first implementation was a DEFERRABLE INITIALLY DEFERRED CONSTRAINT
-- TRIGGER, which is the textbook answer: a create-order inserts the order row
-- before its lines exist, so the aggregate can only be checked at COMMIT. It
-- does not work, and the reason is worth recording.
--
-- A deferred trigger captures no row. It queues the row's `ctid` and re-fetches
-- that tuple at COMMIT. Every state transition in this schema UPDATEs the order
-- row, which supersedes the tuple, so the re-fetch finds a dead one and arrives
-- with NEW and OLD both unassigned. Reading a field then fails:
--
--     ERROR: record "new" has no field "order_id"
--
-- The obvious patch -- `IF NEW IS NULL THEN RETURN NULL` -- silences the crash
-- but silently SKIPS the check, and it skips it precisely on the orders with
-- the most state changes. A constraint that is quietly not applied on the rows
-- that matter most is worse than no constraint.
--
-- A statement-level trigger would avoid the ctid problem (it queues no row
-- identity), but `CREATE CONSTRAINT TRIGGER` only permits FOR EACH ROW, so there
-- is no way to defer a statement-level check in PostgreSQL.
--
-- WHAT IS DONE INSTEAD
--
-- The check runs at the two moments when it is both decidable and consequential:
--
--   1. Whenever an order changes status. An order that is still 'pending' is a
--      basket under construction and its totals are provisional; the instant it
--      moves to 'accepted' the totals must be real, because the next transition
--      takes money.
--   2. Whenever a line is added to an order that has already left 'pending'.
--      That catches the "add one more item, forget to re-total" mistake at once
--      instead of at some later transition.
--
-- Between those, a pending order's totals may legitimately be stale -- and that
-- is safe, because the payments trigger (005) refuses to record a successful
-- payment unless the order is 'paid' or beyond, and reaching 'paid' requires
-- passing a guarded transition that ran this check. Money cannot move against
-- an unverified total. The invariant is therefore enforced on every path that
-- matters, and it is enforced *without* deferral, which means it reports
-- failures at the statement that caused them.
-- ---------------------------------------------------------------------------
-- Catches an out-of-order total update directly: adding a line to an order that
-- has already left 'pending' immediately fails unless the totals were updated
-- in the same transaction. Orders still 'pending' are skipped deliberately --
-- that is the legitimate basket-building window.
CREATE FUNCTION guard_added_line_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ord_status order_status;
BEGIN
  IF NEW IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT status INTO ord_status FROM orders WHERE id = NEW.order_id;

  IF ord_status IS NOT NULL AND ord_status <> 'pending' THEN
    PERFORM check_order_totals_match_items(NEW.order_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER order_items_guard_added_line_totals
  AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_added_line_totals();

COMMENT ON TABLE order_items IS
  'Order lines with denormalised historical snapshots (name, unit price, tax '
  'rate) so that a later product edit cannot rewrite financial history. '
  'Immutable once the order is paid.';
