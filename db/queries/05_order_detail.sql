-- ============================================================================
-- 05_order_detail.sql
-- Action 5 of 5: a buyer opens one order.
--
-- Index: orders_pkey on orders.id                    db/migrations/004:104
--        orders_public_code_key on orders.public_code db/migrations/008
--        order_items_order_idx (order_id)            db/migrations/007:87
--        payments_order_history_idx (order_id, created_at DESC)  db/migrations/007:101
--
-- Three statements, because the three questions genuinely have different
-- shapes: one order is always 0 or 1 rows, its lines are 1..n and want
-- pagination, and its payment history is a separate audit question. Bundling
-- them into one wide row would multiply the line count by the payment count.
--
-- Each statement numbers its parameters from $1 with no gaps. PostgreSQL infers
-- a parameter's type from its use site, so a statement that skipped $2 (using
-- $1, $3, $4) fails at parse time with 42P18 "could not determine data type of
-- parameter $2". It is a sharp edge in the extended protocol, and the fix is
-- just to renumber.
--
-- The money returned here is the *denormalised* copy on the order, not a
-- recomputation from the lines. That is the design decision defended in
-- docs/11-denormalisation.md: an order is a financial record that must stay
-- correct after its lines are archived, and this is asked on every order-detail
-- render. The two are reconciled by check_order_totals_match_items, not by the
-- reader -- which is what makes it safe to return both and trust the header.
-- ============================================================================

-- ---- 1. The order itself -------------------------------------------------
-- `public_code` is an accepted alternative key, so a buyer who read the code
-- off a support email reaches the same order.
--
-- Two parameters, not one, and this is not fussiness. A single `$1` cannot be
-- both: `o.id = $1::uuid` forces the parameter to uuid, and the second clause
-- then compares `order_code_t = uuid`, which has no operator and fails at parse
-- time. Casting the *column* side instead (`o.id::text = $1`) does typecheck,
-- but it gives up the 400: a malformed id becomes a string that matches nothing,
-- so a typo in an identifier would be reported as 404 "no such order" rather
-- than 400 "that is not an identifier". Two parameters keep both behaviours --
-- the API layer validates the UUID with its schema and answers 400 before a
-- query ever runs, and the query stays type-correct.
--
-- Each clause is independently NULL-tolerant, so passing null for the form that
-- was not supplied is safe: `o.id = NULL` is NULL, not true, and the other
-- clause does the work.
SELECT o.id,
       o.public_code,
       o.status,
       o.currency_code,
       o.subtotal_minor,
       o.tax_minor,
       o.shipping_minor,
       o.total_minor,
       o.shipping_name,
       o.shipping_line1,
       o.shipping_line2,
       o.shipping_city,
       o.shipping_region,
       o.shipping_postal_code,
       o.shipping_country_code,
       o.placed_at,
       o.accepted_at,
       o.paid_at,
       o.shipped_at,
       o.completed_at,
       o.cancelled_at,
       o.refunded_at
  FROM orders o
 WHERE o.id = $1::uuid
    OR o.public_code = $2::order_code_t
 LIMIT 1;

-- ---- 2. The line items ---------------------------------------------------
-- Snapshots, not live product columns. `name_snapshot`, `unit_price_minor` and
-- `tax_rate_bp` are copies taken at purchase; `product_id` is retained for
-- provenance only. This is what makes a later product rename or price change
-- unable to rewrite financial history.
--
-- `unit_price_minor * quantity = line_total_minor` and
-- `line_tax_minor = tax_on(line_total_minor, tax_rate_bp)` are both CHECK
-- constraints, so these are not values the API trusts -- they are values the
-- database has already refused to let be inconsistent.
SELECT oi.id,
       oi.product_id,
       oi.name_snapshot,
       oi.unit_price_minor,
       oi.tax_rate_bp,
       oi.quantity,
       oi.line_total_minor,
       oi.line_tax_minor
  FROM order_items oi
 WHERE oi.order_id = $1::uuid
 ORDER BY oi.created_at, oi.id
 LIMIT $2 OFFSET $3;

-- ---- 3. Payment history --------------------------------------------------
-- Uses payments_order_history_idx (order_id, created_at DESC), *not*
-- payments_single_live_per_order. This is "everything ever attempted", which is
-- a different question from "what is the live payment" and gets a different
-- answer. Using the live-payment index here would hide a failed charge that was
-- retried -- exactly the thing someone debugging a double-charge report needs.
SELECT p.id,
       p.state,
       p.amount_minor,
       p.currency_code,
       p.provider,
       p.provider_reference,
       p.failure_code,
       p.failure_reason,
       p.created_at,
       p.succeeded_at
  FROM payments p
 WHERE p.order_id = $1::uuid
 ORDER BY p.created_at DESC
 LIMIT $2 OFFSET $3;
