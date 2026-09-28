/**
 * JSON responses and database-error translation.
 *
 * Two jobs, both of which belong in one place because getting either wrong is
 * invisible until it is expensive:
 *
 *  1. **BigInt safety.** PGlite parses `int8` into a JavaScript `number` while
 *     the value fits in a safe integer and into a `bigint` when it does not
 *     (see its `types.bigint` parser). `JSON.stringify` throws outright on a
 *     BigInt, so a single order total above 2^53 would turn a successful query
 *     into a 500. Money can exceed that, so the boundary is handled once here
 *     rather than in every route. BigInts are serialised as strings -- silently
 *     truncating to a float would corrupt money, which is the one thing this
 *     project must never do.
 *
 *  2. **Error translation.** The database already knows precisely why a write
 *     was refused, down to the constraint name. That information is worth far
 *     more to a client than a generic 400, so it is mapped rather than
 *     discarded. What is *not* forwarded is `message`, `detail` and `routine`:
 *     those name tables, columns and PL/pgSQL internals, which is information
 *     an attacker should not get for free.
 */
import { NextResponse } from 'next/server';
import { describePgError, isPgError } from '@/server/db/client';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Replace BigInt with a string so `JSON.stringify` cannot throw. */
function toJsonSafe(value: unknown): JsonValue {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value as JsonValue;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(toJsonSafe(data) as JsonValue, init);
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    /** SQLSTATE, when the refusal came from the database. */
    readonly sqlstate?: string;
    /** Constraint or trigger that refused the write, when there was one. */
    readonly constraint?: string;
    readonly fields?: Readonly<Record<string, string>>;
  };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra?: { sqlstate?: string; constraint?: string; fields?: Record<string, string> }
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, ...extra } },
    { status }
  );
}

/**
 * A refusal the application decided, rather than the database.
 *
 * The distinction matters. `fromPgError` translates a SQLSTATE into a status,
 * which is the right move for a constraint the application did not anticipate.
 * But a route also knows things no constraint knows -- that a product id in the
 * body does not exist, that a basket is empty -- and those refusals deserve
 * their own precise code instead of being forced through `422 conflict`. This
 * class is the seam: repositories throw it, routes do not catch it, and
 * `toErrorResponse` turns it into a response with the same envelope as
 * everything else.
 *
 * A `fields` map is per-field messages, which is what a form can render inline.
 */
export class HttpError extends Error {
  readonly fields: Readonly<Record<string, string>> | undefined;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    fields?: Record<string, string>
  ) {
    super(message);
    this.name = 'HttpError';
    this.fields = fields;
  }
}

/**
 * SQLSTATE classes, which are the part of the code that is actually a contract.
 * The five-character codes are stable; the constraint names are ours and are
 * documented, so clients may rely on both.
 */
const SQLSTATE_STATUS: Readonly<Record<string, number>> = {
  '23505': 409, // unique_violation
  '23503': 409, // foreign_key_violation
  '23514': 422, // check_violation
  '23502': 422, // not_null_violation
  '22023': 422, // invalid_parameter_value
  '22P02': 400, // invalid_text_representation
  '42501': 403, // insufficient_privilege
  '55P03': 409, // lock_not_available
};

/** Constraint name to the specific conflict, so the message can be actionable. */
const CONSTRAINT_CODE: Readonly<Record<string, string>> = {
  users_email_lower_key: 'email_taken',
  orders_buyer_idempotency_key: 'idempotency_key_reused',
  payments_single_live_per_order: 'payment_already_captured',
  reviews_one_per_order_per_author: 'already_reviewed',
  order_items_one_line_per_product: 'duplicate_line',
  orders_illegal_status_transition: 'illegal_status_transition',
  orders_actor_not_authorized: 'not_your_order',
  order_items_immutable_after_payment: 'order_already_paid',
  payments_settled_fields_immutable: 'payment_already_settled',
  reviews_order_must_be_completed: 'order_not_completed',
  reviews_author_must_be_buyer: 'not_your_order',
  reviews_subject_must_be_order_seller: 'wrong_review_subject',
  order_items_single_seller_per_order: 'mixed_sellers',
  order_items_product_must_be_active: 'product_unavailable',
  products_seller_must_be_active: 'seller_suspended',
  seller_profiles_role_must_be_seller: 'not_a_seller',
};

/**
 * Constraints whose meaning is narrower than their SQLSTATE class.
 *
 * `23514` is "check violation", and 422 is the right default for it: the request
 * was well-formed and the data it carried failed a rule. One check is different
 * in kind. `orders_illegal_status_transition` fires because the order is *not
 * in a state this caller may move it from* -- which is a conflict with the
 * current state of the resource, the textbook 409, and is what the documented
 * contract for the transition endpoint promises.
 *
 * Keeping the override at the constraint level rather than special-casing the
 * code inside `fromPgError` means the generic 23514 handling stays generic. The
 * tempting alternative, sending every check violation as 409, would be wrong for
 * a genuine data-integrity refusal: "your line total does not match price times
 * quantity" is not a conflict with anything that already exists.
 */
const CONSTRAINT_STATUS: Readonly<Record<string, number>> = {
  orders_illegal_status_transition: 409,
};

/**
 * Turns a thrown database error into a response.
 *
 * A trigger-raised `42501` is a genuine authorisation refusal, so it maps to
 * 403 -- but only because the database decided that, not because the route
 * guessed. An unrecognised error falls through to 500 with no internals, which
 * is the point: an unmapped constraint should show up as a missing case here
 * rather than as a leaked stack trace.
 */
export function fromPgError(error: unknown): NextResponse<ApiErrorBody> {
  if (!isPgError(error)) {
    // Server-side only. The client gets a generic 500 -- correctly, since a stack
    // trace names file paths -- but the log gets the whole thing. Without this
    // line a database error is invisible: the response says "internal_error",
    // the dev log says nothing, and the only way to find out what PostgreSQL
    // objected to is to reproduce it in a REPL.
    console.error('[api] non-PostgreSQL error', error);
    return apiError(500, 'internal_error', 'An unexpected error occurred.');
  }

  const status = SQLSTATE_STATUS[error.code] ?? 500;
  const constraint = error.constraint;
  const code = (constraint !== undefined ? CONSTRAINT_CODE[constraint] : undefined) ?? 'conflict';
  // A constraint's own meaning beats its SQLSTATE class when the two disagree.
  const resolved =
    (constraint !== undefined ? CONSTRAINT_STATUS[constraint] : undefined) ?? status;

  if (status >= 500) {
    console.error('[api] database error', describePgError(error));
  }

  const message =
    resolved === 403
      ? 'You are not allowed to perform that action.'
      : resolved === 409
        ? 'That conflicts with something that already exists.'
        : resolved === 422
          ? 'The request failed a database rule.'
          : 'An unexpected error occurred.';

  return apiError(resolved, code, message, {
    sqlstate: error.code,
    ...(constraint !== undefined ? { constraint } : {}),
  });
}

/**
 * The one call a route should use to report a failure.
 *
 * An `HttpError` already knows its status and code, so it is rendered directly.
 * Anything else is a database error and goes through `fromPgError`. Routes
 * therefore never contain a `catch` that inspects an error, which is what stops
 * a write failure from being reported as a generic 500 -- the failure mode where
 * the transaction correctly rolls back and the user is told the opposite.
 */
export function toErrorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof HttpError) {
    return apiError(
      error.status,
      error.code,
      error.message,
      error.fields !== undefined ? { fields: error.fields } : undefined
    );
  }
  return fromPgError(error);
}
