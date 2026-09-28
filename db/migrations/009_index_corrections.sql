-- ============================================================================
-- 009_index_corrections.sql
-- Two index defects, both found by reading the query plans rather than the
-- index definitions. Recorded here because "the plan disagreed with the comment"
-- is the only way either of these shows up.
--
-- WHY A NEW FILE
--
-- `db:migrate` records a checksum per applied migration and fails hard on a
-- mismatch, so an applied file is immutable. Both fixes are therefore additive.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Defect 1: `products_category_search_idx` is a byte-identical duplicate of
-- `products_category_browse_idx`.
--
-- 007_indexes.sql:43 creates
--
--     CREATE INDEX products_category_search_idx
--       ON products (category, price_minor, id)
--       WHERE status = 'active';
--
-- and 003_catalog.sql:113 had already created
--
--     CREATE INDEX products_category_browse_idx
--       ON products (category, price_minor, id)
--       WHERE status = 'active';
--
-- Same table, same three columns, same order, same partial predicate. Two
-- physical indexes holding identical sorted copies of identical rows.
--
-- The comment above the second one says it exists "for the *text search*
-- variant, which additionally filters on category". It does not. It filters on
-- category exactly as the first one does, and it has nothing to do with the
-- GIN index on `search_document`, which is the actual text-search structure
-- (products_search_gin_idx, 007:31). The comment describes an index that was
-- not written.
--
-- This is not a cosmetic duplication. Every INSERT, UPDATE and DELETE on
-- `products` maintains two identical b-trees, so catalogue writes cost roughly
-- double what they should; the pair also doubles the time a VACUUM spends and
-- the pages a buffer pool must hold. And the plan confirms the cost is pure:
-- with both present, the planner picked `_search_`, so the other one is paid
-- for on every write and read by nobody.
--
-- Which name survives: `_browse_`. It describes what the index is for, whereas
-- `_search_` named a capability it does not have. The alternative -- keeping
-- `_search_` -- would leave a misleading name in the schema, and the next person
-- to read it would look for full-text behaviour that is not there.
--
-- Not IF EXISTS: this migration is supposed to fail loudly if the index has
-- already gone, because that means the database is not in the state the file
-- describes. A silent success would mean the checksum recorded a change that
-- did not happen.
-- ---------------------------------------------------------------------------
DROP INDEX products_category_search_idx;

-- ---------------------------------------------------------------------------
-- Defect 2: `orders_seller_queue_idx` does not match the ORDER BY it is meant
-- to eliminate.
--
-- The index is (seller_id, created_at) and 04_seller_orders.sql orders by
-- `o.placed_at ASC, o.id ASC`. The planner therefore uses the index to find the
-- seller's pending orders and then SORTS them, which is the thing the index was
-- built to avoid:
--
--     ->  Sort  (Sort Key: o.placed_at, o.id)
--           ->  Index Scan using orders_seller_queue_idx (actual rows=10001)
--
-- Two `created_at`s and one `placed_at` are all `DEFAULT now()`, so in practice
-- they agree -- but the planner is right not to assume that. `now()` is
-- `transaction_timestamp()`, and a caller that explicitly backdates `placed_at`
-- (an import, a correction) makes the two columns genuinely different values.
-- The schema even has a constraint acknowledging that `placed_at` is the
-- meaningful one: orders_progress_monotonic treats it as the origin of the
-- monotonic clock.
--
-- FIFO fairness is a business rule about when the buyer placed the order, so
-- the column the index carries has to be `placed_at`. The alternative -- change
-- the query to sort on `created_at` -- would be faster and wrong, and it would
-- quietly couple the seller's queue order to row insertion time.
--
-- Also fixed: the trailing `id`. The original key stopped at `created_at`, so
-- ties in `placed_at` were not a total order and the planner had to keep the
-- sort alive to break them even when the columns did agree. With `id` last, the
-- index order is total and matches the ORDER BY exactly.
--
-- The name is kept. The index is still the seller queue; only its key was wrong.
-- ---------------------------------------------------------------------------
DROP INDEX orders_seller_queue_idx;

CREATE INDEX orders_seller_queue_idx
  ON orders (seller_id, placed_at, id)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- One more index, added rather than corrected.
--
-- `orders_seller_active_idx` (007:77) is (seller_id, created_at DESC) and serves
-- "this seller's live orders". It is the read-side counterpart to the queue
-- index, but it still has the same created_at/placed_at mismatch, and unlike the
-- queue index it is not partial to a single status -- it covers four
-- (pending, accepted, paid, shipped). A seller dashboard listing all of those
-- was paying for a sort it did not need to pay for.
--
-- Corrected for the same reason and in the same way. Both indexes are rebuilt
-- rather than amended because there is no cheaper operation in PostgreSQL 16 for
-- changing a key; `REINDEX` cannot alter the key, and creating-then-dropping
-- leaves the old copy live until the new one is ready, which is the correct
-- order for an index in a live system.
-- ---------------------------------------------------------------------------
DROP INDEX orders_seller_active_idx;

CREATE INDEX orders_seller_active_idx
  ON orders (seller_id, placed_at DESC, id DESC)
  WHERE status IN ('pending', 'accepted', 'paid', 'shipped');

COMMENT ON INDEX orders_seller_queue_idx IS
  'Serves db/queries/04_seller_orders.sql. Key is (seller_id, placed_at, id) to '
  'match its ORDER BY exactly, so the seller FIFO queue is an index scan with no '
  'sort node. placed_at, not created_at: FIFO fairness is about when the buyer '
  'placed the order. See db/migrations/009_index_corrections.sql.';
