/**
 * GET /api/v1/probe -- exercises the Prisma data layer and reports the
 * connection it used. Safe to hit from a browser: returns host/port/database
 * and a real query result, never credentials.
 */
import { env } from '@/server/env';
import { query } from '@/server/db/client';
import { networkQuery } from '@/server/db/prisma';
import { json } from '@/server/http/responses';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  const source = env.databaseUrl === '' ? 'pglite-embedded' : 'prisma-pg-adapter';

  const sql = `SELECT current_setting('server_version') AS server_version,
                      (SELECT count(*)::int FROM schema_migrations) AS migrated,
                      (SELECT count(*)::int FROM products)          AS products,
                      (SELECT count(*)::int FROM orders)            AS orders`;

  try {
    const rows = source === 'prisma-pg-adapter'
      ? (await networkQuery<{ server_version: string; migrated: number; products: number; orders: number }>(sql)).rows
      : (await query<{ server_version: string; migrated: number; products: number; orders: number }>(sql)).rows;
    const row = rows[0];

    return json({
      status: 'ok',
      dataSource: source,
      connection:
        source === 'prisma-pg-adapter'
          ? (() => {
              const url = new URL(env.databaseUrl);
              return { host: url.hostname, port: Number(url.port), database: url.pathname.replace(/^\//, '') };
            })()
          : { engine: 'embedded pglite', dataDir: env.dataDir },
      engine: row?.server_version ?? 'unknown',
      passthrough: source === 'prisma-pg-adapter' ? 'db/client -> (query/transaction) -> prisma.ts networkQuery -> @prisma/adapter-pg -> postgres' : 'db/client -> pglite',
      migrated: row?.migrated ?? 0,
      products: row?.products ?? 0,
      orders: row?.orders ?? 0,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    return json(
      {
        status: 'degraded',
        dataSource: source,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      },
      { status: 503 }
    );
  }
}