/**
 * Orders repository for workflows 3, 4, and 5 with explicit camelCase mapping.
 *
 * Reads and writes live together on purpose. The write path ends by reading the
 * order back through the same mapper the read path uses, so a `201` body and a
 * later `GET` of the same order cannot disagree -- which is the failure mode
 * when a create response is assembled by hand and a subtle field is forgotten.
 */
import { isPgError, query, transaction, type RunQuery, type SqlParam, type Tx } from '@/server/db/client';
import { HttpError } from '@/server/http/responses';
import type { Actor } from '@/server/auth/session';
import {
  FREE_SHIPPING_THRESHOLD_MINOR,
  SHIPPING_FLAT_MINOR,
  shippingMinorFor,
} from '@/lib/shipping';

export interface BuyerOrderSummary {
  readonly id: string;
  readonly publicCode: string;
  readonly sellerShopName: string;
  readonly sellerSlug: string;
  readonly status: string;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly totalMinor: number;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly shippingMinor: number;
  readonly itemCount: number;
  readonly totalQuantity: number;
  readonly placedAt: string;
  readonly acceptedAt: string | null;
  readonly paidAt: string | null;
  readonly shippedAt: string | null;
  readonly completedAt: string | null;
  readonly rejectedAt: string | null;
  readonly cancelledAt: string | null;
  readonly refundedAt: string | null;
}

export interface OrderItemDetail {
  readonly id: string;
  readonly productId: string;
  readonly nameSnapshot: string;
  readonly unitPriceMinor: number;
  readonly taxRateBp: number;
  readonly quantity: number;
  readonly lineTotalMinor: number;
  readonly lineTaxMinor: number;
}

export interface PaymentAttempt {
  readonly id: string;
  readonly amountMinor: number;
  readonly currencyCode: string;
  readonly state: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly succeededAt: string | null;
}

export interface FullOrderDetail {
  readonly order: BuyerOrderSummary & {
    readonly buyerName: string;
    readonly buyerEmail: string;
    readonly shippingName: string;
    readonly shippingLine1: string;
    readonly shippingCity: string;
    readonly shippingCountryCode: string;
    readonly idempotencyKey: string;
  };
  readonly items: readonly OrderItemDetail[];
  readonly payments: readonly PaymentAttempt[];
}

interface RawOrderSummaryRow {
  readonly id: string;
  readonly public_code: string;
  readonly seller_shop_name: string;
  readonly seller_slug: string;
  readonly status: string;
  readonly currency_code: string;
  readonly currency_exponent: number;
  readonly total_minor: number;
  readonly subtotal_minor: number;
  readonly tax_minor: number;
  readonly shipping_minor: number;
  readonly item_count: number;
  readonly total_quantity: number;
  readonly placed_at: string;
  readonly accepted_at: string | null;
  readonly paid_at: string | null;
  readonly shipped_at: string | null;
  readonly completed_at: string | null;
  readonly rejected_at: string | null;
  readonly cancelled_at: string | null;
  readonly refunded_at: string | null;
}

interface RawFullOrderHeaderRow extends RawOrderSummaryRow {
  readonly buyer_name: string;
  readonly buyer_email: string;
  readonly shipping_name: string;
  readonly shipping_line1: string;
  readonly shipping_city: string;
  readonly shipping_country_code: string;
  readonly idempotency_key: string;
}

interface RawOrderItemRow {
  readonly id: string;
  readonly product_id: string;
  readonly name_snapshot: string;
  readonly unit_price_minor: number;
  readonly tax_rate_bp: number;
  readonly quantity: number;
  readonly line_total_minor: number;
  readonly line_tax_minor: number;
}

interface RawPaymentRow {
  readonly id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly state: string;
  readonly provider: string;
  readonly provider_reference: string | null;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly succeeded_at: string | null;
}

