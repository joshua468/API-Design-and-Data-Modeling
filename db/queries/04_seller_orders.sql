-- ============================================================================
-- 04_seller_orders.sql
-- Action 3 of 5: a seller works their queue.
--
-- Index: orders_seller_queue_idx (seller_id, created_at)
--        WHERE status = 'pending'
--        db/migrations/007_indexes.sql:73
--
-- This is the narrowest index in the schema and the one whose smallness is the
-- whole point. The seller's work queue is *only* pending orders -- the only rows
-- a seller can act on right now. A partial index over that predicate means the
-- queue page is a pure index scan over exactly the actionable rows, and the
-- index does not grow with the seller's history. Orders they already fulfilled
-- cost nothing.
--
-- The `oldest first` ordering is deliberate and is the reason the index is
-- (seller_id, created_at) ascending rather than DESC like the buyer's. This is
-- oldest-first: a seller works the back of the queue, so FIFO is fairness, and
-- it stops a high-volume seller from being perpetually buried under their own
-- success. Same column, opposite direction, opposite reason -- which is a
-- reminder that an index's sort direction is a business decision, not a
-- default.
--
-- Note the actor check. The queue is a list, not a mutation, so it reads
-- directly; the state machine is what stops a *different* seller acting on the
-- order. See guard_order_transition in db/migrations/004_orders.sql:383.
-- ============================================================================

SELECT o.id,
       o.public_code,
       o.status,
       o.currency_code,
       o.subtotal_minor,
       o.tax_minor,
       o.total_minor,
       o.shipping_name,
       o.shipping_city,
       o.shipping_region,
       o.placed_at,
       (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
  FROM orders o
 WHERE o.seller_id = $1::uuid
   AND o.status = 'pending'
 ORDER BY o.placed_at ASC, o.id ASC
 LIMIT $2 OFFSET $3;
