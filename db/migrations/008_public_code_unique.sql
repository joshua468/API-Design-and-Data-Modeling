-- ============================================================================
-- 008_public_code_unique.sql
-- Add the missing uniqueness guarantee on `orders.public_code`.
--
-- WHY THIS FILE EXISTS
--
-- `orders.public_code` is the identifier a buyer reads out to support staff and
-- writes on a form. The column comment in 004_orders.sql:106 says it is
-- "defended by a unique index". It was not. Nothing in the schema made it
-- unique, and the only guard was the `NOT EXISTS` probe inside
-- assign_order_public_code().
--
-- That probe is a correctness bug, not just a missing optimisation, and it is
-- worth being precise about why. The trigger checks-then-inserts without
-- locking anything, so two concurrent inserts of different orders whose UUIDs
-- hash to the same six hex characters both see the code as free and both take
-- it. The window is small and the seed never hits it, which is exactly why it
-- would have shipped. A six-character hex space is 16.7M values; at 10k orders
-- the birthday collision probability is already around 3%.
--
-- The consequence is not a cosmetic duplicate. `public_code` is an accepted
-- alternative key for looking up an order (see db/queries/05_order_detail.sql),
-- so a duplicate means a lookup by code returns an arbitrary one of two
-- customers' orders. In a system that moves money, that is the worst possible
-- failure and it is silent.
--
-- WHY A NEW FILE
--
-- `db:migrate` records a checksum per applied migration and fails hard on a
-- mismatch, which is the correct behaviour: the file in the repo and the schema
-- in the database must not diverge silently. So this is an additive migration
-- rather than an edit to 004.
-- ============================================================================

-- Step 1: refuse to proceed if duplicates are already present. Creating a unique
-- index over duplicated data fails with a bare "could not create unique index",
-- which says nothing about which rows are the problem. Saying it here turns an
-- opaque failure into a diagnosis.
DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(public_code || ' x' || n, ', ') INTO dupes
    FROM (
      SELECT public_code, count(*) AS n
        FROM orders
       GROUP BY public_code
      HAVING count(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot enforce public_code uniqueness: these codes are duplicated: %', dupes
      USING ERRCODE = 'unique_violation',
            HINT = 'Reassign the duplicated codes, then re-run db:migrate.';
  END IF;
END;
$$;

-- Step 2: the guarantee itself.
--
-- A plain UNIQUE index, not a partial one, and the asymmetry with
-- products_slug_key is deliberate in both directions. There is no reason to
-- exempt any row here: every order is assigned a code before it is ever
-- visible, so there is no class of row that legitimately lacks one. And a code
-- must never be recycled -- an order code that is reassigned to a new order
-- would resolve an archived invoice to someone else's purchase, which is the
-- same failure this migration exists to prevent, arriving through a different
-- door.
--
-- The index also retires the sequential scan in assign_order_public_code():
-- `WHERE o.public_code = candidate` was an unindexed lookup executed once per
-- insert, so allocating codes was O(n) per row and O(n^2) per import.
CREATE UNIQUE INDEX orders_public_code_key ON orders (public_code);

-- The column comment in 004 now describes reality, and says so in the only way
-- that cannot rot: by pointing at the file that makes it true.
COMMENT ON COLUMN orders.public_code IS
  'Human-facing order code, e.g. ''ORD-7K2QX9''. Unique for the lifetime of the '
  'table (orders_public_code_key, db/migrations/008_public_code_unique.sql) and '
  'never recycled. Distinct from the UUID primary key, which is a join key and '
  'should never be printed.';