function toOrderSummary(row: RawOrderSummaryRow): BuyerOrderSummary {
  return {
    id: row.id,
    publicCode: row.public_code,
    sellerShopName: row.seller_shop_name,
    sellerSlug: row.seller_slug,
    status: row.status,
    currencyCode: row.currency_code,
    currencyExponent: row.currency_exponent,
    totalMinor: Number(row.total_minor),
    subtotalMinor: Number(row.subtotal_minor),
    taxMinor: Number(row.tax_minor),
    shippingMinor: Number(row.shipping_minor),
    itemCount: Number(row.item_count),
    totalQuantity: Number(row.total_quantity),
    placedAt: row.placed_at,
    acceptedAt: row.accepted_at,
    paidAt: row.paid_at,
    shippedAt: row.shipped_at,
    completedAt: row.completed_at,
    rejectedAt: row.rejected_at,
    cancelledAt: row.cancelled_at,
    refundedAt: row.refunded_at,
  };
}

export async function listBuyerOrders(buyerId?: string): Promise<readonly BuyerOrderSummary[]> {
  const sql = `
    SELECT o.id,
           o.public_code,
           sp.shop_name          AS seller_shop_name,
           sp.slug               AS seller_slug,
           o.status,
           o.currency_code,
           c.exponent            AS currency_exponent,
           o.total_minor,
           o.subtotal_minor,
           o.tax_minor,
           o.shipping_minor,
           count(oi.id)::int     AS item_count,
           coalesce(sum(oi.quantity), 0)::int AS total_quantity,
           o.placed_at,
           o.accepted_at,
           o.paid_at,
           o.shipped_at,
           o.completed_at,
           o.rejected_at,
           o.cancelled_at,
           o.refunded_at
      FROM orders o
      JOIN seller_profiles sp ON sp.user_id = o.seller_id
      JOIN currencies c      ON c.code = o.currency_code
      LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ($1::uuid IS NULL OR o.buyer_id = $1)
     GROUP BY o.id, sp.shop_name, sp.slug, c.exponent
     ORDER BY o.placed_at DESC
     LIMIT 50;
  `;
  const { rows } = await query<RawOrderSummaryRow>(sql, [buyerId ?? null]);
  return rows.map(toOrderSummary);
}

export async function getSellerQueue(sellerId?: string): Promise<readonly BuyerOrderSummary[]> {
  const sql = `
    SELECT o.id,
           o.public_code,
           sp.shop_name          AS seller_shop_name,
           sp.slug               AS seller_slug,
           o.status,
           o.currency_code,
           c.exponent            AS currency_exponent,
           o.total_minor,
           o.subtotal_minor,
           o.tax_minor,
           o.shipping_minor,
           (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
           (SELECT coalesce(sum(oi.quantity), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS total_quantity,
           o.placed_at,
           o.accepted_at,
           o.paid_at,
           o.shipped_at,
           o.completed_at,
           o.rejected_at,
           o.cancelled_at,
           o.refunded_at
      FROM orders o
      JOIN seller_profiles sp ON sp.user_id = o.seller_id
      JOIN currencies c      ON c.code = o.currency_code
     WHERE ($1::uuid IS NULL OR o.seller_id = $1)
       AND o.status = 'pending'
     ORDER BY o.placed_at ASC, o.id ASC
     LIMIT 50;
  `;
  const { rows } = await query<RawOrderSummaryRow>(sql, [sellerId ?? null]);
  return rows.map(toOrderSummary);
}

