/**
 * POST /api/v1/orders -- workflow 3, a buyer checks out.
 *
 * Contract:
 *   auth      session cookie; the role is read from the `users` row, never
 *             from the request
 *   headers   Idempotency-Key (required, 8-128 chars)
 *   body      { sellerId, shipping: {...}, items: [{ productId, quantity }] }
 *   success   201 { data: { order, items, payments } } with a Location header
 *             200 { data: {...} } + Idempotent-Replay when the key was used
 *             before with this same basket
 *   errors    400 invalid_request / missing_idempotency_key
 *             401 unauthenticated
 *             403 not_a_buyer
 *             404 order_not_found (not produced here; reserved by the contract)
 *             409 idempotency_key_reused / insufficient_stock
 *             422 product_not_found / product_unavailable / mixed_sellers /
 *                   mixed_currencies / seller_suspended / not_a_seller /
 *                   empty_basket / quantity_too_large
 *
 * THE REQUEST BODY DOES NOT CONTAIN A PRICE.
 *
 * That is the whole point of this endpoint, and it is worth being explicit about
 * because a checkout API that accepted a `priceMinor` per line would be a
 * security hole with a validation function attached. Here the body is ids and
 * quantities; prices, tax rates and currency are read from `products` inside the
 * same transaction, and the totals are computed by the database with the same
 * `tax_on()` the CHECK constraints use. A caller can change what it buys; it
 * cannot change what they pay.
 *
 * WHY A REPLAY IS 200 AND NOT 409
 *
 * An idempotency key exists so that a client which never received a response can
 * retry safely. Answering 409 to a retry would punish exactly the behaviour the
 * header is for. So a repeat of the same basket returns the original order with
 * 200 and an `Idempotent-Replay: true` header -- nothing was created, so 201
 * would be a lie. 409 is still reachable, for the genuinely different case of
 * the same key carrying a *different* basket, which is a client bug and is
 * reported as one.
 */
import { z } from 'zod';
import { requireActor } from '@/server/auth/session';
import { apiError, json, toErrorResponse } from '@/server/http/responses';
import { getOrderDetail, placeOrder } from '@/server/repositories/orders';

const ShippingSchema = z.object({
  name: z.string().trim().min(2).max(120),
  line1: z.string().trim().min(3).max(200),
  // Optional parts are trimmed but may be absent, empty or explicitly null. The
  // columns are nullable, and a client sending "" and a client sending null mean
  // the same thing -- "there is no second line" -- so they should not produce
  // different orders.
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(80),
  region: z.string().trim().max(80).nullish(),
  postalCode: z.string().trim().max(12).nullish(),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Must be a two-letter ISO 3166-1 country code.'),
});

const OrderSchema = z.object({
  sellerId: z.uuid('Must be a uuid.'),
  shipping: ShippingSchema,
  items: z
    .array(
      z.object({
        productId: z.uuid('Must be a uuid.'),
        // z.int(), not z.number(): "2" as a string is not a quantity, and
        // z.coerce.number() would accept it -- and accept 1.5, and round it.
        quantity: z.int('Must be a whole number.').min(1).max(999),
      })
    )
    .min(1, 'An order needs at least one item.')
    .max(50),
});

/** `idempotency_key_t` is VARCHAR(128) with a >= 8 length check. */
const IDEMPOTENCY_RE = /^.{8,128}$/;

function fieldErrors(error: z.ZodError): Record<string, string> {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join('.') || '(body)', issue.message])
  );
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireActor(request);
  if (actor === null) {
    return apiError(401, 'unauthenticated', 'Sign in to place an order.');
  }
  // A seller placing an order is a legitimate marketplace action -- a shop
  // buying from another shop -- so this is not refused here. What is refused is
  // selling to yourself, and that is a row-level fact about the order, so the
  // `orders_buyer_is_not_seller` check is the right place for it: it is true no
  // matter which route or script created the row.
  if (actor.role === 'admin') {
    return apiError(
      403,
      'not_a_buyer',
      'The admin account is not a shopping account and cannot place orders.'
    );
  }

  const rawKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (!IDEMPOTENCY_RE.test(rawKey)) {
    return apiError(
      400,
      'missing_idempotency_key',
      'Send an Idempotency-Key header of 8 to 128 characters.'
    );
  }

  // A body that is not JSON at all fails `parse` with a SyntaxError rather than
  // a ZodError, so the two are distinguished here instead of being reported
  // with the same "invalid" code -- one is a malformed document and the other
  // is a document that parsed and said the wrong thing.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, 'invalid_request', 'The request body is not valid JSON.');
  }

  const parsed = OrderSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(400, 'invalid_request', 'The request body is invalid.', {
      fields: fieldErrors(parsed.error),
    });
  }

  const { sellerId, shipping, items } = parsed.data;
  const optional = (value: string | null | undefined): string | undefined =>
    value === null || value === undefined || value === '' ? undefined : value;

  try {
    const placed = await placeOrder({
      buyerId: actor.id,
      sellerId,
      idempotencyKey: rawKey,
      shipping: {
        name: shipping.name,
        line1: shipping.line1,
        city: shipping.city,
        countryCode: shipping.countryCode,
        line2: optional(shipping.line2),
        region: optional(shipping.region),
        postalCode: optional(shipping.postalCode),
      },
      items,
    });

    // Read back through the shared detail mapper rather than assembling the
    // response here, so the order a client receives on creation and the order it
    // receives on a later GET cannot drift apart.
    const detail = await getOrderDetail(placed.publicCode);
    if (detail === null) {
      // Unreachable: the row was written by this call. Answering 500 rather than
      // throwing keeps a bug in the read mapper from surfacing as a 200 with a
      // null body.
      return apiError(500, 'internal_error', 'An unexpected error occurred.');
    }

    const body = { data: detail };

    if (placed.replayed) {
      return json(body, { status: 200, headers: { 'Idempotent-Replay': 'true' } });
    }
    return json(body, {
      status: 201,
      headers: { Location: `/api/v1/orders/${placed.publicCode}` },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
