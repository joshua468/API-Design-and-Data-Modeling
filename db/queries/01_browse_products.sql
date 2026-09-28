-- ============================================================================
-- 01_browse_products.sql
-- Action 1 of 5: a buyer browses the catalogue.
--
-- Index: products_category_browse_idx (category, price_minor, id)
--        WHERE status = 'active'
--        db/migrations/003_catalog.sql:113, repeated in 007:43
--
-- The two halves of the index do two different jobs. `category` narrows to the
-- rows a filtered browse can return; (price_minor, id) then satisfies the ORDER
-- BY from inside the index, so the planner walks the page in order and stops
-- after LIMIT rows instead of sorting the whole match set and then discarding
-- most of it. The trailing `id` is the tiebreaker, and it matters: without a
-- unique final column PostgreSQL must re-sort ties, and `ORDER BY price_minor`
-- alone is not a total order, so pagination would also be unstable between
-- requests.
--
-- HEAVY QUERY: yes. This is the largest result set in the schema and the one
-- run on every storefront render, so it is one of the two EXPLAINed in
-- docs/23-index-evidence.md.
--
-- Binding: $1 category (nullable), $2 limit, $3 offset, $4 search (nullable).
-- ============================================================================

SELECT p.id,
       p.slug,
       p.name,
       p.category,
       p.price_minor,
       p.currency_code,
       c.exponent            AS currency_exponent,
       p.stock_policy,
       p.stock_quantity,
       (p.stock_policy = 'unlimited' OR p.stock_quantity > 0) AS in_stock,
       sp.shop_name
  FROM products p
  JOIN seller_profiles sp ON sp.user_id = p.seller_id
  JOIN currencies c      ON c.code = p.currency_code
 WHERE p.status = 'active'
   AND sp.status = 'active'
   -- Both filters are optional and are skipped rather than written as
   -- "($1 IS NULL OR p.category = $1)". The latter is a valid predicate but it
   -- appears in the plan as a filter the planner must evaluate per row and it
   -- blocks the partial-index predicate from matching cleanly. Two query shapes
   -- selected from the same constant SQL is a cheaper price than an
   -- unexplainable plan.
   AND ($1::text IS NULL OR p.category = $1)
   AND ($4::text IS NULL OR p.search_document @@ plainto_tsquery('simple', $4))
 ORDER BY p.price_minor ASC, p.id ASC
 LIMIT $2 OFFSET $3;