export async function getOrderDetail(orderIdOrCode: string): Promise<FullOrderDetail | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(orderIdOrCode);
  const headerSql = `
    SELECT o.id,
           o.public_code,
           u.full_name           AS buyer_name,
           u.email               AS buyer_email,
           sp.shop_name          AS seller_shop_name,
           sp.slug               AS seller_slug,
           o.status,
           o.currency_code,
           c.exponent            AS currency_exponent,
           o.total_minor,
           o.subtotal_minor,
           o.tax_minor,
           o.shipping_minor,
           o.shipping_name,
           o.shipping_line1,
           o.shipping_city,
           o.shipping_country_code,
           o.idempotency_key,
           o.placed_at,
           o.accepted_at,
           o.paid_at,
           o.shipped_at,
           o.completed_at,
           o.rejected_at,
           o.cancelled_at,
           o.refunded_at,
           0                     AS item_count,
           0                     AS total_quantity
      FROM orders o
      JOIN users u           ON u.id = o.buyer_id
      JOIN seller_profiles sp ON sp.user_id = o.seller_id
      JOIN currencies c      ON c.code = o.currency_code
     WHERE ${isUuid ? 'o.id = $1::uuid' : 'o.public_code = $1'}
     LIMIT 1;
  `;
  const { rows: headerRows } = await query<RawFullOrderHeaderRow>(headerSql, [orderIdOrCode]);
  const row = headerRows[0];
  if (!row) return null;

  const itemsSql = `
    SELECT oi.id,
           oi.product_id,
           oi.name_snapshot,
           oi.unit_price_minor,
           oi.tax_rate_bp,
           oi.quantity,
           oi.line_total_minor,
           oi.line_tax_minor
      FROM order_items oi
     WHERE oi.order_id = $1
     ORDER BY oi.created_at ASC;
  `;
  const { rows: itemRows } = await query<RawOrderItemRow>(itemsSql, [row.id]);

  const paymentsSql = `
    SELECT p.id,
           p.amount_minor,
           p.currency_code,
           p.state,
           p.provider,
           p.provider_reference,
           p.idempotency_key,
           p.created_at,
           p.succeeded_at
      FROM payments p
     WHERE p.order_id = $1
     ORDER BY p.created_at DESC;
  `;
  const { rows: paymentRows } = await query<RawPaymentRow>(paymentsSql, [row.id]);

  const summary = toOrderSummary(row);
  const items: OrderItemDetail[] = itemRows.map((item) => ({
    id: item.id,
    productId: item.product_id,
    nameSnapshot: item.name_snapshot,
    unitPriceMinor: Number(item.unit_price_minor),
    taxRateBp: item.tax_rate_bp,
    quantity: item.quantity,
    lineTotalMinor: Number(item.line_total_minor),
    lineTaxMinor: Number(item.line_tax_minor),
  }));

  const payments: PaymentAttempt[] = paymentRows.map((p) => ({
    id: p.id,
    amountMinor: Number(p.amount_minor),
    currencyCode: p.currency_code,
    state: p.state,
    provider: p.provider,
    providerReference: p.provider_reference,
    idempotencyKey: p.idempotency_key,
    createdAt: p.created_at,
    succeededAt: p.succeeded_at,
  }));

  return {
    order: {
      ...summary,
      buyerName: row.buyer_name,
      buyerEmail: row.buyer_email,
      shippingName: row.shipping_name,
      shippingLine1: row.shipping_line1,
      shippingCity: row.shipping_city,
      shippingCountryCode: row.shipping_country_code,
      idempotencyKey: row.idempotency_key,
      itemCount: items.length,
      totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    },
    items,
    payments,
  };
}

// ===========================================================================
// Write path
//
// Three rules govern everything below.
//
// 1. THE REQUEST NEVER SAYS WHAT THINGS COST. Prices, tax rates, product names
//    and currency are read from the database inside the same transaction that
//    writes the order. A checkout that accepts a client-supplied price is not a
//    checkout that computes a total, it is a function that takes the total as
//    input. The client sends ids and quantities and nothing else it could lie
//    about.
//
// 2. THE ARITHMETIC LIVES IN POSTGRESQL. Totals are computed by `tax_on()` in
//    the same statement that inserts the row, so the value written is the same
//    value the CHECK constraints and the deferred totals check will verify. A
//    JavaScript reimplementation of the tax rounding would be a second
//    definition of "tax", and the two would disagree at exactly the half-cent
//    cases the database was written to pin down.
//
// 3. THE STATE MACHINE IS NOT REIMPLEMENTED HERE. `placeOrder` writes a pending
//    order and `transitionOrder` issues one `UPDATE ... SET status`. Which edges
//    are legal, and who may take them, is answered by the guard trigger reading
//    `order_status_transitions`. If this file had its own list of transitions it
//    would be a second source of truth that could be right today and wrong
//    tomorrow, and the tests would pass against the wrong one.
// ===========================================================================

