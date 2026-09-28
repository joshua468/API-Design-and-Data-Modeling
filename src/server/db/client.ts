/**
 * The single PGlite handle for the whole process.
 *
 * PGlite is PostgreSQL 16.4 compiled to WebAssembly and running in-process, so
 * everything in `db/migrations` is real PostgreSQL: real enums, real CHECK
 * constraints, real partial unique indexes, real EXPLAIN plans. The only thing
 * that changes versus a networked server is how you connect, and the reason for
 * that is environmental rather than a preference -- see docs section 22.
 *
 * Three constraints shape this module:
 *
 *  1. **One instance per process.** PGlite takes an exclusive lock on its data
 *     directory. Two handles on the same directory is a hard error, not a
 *     warning, so the handle is cached on `globalThis`. That also survives
 *     Next.js hot reload, which re-evaluates modules but not globals.
 *
 *  2. **A caller cannot guess a row's shape.** `query` returns `Row[]` typed by
 *     the caller's assertion, and `unknown` is the honest type at the database
 *     boundary. Narrowing happens once, in the repository functions.
 *
 *  3. **Migrations and the app must not run at the same time.** Scripts open
 *     their own handle, so `npm run db:seed` against a running `next dev` will
 *     fail loudly on the directory lock. That is the intended behaviour: a
 *     silent "database is locked" retry loop is how seeds get half-applied.
 */
import { PGlite } from '@electric-sql/pglite';
import { resolve } from 'node:path';

/**
 * A value that can be bound to a placeholder.
 *
 * The array member is not decoration: `WHERE p.id = ANY($1::uuid[])` is the
 * natural way to load an arbitrary set of rows, and passing a bare
 * `unknown[]` would mean every caller casts at the call site -- which is exactly
 * the boundary this module exists to keep narrow. Scalars inside an array are
 * limited to what a driver can serialise; structured values still belong in
 * JSON.
 */
export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Date
  | undefined
  | readonly string[]
  | readonly number[];

/** The query function, as both the module-level `query` and `Tx` expose it. */
export type RunQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: SqlParam[]
) => Promise<QueryResult<T>>;


export interface QueryResult<T> {
  rows: T[];
  affectedRows: number;
}

interface PGliteHandle {
  db: PGlite;
  opening?: Promise<PGliteHandle>;
}

const globalCache = globalThis as typeof globalThis & {
  __marketplacePglite?: PGliteHandle;
};

/**
 * Postgres error shape, narrowed to the fields the API layer reports. PGlite
 * throws a `DatabaseError` whose useful parts are own properties; `message` sits
 * behind a getter, so it is read defensively at the one place that needs it.
 */
export interface PgError {
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  table?: string;
  column?: string;
  severity?: string;
}

export function isPgError(error: unknown): error is PgError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
  );
}

export function describePgError(error: unknown): PgError {
  if (!isPgError(error)) {
    return { code: 'UNKNOWN', message: String(error) };
  }
  let message = '';
  try {
    message = String((error as { message?: unknown }).message ?? '');
  } catch {
    message = '';
  }
  if (!message) {
    message = [error.severity, error.code, error.detail, error.hint]
      .filter(Boolean)
      .join(': ');
  }
  return { ...error, message: message.split('\n').at(0)?.trim() ?? '' };
}

async function getHandle(): Promise<PGlite> {
  const existing = globalCache.__marketplacePglite;
  if (existing) {
    // Concurrent first callers share one open rather than racing to open twice.
    if (existing.opening) await existing.opening;
    return existing.db;
  }

  const { env } = await import('@/server/env');
  const handle: PGliteHandle = { db: undefined as unknown as PGlite };
  globalCache.__marketplacePglite = handle;

  handle.opening = (async () => {
    handle.db = new PGlite(resolve(process.cwd(), env.dataDir));
    await handle.db.waitReady;
    return handle;
  })();

  try {
    await handle.opening;
  } catch (error) {
    // Do not leave a half-open handle cached: the next caller would inherit a
    // broken instance and every later failure would point at the wrong cause.
    globalCache.__marketplacePglite = undefined;
    throw error;
  }
  return handle.db;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = []
): Promise<QueryResult<T>> {
  if (isNetworkDatabase()) {
    const { networkQuery } = await import('./prisma');
    return networkQuery<T>(sql, params);
  }
  const db = await getHandle();
  const result = await db.query<T>(sql, params as never[]);
  return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
}

/** Multi-statement execution, used by the migration runner. */
export async function exec(sql: string): Promise<void> {
  const db = await getHandle();
  await db.exec(sql);
}

/**
 * Runs `fn` inside a transaction and commits only if it returns.
 *
 * Every multi-statement write in the API layer goes through here. It is not
 * decoration: an order plus its items plus its payment is three writes that are
 * only meaningful together, and a failure after the first would otherwise leave
 * a buyer charged for an order that does not exist.
 */
export async function transaction<T>(
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (isNetworkDatabase()) {
    const { networkTransaction } = await import('./prisma');
    return networkTransaction(fn);
  }
  const db = await getHandle();
  await db.exec('BEGIN');
  try {
    const result = await fn({
      query: async <R = Record<string, unknown>>(
        sql: string,
        params: SqlParam[] = []
      ): Promise<QueryResult<R>> => {
        const r = await db.query<R>(sql, params as never[]);
        return { rows: r.rows, affectedRows: r.affectedRows ?? 0 };
      },
    });
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

export interface Tx {
  query: RunQuery;
}

/**
 * Which handle the process should talk to.
 *
 * The vitest suite pins PGlite so tests never open a network connection by
 * accident and stay hermetic. For the running app, `DATABASE_URL` selects the
 * networked Postgres server through the Prisma data layer; without it the app
 * gracefully falls back to the embedded PGlite database.
 */
function isNetworkDatabase(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  const url = process.env.DATABASE_URL;
  return url !== undefined && url !== '';
}

/** Test-only: drop the cached handle so the next call reopens. */
export async function closeDatabase(): Promise<void> {
  const handle = globalCache.__marketplacePglite;
  globalCache.__marketplacePglite = undefined;
  if (handle?.db) await handle.db.close();
}
