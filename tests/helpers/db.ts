/**
 * Shared access to the seeded test database.
 *
 * `tests/global-setup.ts` has already migrated and seeded `.pglite-test` by the
 * time any of this runs, so nothing here creates schema or fixtures. Tests
 * reference seeded rows by a stable marker rather than by hard-coded id, which
 * is what lets the seed change without silently invalidating the suite.
 */
import { query, closeDatabase } from '@/server/db/client';

/**
 * Runs `fn` inside a transaction that is always rolled back.
 *
 * The tempting alternative -- truncate the tables in `afterEach` -- is worse
 * than it looks. The schema has triggers, generated columns and foreign keys
 * that make a clean TRUNCATE order a chore worth getting wrong, and a suite that
 * leaves the database dirty makes the *next* failure depend on the *previous*
 * run. A rolled-back transaction gives every test the same starting state and
 * costs nothing, because nothing was written.
 */
export async function inRolledBackTransaction<T>(
  fn: (q: typeof query) => Promise<T>
): Promise<T> {
  await query('BEGIN');
  try {
    const result = await fn(query);
    return result;
  } finally {
    // Roll back even if `fn` threw. A leaked open transaction would hold locks
    // and, worse, leave the fixture data visible to whatever runs next.
    await query('ROLLBACK');
  }
}

/** The seeded seller who owns the most orders, used by queue and review tests. */
export async function busiestSellerId(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT seller_id AS id
       FROM orders
      GROUP BY seller_id
      ORDER BY count(*) DESC, seller_id
      LIMIT 1`
  );
  const row = rows[0];
  if (!row) throw new Error('seed produced no orders; run the seed first');
  return row.id;
}

/** A seeded buyer with at least one order, for order-history tests. */
export async function buyerWithOrders(): Promise<{ id: string; publicCode: string }> {
  const { rows } = await query<{ id: string; public_code: string }>(
    `SELECT buyer_id AS id, public_code
       FROM orders
      ORDER BY placed_at, id
      LIMIT 1`
  );
  const row = rows[0];
  if (!row) throw new Error('seed produced no orders; run the seed first');
  return { id: row.id, publicCode: row.public_code };
}

export { query, closeDatabase };