/** The `order_status` enum, in the database's own spelling. */
export const ORDER_STATUSES = [
  'pending',
  'accepted',
  'paid',
  'shipped',
  'completed',
  'rejected',
  'cancelled',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** `quantity_t` has an upper bound; a line that exceeded it would be a 422 from
 *  the domain, so it is refused here where the message can name the product. */
const MAX_LINE_QUANTITY = 999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShippingAddress {
  readonly name: string;
  readonly line1: string;
  readonly line2?: string | undefined;
  readonly city: string;
  readonly region?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly countryCode: string;
}

export interface OrderLineRequest {
  readonly productId: string;
  readonly quantity: number;
}

export interface PlaceOrderInput {
  readonly buyerId: string;
  readonly sellerId: string;
  readonly idempotencyKey: string;
  readonly shipping: ShippingAddress;
  readonly items: readonly OrderLineRequest[];
}

/**
 * What a completed checkout reports.
 *
 * Deliberately just the identity, not the order body. The caller reads the order
 * back with `getOrderDetail`, which is the same function a `GET` uses, so there
 * is exactly one place where an order becomes an API resource.
 */
export interface PlacedOrder {
  readonly id: string;
  readonly publicCode: string;
  /** True when the key had already been used and the stored order was returned. */
  readonly replayed: boolean;
}

/**
 * Publishes the caller's identity to the guard trigger.
 *
 * This is not a convenience and it is not optional. `guard_order_transition`
 * reads `app.actor_role` with a `COALESCE(..., 'system')` default, so a write
 * that forgets to set the GUC is not treated as an anonymous caller -- it is
 * treated as the most privileged actor in the model, and the edges reserved for
 * `system` (notably `accepted -> paid`, the one that takes money) become
 * reachable. Every path that writes to `orders` must call this first.
 *
 * The role is the caller's authenticated `users.role`, not a parameter. Note
 * what is therefore impossible: a user request can never present as `system`,
 * because no `users` row has that role. A wider `actor_role` is only reachable
 * from a trusted internal caller such as a payment webhook.
 */
async function setActor(tx: Tx, role: Actor['role'], actorId: string): Promise<void> {
  await tx.query(
    `SELECT set_config('app.actor_id', $1, true), set_config('app.actor_role', $2, true)`,
    [actorId, role]
  );
}

/**
 * Collapses repeated product ids into one line.
 *
 * `order_items_one_line_per_product` is UNIQUE (order_id, product_id), so a
 * client that sends the same product twice cannot be allowed to create two
 * lines. Merging here turns that into a success; leaving it to the index turns
 * it into a 409 that looks like a conflict with somebody else's order. The
 * merged total is then checked against `quantity_t`, which is where a genuine
 * over-large line is caught.
 */
function aggregateBasket(
  items: readonly OrderLineRequest[]
): Map<string, number> {
  const basket = new Map<string, number>();
  for (const line of items) {
    const merged = (basket.get(line.productId) ?? 0) + line.quantity;
    if (merged > MAX_LINE_QUANTITY) {
      throw new HttpError(
        422,
        'quantity_too_large',
        `A single line may not exceed ${MAX_LINE_QUANTITY} units.`,
        { [line.productId]: `Maximum ${MAX_LINE_QUANTITY} units per line.` }
      );
    }
    basket.set(line.productId, merged);
  }
  return basket;
}

/**
 * A stable string for "what did this buyer ask for".
 *
 * Only product ids and quantities go in. Prices are deliberately excluded: a
 * buyer who retries next week, after the seller has changed a price, must still
 * be recognised as retrying the *same* basket. Comparing anything derived from
 * current prices would tell them their key was reused for a different order
 * when the only thing that changed was the catalogue.
 */
function basketFingerprint(basket: ReadonlyMap<string, number>): string {
  return [...basket.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId, quantity]) => `${productId}#${quantity}`)
    .join(',');
}

interface PriorOrder {
  readonly id: string;
  readonly publicCode: string;
  readonly fingerprint: string;
}

/**
 * Looks up a buyer's order for an idempotency key, with its lines folded into
 * the same fingerprint format the request side produces.
 *
 * The concatenation is done in SQL rather than by a second round trip and a
 * `Map` because the two sides must agree byte for byte, and a comparison that
 * depends on both sides being built the same way is a comparison that breaks
 * when one of them is edited.
 */
