/**
 * GET /api/v1/health -- proves the process can reach its database.
 *
 * Exists because "the server started" and "the server can serve" are different
 * claims. This is the endpoint to curl when something looks wrong, and it
 * reports which dependency failed rather than a bare 500.
 */
import { query } from '@/server/db/client';
import { json } from '@/server/http/responses';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  try {
    // `schema_migrations` is the name the migration runner actually creates
    // (scripts/migrate.ts). Naming a table that does not exist here would make
    // the health check report "database unavailable" against a database that is
    // serving traffic perfectly well, which is the one failure mode a health
    // endpoint must not have.
    const { rows } = await query<{ migrated: number; products: number; orders: number }>(
      `SELECT (SELECT count(*)::int FROM schema_migrations) AS migrated,
              (SELECT count(*)::int FROM products)            AS products,
              (SELECT count(*)::int FROM orders)              AS orders`
    );
    const counts = rows[0];
    return json({
      status: 'ok',
      database: 'connected',
      latencyMs: Date.now() - startedAt,
      ...(counts ?? { migrated: 0, products: 0, orders: 0 }),
    });
  } catch {
    return json(
      {
        status: 'degraded',
        database: 'unavailable',
        latencyMs: Date.now() - startedAt,
        hint: 'Run: npm run db:setup',
      },
      { status: 503 }
    );
  }
}
