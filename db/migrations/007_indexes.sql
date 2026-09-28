-- ============================================================================
-- 007_indexes.sql
-- Full-text search plus the index set, one per documented query pattern.
--
-- Rule applied throughout: an index here exists because a named query in
-- db/queries/ needs it, not because the column looks filterable. Each block
-- below names the query it serves. The reasoning and the EXPLAIN evidence are
-- in docs sections 15 and 23.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Storefront text search.
--
-- A generated column rather than an expression index because the generated
-- column is also readable: the same value can be selected for search snippets
-- without re-evaluating the expression, and it cannot drift from the indexed
-- representation. `english` config is correct for the English product copy in
-- this prototype and is the one piece of localisation debt the docs call out.
--
-- Weighted: name matches outrank body matches, which is what a shopper typing
-- "leather" into a search box expects.
-- ---------------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN search_document tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(category, '')), 'C')
    ) STORED;

CREATE INDEX products_search_gin_idx
  ON products USING GIN (search_document);

-- ---------------------------------------------------------------------------
-- Query: "list active products in a category, cheapest first, paginated"
--   db/queries/01_browse_products.sql
-- Serves the storefront. Partial to the rows that query can return; the
-- covering-ish (price_minor, id) key satisfies the ORDER BY from the index
-- instead of sorting the page in memory.
-- Already declared in 003_catalog.sql for the same query. This index is for
-- the *text search* variant, which additionally filters on category:
-- ---------------------------------------------------------------------------
CREATE INDEX products_category_search_idx
  ON products (category, price_minor, id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Query: "a seller's active products" -- db/queries/02_seller_catalog.sql
-- Declared in 003; repeated here only as a reminder of the coverage.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Query: "a buyer's orders, newest first" -- db/queries/03_buyer_orders.sql
-- Descending on created_at because the UI's default sort is newest first, and
-- the index is walked backwards for the DESC, so the planner never sorts.
-- Partial to non-terminal orders, because the common view is "what is in
-- flight" and the terminal ones are reached through the same list filtered
-- client-side.
-- ---------------------------------------------------------------------------
CREATE INDEX orders_buyer_recent_idx
  ON orders (buyer_id, created_at DESC);

CREATE INDEX orders_buyer_active_idx
  ON orders (buyer_id, created_at DESC)
  WHERE status IN ('pending', 'accepted', 'paid', 'shipped');

-- ---------------------------------------------------------------------------
-- Query: "orders awaiting a seller's action" -- db/queries/04_seller_orders.sql
-- The seller's work queue. Narrow, partial, and ordered: the only rows in it
-- are orders a seller can actually act on right now, which keeps the index
-- small and the query a pure index scan.
-- ---------------------------------------------------------------------------
CREATE INDEX orders_seller_queue_idx
  ON orders (seller_id, created_at)
  WHERE status = 'pending';

CREATE INDEX orders_seller_active_idx
  ON orders (seller_id, created_at DESC)
  WHERE status IN ('pending', 'accepted', 'paid', 'shipped');

-- ---------------------------------------------------------------------------
-- Query: "an order's line items" -- db/queries/05_order_detail.sql
-- Also the foreign-key support index for order_items.order_id, which Postgres
-- needs for the ON DELETE CASCADE from orders; without it, deleting an order
-- would sequentially scan every line in the table.
-- ---------------------------------------------------------------------------
CREATE INDEX order_items_order_idx
  ON order_items (order_id);

-- Reverse direction: "which orders contain this product", used by the product
-- detail page's "sold in N orders" figure and by the seller dashboard.
CREATE INDEX order_items_product_idx
  ON order_items (product_id);

-- ---------------------------------------------------------------------------
-- Query: "the payment for an order" -- db/queries/06_payment_lookup.sql
-- payments_single_live_per_order (in 005) covers the live-payment case. This
-- covers the history case, which is a different question with a different
-- answer and would otherwise fall back to a scan of a table that only grows.
-- ---------------------------------------------------------------------------
CREATE INDEX payments_order_history_idx
  ON payments (order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Query: "reviews for a seller, newest first" -- db/queries/07_seller_reviews.sql
-- Partial to live reviews, so the moderator's unfiltered view stays cheap and
-- the storefront's filtered view uses a fraction of the index.
-- ---------------------------------------------------------------------------
CREATE INDEX reviews_seller_live_idx
  ON reviews (subject_seller_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX reviews_author_idx
  ON reviews (author_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Query: "is this buyer already reviewing this order?" -- the eligibility
-- pre-check in the review endpoint. The UNIQUE(order_id, author_id) constraint
-- already provides this index; the trigger is what makes the pre-check
-- advisory rather than necessary. Listed so the redundancy is documented rather
-- than accidental.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Reporting: fulfilment latency per seller. Not on the critical path of any
-- of the five workflows, and included deliberately as the *example* of an
-- index that is justified by a named question. If that question is dropped,
-- this index should be dropped with it.
-- ---------------------------------------------------------------------------
CREATE INDEX orders_completion_latency_idx
  ON orders (seller_id, completed_at)
  WHERE completed_at IS NOT NULL;