async function findOrderByKey(
  run: RunQuery,
  buyerId: string,
  idempotencyKey: string
): Promise<PriorOrder | null> {
  const { rows } = await run<{
    id: string;
    public_code: string;
    fingerprint: string;
  }>(
    `SELECT o.id,
            o.public_code,
            coalesce(
              (SELECT string_agg(oi.product_id::text || '#' || oi.quantity::text, ','
                                  ORDER BY oi.product_id::text)
                 FROM order_items oi
                WHERE oi.order_id = o.id),
              ''
            ) AS fingerprint
       FROM orders o
      WHERE o.buyer_id = $1::uuid
        AND o.idempotency_key = $2
      LIMIT 1`,
    [buyerId, idempotencyKey]
  );

  const row = rows[0];
  return row === undefined
    ? null
    : { id: row.id, publicCode: row.public_code, fingerprint: row.fingerprint };
}

function assertSameBasket(prior: PriorOrder, basket: ReadonlyMap<string, number>): void {
  if (prior.fingerprint !== basketFingerprint(basket)) {
    throw new HttpError(
      409,
      'idempotency_key_reused',
      'This idempotency key was already used for a different basket. ' +
        'Use a new key for a new basket, or retry with the original basket.'
    );
  }
}

/**
 * Confirms the seller exists and is trading.
 *
 * A separate check rather than a foreign-key failure, because "you cannot buy
 * from a suspended shop" is a decision the buyer needs explained and a 409
 * `foreign_key_violation` on `orders_seller_id` is not. The database would still
 * have refused the write either way; this only decides what the caller is told.
 */
async function assertSellerTrading(tx: Tx, sellerId: string): Promise<void> {
  const { rows } = await tx.query<{ status: string }>(
    `SELECT status::text
       FROM seller_profiles
      WHERE user_id = $1::uuid`,
    [sellerId]
  );

  const row = rows[0];
  if (row === undefined) {
    throw new HttpError(422, 'not_a_seller', 'The seller in this order does not sell anything.');
  }
  if (row.status !== 'active') {
    throw new HttpError(
      422,
      'seller_suspended',
      'This seller is not currently accepting orders.'
    );
  }
}

interface RawBasketRow {
  readonly id: string;
  readonly seller_id: string;
  readonly status: string;
  readonly currency_code: string;
  readonly stock_policy: string;
  readonly stock_quantity: number | null;
}

/**
 * Reads the products the buyer asked for, and refuses anything not purchasable.
 *
 * `FOR UPDATE` is load-bearing. The two statements that follow re-derive prices
 * from `products`, and without the row lock a seller could edit a price in the
 * window between this read and the insert -- producing an order whose stored
 * total reflects neither the price the buyer was shown nor the price the seller
 * set. Holding the lock makes the whole checkout serialise on the products it
 * touches, which is the granularity a checkout genuinely needs.
 *
 * Stock is checked but not decremented. The decision is about where a
 * decrement belongs, and the schema already answers it: the
 * `pending -> accepted` edge is documented as "Seller confirms stock and accepts
 * the order", so stock is committed by the seller, not by the buyer's basket.
 * Decrementing here would have to be undone on `rejected` and on every
 * cancellation of an accepted order, and doing that with an `UPDATE` per
 * outcome is how stock levels start lying. A ledger that records every movement
 * is the right answer and it is a schema change, not a line of code, so this
 * endpoint validates availability -- which is the part that stops the harm --
 * and leaves the accounting to the transition that is specified to perform it.
 */
