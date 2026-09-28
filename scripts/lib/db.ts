/**
 * A thin connection for the standalone scripts.
 *
 * `src/server/db/client.ts` is the application's handle and is cached on
 * globalThis for hot-reload safety. Scripts do not need that: each is a
 * one-shot process. Importing the app's client here would drag Next.js's `env`
 * module (and its `server-only` guard) into a plain Node process for no
 * benefit, so this file opens PGlite directly and stays small enough to audit.
 *
 * The data directory is read from the same `PGLITE_DATA_DIR` variable the app
 * uses, so scripts and the app always agree on which database they mean.
 */
import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What a transaction body is given.
 *
 * Deliberately *not* `ScriptDb`: handing the callback a `transaction` method
 * would invite a nested `BEGIN`, which PostgreSQL accepts as a savepoint-less
 * no-op warning at best. The narrower type makes that unrepresentable.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[]; affectedRows: number }>;
  exec(sql: string): Promise<void>;
}

export interface ScriptDb extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function dataDir(): string {
  return process.env['PGLITE_DATA_DIR'] ?? '.pglite';
}

export function dataPath(): string {
  return resolve(process.cwd(), dataDir());
}

/**
 * The connection a one-shot script should use.
 *
 * A script that talks to the *server* the app runs against sets `DATABASE_URL`;
 * without it the script falls back to the embedded PGlite database. This is the
 * same variable the app's Prisma client will read, so "seed the app's database"
 * and "seed the prototype's database" are the same command with different
 * environment.
 *
 * `DB_FORCE_PGLITE=1` wins over a checked-in `DATABASE_URL`. The test harness
 * relies on that: it re-reads `.env.local` inside each subprocess (see
 * `loadDotEnv`), so deleting the variable would not survive -- deleting it in
 * the parent only means it is re-added on the first line of `openConn`. The
 * flag makes the tests' PGlite guarantee explicit instead of incidental.
 */
export function openConn(): Promise<ScriptDb> {
  if (process.env['DB_FORCE_PGLITE'] === '1') return openDb();
  const url = process.env['DATABASE_URL'];
  return url === undefined || url === '' ? openDb() : openPostgres(url);
}

function attachStatement(error: unknown, sql: string, prefix = ''): never {
  const err = error as Error & { statement?: string };
  err.statement = `${prefix}${sql.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
  throw err;
}

/**
 * Network Postgres instead of PGlite, wearing the same `ScriptDb` surface so
 * the migration runner and the seed need no branching of their own.
 *
 * `exec` runs with the simple query protocol (no parameters), which is the only
 * kind of `pg` query that may contain multiple statements -- exactly how the
 * migration files are written. `query` stays parameterized for single
 * statements.
 */
export function openPostgres(url: string): Promise<ScriptDb> {
  return (async () => {
    const { Client } = await import('pg');
    const client = new Client({ connectionString: url });
    await client.connect();

    const wrap = (
      exec: Queryable['exec'],
      query: Queryable['query']
    ): Queryable => ({ exec, query });

    return {
      ...wrap(
        async (sql) => {
          try {
            await client.query(sql);
          } catch (error) {
            attachStatement(error, sql, 'exec: ');
          }
        },
        async <T>(sql: string, params: readonly unknown[] = []) => {
          try {
            const result = await client.query(sql, params as never[]);
            return { rows: result.rows as T[], affectedRows: result.rowCount ?? 0 };
          } catch (error) {
            attachStatement(error, sql);
          }
        }
      ),
      async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
        await client.query('BEGIN');
        try {
          const result = await fn(
            wrap(
              async (sql) => {
                await client.query(sql);
              },
              async <R>(sql: string, params: readonly unknown[] = []) => {
                const result = await client.query(sql, params as never[]);
                return { rows: result.rows as R[], affectedRows: result.rowCount ?? 0 };
              }
            )
          );
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    };
  })();
}

/** Minimal .env loader so scripts behave the same as the app. */
function loadDotEnv(): void {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadDotEnv();

export async function openDb(dir = dataPath()): Promise<ScriptDb> {
  const pg = new PGlite(dir);
  await pg.waitReady;

  const wrap = (exec: Queryable['exec'], query: Queryable['query']): Queryable => ({
    exec,
    query,
  });

  return {
    ...wrap(
      async (sql) => {
        try {
          await pg.exec(sql);
        } catch (error) {
          // Deferred constraint triggers fire during COMMIT, so a violation
          // surfaces here rather than from the query that caused it. Attaching
          // the statement is the only way to tell a TRUNCATE failure apart from
          // a COMMIT-time trigger failure.
          const err = error as Error & { statement?: string };
          err.statement = `exec: ${sql.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
          throw err;
        }
      },
      async <T>(sql: string, params: readonly unknown[] = []) => {
        try {
          const result = await pg.query<T>(sql, params as never[]);
          return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
        } catch (error) {
          // Attach the statement. A constraint violation from a trigger names the
          // constraint but not the query that caused it, and a seed runs dozens of
          // similar statements -- without this, diagnosing a failure means
          // bisecting the file by hand.
          const err = error as Error & { statement?: string };
          err.statement = sql.replace(/\s+/g, ' ').trim().slice(0, 300);
          throw err;
        }
      }
    ),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      await pg.exec('BEGIN');
      try {
        const result = await fn(
          wrap(
            async (sql) => {
              await pg.exec(sql);
            },
            async <R>(sql: string, params: readonly unknown[] = []) => {
              const result = await pg.query<R>(sql, params as never[]);
              return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
            }
          )
        );
        await pg.exec('COMMIT');
        return result;
      } catch (error) {
        await pg.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
