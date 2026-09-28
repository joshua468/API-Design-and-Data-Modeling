/**
 * Contract tests for the two order write endpoints.
 *
 * WHAT THESE TESTS ARE FOR
 *
 * The state machine is not being tested here. `scripts/verify-constraints.ts`
 * already proves, at the database, that every illegal edge is refused and every
 * legal one is allowed. Re-proving it in TypeScript would be worse than
 * redundant: it would establish a second source of truth, and the suite would
 * then be able to pass against a rule the database no longer enforces.
 *
 * So the question these ask is the one the constraint proofs cannot: given a
 * valid transition, does the API *make the call correctly*? Concretely --
 *
 *   - it publishes the caller's identity so the trigger sees the right party
 *     rather than an anonymous one;
 *   - it takes prices from the database rather than from the request;
 *   - it returns the statuses and error codes it promises;
 *   - it reports the same order on a retry instead of creating a second.
 *
 * THE TEST THAT LOOKES LIKE A CONSTRAINT PROOF
 *
 * `accepted -> paid` is refused here for every human role. That is deliberate
 * overlap with the database suite, and it is here for a reason the SQL proofs
 * cannot check: `system` is an `actor_role` that no `users` row carries, and the
 * guard trigger defaults an *unset* `app.actor_role` to `system`. An API that
 * failed to identify its caller would therefore be handed the most privileged
 * role in the model, including the one edge that takes money. Nothing at the
 * database can tell whether the application is the thing that would have let
 * that through; only driving the endpoint as buyer, seller and admin can.
 *
 * FIXTURES
 *
 * These tests commit, because the endpoint under test commits -- and wrapping
 * the route in a rolled-back transaction is not possible against a
 * single-connection handle, where an outer BEGIN makes the route's own COMMIT
 * release the outer transaction too. Faking it would mean never exercising the
 * real commit path. Cleanup is therefore explicit: a dedicated buyer per file
 * whose orders are deleted afterwards, plus two products this file creates and
 * removes. Seeded rows are never modified, and every seeded fixture is resolved
 * by slug rather than by id, so re-seeding does not silently invalidate the
 * suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as placeOrderRoute } from '@/app/api/v1/orders/route';
import { PATCH as transitionRoute } from '@/app/api/v1/orders/[id]/transition/route';
import { SESSION_COOKIE, signSession } from '@/server/auth/session';
import { query } from '@/server/db/client';

/** Exactly as the row comes back: `RETURNING` cannot alias, so the mapping is
 *  explicit rather than a set of aliased columns that only some queries have. */
interface RawProduct {
  readonly id: string;
  readonly seller_id: string;
  readonly name: string;
  readonly price_minor: number;
  readonly tax_rate_bp: number;
  readonly stock_quantity: number | null;
}

interface Product {
  readonly id: string;
  readonly sellerId: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly taxRateBp: number;
  readonly stockQuantity: number | null;
}

/**
 * One mapper for every product the suite reads.
 *
 * The point of naming the raw shape separately is that `RETURNING` hands back
 * column names, so a fixture typed as `Product` but populated straight from a
 * query silently fills `sellerId: undefined`. That is not hypothetical: it is
 * how this file first inserted a product with a NULL seller, and the schema
 * refused the write with a message about a seller who did not exist.
 */
const toProduct = (row: RawProduct): Product => ({
  id: row.id,
  sellerId: row.seller_id,
  name: row.name,
  priceMinor: row.price_minor,
  taxRateBp: row.tax_rate_bp,
  stockQuantity: row.stock_quantity,
});

interface OrderBody {
  readonly order: {
    readonly id: string;
    readonly publicCode: string;
    readonly status: string;
    readonly acceptedAt: string | null;
    readonly subtotalMinor: number;
    readonly taxMinor: number;
    readonly shippingMinor: number;
    readonly totalMinor: number;
  };
  readonly items: ReadonlyArray<{
    readonly productId: string;
    readonly nameSnapshot: string;
    readonly unitPriceMinor: number;
    readonly taxRateBp: number;
    readonly quantity: number;
    readonly lineTotalMinor: number;
    readonly lineTaxMinor: number;
  }>;
}