async function assertBasketPurchasable(
  tx: Tx,
  sellerId: string,
  basket: ReadonlyMap<string, number>
): Promise<void> {
  const ids = [...basket.keys()].sort();
  const { rows } = await tx.query<RawBasketRow>(
    `SELECT p.id,
            p.seller_id,
            p.status::text,
            p.currency_code,
            p.stock_policy::text,
            p.stock_quantity
       FROM products p
      WHERE p.id = ANY($1::uuid[])
      ORDER BY p.id
        FOR UPDATE`,
    [[...ids]]
  );

  const found = new Map(rows.map((row) => [row.id, row]));

  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HttpError(422, 'product_not_found', 'One or more products do not exist.', {
      ...Object.fromEntries(missing.map((id) => [id, 'No such product.'])),
    });
  }

  const unavailable = ids.filter((id) => found.get(id)!.status !== 'active');
  if (unavailable.length > 0) {
    throw new HttpError(
      422,
      'product_unavailable',
      'One or more products are not currently on sale.',
      Object.fromEntries(unavailable.map((id) => [id, 'Not available for purchase.']))
    );
  }

  const wrongSeller = ids.filter((id) => found.get(id)!.seller_id !== sellerId);
  if (wrongSeller.length > 0) {
    // One order belongs to one seller, so a basket spanning two shops has to be
    // split into two orders. Saying so is more useful than a generic conflict.
    throw new HttpError(
      422,
      'mixed_sellers',
      'Every product in an order must belong to the same seller.',
      Object.fromEntries(wrongSeller.map((id) => [id, 'Belongs to a different seller.']))
    );
  }

  // The order stores one currency. Mixing two would leave `total_minor`
  // meaningless, since the components would not be comparable -- and would need
  // an exchange rate, which this model deliberately has no column for.
  const currencies = new Set(rows.map((row) => row.currency_code));
  if (currencies.size > 1) {
    throw new HttpError(422, 'mixed_currencies', 'All products in an order must be priced in the same currency.');
  }

  const short: Record<string, string> = {};
  for (const [id, quantity] of basket) {
    const product = found.get(id)!;
    if (product.stock_policy !== 'tracked') continue;
    const available = product.stock_quantity ?? 0;
    if (quantity > available) {
      short[id] = `Only ${available} available.`;
    }
  }
  if (Object.keys(short).length > 0) {
    // 409 rather than 422: the request is well-formed, it conflicts with the
    // current state of the product. The same basket may succeed later, which is
    // the distinction a client needs in order to decide whether to retry.
    throw new HttpError(409, 'insufficient_stock', 'Not enough stock to fill this order.', {
      ...short,
    });
  }
}

