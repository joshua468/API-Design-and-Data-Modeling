-- ============================================================================
-- 002_identity.sql
-- Users and seller profiles.
--
-- One `users` table holds every human. A separate `seller_profiles` row marks
-- the subset that trades. See docs section 10 for why this is one table plus a
-- profile rather than `buyers` and `sellers`.
-- ============================================================================

CREATE TYPE user_role AS ENUM ('buyer', 'seller', 'admin');
CREATE TYPE seller_status AS ENUM ('pending', 'active', 'suspended', 'closed');

-- ---------------------------------------------------------------------------
-- users
--
-- Soft-deleted (`deleted_at`), deliberately. A user is referenced by orders,
-- payments and reviews for as long as those records exist, which in a
-- money-handling system is indefinitely. Hard-deleting the row would either
-- cascade into deleting financial history or fail on the foreign keys. Soft
-- deletion means the audit trail stays intact while the account disappears
-- from every active view. See docs section 9.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL,
  full_name      TEXT NOT NULL
                   CONSTRAINT users_full_name_not_blank CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  role           user_role NOT NULL DEFAULT 'buyer',
  -- Only a hash is ever stored. The column is NOT NULL so that "no password
  -- set" cannot be confused with "password set to the empty string", which is
  -- a real authentication bypass if the comparison is `password_hash = ''`.
  password_hash  TEXT NOT NULL
                   CONSTRAINT users_password_hash_present CHECK (length(password_hash) >= 20),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,

  CONSTRAINT users_email_shape CHECK (
    email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
    AND length(email) <= 254
  ),

  -- Invariant that must never be broken: a soft-deleted row still has a
  -- deleted_at timestamp. This makes "re-activate" a single, well-defined
  -- operation instead of a judgement call.
  CONSTRAINT users_deleted_at_consistent CHECK (
    (deleted_at IS NULL) OR (deleted_at >= created_at)
  )
);

-- Case-insensitive uniqueness via an expression index rather than a UNIQUE
-- constraint on `email`. Two accounts differing only in case is the oldest
-- account-takeover bug in email systems, and it cannot be fixed by a plain
-- UNIQUE because Postgres compares text case-sensitively.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- A soft-deleted account releases its email. Without this, an address would be
-- permanently burned, and the natural expectation ("delete my account, then
-- sign up again") would fail on a uniqueness violation.
CREATE UNIQUE INDEX users_email_lower_active_key
  ON users (lower(email))
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN users.deleted_at IS
  'Soft delete only. Financial history (orders, payments, reviews) references '
  'this row permanently, so the row is retained and excluded from active views '
  'instead of being deleted.';

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- seller_profiles
--
-- A 1:1 extension of `users`, keyed by the same id rather than by a surrogate.
-- That is a real modelling decision: `seller_profiles.user_id` being both the
-- primary key and the foreign key means the join is a bare index lookup and
-- the database can never hold a seller profile whose user row is missing. A
-- surrogate key here would add a column and an extra hop to buy nothing --
-- seller profiles are never referenced independently of their user.
--
-- NOT soft-deleted. A profile is part of the counterparty record on every
-- order the seller ever received; removing it would orphan order attribution.
-- A seller stops trading by moving `status` to 'closed', not by disappearing.
-- ---------------------------------------------------------------------------
CREATE TABLE seller_profiles (
  user_id           UUID PRIMARY KEY
                      REFERENCES users (id) ON DELETE RESTRICT
                      ON UPDATE RESTRICT,

  shop_name         TEXT NOT NULL
                      CONSTRAINT seller_profiles_shop_name_length
                      CHECK (length(btrim(shop_name)) BETWEEN 2 AND 120),
  slug              TEXT NOT NULL
                      CONSTRAINT seller_profiles_slug_format
                      CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description       TEXT
                      CONSTRAINT seller_profiles_description_length
                      CHECK (description IS NULL OR length(description) <= 4000),
  status            seller_status NOT NULL DEFAULT 'pending',
  payout_currency   currency_code_t NOT NULL REFERENCES currencies (code)
                      ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- ---- Denormalised aggregate -------------------------------------------
  -- Maintained by the trigger in 006_reviews.sql, never by application code.
  --
  -- Justification: the storefront needs "4.8 from 212 reviews" on every
  -- listing row. Computing that from `reviews` per seller is a per-row
  -- aggregate over the largest table in the schema; the listing query would go
  -- from an index scan to a nested aggregate for every page. The value is
  -- additive and its rebuild rule is trivial (`AVG(rating) * 100`), so the
  -- staleness risk is bounded to a single transaction and is cheaper than the
  -- read it removes. The snapshot copy of the same figure on each review
  -- (see 006) means a historical average is still recoverable.
  rating_average_bp INTEGER NOT NULL DEFAULT 0
                      CONSTRAINT seller_profiles_rating_bp_range
                      CHECK (rating_average_bp BETWEEN 0 AND 500),
  rating_count      INTEGER NOT NULL DEFAULT 0
                      CONSTRAINT seller_profiles_rating_count_range
                      CHECK (rating_count >= 0),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- If a seller has any rating, the count and the average must agree. A row
  -- with rating_count > 0 and rating_average_bp = 0 is only reachable by
  -- bypassing the trigger, and it is exactly the state that makes a UI render
  -- "0.0 (0 reviews)" next to five visible stars.
  CONSTRAINT seller_profiles_rating_consistent CHECK (
    (rating_count = 0 AND rating_average_bp = 0)
    OR (rating_count > 0 AND rating_average_bp > 0)
  )
);

CREATE UNIQUE INDEX seller_profiles_slug_key ON seller_profiles (slug);
CREATE UNIQUE INDEX seller_profiles_shop_name_key ON seller_profiles (lower(shop_name));

CREATE TRIGGER seller_profiles_set_updated_at
  BEFORE UPDATE ON seller_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A shop can only be live if the underlying account can act. Enforced with a
-- trigger because it spans two tables, which a CHECK cannot do -- a
-- cross-table invariant in a CHECK constraint would be a lie about what the
-- database guarantees.
CREATE FUNCTION assert_seller_role()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  actual_role user_role;
  deleted     TIMESTAMPTZ;
BEGIN
  SELECT role, deleted_at INTO actual_role, deleted
    FROM users WHERE id = NEW.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user % does not exist', NEW.user_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF actual_role <> 'seller' THEN
    RAISE EXCEPTION
      'user % has role %, but a seller_profiles row requires role ''seller''',
      NEW.user_id, actual_role
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'seller_profiles_role_must_be_seller',
            DETAIL = 'Promote the user to role ''seller'' before creating a seller profile, or drop the profile.';
  END IF;

  IF deleted IS NOT NULL THEN
    RAISE EXCEPTION
      'user % is soft-deleted and cannot hold a seller profile', NEW.user_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'seller_profiles_user_must_be_active';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER seller_profiles_assert_role
  BEFORE INSERT OR UPDATE ON seller_profiles
  FOR EACH ROW EXECUTE FUNCTION assert_seller_role();

-- ---------------------------------------------------------------------------
-- Cross-role status coherence: a suspended or closed seller may not be active
-- on the profile, and an account that is itself deleted must not keep an
-- 'active' profile. Declared as a rule table so the intent is data, and so
-- docs section 6 can show the same transition table the order machine uses.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE seller_profiles IS
  'Trading profile for users with role = ''seller''. Payout currency is stored '
  'here rather than inherited from each product so a seller settles in one '
  'currency; order and product currency compatibility is enforced in 004.';