let buyerId = '';
let otherBuyerId = '';
let adminId = '';
/** The seller that owns `scratchProduct`; the default seller for most tests. */
let primarySellerId = '';
/** Lagos Leatherworks. A real, active seller used as "somebody else's shop". */
let leatherSellerId = '';
/** Port Harcourt Spice Traders, for the free-shipping-below-threshold case. */
let spiceSellerId = '';
let suspendedSellerId = '';
let product: Product;
let secondProduct: Product;
let draftProduct: Product;
let spiceProduct: Product;
let ceramicsProduct: Product;
let scratchProduct: Product;
let usdProduct: Product;

let keyCounter = 0;
const nextKey = (): string => `test-key-${process.pid}-${(keyCounter += 1)}`;

const bySlug = async (slug: string): Promise<Product> => {
  const { rows } = await query<RawProduct>(
    `SELECT p.id, p.seller_id, p.name, p.price_minor, p.tax_rate_bp, p.stock_quantity
       FROM products p
      WHERE p.slug = $1`,
    [slug]
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`the seed has no product "${slug}"`);
  return toProduct(row);
};

const one = async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
  const { rows } = await query<T>(sql, params as never[]);
  const row = rows[0];
  if (row === undefined) throw new Error(`fixture query returned nothing: ${sql.slice(0, 60)}`);
  return row;
};

function authed(userId: string | null, headers: Record<string, string>): RequestInit {
  return {
    headers: {
      'content-type': 'application/json',
      ...(userId === null ? {} : { cookie: `${SESSION_COOKIE}=${signSession(userId)}` }),
      ...headers,
    },
  };
}