/** Renders the basket as a SQL `VALUES` list, continuing the parameter numbering. */
function basketValues(
  basket: ReadonlyMap<string, number>,
  firstParam: number
): { readonly sql: string; readonly params: SqlParam[] } {
  const rows: string[] = [];
  const params: SqlParam[] = [];
  let n = firstParam;
  for (const [productId, quantity] of [...basket.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    rows.push(`($${n}::uuid, $${n + 1}::int)`);
    params.push(productId, quantity);
    n += 2;
  }
  return { sql: rows.join(', '), params };
}

interface CreatedOrder {
  readonly id: string;
  readonly publicCode: string;
}

/**
 * Inserts the order header, with its totals computed in the same statement.
 *
 * The shipping rule is a `CASE` over the subtotal rather than a value computed
 * in JavaScript, because the subtotal is only known here -- it comes out of the
 * aggregate over the lines. The constants travel as parameters, so the policy
 * lives in TypeScript and the arithmetic lives in SQL, which is the split that
 * keeps the two from having to agree about rounding.
 *
 * `min(currency_code)` is safe rather than clever: `assertBasketPurchasable`
 * has already refused a basket with two currencies, and the per-line trigger
 * re-checks each line against the order afterwards. Taking the currency from the
 * lines means the order cannot end up in a currency none of its products use.
 */
async function insertOrder(
  tx: Tx,
  input: PlaceOrderInput,
  basket: ReadonlyMap<string, number>
): Promise<CreatedOrder> {
  const params: SqlParam[] = [input.buyerId, input.sellerId];
  const values = basketValues(basket, params.length + 1);
  params.push(...values.params);

  // `params.length` is the number of parameters pushed so far, so the next
  // placeholder is one past it. Off by one here and the statement silently binds
  // the last address field to a basket quantity -- which the database reports
  // only as "supplies 14 parameters, but the statement requires 13", so the
  // offset has to be derived rather than eyeballed.
  const addressStart = params.length + 1;
  const s = input.shipping;
  params.push(
    s.name,
    s.line1,
    s.line2 ?? null,
    s.city,
    s.region ?? null,
    s.postalCode ?? null,
    s.countryCode,
    input.idempotencyKey,
    FREE_SHIPPING_THRESHOLD_MINOR,
    SHIPPING_FLAT_MINOR
  );
  const at = (offset: number): string => `$${addressStart + offset}`;
  // offset: 0 name, 1 line1, 2 line2, 3 city, 4 region, 5 postal, 6 country,
  //         7 idempotency key, 8 free-shipping threshold, 9 flat charge
  const charge = `CASE WHEN t.subtotal_minor >= ${at(8)}::bigint
                       THEN ${at(9)}::bigint
                       ELSE 0::bigint
                  END`;

  const { rows } = await tx.query<{ id: string; public_code: string }>(
    `WITH basket (product_id, quantity) AS (
       VALUES ${values.sql}
     ),
     lines AS (
       SELECT b.product_id,
              b.quantity,
              p.price_minor,
              p.tax_rate_bp,
              p.currency_code,
              (p.price_minor * b.quantity)::minor_units AS line_total_minor
         FROM basket b
         JOIN products p ON p.id = b.product_id
     ),
     totals AS (
       SELECT min(currency_code)                                 AS currency_code,
              coalesce(sum(line_total_minor), 0)::bigint         AS subtotal_minor,
              coalesce(sum(tax_on(line_total_minor, tax_rate_bp)), 0)::bigint AS tax_minor
         FROM lines
     )
     INSERT INTO orders (
       buyer_id, seller_id, status, currency_code,
       subtotal_minor, tax_minor, shipping_minor, total_minor,
       shipping_name, shipping_line1, shipping_line2, shipping_city,
       shipping_region, shipping_postal_code, shipping_country_code,
       idempotency_key
     )
     SELECT $1::uuid,
            $2::uuid,
            'pending',
            t.currency_code,
            t.subtotal_minor,
            t.tax_minor,
            ${charge},
            t.subtotal_minor + t.tax_minor + ${charge},
            ${at(0)}, ${at(1)}, ${at(2)}, ${at(3)},
            ${at(4)}, ${at(5)}, ${at(6)},
            ${at(7)}
       FROM totals t
     RETURNING id, public_code`,
    params
  );

  const row = rows[0];
  if (row === undefined) throw new Error('order insert returned no row');
  return { id: row.id, publicCode: row.public_code };
}

/**
 * Inserts the lines, again with the arithmetic left to the database.
 *
 * `line_tax_minor` is `tax_on(...)` rather than the order-level tax apportioned
 * across lines. That is the point of storing it per line: the order total is the
 * sum of independently-rounded line taxes, not a tax on the sum. Rounding once
 * at the total and distributing it afterwards produces a different number, and
 * the two only agree when every line happens to divide evenly -- which is why
 * `order_items_line_tax_identity` is a constraint rather than a convention.
 */
async function insertOrderItems(
  tx: Tx,
  orderId: string,
  basket: ReadonlyMap<string, number>
): Promise<void> {
  const params: SqlParam[] = [orderId];
  const values = basketValues(basket, params.length + 1);
  params.push(...values.params);

  await tx.query(
    `WITH basket (product_id, quantity) AS (
       VALUES ${values.sql}
     ),
     lines AS (
       SELECT b.product_id,
              b.quantity,
              p.name           AS name_snapshot,
              p.price_minor,
              p.tax_rate_bp,
              (p.price_minor * b.quantity)::minor_units AS line_total_minor
         FROM basket b
         JOIN products p ON p.id = b.product_id
     )
     INSERT INTO order_items (
       order_id, product_id, name_snapshot, unit_price_minor,
       tax_rate_bp, quantity, line_total_minor, line_tax_minor
     )
     SELECT $1::uuid,
            l.product_id,
            l.name_snapshot,
            l.price_minor,
            l.tax_rate_bp,
            l.quantity,
            l.line_total_minor,
            tax_on(l.line_total_minor, l.tax_rate_bp)
       FROM lines l`,
    params
  );
}

/**
 * Places an order, or returns the one this idempotency key already placed.
 *
 * The order of the operations inside the transaction is the interesting part.
 * The idempotency lookup runs *first*, before the basket is validated, because
 * validating first would break the exact case idempotency exists for. A buyer
 * who submits a basket, loses the response, and retries an hour later must get
 * their original order back; if the seller archived one of the products in the
 * meantime, a validate-first implementation answers `product_unavailable` and
 * tells the buyer their order does not exist when it does and is sitting in the
 * seller's queue.
 *
 * The lookup is not the only line of defence. Between the probe and the insert
 * another request carrying the same key can commit, and the unique index on
 * (buyer_id, idempotency_key) is what settles that race -- so the losing
 * transaction is caught outside, and re-read as a replay. Probing alone would
 * have two concurrent retries both decide they are first, and one of them would
 * take a 409 for something the client did correctly.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlacedOrder> {
  const basket = aggregateBasket(input.items);
  if (basket.size === 0) {
    throw new HttpError(422, 'empty_basket', 'An order must contain at least one item.');
  }

  try {
    return await transaction(async (tx) => {
      await setActor(tx, 'buyer', input.buyerId);

      const prior = await findOrderByKey(tx.query, input.buyerId, input.idempotencyKey);
      if (prior !== null) {
        assertSameBasket(prior, basket);
        return { id: prior.id, publicCode: prior.publicCode, replayed: true };
      }

      await assertSellerTrading(tx, input.sellerId);
      await assertBasketPurchasable(tx, input.sellerId, basket);

      const created = await insertOrder(tx, input, basket);
      await insertOrderItems(tx, created.id, basket);
      return { id: created.id, publicCode: created.publicCode, replayed: false };
    });
  } catch (error) {
    // The unique index, not the probe above, is the real arbiter of concurrent
    // retries. Reaching here means somebody committed the same key first, so
    // this is a successful retry rather than a conflict -- and the transaction
    // has already rolled back, which is what makes it safe to read again.
    if (isPgError(error) && error.constraint === 'orders_buyer_idempotency_key') {
      const prior = await findOrderByKey(query, input.buyerId, input.idempotencyKey);
      if (prior !== null) {
        assertSameBasket(prior, basket);
        return { id: prior.id, publicCode: prior.publicCode, replayed: true };
      }
    }
    throw error;
  }
}

export interface TransitionInput {
  readonly orderIdOrCode: string;
  readonly to: OrderStatus;
  readonly actor: Actor;
}

export interface TransitionResult {
  readonly publicCode: string;
  readonly status: OrderStatus;
  readonly previousStatus: OrderStatus;
  /** False for a request to move an order to the state it is already in. */
  readonly changed: boolean;
}

