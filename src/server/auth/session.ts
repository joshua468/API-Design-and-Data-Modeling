/**
 * Session cookies and actor resolution.
 *
 * The order state machine authorises on identity, not on capability: the guard
 * trigger reads `app.actor_id` and `app.actor_role` and refuses any transition
 * the acting party is not entitled to make on *that* order. So the API layer
 * needs exactly one thing -- a trustworthy answer to "who is calling?" -- and
 * everything else follows from the database.
 *
 * That answer is deliberately assembled from two separate facts:
 *
 *   1. The cookie proves *which user id* the caller is. A client can present
 *      any cookie, but not a forged one: the value carries an HMAC over the id
 *      keyed by SESSION_SECRET, so a caller who does not hold the secret cannot
 *      name somebody else. Without the signature this module would be
 *      "impersonate anyone by sending their UUID", which is not authentication.
 *
 *   2. The role comes from the `users` row, read at request time. It is never
 *      taken from the cookie, the body, or a header. A signed cookie is a
 *      statement of identity; treating it as a statement of authority is how
 *      privilege escalation gets in through a login flow. A user demoted to
 *      `buyer` mid-session loses the ability on their next request, with no
 *      wait for a token to expire, because there is no token caching the role.
 *
 * WHAT IS NOT HERE
 *
 * There is no route that *issues* a cookie. Signing a real session means
 * verifying a password, and password verification belongs with a login endpoint
 * and the UI that drives it; those are not part of this increment. `signSession`
 * is exported so the tests can mint a cookie the same way the eventual login
 * route will, which is what keeps the test from proving something the
 * production path would not do.
 *
 * `system` is not a `users.role`. It is an `actor_role` that the trigger uses
 * for edges no human may perform -- `accepted -> paid` in particular, which
 * exists because payment capture is not a user action. Since the role is read
 * from the `users` table, a user-facing request can never present as `system`.
 * That is a property of the data model rather than a check in this file, and it
 * is why the trigger's `COALESCE(..., 'system')` default is not reachable from
 * here: see `setActor` in the orders repository.
 */
import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/server/env';
import { query } from '@/server/db/client';

export const SESSION_COOKIE = 'mp_session';

/**
 * The authenticated caller.
 *
 * `role` is a `user_role`: 'buyer' | 'seller' | 'admin'. It is deliberately
 * typed to exclude 'system', so passing it to a place that expects a wider
 * `actor_role` is an explicit widening rather than something a stray value
 * causes by accident.
 */
export interface Actor {
  readonly id: string;
  readonly role: 'buyer' | 'seller' | 'admin';
  readonly fullName: string;
}

function sign(userId: string): string {
  return createHmac('sha256', env.sessionSecret).update(userId).digest('base64url');
}

/**
 * Mints a cookie value for a user id.
 *
 * Exported for tests and for the future login route; not reachable from a
 * request handler, because a handler that could mint its own cookie would be an
 * authentication bypass regardless of what it does with the result.
 */
export function signSession(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

/**
 * Recovers a user id from a cookie value, or null if the value is not one this
 * server produced.
 *
 * The signature comparison is length-checked and constant-time. A short-circuit
 * `===` on the MAC is a timing oracle: an attacker who can measure how long the
 * comparison took learns the expected value one byte at a time, and a
 * `base64url` digest is short enough to guess in practice.
 */
export function readSession(token: string | undefined): string | null {
  if (token === undefined) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const userId = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(sign(userId));

  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  // A forged-but-correctly-signed value is impossible without the secret, but a
  // signature is not a parse: still refuse anything that is not a uuid, so a
  // value cannot reach the database as an untyped parameter.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
    ? userId
    : null;
}

/** Pulls a named cookie out of a Request's `Cookie` header. */
function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Resolves the caller, or null when the request is not authenticated.
 *
 * A soft-deleted user is treated as absent. `users.deleted_at` exists so an
 * account can be removed while its orders remain, and the obvious bug this
 * guards against is a deleted account continuing to place orders for as long as
 * its cookie happens to be replayed.
 */
export async function requireActor(request: Request): Promise<Actor | null> {
  const userId = readSession(cookieValue(request.headers.get('cookie'), SESSION_COOKIE));
  if (userId === null) return null;

  const { rows } = await query<{ id: string; role: 'buyer' | 'seller' | 'admin'; full_name: string }>(
    `SELECT id, role::text, full_name
       FROM users
      WHERE id = $1::uuid
        AND deleted_at IS NULL`,
    [userId]
  );

  const row = rows[0];
  if (row === undefined) return null;

  return { id: row.id, role: row.role, fullName: row.full_name };
}
