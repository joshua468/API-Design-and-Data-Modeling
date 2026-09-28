/**
 * Cold-start bootstrap for the embedded PGlite database.
 *
 * A deployment that has no `DATABASE_URL` cannot rely on a database having been
 * seeded by a human: on a serverless cold start the process may hold an empty
 * data directory. This module makes that state self-healing -- apply any
 * pending migration, then seed the demo dataset if the schema is empty -- and
 * nothing else. It deliberately reuses the exact runner semantics of
 * `scripts/migrate.ts` (one file per transaction, checksummed `schema_migrations`
 * rows) and the exact dataset of `scripts/seed.ts` (`seedDatabase`), so a cold
 * start produces byte-identical rows to `npm run db:setup`.
 */
import type { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seedDatabase, type SeedDb, type SeedTx } from './seed-data';

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

/**
 * Adapts the application's single PGlite handle to the `{query, exec,
 * transaction}` surface the migration runner and the seed expect. Scripts get
 * the same surface from `scripts/lib/db.ts`; this is the in-process twin.
 */
export function wrapHandle(pg: PGlite): SeedDb {
  const base: SeedTx = {
    async exec(sql: string): Promise<void> {
      await pg.exec(sql);
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = []
    ): Promise<{ rows: T[]; affectedRows: number }> {
      const result = await pg.query<T>(sql, params as never[]);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    },
  };

  return {
    ...base,
    async transaction<T>(fn: (tx: SeedTx) => Promise<T>): Promise<T> {
      await pg.exec('BEGIN');
      try {
        const result = await fn(base);
        await pg.exec('COMMIT');
        return result;
      } catch (error) {
        await pg.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/**
 * Applies every `db/migrations/*.sql` file that `schema_migrations` does not
 * yet record. Idempotent by construction: already-applied files are skipped and
 * their recorded checksums are left untouched.
 */
async function applyPendingMigrations(db: SeedDb): Promise<void> {
  const { createHash } = await import('node:crypto');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations'
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const started = Date.now();

    // Same transaction as the migration so "DDL committed but version not
    // recorded" is unrepresentable, exactly as in scripts/migrate.ts.
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(
        `INSERT INTO schema_migrations (version, checksum, duration_ms)
         VALUES ($1, $2, $3)`,
        [file, checksum, Date.now() - started]
      );
    });
  }
}

/**
 * Makes the embedded database usable as a demo (in place, in this process):
 * apply pending migrations, then seed the demo dataset if no schema exists yet.
 *
 * Runs per cold start against the process's own PGlite handle, so it never
 * touches a database the app shares with anything else.
 */
export async function ensureBootstrapped(db: PGlite): Promise<void> {
  const conn = wrapHandle(db);
  await applyPendingMigrations(conn);

  const { rows } = await conn.query<{ n: bigint }>(
    'SELECT count(*) AS n FROM users'
  );
  if (Number(rows[0]?.n ?? 0) > 0) return;

  const [{ hashPassword }, { shippingMinorFor }, { env }] = await Promise.all([
    import('../auth/password'),
    import('../../lib/shipping'),
    import('../env'),
  ]);

  await seedDatabase(conn, {
    passwordHash: await hashPassword(env.seedDemoPassword),
    shippingFor: shippingMinorFor,
  });
}