/**
 * Advances an order through the state machine.
 *
 * The statement sets one column and returns. It does not check whether the edge
 * exists, does not check the caller's role against the order, and does not stamp
 * the lifecycle timestamp -- `guard_order_transition` does all three, and any
 * second implementation here would be the one the tests happened to agree with.
 *
 * A self-transition is a success that changes nothing, and reports
 * `changed: false`. That is the trigger's own contract, and it is the right one
 * for a client: a PATCH that is retried after a timeout should be safe, and a
 * 409 for "it is already accepted" would turn every retry into an error the
 * caller has to special-case. `order_status_transitions` also has no self-edges
 * to find, so the guard returns before it looks for one.
 */
export async function transitionOrder(
  input: TransitionInput
): Promise<TransitionResult | null> {
  const isUuid = UUID_RE.test(input.orderIdOrCode);

  return transaction(async (tx) => {
    await setActor(tx, input.actor.role, input.actor.id);

    const { rows, affectedRows } = await tx.query<{
      public_code: string;
      status: string;
      previous_status: string;
    }>(
      `WITH current AS (
         SELECT o.id, o.status
           FROM orders o
          WHERE ${isUuid ? 'o.id = $1::uuid' : 'o.public_code = $1'}
            FOR UPDATE
       )
       UPDATE orders o
          SET status = $2::order_status
         FROM current c
        WHERE o.id = c.id
       RETURNING o.public_code, o.status::text, c.status::text AS previous_status`,
      [input.orderIdOrCode, input.to]
    );

    if (affectedRows === 0) return null;

    const row = rows[0]!;
    return {
      publicCode: row.public_code,
      status: row.status as OrderStatus,
      previousStatus: row.previous_status as OrderStatus,
      changed: row.previous_status !== row.status,
    };
  });
}

/**
 * The shipping a basket of this subtotal owes.
 *
 * Exported so a caller that needs to explain the charge can read it from the
 * same rule the insert used, rather than restating the threshold and getting it
 * subtly wrong for a basket that sits exactly on the boundary.
 */
export { shippingMinorFor };


