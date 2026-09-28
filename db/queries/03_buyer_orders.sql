-- ============================================================================
-- 03_buyer_orders.sql
-- Action 2 of 5: a buyer checks what they have ordered.
--
-- Index: orders_buyer_recent_idx (buyer_id, created_at DESC)
--        db/migrations/007_indexes.sql:60
--        orders_buyer_active_idx, the partial variant, at 007:63
--
-- `meta.total` for this list has to come from somewhere, and the obvious
-- `count(*) OVER ()` window function is a trap: it makes the planner materialise
-- the whole partition before emitting the first row, which defeats the LIMIT
-- entirely. So the count is a separate statement (see run-queries.ts) and this
-- file returns only the page. At the cost of one extra cheap index probe, the
-- page stays a pure index scan. See docs/15-queries-and-indexes.md.
--
-- The per-order item count is a LATERAL join, deliberately not a second
-- correlated subquery: LATERAL evaluates once per output row, a scalar subquery
-- in the SELECT list would be re-planned per row, and both produce the same
-- number. The difference is measurable on a buyer's history.
-- ============================================================================

SELECT o.id,
       o.public_code,
       o.status,
       o.currency_code,
       o.total_minor,
       o.placed_at,
       o.created_at,
       items.item_count
  FROM orders o
  LEFT JOIN LATERAL (
       SELECT count(*)::int AS item_count
         FROM order_items oi
        WHERE oi.order_id = o.id
  ) items ON TRUE
 WHERE o.buyer_id = $1::uuid
   AND ($2::order_status IS NULL OR o.status = $2)
 ORDER BY o.created_at DESC, o.id DESC
 LIMIT $3 OFFSET $4;
