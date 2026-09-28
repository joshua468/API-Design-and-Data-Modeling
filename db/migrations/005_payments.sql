-- ============================================================================
-- 005_payments.sql
-- Payment attempts against an order.
--
-- A payment is not the order's `status`. Keeping them as separate tables is the
-- point of the design: an order can be attempted, retried, and failed, and a
-- single `status` column on `orders` would have to encode all of that. The
-- order's status answers "where is this order in its lifecycle"; the payment's
-- state answers "what happened to the money", and the two move independently
-- until a trigger reconciles them.
-- ============================================================================

CREATE TYPE payment_state AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

CREATE TABLE payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders (id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Money. Mirrors the order's currency, enforced by trigger: a payment that
  -- quietly used a different currency from its order would be a real-money
  -- defect that no row-local CHECK could see.
  amount_minor   minor_units NOT NULL CONSTRAINT payments_amount_positive CHECK (amount_minor > 0),
  currency_code  currency_code_t NOT NULL REFERENCES currencies (code) ON DELETE RESTRICT ON UPDATE RESTRICT,

  state          payment_state NOT NULL DEFAULT 'pending',

  -- The prototype provider is a stub, so the reference is derived, not random:
  -- the same payment always reports the same provider id. That is what makes
  -- the idempotency proof meaningful -- a real PSP's behaviour is the property
  -- being modelled, and a random reference would not exercise it.
  provider        TEXT NOT NULL
                    CONSTRAINT payments_provider_format CHECK (provider ~ '^[a-z][a-z0-9_]{2,31}$'),
  provider_reference TEXT,

  failure_code   TEXT,
  failure_reason TEXT,

  idempotency_key idempotency_key_t NOT NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  succeeded_at   TIMESTAMPTZ,
  failed_at      TIMESTAMPTZ,
  refunded_at    TIMESTAMPTZ,

  -- One key per order. Two different orders can be paid with the same
  -- client-supplied key without colliding, but retrying the *same* checkout
  -- must be a no-op, which is what this enforces.
  CONSTRAINT payments_order_idempotency_key UNIQUE (order_id, idempotency_key),

  -- State must agree with its own timestamps. Same reasoning as
  -- orders_status_timestamp_agreement: a row that says 'succeeded' with no
  -- succeeded_at is a reporting bug waiting to happen.
  CONSTRAINT payments_state_timestamp_agreement CHECK (
       (state = 'pending'  AND succeeded_at IS NULL AND failed_at IS NULL AND refunded_at IS NULL)
    OR (state = 'succeeded' AND succeeded_at IS NOT NULL AND failed_at IS NULL AND refunded_at IS NULL)
    OR (state = 'failed'    AND failed_at IS NOT NULL AND succeeded_at IS NULL AND refunded_at IS NULL
        AND failure_code IS NOT NULL)
    OR (state = 'refunded'  AND refunded_at IS NOT NULL AND succeeded_at IS NOT NULL)
  ),

  CONSTRAINT payments_failure_detail_required CHECK (
    (state = 'failed') = (failure_code IS NOT NULL)
  ),

  -- A provider reference, once assigned, is globally unique. A partial index
  -- rather than a UNIQUE constraint because many rows legitimately have NULL
  -- while pending, and NULLs would otherwise collide with each other.
  CONSTRAINT payments_refunded_requires_success CHECK (
    (state = 'refunded') = (refunded_at IS NOT NULL)
  )
);

COMMENT ON TABLE payments IS
  'Payment attempts. Not soft-deleted: a payment is a financial fact. Retry '
  'safety comes from the (order_id, idempotency_key) unique constraint plus the '
  'single-live-payment partial index below.';

-- At most one payment in a non-final state per order. This is the constraint
-- that prevents the classic double-charge: two concurrent "pay now" requests
-- both inserting a pending payment, only one of which the caller remembers.
CREATE UNIQUE INDEX payments_single_live_per_order
  ON payments (order_id)
  WHERE state IN ('pending', 'succeeded');

