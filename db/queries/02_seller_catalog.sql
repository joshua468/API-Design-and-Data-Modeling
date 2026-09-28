-- ============================================================================
-- 02_seller_catalog.sql
-- Supporting query: a seller's public catalogue page.
--
-- Index: products_seller_active_idx (seller_id, created_at DESC)
--        WHERE status = 'active'
--        db/migrations/003_catalog.sql:109
--
-- The join to seller_profiles is on the primary key, so it is a single index
-- probe. The interesting part is the ordering: `created_at DESC` is the UI's
-- "newest first" default, and the index is stored in that order, so the planner
-- walks it backwards and never sorts.
--
-- Note what is *not* here: no `LIMIT`-then-filter. A query that fetches a page
-- and then discards archived rows returns short pages and a `total` that
-- disagrees with the list. The status filter is inside the predicate so the
-- count and the page are computed over the same rows.
-- ============================================================================

SELECT p.id,
       p.slug,
       p.name,
       p.category,
       p.price_minor,
       p.currency_code,
       c.exponent            AS currency_exponent,
       p.stock_quantity,
       sp.shop_name,
       sp.rating_average_bp,
       sp.rating_count
  FROM products p
  JOIN seller_profiles sp ON sp.user_id = p.seller_id
  JOIN currencies c      ON c.code = p.currency_code
 WHERE p.seller_id = $1::uuid
   AND p.status = 'active'
 ORDER BY p.created_at DESC, p.id DESC
 LIMIT $2 OFFSET $3;
