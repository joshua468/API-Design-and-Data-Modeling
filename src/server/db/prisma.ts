/**
 * Prisma Client for the application's networked PostgreSQL server.
 *
 * The hand-written `db/migrations/*.sql` remain the schema's source of truth
 * (domains, CHECK constraints, triggers, partial indexes -- things `prisma
 * db push` cannot express). Prisma's job here is the part it is good at: a
 * pooled, type-safe client for the running app. Reads can go through the ORM
 * models in `prisma/schema.prisma`; the constraint-heavy writes go through
 * `$queryRaw`/`$executeRaw` inside Prisma transactions so the guard trigger and
 * the CHECK constraints keep full control of order state.
 *
 * The module is imported lazily (never in tests), so `new PrismaClient` is only
 * constructed for the real server and the driver adapter is only created when
 * `DATABASE_URL` is present.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { env } from '@/server/env';
import type { QueryResult, RunQuery, SqlParam, Tx } from './client';

function adapter(): PrismaPg {
  if (env.databaseUrl === '') {
    throw new Error(
      'DATABASE_URL must be set to construct the Prisma data layer.'
    );
  }
  return new PrismaPg({ connectionString: env.databaseUrl });
}

declare global {
  // Module-level state that must survive Next.js hot reload.
  var __marketplacePrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__marketplacePrisma ??
  new PrismaClient({
    adapter: adapter(),
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__marketplacePrisma = prisma;
}

/**
 * Normalizes the module's `SqlParam[]` into what a Prisma raw query accepts.
 *
 * PGlite binds `undefined` as SQL NULL, like the `pg` driver does. Prisma
 * rejects `undefined` outright, so it is coalesced to `null`. Position is
 * preserved (every placeholder still has a value), because removing a late
 * element would silently renumber `$N` and bind the wrong values.
 */
function sanitize(params: readonly SqlParam[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

/**
 * Replaces `bigint` with a JS `number` throughout a result row.
 *
 * The PostgreSQL adapter hands back int8 columns (the `minor_units` money
 * domain, `count(*)::bigint`) as `bigint`. `JSON.stringify` then throws, or
 * Next.js stringifies them -- either way the API contract leaks "1850000n"
 * would-be handled wrongly: PGlite has always delivered these as numbers, the
 * route contracts assert numbers, and the docs say money is a minor-unit
 * integer. Demoting at this one seam matches the PGlite backend exactly instead
 * of sprinkling `Number(...)` across every mapper.
 *
 * An unscoped demotion can lose precision past 2^53. Every bigint in this
 * schema is a monetary amount or a count, and the upper CHECK bounds are well
 * inside the safe range, so the trade is acceptable and cheap to revisit.
 */
function demoteBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(demoteBigInt);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = demoteBigInt(item);
    }
    return out;
  }
  return value;
}

function toRows<T>(value: unknown): T[] {
  const rows = (value ?? []) as T[];
  return (rows as unknown[]).map(demoteBigInt) as T[];
}

/**
 * The narrowed shape of the raw error the Prisma pg driver adapter forwards.
 *
 * `@prisma/adapter-pg` catches the driver's `DatabaseError` and re-wraps it as a
 * `P2010` whose `meta.driverAdapterError.cause` keeps only a handful of fields
 * (`code`, `message`, `detail`, `severity`). The `constraint` name -- the field
 * `fromPgError` keys its documented 409/403 codes on -- is dropped, so a write
 * the PGlite backend reports as `illegal_status_transition` would surface here
 * as a generic 422/409. The adapter cannot be told to keep it, so the seam puts
 * it back.
 */
interface RawCause {
  code?: string;
  message?: string;
  detail?: string;
  severity?: string;
}

function rawCause(error: unknown): RawCause | undefined {
  const meta = (error as {
    meta?: { driverAdapterError?: { cause?: RawCause } };
  })?.meta;
  return meta?.driverAdapterError?.cause;
}

/**
 * Recover the constraint name the driver adapter strips, for the refusals the
 * write contracts promise by name.
 *
 * Every trigger-armed constraint except the order guard's two is pre-checked by
 * an `HttpError` in the repository before the write, so a lost name there only
 * degrades an already-lost race. The delimiting map is purely first-words of
 * messages the migrations themselves raise -- safe enough for a case where the
 * alternative is a degraded public contract, and pinned by the proof suite.
 */
function constraintFor(cause: RawCause): string | undefined {
  const message = cause.message ?? '';
  if (cause.code === '23514' && message.startsWith('illegal order transition:')) {
    return 'orders_illegal_status_transition';
  }
  if (cause.code === '42501' && message.startsWith('actor ')) {
    return 'orders_actor_not_authorized';
  }
  return undefined;
}

/**
 * Rehydrate a Prisma `P2010` into the PgError shape PGlite throws, so
 * `fromPgError` maps the two backends identically. Errors that are not the
 * adapter's fault (an `HttpError` from repository code, a driver failure) pass
 * through untouched.
 */
function unwrapPrismaError(error: unknown): unknown {
  const cause = rawCause(error);
  if (!cause) return error;
  const code = cause.code;
  if (code === undefined || !/^[0-9A-Z]{5}$/.test(code)) return error;
  return {
    code,
    message: cause.message ?? 'An unexpected database error occurred.',
    ...(cause.detail !== undefined ? { detail: cause.detail } : {}),
    ...(cause.severity !== undefined ? { severity: cause.severity } : {}),
    ...(constraintFor(cause) !== undefined ? { constraint: constraintFor(cause) } : {}),
  };
}

/**
 * `query` for the network backend: raw SQL through Prisma, returning the same
 * `{ rows, affectedRows }` shape the PGlite implementation exposes.
 */
export async function networkQuery<T = Record<string, unknown>>(
  sql: string,
  params: SqlParam[] = []
): Promise<QueryResult<T>> {
  try {
    const rows = await prisma.$queryRawUnsafe<T[]>(sql, ...sanitize(params));
    return {
      rows: toRows<T>(rows),
      affectedRows: Array.isArray(rows) ? rows.length : 0,
    };
  } catch (error) {
    throw unwrapPrismaError(error);
  }
}

/**
 * `transaction` for the network backend: a Prisma interactive transaction whose
 * `tx.query` issues the same raw SQL the repositories already run against
 * PGlite. It is the transaction, not the query, that carries the
 * `app.actor_id`/`app.actor_role` GUCs the order guard trigger reads, so this
 * must be a *real* Postgres transaction -- exactly what Prisma's callback form
 * gives us.
 */
export async function networkTransaction<T>(
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const run: RunQuery = async <R = Record<string, unknown>>(
          sql: string,
          params: SqlParam[] = []
        ): Promise<QueryResult<R>> => {
          const rows = await tx.$queryRawUnsafe<R[]>(sql, ...sanitize(params));
          return { rows: toRows<R>(rows), affectedRows: Array.isArray(rows) ? rows.length : 0 };
        };
        return fn({ query: run });
      },
      { maxWait: 5_000, timeout: 60_000 }
    );
  } catch (error) {
    throw unwrapPrismaError(error);
  }
}