CREATE UNIQUE INDEX payments_provider_reference_key
  ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Reconciliation between payment state and order state.
--
-- The rule is deliberately narrow: money may only move the order forward to
-- 'paid', and only back to 'refunded'. A refund is a distinct transition in the
-- order machine (see 004), so this trigger's job is to refuse a payment row
-- claiming settlement while the order has not actually been marked paid.
--
-- Statement-level for the same reason documented at length in 004: a deferred
-- *row-level* trigger re-fetches its row by ctid at COMMIT, and this schema
-- updates both the payment and its order inside the same transaction, so the
-- queued ctid is stale by the time it fires and NEW comes back unassigned.
--
-- This one does NOT need to be deferred, which is the better outcome. The
-- payment workflow always writes in this order inside one transaction:
--
--   capture:  orders.status -> 'paid'   (guarded, and that guard has already
--                                        verified totals against lines)
--             then INSERT payments (state = 'succeeded')
--   refund:   orders.status -> 'refunded'
--             then UPDATE payments (state = 'refunded')
--
-- So by the time the payment row is written, the order is already in the
-- matching state and an immediate check has everything it needs. Immediate is
-- strictly better here: the failure is attributed to the statement that caused
-- it, inside the caller's transaction, with no COMMIT-time surprise.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_payments_consistent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  bad RECORD;
BEGIN
  SELECT p.id,
         p.state,
         p.amount_minor,
         p.currency_code,
         o.public_code,
         o.status            AS order_status,
         o.total_minor       AS order_total,
         o.currency_code     AS order_currency
    INTO bad
    FROM payments p
    JOIN orders o ON o.id = p.order_id
   WHERE p.currency_code <> o.currency_code
      -- A succeeded payment must be for the full order total. Part-payment is
      -- out of scope, and silently accepting less would let an order be marked
      -- paid while money is still outstanding.
      OR (p.state = 'succeeded'
          AND (p.amount_minor <> o.total_minor
               OR o.status NOT IN ('paid', 'shipped', 'completed', 'refunded')))
      OR (p.state = 'refunded' AND o.status <> 'refunded')
   LIMIT 1;

  IF FOUND THEN
    IF bad.currency_code <> bad.order_currency THEN
      RAISE EXCEPTION
        'payment % is in % but order % is in %',
        bad.id, bad.currency_code, bad.public_code, bad.order_currency
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'payments_currency_matches_order';
    END IF;

    IF bad.state = 'succeeded' AND bad.amount_minor <> bad.order_total THEN
      RAISE EXCEPTION
        'payment of % % does not match order total of % %',
        bad.amount_minor, bad.currency_code, bad.order_total, bad.order_currency
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'payments_amount_matches_order_total';
    END IF;

    IF bad.state = 'succeeded' THEN
      RAISE EXCEPTION
        'cannot record a succeeded payment for order % in state %',
        bad.public_code, bad.order_status
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'payments_order_must_be_paid';
    END IF;

    RAISE EXCEPTION
      'cannot record a refunded payment for order % in state %',
      bad.public_code, bad.order_status
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'payments_order_must_be_refunded';
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER payments_agree_with_order
  AFTER INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION assert_payments_consistent();

-- ---------------------------------------------------------------------------
-- A payment amount may not be edited after it succeeded. Same reasoning as
-- order_items: past the point of capture the row is a receipt.
-- ---------------------------------------------------------------------------
CREATE FUNCTION guard_payment_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'refunded') THEN
    IF NEW.amount_minor <> OLD.amount_minor
       OR NEW.currency_code <> OLD.currency_code
       OR NEW.provider_reference <> OLD.provider_reference THEN
      RAISE EXCEPTION
        'payment % is % and its amount, currency and provider reference are immutable',
        OLD.id, OLD.state
        USING ERRCODE = 'insufficient_privilege',
              CONSTRAINT = 'payments_settled_fields_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard_immutability
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION guard_payment_immutability();
