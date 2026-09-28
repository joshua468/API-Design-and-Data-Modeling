-- ============================================================================
-- 003_catalog.sql
-- Products.
--
-- One product belongs to exactly one seller, and a product's price is a single
-- currency. That combination is the single most consequential modelling
-- decision in the schema, so it is stated here rather than discovered during
-- implementation.
-- ============================================================================

CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE stock_policy AS ENUM ('tracked', 'unlimited');

CREATE TABLE products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id      UUID NOT NULL
                   REFERENCES seller_profiles (user_id) ON DELETE RESTRICT
                   ON UPDATE RESTRICT,

  name           TEXT NOT NULL
                   CONSTRAINT products_name_length CHECK (length(btrim(name)) BETWEEN 3 AND 140),
  slug           TEXT NOT NULL
                   CONSTRAINT products_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description    TEXT
                   CONSTRAINT products_description_length
                   CHECK (description IS NULL OR length(description) <= 8000),

  -- Money. Integer minor units plus an explicit currency. A separate
  -- `currency` column rather than defaulting to a single store currency is
  -- what makes a future multi-currency store a data change instead of a
  -- migration of every price in the system.
  price_minor    minor_units NOT NULL,
  currency_code  currency_code_t NOT NULL
                   REFERENCES currencies (code) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- Tax rate is stored per product, as basis points, because tax is a property
  -- of what is being sold and of where the seller is registered -- not of the
  -- buyer. It is snapshotted onto the order item at purchase (see 004) so a
  -- later tax-rate change cannot retroactively alter a historical order.
  tax_rate_bp    rate_bp NOT NULL DEFAULT 0,

  status         product_status NOT NULL DEFAULT 'draft',
  stock_policy   stock_policy NOT NULL DEFAULT 'tracked',
  stock_quantity stock_level_t,

  -- Category as a bounded text label rather than a lookup table: the brief
  -- scopes out a catalogue taxonomy, and a CHECK'd domain is enforceable
  -- without a table that would otherwise be one row per fixed value.
  category       TEXT NOT NULL
                   CONSTRAINT products_category_length CHECK (category ~ '^[a-z][a-z-]{2,31}$'),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- No deleted_at here, deliberately. `status = 'archived'` already means "not
  -- for sale", and adding a second flag for the same fact would create two
  -- sources of truth that can disagree -- a row that is 'active' with a
  -- deleted_at timestamp, or an archived row with no deletion record. Rather
  -- than add a CHECK to force the two into agreement (which is how the two
  -- concepts get permanently entangled), the schema has one mechanism.
  --
  -- Consequence, stated plainly: an unreferenced product can be hard-deleted,
  -- and a referenced one cannot, because order_items holds ON DELETE RESTRICT
  -- and the order line is preserved by its own snapshots regardless. See docs
  -- section 9 for the full soft-delete policy across the schema.

  -- A product's price and currency are an inseparable pair, so they are
  -- validated as a pair: no free product (price 0 may not be right) and no
  -- mismatch between a non-zero price and an exotic currency.
  CONSTRAINT products_price_sane CHECK (price_minor > 0),

  -- Stock accounting is conditional on the policy. `tracked` requires a real
  -- quantity; `unlimited` must not carry a misleading number that a
  -- decrementing query would then act on. This is the "check what must be true
  -- given another column" case that a simple CHECK handles cleanly.
  CONSTRAINT products_stock_matches_policy CHECK (
    (stock_policy = 'tracked' AND stock_quantity IS NOT NULL)
    OR (stock_policy = 'unlimited' AND stock_quantity IS NULL)
  ),

  -- Publishing requires published content. A product with an empty
  -- description and a bare name is a draft that reached 'active' by accident.
  CONSTRAINT products_active_has_description CHECK (
    (status <> 'active') OR (description IS NOT NULL AND length(btrim(description)) >= 20)
  )
);

COMMENT ON TABLE products IS
  'Products carry their own currency and tax rate, both of which are snapshotted '
  'onto order_items at purchase time. A product is single-seller and '
  'single-currency by design; see docs section 10 for the checkout trade-off.';

-- A seller's product names are unique among their sellable products. Two live
-- products with the same name at the same price is a duplicate-listing data
-- error, and the listing UI has nowhere sensible to disambiguate them.
-- Archived rows are excluded so a seller can archive a listing and re-list the
-- same name later.
CREATE UNIQUE INDEX products_seller_name_active_key
  ON products (seller_id, name)
  WHERE status <> 'archived';

-- The storefront's primary access path: browse active products, cheapest first,
-- one page at a time. Partial, so the index only covers rows a storefront query
-- can actually return.
CREATE INDEX products_active_browse_idx
  ON products (price_minor, id)
  WHERE status = 'active';

CREATE INDEX products_seller_active_idx
  ON products (seller_id, created_at DESC)
  WHERE status = 'active';

CREATE INDEX products_category_browse_idx
  ON products (category, price_minor, id)
  WHERE status = 'active';

-- Slug lookup for the detail route. NOT partial, and that is the point: a slug
-- is a published URL. Letting a seller recycle it after archiving would mean an
-- old inbound link silently started resolving to a different product, so the
-- slug is permanently bound to the row that claimed it. An archived product's
-- detail route is filtered to 404 in the query, not by dropping the index.
CREATE UNIQUE INDEX products_slug_key ON products (slug);

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- A seller may only publish an 'active' product if the profile can trade.
-- Cross-table, so a trigger. Without it, a suspended shop keeps serving live
-- listings, which is precisely the failure an admin action is meant to prevent.
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_product_sellable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  seller_state seller_status;
BEGIN
  -- Only validate on the transitions that publish. A draft or archived product
  -- by a suspended seller is fine and must remain insertable, otherwise an
  -- admin suspension would block a seller from even staging work.
  IF NEW.status = 'active' THEN
    SELECT status INTO seller_state
      FROM seller_profiles WHERE user_id = NEW.seller_id;

    IF seller_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION
        'cannot publish product %: seller % profile status is %, expected ''active''',
        NEW.id, NEW.seller_id, coalesce(seller_state::text, '(missing)')
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'products_seller_must_be_active';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER products_assert_sellable
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION assert_product_sellable();
