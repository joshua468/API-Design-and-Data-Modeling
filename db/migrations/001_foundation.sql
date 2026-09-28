-- ============================================================================
-- 001_foundation.sql
-- Shared vocabulary: money representation, timestamps, and reference data.
--
-- Everything in this file exists to make later migrations shorter and to stop
-- two related mistakes from being possible: storing money as a float, and
-- silently drifting `updated_at`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Money: a composite type, not a bare BIGINT.
--
-- The brief requires integer minor units plus an explicit currency code. A
-- bare `amount_minor BIGINT` satisfies that literally, but it makes the
-- currency a *sibling* column that the compiler cannot relate to the amount --
-- so `charge_amount(order_id, 5000, 'USD')` and `charge_amount(order_id, 'USD',
-- 5000)` are equally type-correct, and a swap compiles, passes review, and
-- produces a corrupt ledger.
--
-- Wrapping the pair removes the failure mode: you cannot pass a currency
-- where an amount is expected. Stored columns stay unwrapped (see below)
-- because composite storage buys nothing at rest; the type earns its keep in
-- function signatures and in the check constraints that build a total.
-- ---------------------------------------------------------------------------
CREATE DOMAIN minor_units AS BIGINT
  CONSTRAINT minor_units_non_negative CHECK (VALUE >= 0);

CREATE TYPE money_t AS (amount_minor minor_units, currency_code CHAR(3));

-- ISO 4217 alphabetic codes are exactly three uppercase letters. Enforcing the
-- shape at the domain level means `currencies` cannot be seeded with 'DOLLARS'
-- or 'usd', and every FK target inherits the guarantee.
CREATE DOMAIN currency_code_t AS CHAR(3)
  CONSTRAINT currency_code_iso_4217 CHECK (VALUE ~ '^[A-Z]{3}$');

-- Basis points: 1 bp = 0.01%, so 750 bp = 7.50%. Rates are integers, never
-- floats, and the 0..10000 bound makes an impossible rate (120%) unrepresentable.
CREATE DOMAIN rate_bp AS SMALLINT
  CONSTRAINT rate_bp_in_percent CHECK (VALUE BETWEEN 0 AND 10000);

CREATE DOMAIN rating_t AS SMALLINT
  CONSTRAINT rating_one_to_five CHECK (VALUE BETWEEN 1 AND 5);

CREATE DOMAIN quantity_t AS INTEGER
  CONSTRAINT quantity_positive CHECK (VALUE > 0)
  CONSTRAINT quantity_upper_bound CHECK (VALUE <= 999);

-- Stock is deliberately NOT a quantity_t. An order line must contain at least
-- one item, but "zero in stock" is a completely ordinary and important state --
-- it is what stops a storefront from selling something it does not have. A
-- single domain for both would force one of those two facts to be a lie, so
-- the bounds are stated separately.
CREATE DOMAIN stock_level_t AS INTEGER
  CONSTRAINT stock_level_non_negative CHECK (VALUE >= 0)
  CONSTRAINT stock_level_upper_bound CHECK (VALUE <= 1_000_000);

-- ---------------------------------------------------------------------------
-- Currency reference data.
--
-- The `exponent` column is the part that matters. It records how many decimal
-- places the currency subdivides into, and it is the reason a `BIGINT` minor
-- unit is only correct relative to a currency. 100 minor units means:
--   NGN (exponent 2) -> 1,000.00 naira
--   JPY (exponent 0) -> 100 yen
--   KWD (exponent 3) -> 0.100 dinar
-- Storing the exponent makes the display layer data-driven instead of
-- hard-coding a JPY-is-the-exception branch, and makes the minor-unit choice
-- self-describing for a reviewer.
-- ---------------------------------------------------------------------------
CREATE TABLE currencies (
  code        currency_code_t PRIMARY KEY,
  exponent    SMALLINT NOT NULL
                CONSTRAINT currencies_exponent_range CHECK (exponent BETWEEN 0 AND 4),
  name        TEXT NOT NULL
                CONSTRAINT currencies_name_not_blank CHECK (length(btrim(name)) > 0),
  symbol      TEXT NOT NULL
                CONSTRAINT currencies_symbol_not_blank CHECK (length(btrim(symbol)) > 0)
);

COMMENT ON TABLE currencies IS
  'ISO 4217 reference data. `exponent` is the number of decimal places the '
  'currency subdivides into and is what makes an integer minor-unit amount '
  'interpretable without a hard-coded table in the application.';

INSERT INTO currencies (code, exponent, name, symbol) VALUES
  ('NGN', 2, 'Nigerian Naira',   '\u20a6'),
  ('USD', 2, 'US Dollar',        '$'),
  ('GBP', 2, 'Pound Sterling',   '\u00a3'),
  ('EUR', 2, 'Euro',             '\u20ac'),
  ('JPY', 0, 'Japanese Yen',     '\u00a5'),
  ('KWD', 3, 'Kuwaiti Dinar',    '\u062f.\u0643');

-- ---------------------------------------------------------------------------
-- Money arithmetic.
--
-- Tax is computed on the extended amount: rounding per unit and rounding the
-- sum are different numbers, and the discrepancy is a real-money discrepancy.
-- Rounding half-up (rather than PostgreSQL's banker's rounding on numeric) is
-- deliberate -- it matches how a shop's arithmetic behaves, so the total the
-- buyer sees matches the total they are charged.
-- ---------------------------------------------------------------------------
CREATE FUNCTION tax_on(amount_minor minor_units, rate rate_bp)
RETURNS minor_units
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT round(amount_minor::numeric * rate::numeric / 10000.0)::bigint::minor_units;
$$;

-- ---------------------------------------------------------------------------
-- updated_at maintenance.
--
-- One shared trigger function rather than one per table: the behaviour is
-- identical everywhere, so a single definition means a fix to the clock
-- semantics cannot be applied to six of seven tables.
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Guarded so that a caller who deliberately sets updated_at (an import, a
  -- backfill) is not silently overwritten.
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Shared value-object domains for the things that are referenced by hand.
-- ---------------------------------------------------------------------------

-- A short human-facing order code, e.g. 'ORD-7K2QX9'. Distinct from the UUID
-- primary key on purpose: the UUID is a join key and should never be printed,
-- the code is safe to read over the phone and has a far smaller collision
-- surface to defend.
CREATE DOMAIN order_code_t AS VARCHAR(12)
  CONSTRAINT order_code_format CHECK (VALUE ~ '^ORD-[0-9A-HJ-NP-Z]{6}$');

CREATE DOMAIN idempotency_key_t AS VARCHAR(128)
  CONSTRAINT idempotency_key_not_blank CHECK (length(btrim(VALUE)) >= 8);
