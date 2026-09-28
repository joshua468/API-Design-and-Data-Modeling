-- ============================================================================
-- 06_payment_lookup.sql
-- Supporting query: resolve a provider webhook back to a payment.
--
-- Index: payments_provider_reference_key (provider, provider_reference)
--        WHERE provider_reference IS NOT NULL
--        db/migrations/005_payments.sql:87
--
-- The direction of this lookup is the whole reason the index is shaped this
-- way. The provider tells us "the charge reference pi_abc123 failed"; we need
-- the row. Searching by (provider, provider_reference) rather than by
-- reference alone means the index also serves the question "has this provider
-- ever issued this reference", which is a correctness check, not just a lookup.
--
-- The partial predicate is doing real work: many rows legitimately have a NULL
-- reference while pending, and a plain UNIQUE on (provider, provider_reference)
-- would collide on every one of them. A partial UNIQUE constrains only the rows
-- that have a reference, which is exactly the set that must be unique.
-- ============================================================================

SELECT p.id,
       p.order_id,
       o.public_code,
       p.state,
       p.amount_minor,
       p.currency_code,
       p.provider,
       p.provider_reference,
       p.failure_code,
       p.failure_reason,
       o.status AS order_status
  FROM payments p
  JOIN orders o ON o.id = p.order_id
 WHERE p.provider = $1::text
   AND p.provider_reference = $2::text
 LIMIT 1;