function post(body: unknown, userId: string | null = buyerId, key = nextKey()): Request {
  return new Request('http://localhost:4321/api/v1/orders', {
    method: 'POST',
    ...authed(userId, { 'idempotency-key': key }),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function patch(id: string, to: string, userId: string | null = buyerId): Promise<Response> {
  return transitionRoute(
    new Request(`http://localhost:4321/api/v1/orders/${id}/transition`, {
      method: 'PATCH',
      ...authed(userId, {}),
      body: JSON.stringify({ to }),
    }),
    { params: Promise.resolve({ id }) }
  );
}

const ADDRESS = {
  name: 'Adaeze Okonkwo',
  line1: '14 Marina Road',
  city: 'Lagos',
  countryCode: 'NG',
};

const basket = (
  items: ReadonlyArray<{ productId: string; quantity: number }>,
  seller = primarySellerId
) => ({ sellerId: seller, shipping: ADDRESS, items });

/** Places an order and insists it succeeded, so each test starts from an order. */
async function place(
  items: ReadonlyArray<{ productId: string; quantity: number }>,
  seller = primarySellerId
): Promise<OrderBody> {
  const response = await placeOrderRoute(post(basket(items, seller)));
  expect(`place order: ${response.status}`).toBe('place order: 201');
  const body = (await response.json()) as { data: OrderBody };
  return body.data;
}

beforeAll(async () => {
  const { rows: buyer } = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, role, password_hash)
     VALUES ($1, 'Orders Test Buyer', 'buyer', repeat('x', 32))
     RETURNING id`,
    [`orders-test-a-${process.pid}@example.test`]
  );
  buyerId = buyer[0]!.id;

  const { rows: second } = await query<{ id: string }>(
    `INSERT INTO users (email, full_name, role, password_hash)
     VALUES ($1, 'Orders Test Buyer Two', 'buyer', repeat('x', 32))
     RETURNING id`,
    [`orders-test-b-${process.pid}@example.test`]
  );
  otherBuyerId = second[0]!.id;

  adminId = await one<{ id: string }>(
    `SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL`
  ).then((r) => r.id);

  product = await bySlug('obi-leather-tote');
  secondProduct = await bySlug('danfo-card-holder');
  draftProduct = await bySlug('ile-ife-passport-cover');
  spiceProduct = await bySlug('calabar-bonny-pepper');
  ceramicsProduct = await bySlug('kaduna-stone-mug');
  leatherSellerId = product.sellerId;
  spiceSellerId = spiceProduct.sellerId;
  suspendedSellerId = await one<{ user_id: string }>(
    `SELECT user_id FROM seller_profiles WHERE slug = 'kaduna-textile-co'`
  ).then((r) => r.user_id);

  // Two products this file owns, both belonging to the same seller:
  //
  //   scratch -- an ordinary NGN listing, used wherever a test needs an active
  //              product it is safe to archive and restore;
  //   usd     -- priced in a second currency, because the seeded catalogue is
  //              single-currency by design and without this the
  //              `mixed_currencies` refusal would never be exercised.
  const owner = ceramicsProduct.sellerId;
  primarySellerId = owner;
  const { rows: scratch } = await query<RawProduct>(
    `INSERT INTO products (
       seller_id, name, slug, description, category, price_minor,
       currency_code, tax_rate_bp, status, stock_policy, stock_quantity
     ) VALUES (
       $1, 'Test NGN Item', 'test-ngn-item',
       'A fixture product created by the order write contract tests.',
       'ceramics', 145000, 'NGN', 0, 'active', 'tracked', 50
     )
     RETURNING id, seller_id, name, price_minor, tax_rate_bp, stock_quantity`,
    [owner]
  );
  scratchProduct = toProduct(scratch[0]!);

  const { rows: usd } = await query<RawProduct>(
    `INSERT INTO products (
       seller_id, name, slug, description, category, price_minor,
       currency_code, tax_rate_bp, status, stock_policy, stock_quantity
     ) VALUES (
       $1, 'Test USD Item', 'test-usd-item',
       'A fixture product priced in a currency the rest of the catalogue does not use.',
       'ceramics', 10000, 'USD', 750, 'active', 'tracked', 50
     )
     RETURNING id, seller_id, name, price_minor, tax_rate_bp, stock_quantity`,
    [owner]
  );
  usdProduct = toProduct(usd[0]!);
});

afterAll(async () => {
  // Order matters. `order_items.product_id` references the products, and
  // `orders.buyer_id` references the users, so the orders have to go first.
  // Deleting the products before the orders fails the foreign key and leaves the
  // fixtures behind, which then makes the next run fail in `beforeAll` for
  // reasons that have nothing to do with the test that is running.
  for (const id of [buyerId, otherBuyerId]) {
    await query(`DELETE FROM orders WHERE buyer_id = $1::uuid`, [id]);
  }
  await query(`DELETE FROM products WHERE slug IN ('test-ngn-item', 'test-usd-item')`);
  for (const id of [buyerId, otherBuyerId]) {
    await query(`DELETE FROM users WHERE id = $1::uuid`, [id]);
  }
});

describe('POST /api/v1/orders', () => {
  it('refuses an unauthenticated request with 401', async () => {
    const response = await placeOrderRoute(post(basket([]), null));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthenticated');
  });

  it('refuses a session cookie this server did not sign', async () => {
    // The signature is what makes a session an authentication mechanism. Without
    // it this module would be "impersonate anyone by sending their uuid".
    const response = await placeOrderRoute(
      post(basket([{ productId: scratchProduct.id, quantity: 1 }]), null)
    );
    // Same request as below but with a forged value in place of a signed one.
    expect(response.status).toBe(401);

    const forged = await placeOrderRoute(
      new Request('http://localhost:4321/api/v1/orders', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': nextKey(),
          cookie: `${SESSION_COOKIE}=${buyerId}.forged-signature`,
        },
        body: JSON.stringify(basket([{ productId: scratchProduct.id, quantity: 1 }])),
      })
    );
    expect(forged.status).toBe(401);
  });

  it('requires an Idempotency-Key header', async () => {
    const response = await placeOrderRoute(
      new Request('http://localhost:4321/api/v1/orders', {
        method: 'POST',
        ...authed(buyerId, {}),
        body: JSON.stringify(basket([{ productId: scratchProduct.id, quantity: 1 }])),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('rejects a body that is not JSON', async () => {
    const response = await placeOrderRoute(
      post('{ not json', buyerId)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('rejects a fractional quantity rather than rounding it', async () => {
    const response = await placeOrderRoute(
      post(basket([{ productId: scratchProduct.id, quantity: 1.5 }]))
    );
    expect(response.status).toBe(400);
  });

  it('creates a pending order and points Location at it', async () => {
    const response = await placeOrderRoute(
      post(basket([{ productId: scratchProduct.id, quantity: 2 }]))
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as { data: OrderBody };
    expect(response.headers.get('location')).toBe(
      `/api/v1/orders/${body.data.order.publicCode}`
    );
    expect(body.data.order.status).toBe('pending');
    expect(body.data.order.publicCode).toMatch(/^ORD-[0-9A-HJ-NP-Z]{6}$/);
  });

  it('takes every price and tax rate from the database, not the request', async () => {
    // The body may only carry ids and quantities -- the schema has no place for
    // a price, so there is nothing in it for a caller to lie with. The assertion
    // is that the returned figures are the stored ones and that the line
    // arithmetic holds line by line.
    const data = await place(
      [
        { productId: product.id, quantity: 2 },
        { productId: secondProduct.id, quantity: 3 },
      ],
      leatherSellerId
    );

    const stored = await one<{
      subtotal_minor: number;
      tax_minor: number;
      shipping_minor: number;
      total_minor: number;
    }>(
      `SELECT subtotal_minor, tax_minor, shipping_minor, total_minor
         FROM orders WHERE id = $1::uuid`,
      [data.order.id]
    );

    expect(data.order.subtotalMinor).toBe(Number(stored.subtotal_minor));
    expect(data.order.taxMinor).toBe(Number(stored.tax_minor));
    expect(data.order.shippingMinor).toBe(Number(stored.shipping_minor));
    expect(data.order.totalMinor).toBe(Number(stored.total_minor));
    expect(data.order.totalMinor).toBe(
      data.order.subtotalMinor + data.order.taxMinor + data.order.shippingMinor
    );

    for (const line of data.items) {
      expect(line.lineTotalMinor).toBe(line.unitPriceMinor * line.quantity);
      expect(line.lineTaxMinor).toBe(
        Math.round((line.lineTotalMinor * line.taxRateBp) / 10_000)
      );
    }
    expect(data.items.map((l) => l.unitPriceMinor).sort((a, b) => a - b)).toEqual(
      [product.priceMinor, secondProduct.priceMinor].sort((a, b) => a - b)
    );
  });

  it('charges flat shipping above the threshold and nothing below it', async () => {
    const over = await place([{ productId: product.id, quantity: 1 }], leatherSellerId);
    expect(over.order.shippingMinor).toBe(250_000);

    // 2 x 145_000 = 290_000, under the 500_000 threshold.
    const under = await place(
      [{ productId: spiceProduct.id, quantity: 2 }],
      spiceSellerId
    );
    expect(under.order.subtotalMinor).toBe(290_000);
    expect(under.order.shippingMinor).toBe(0);
  });

  it('returns the original order on a retry, creating no second order', async () => {
    const key = nextKey();
    const items = [{ productId: scratchProduct.id, quantity: 1 }];

    const first = await placeOrderRoute(post(basket(items), buyerId, key));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: OrderBody };

    const second = await placeOrderRoute(post(basket(items), buyerId, key));
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    const secondBody = (await second.json()) as { data: OrderBody };
    expect(secondBody.data.order.id).toBe(firstBody.data.order.id);

    const count = await one<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM orders
        WHERE buyer_id = $1::uuid AND idempotency_key = $2`,
      [buyerId, key]
    );
    expect(count.count).toBe(1);
  });

  it('still replays after the product has been archived', async () => {
    // The regression this guards. Validating the basket before consulting
    // idempotency would answer `product_unavailable` to a buyer retrying an order
    // that already exists, and tell them it was never placed.
    const key = nextKey();
    const items = [{ productId: scratchProduct.id, quantity: 1 }];

    const first = await placeOrderRoute(post(basket(items), buyerId, key));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: OrderBody };

    // Archive only *after* the order exists. Archiving first would make the first
    // call a plain `product_unavailable` 422 and the test would prove nothing
    // about replay.
    await query(`UPDATE products SET status = 'archived' WHERE id = $1::uuid`, [
      scratchProduct.id,
    ]);
    try {
      const second = await placeOrderRoute(post(basket(items), buyerId, key));
      expect(second.status).toBe(200);
      expect(second.headers.get('Idempotent-Replay')).toBe('true');
      const secondBody = (await second.json()) as { data: OrderBody };
      expect(secondBody.data.order.id).toBe(firstBody.data.order.id);
    } finally {
      await query(`UPDATE products SET status = 'active' WHERE id = $1::uuid`, [
        scratchProduct.id,
      ]);
    }
  });

  it('reports 409 when one key is reused for a different basket', async () => {
    const key = nextKey();
    await placeOrderRoute(post(basket([{ productId: scratchProduct.id, quantity: 1 }]), buyerId, key));

    const response = await placeOrderRoute(
      post(basket([{ productId: scratchProduct.id, quantity: 2 }]), buyerId, key)
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_key_reused');
  });

  it('merges repeated lines for one product into a single line', async () => {
    // `order_items_one_line_per_product` is UNIQUE (order_id, product_id), so a
    // client that sends the same product twice has to be merged rather than
    // refused with a conflict that looks like somebody else's order.
    const data = await place([
      { productId: scratchProduct.id, quantity: 1 },
      { productId: scratchProduct.id, quantity: 2 },
    ]);
    const lines = data.items.filter((line) => line.productId === scratchProduct.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(3);
  });

  it('reports 422 for a product that does not exist', async () => {
    const response = await placeOrderRoute(
      post(basket([{ productId: '00000000-0000-4000-8000-0000000000ff', quantity: 1 }]))
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(body.error.code).toBe('product_not_found');
    expect(Object.keys(body.error.fields ?? {})).toContain(
      '00000000-0000-4000-8000-0000000000ff'
    );
  });

  it('reports 422 for a draft product', async () => {
    const response = await placeOrderRoute(
      post(basket([{ productId: draftProduct.id, quantity: 1 }]))
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('product_unavailable');
  });

  it('reports 422 for a basket spanning two sellers', async () => {
    const response = await placeOrderRoute(
      post(
        basket(
          [
            { productId: scratchProduct.id, quantity: 1 },
            { productId: spiceProduct.id, quantity: 1 },
          ],
          primarySellerId
        )
      )
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mixed_sellers');
  });

  it('reports 422 for a basket mixing currencies', async () => {
    // Both products belong to the seller named in the body, so this reaches the
    // currency check rather than tripping the seller check first.
    const response = await placeOrderRoute(
      post(
        basket([
          { productId: ceramicsProduct.id, quantity: 1 },
          { productId: usdProduct.id, quantity: 1 },
        ])
      )
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('mixed_currencies');
  });

  it('reports 422 for a suspended seller', async () => {
    const response = await placeOrderRoute(
      post(basket([{ productId: product.id, quantity: 1 }], suspendedSellerId))
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('seller_suspended');
  });

  it('reports 409 when the basket exceeds available stock', async () => {
    const response = await placeOrderRoute(
      post(
        basket(
          [{ productId: product.id, quantity: (product.stockQuantity ?? 0) + 1 }],
          leatherSellerId
        )
      )
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('insufficient_stock');
  });

  it('refuses the admin account from checking out', async () => {
    const response = await placeOrderRoute(
      post(basket([{ productId: scratchProduct.id, quantity: 1 }]), adminId)
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_a_buyer');
  });
});

describe('PATCH /api/v1/orders/[id]/transition', () => {
  it('refuses an unauthenticated request with 401', async () => {
    const response = await patch('00000000-0000-4000-8000-0000000000ff', 'accepted', null);
    expect(response.status).toBe(401);
  });

  it('reports 404 for an order that does not exist', async () => {
    const response = await patch('00000000-0000-4000-8000-0000000000ff', 'accepted');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('order_not_found');
  });

  it('rejects an unknown status with 400', async () => {
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'teleported');
    expect(response.status).toBe(400);
  });

  it('lets the seller accept a pending order, and the trigger stamps the time', async () => {
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'accepted', primarySellerId);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: OrderBody & { transition: { to: string; from: string; changed: boolean } };
    };
    expect(body.data.order.status).toBe('accepted');
    expect(body.data.transition).toEqual({ to: 'accepted', from: 'pending', changed: true });
    // Stamping the lifecycle timestamp is the trigger's job. A handler that wrote
    // it would let a caller backdate an order's history.
    expect(body.data.order.acceptedAt).toBeTruthy();
  });

  it('accepts the human public code in place of the uuid', async () => {
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.publicCode, 'accepted', primarySellerId);
    expect(response.status).toBe(200);
  });

  it('reports 409, not 403, when the caller owns the order but the edge is not theirs', async () => {
    // The guard checks the edge before the identity: it looks for
    // (pending, accepted, 'buyer') in the transition table, finds nothing, and
    // stops. So a buyer asking to accept *their own* order is told the move does
    // not exist for them rather than that they are not permitted. That ordering is
    // the schema's, and it is the right one -- the message the buyer needs is
    // "accepting is the seller's move", not "you are not the seller".
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'accepted', buyerId);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('illegal_status_transition');
  });

  it('refuses a buyer who does not own the order with 403', async () => {
    // `pending -> cancelled` by a buyer is a real edge, so the guard gets past
    // the transition table and reaches the identity check, which is where 403
    // comes from. Cancelling is the right edge to test with: it exists for both
    // buyer and seller, so the refusal is unambiguously about *whose* order.
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'cancelled', otherBuyerId);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_your_order');
  });

  it('refuses a seller who does not own the order with 403', async () => {
    // `accepted` is the seller-owned edge, so the guard passes the transition
    // table and fails on identity. Cancelling would have been a 409 here: no
    // seller may cancel a pending order at all, which is a different fact.
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'accepted', leatherSellerId);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_your_order');
  });

  it('lets the buyer cancel their own pending order', async () => {
    // The control for the two refusals above. A suite that asserted only "403"
    // would also pass if every cancellation failed, which is the weakness the
    // constraint proofs call out for their own CONTROL cases.
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'cancelled', buyerId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { order: { status: string } } };
    expect(body.data.order.status).toBe('cancelled');
  });

  it('reports 409 for an edge the machine does not have', async () => {
    // pending -> shipped has no edge for anybody. The constraint proofs assert
    // that at the database; this asserts the refusal survives the trip through
    // the route as 409 rather than as a generic 422.
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    const response = await patch(data.order.id, 'shipped', primarySellerId);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; constraint?: string };
    };
    expect(body.error.code).toBe('illegal_status_transition');
    expect(body.error.constraint).toBe('orders_illegal_status_transition');
  });

  it('treats a self-transition as a no-op success rather than a conflict', async () => {
    // A PATCH retried after a timeout has to be safe. Answering 409 for "it is
    // already accepted" would make every retry a client-side special case.
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    expect((await patch(data.order.id, 'accepted', primarySellerId)).status).toBe(200);

    const again = await patch(data.order.id, 'accepted', primarySellerId);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { data: { transition: { changed: boolean } } };
    expect(body.data.transition.changed).toBe(false);
  });

  it('refuses accepted -> paid for every human role', async () => {
    const data = await place([{ productId: scratchProduct.id, quantity: 1 }]);
    expect((await patch(data.order.id, 'accepted', primarySellerId)).status).toBe(200);

    for (const [label, userId] of [
      ['buyer', buyerId],
      ['seller', primarySellerId],
      ['admin', adminId],
    ] as const) {
      const response = await patch(data.order.id, 'paid', userId);
      expect(`${label} -> ${response.status}`).toBe(`${label} -> 409`);
    }

    const row = await one<{ status: string }>(
      `SELECT status::text FROM orders WHERE id = $1::uuid`,
      [data.order.id]
    );
    expect(row.status).toBe('accepted');
  });
});
