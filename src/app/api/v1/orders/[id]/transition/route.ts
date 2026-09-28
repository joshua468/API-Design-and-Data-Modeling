/**
 * PATCH /api/v1/orders/[id]/transition -- workflow 3, the state machine.
 *
 * Contract:
 *   auth      session cookie; the role is read from the `users` row
 *   body      { "to": "accepted" }
 *   success   200 { data: { order, items, payments, transition } }
 *   errors    400 invalid_request
 *             401 unauthenticated
 *             403 not_your_order / not_your_transition
 *             404 order_not_found
 *             409 illegal_status_transition
 *
 * `[id]` accepts either the order's uuid or its human `public_code` (ORD-XXXXXX).
 * The buyer's order history renders codes because they are quotable over the
 * counter; the same URL has to work for both or one of the two callers has to
 * know an implementation detail.
 *
 * WHY THE ROUTE IS SO THIN
 *
 * The handler validates the envelope, resolves the caller, issues one UPDATE,
 * and translates the result. It does not ask whether the edge is legal and it
 * does not decide whether the caller may take it. Both of those questions are
 * answered by `guard_order_transition`, which reads `order_status_transitions`
 * and the order's own buyer and seller columns. A route that duplicated that
 * logic would be a second implementation of the state machine, and the schema's
 * main claim -- that the legal lifecycle is data, not code -- would stop being
 * true at the API boundary.
 *
 * So the interesting outcomes here are all refusals, and all of them arrive as
 * named constraints:
 *
 *   - an edge that does not exist for this actor  -> 409 illegal_status_transition
 *   - an edge that exists for somebody else       -> 403 not_your_order
 *   - an order that is not there                  -> 404
 *
 * The distinction between the first two is the one worth having. "You may not do
 * that" and "you are not allowed to do that" need different fixes from the
 * caller, and a single 403 for both would make a seller debugging a stuck queue
 * unable to tell a state-machine problem from a permissions problem.
 */
import { z } from 'zod';
import { requireActor } from '@/server/auth/session';
import { apiError, json, toErrorResponse } from '@/server/http/responses';
import { getOrderDetail, ORDER_STATUSES, transitionOrder } from '@/server/repositories/orders';

const BodySchema = z.object({
  // Enumerated from the order_status enum's own spelling. This is the one place
  // a status is spelled out outside the database, and it exists only to turn a
  // typo into a 400. It is deliberately NOT a copy of the transition table: the
  // set of states and the set of legal moves between them are different things,
  // and collapsing them here would let the route answer "is this legal?" with a
  // list that can go stale.
  to: z.enum(ORDER_STATUSES),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await context.params;

  const actor = await requireActor(request);
  if (actor === null) {
    return apiError(401, 'unauthenticated', 'Sign in to change an order.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'invalid_request', 'The request body is not valid JSON.');
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      400,
      'invalid_request',
      `Body must be { "to": one of ${ORDER_STATUSES.join(', ')} }.`,
      { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '(body)', i.message])) }
    );
  }

  try {
    const result = await transitionOrder({
      orderIdOrCode: id,
      to: parsed.data.to,
      actor,
    });

    if (result === null) {
      return apiError(404, 'order_not_found', 'No order with that id.');
    }

    const detail = await getOrderDetail(result.publicCode);
    if (detail === null) {
      return apiError(500, 'internal_error', 'An unexpected error occurred.');
    }

    return json({
      data: {
        ...detail,
        transition: {
          to: result.status,
          from: result.previousStatus,
          // False when the order was already in the requested state. Reported
          // rather than hidden so a client retrying a timed-out PATCH can tell
          // "your retry landed" from "your retry was ignored".
          changed: result.changed,
        },
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
