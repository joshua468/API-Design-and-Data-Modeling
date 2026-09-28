/**
 * The marketplace demo dataset, written as a module with no imports.
 *
 * `scripts/seed.ts` (via node, which needs `.ts` suffixed specifiers) and
 * `src/server/db/bootstrap.ts` (via the Next/SWC compiler, which needs plain
 * specifiers) both execute this file. The only way one body of code can serve
 * both compilers is to import nothing at all: the two strings that differ
 * between the worlds -- the password hash and the shipping curve -- are passed
 * in as options instead.
 *
 * Everything else, including the deterministic ids, is byte-identical to the
 * dataset `scripts/verify-constraints.ts`, `scripts/run-queries.ts`, and the
 * `docs/evidence/` screenshots were produced against. Do not re-shape ids,
 * slugs, or the order scenarios here without regenerating that evidence.
 */
export interface SeedTx {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[]; affectedRows: number }>;
  exec(sql: string): Promise<void>;
}

export interface SeedDb extends SeedTx {
  transaction<T>(fn: (tx: SeedTx) => Promise<T>): Promise<T>;
}

export interface SeedOptions {
  passwordHash: string;
  shippingFor: (subtotalMinor: number) => number;
}

export interface SeedSummary {
  counts: { table_name: string; n: bigint }[];
  statuses: { status: string; n: bigint }[];
}

// ---------------------------------------------------------------------------
// Deterministic ids. Version 4, variant 8, with a readable tail: valid UUIDs
// that a human can point at in a log line.
// ---------------------------------------------------------------------------
const uuid = (n: number): string =>
  `a1b2c3d4-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const U = {
  admin: uuid(1),
  sellers: [uuid(10), uuid(11), uuid(12), uuid(13)],
  buyers: [uuid(20), uuid(21), uuid(22), uuid(23)],
} as const;

// Product ids 100..199, order ids 300..399. Line, payment and review ids come
// from their own counters so that a re-run produces byte-identical ids: no
// `random()` anywhere in the identity path, because the documentation's
// screenshots and EXPLAIN output reference specific rows.
let nextProduct = 100;
let nextOrder = 300;
let nextLine = 1000;
let nextPayment = 2000;
let nextReview = 3000;

interface ProductSpec {
  sellerIndex: number;
  name: string;
  slug: string;
  description: string;
  priceMinor: number;
  taxRateBp: number;
  category: string;
  status?: 'draft' | 'active' | 'archived';
  /** Tracked stock. Omit for an `unlimited` product, which stores no number. */
  stock?: number;
}

/** A spec that has been assigned its deterministic id, ready to be inserted. */
interface SeedProduct extends ProductSpec {
  id: string;
}

const PRODUCTS: ProductSpec[] = [
  // --- Seller 1: Lagos Leatherworks ---------------------------------------
  { sellerIndex: 0, name: 'Obi Leather Tote', slug: 'obi-leather-tote', category: 'leather-goods', priceMinor: 1_850_000, taxRateBp: 750, stock: 12, description: 'Vegetable-tanned leather tote with a reinforced base and brass hardware.' },
  { sellerIndex: 0, name: 'Danfo Card Holder', slug: 'danfo-card-holder', category: 'leather-goods', priceMinor: 425_000, taxRateBp: 750, stock: 40, description: 'Four-slot card holder cut from a single piece of shell cordovan.' },
  { sellerIndex: 0, name: 'Aso Oke Belt', slug: 'aso-oke-belt', category: 'leather-goods', priceMinor: 690_000, taxRateBp: 750, stock: 25, description: 'Hand-stitched belt with woven aso oke inlay.' },
  { sellerIndex: 0, name: 'Yoruba Grain Wallet', slug: 'yoruba-grain-wallet', category: 'leather-goods', priceMinor: 1_150_000, taxRateBp: 750, stock: 8, description: 'Long wallet with six card slots and a full-width bill compartment.' },
  { sellerIndex: 0, name: 'Adire Tote (Archived)', slug: 'adire-tote-archived', category: 'leather-goods', priceMinor: 2_400_000, taxRateBp: 750, stock: 0, status: 'archived', description: 'Discontinued seasonal run. Kept for order history.' },
  { sellerIndex: 0, name: 'Ile-Ife Passport Cover', slug: 'ile-ife-passport-cover', category: 'leather-goods', priceMinor: 380_000, taxRateBp: 750, stock: 25, status: 'draft', description: 'Passport cover in progress; not yet published.' },

  // --- Seller 2: Abuja Ceramics Studio ------------------------------------
  { sellerIndex: 1, name: 'Nok Terracotta Bowl', slug: 'nok-terracotta-bowl', category: 'ceramics', priceMinor: 320_000, taxRateBp: 750, stock: 30, description: 'Stoneware bowl with a matte nok-inspired slip.' },
  { sellerIndex: 1, name: 'Aso Rock Espresso Set', slug: 'aso-rock-espresso-set', category: 'ceramics', priceMinor: 1_250_000, taxRateBp: 750, stock: 6, description: 'Two-cup espresso set and saucers, wheel-thrown.' },
  { sellerIndex: 1, name: 'Kaduna Stone Mug', slug: 'kaduna-stone-mug', category: 'ceramics', priceMinor: 285_000, taxRateBp: 750, stock: 55, description: '350ml stoneware mug, reactive glaze.' },
  { sellerIndex: 1, name: 'Sallah Dinner Plates (Set of 4)', slug: 'sallah-dinner-plates', category: 'ceramics', priceMinor: 2_100_000, taxRateBp: 750, stock: 14, description: 'Wide-rim dinner plates for shared servings.' },
  { sellerIndex: 1, name: 'Pottery Vase (Archived)', slug: 'pottery-vase-delisted', category: 'ceramics', priceMinor: 890_000, taxRateBp: 750, stock: 3, status: 'archived', description: 'Withdrawn from sale; existing orders are unaffected.' },

  // --- Seller 3: Port Harcourt Spice Traders ------------------------------
  { sellerIndex: 2, name: 'Calabar Bonny Pepper', slug: 'calabar-bonny-pepper', category: 'spices', priceMinor: 145_000, taxRateBp: 0, stock: 200, description: 'Whole dried bonnet pepper, 100g. Heat rating: high.' },
  { sellerIndex: 2, name: 'Ogiri Spice Blend', slug: 'ogiri-spice-blend', category: 'spices', priceMinor: 98_000, taxRateBp: 0, stock: 350, description: 'Fermented ogiri and uda blend, 150g.' },
  { sellerIndex: 2, name: 'Aro Palm Oil', slug: 'aro-palm-oil', category: 'spices', priceMinor: 260_000, taxRateBp: 0, stock: 80, description: 'Unrefined red palm oil, 1L, food-grade.' },
  { sellerIndex: 2, name: 'Nsukka Ukazi Leaves', slug: 'nsukka-ukazi-leaves', category: 'spices', priceMinor: 75_000, taxRateBp: 0, stock: 120, description: 'Sun-dried ukazi leaves, 200g. Sells by weight.' },
  { sellerIndex: 2, name: 'Ogba Ado Crayfish', slug: 'ogba-ado-crayfish', category: 'spices', priceMinor: 210_000, taxRateBp: 0, stock: 64, description: 'Whole dried crayfish, no added salt.' },
  // No stock column at all: exercises the `unlimited` half of the
  // products_stock_matches_policy CHECK, which is the constraint that stops a
  // decrementing query from acting on a meaningless number.
  { sellerIndex: 2, name: 'Ginger Root, per kg', slug: 'ginger-root-per-kg', category: 'spices', priceMinor: 320_000, taxRateBp: 0, description: 'Sold to weight at the counter; no tracked stock.' },

  // --- Seller 4: Kaduna Textile Co (suspended) -----------------------------
  { sellerIndex: 3, name: 'Block-Print Wrapper', slug: 'block-print-wrapper', category: 'textiles', priceMinor: 4_800_000, taxRateBp: 750, stock: 0, status: 'draft', description: 'Six-yard wrapper in a hand-block print. Draft pending reinstatement.' },
];

const SELLERS = [
  { index: 0, email: 'hello@lagosleatherworks.test', name: 'Ngozi Eze', shop: 'Lagos Leatherworks', slug: 'lagos-leatherworks', description: 'Hand-cut leather goods from Ojota, Lagos. Vegetable tanning, brass hardware, lifetime repairs.', status: 'active', currency: 'NGN' },
  { index: 1, email: 'studio@abujaceramics.test', name: 'Ibrahim Yusuf', shop: 'Abuja Ceramics Studio', slug: 'abuja-ceramics-studio', description: 'Wheel-thrown stoneware for everyday use. Small kiln, small batches, no two alike.', status: 'active', currency: 'NGN' },
  { index: 2, email: 'sales@phspicetraders.test', name: 'Blessing Okoro', shop: 'Port Harcourt Spice Traders', slug: 'portharcourt-spice-traders', description: 'Whole spices and pantry staples sourced directly from growers in the Niger Delta.', status: 'active', currency: 'NGN' },
  { index: 3, email: 'team@kadunatextiles.test', name: 'Amina Bello', shop: 'Kaduna Textile Co', slug: 'kaduna-textile-co', description: 'Hand-loomed and block-printed textiles from Kaduna.', status: 'suspended', currency: 'NGN' },
] as const;

const BUYERS = [
  { email: 'adaeze@example.test', name: 'Adaeze Nnamdi' },
  { email: 'tunde@example.test', name: 'Tunde Bakare' },
  { email: 'fatima@example.test', name: 'Fatima Suleiman' },
  { email: 'chidi@example.test', name: 'Chidi Okafor' },
] as const;

const SHIPPING = [
  { name: 'Adaeze Nnamdi', line1: '14 Bode Thomas Street', line2: 'Surulere', city: 'Lagos', region: 'Lagos', postal: '101283', country: 'NG' },
  { name: 'Tunde Bakare', line1: '3 Unity Crescent', line2: null, city: 'Ibadan', region: 'Oyo', postal: '200171', country: 'NG' },
  { name: 'Fatima Suleiman', line1: '22 Kawo Close', line2: 'Gidan Kwaye', city: 'Kano', region: 'Kano', postal: '700213', country: 'NG' },
  { name: 'Chidi Okafor', line1: '9 Aba Road', line2: null, city: 'Port Harcourt', region: 'Rivers', postal: '500102', country: 'NG' },
] as const;

/** Ordering of a product, for readable seed output. */
const orderedProducts: SeedProduct[] = [];
for (const p of PRODUCTS) orderedProducts.push({ ...p, id: uuid(nextProduct++) });

/** Look up a seeded product by slug. Throws if the seed data and this drift. */
function product(slug: string): SeedProduct {
  const found = orderedProducts.find((p) => p.slug === slug);
  if (!found) throw new Error(`seed references unknown product slug "${slug}"`);
  return found;
}

// ---------------------------------------------------------------------------
// Order construction
// ---------------------------------------------------------------------------

type OrderStatus =
  | 'pending' | 'accepted' | 'paid' | 'shipped' | 'completed'
  | 'rejected' | 'cancelled' | 'refunded';

/**
 * One step of an order's history.
 *
 * `on` is days ago. The path is written out explicitly per scenario rather than
 * inferred from the target status, because inference is what produced a silently
 * dropped `accepted` step during development: the order stayed `pending` and the
 * scenario quietly stopped testing what it claimed to test. An explicit path
 * cannot be misread -- it is also the most direct documentation of the state
 * machine in the repository.
 */
interface OrderStep {
  to: OrderStatus;
  actor: 'buyer' | 'seller' | 'system' | 'admin';
  on: number;
}

interface OrderSpec {
  buyerIndex: number;
  sellerIndex: number;
  lines: { slug: string; quantity: number }[];
  placedDaysAgo: number;
  /** The exact sequence of legal transitions from 'pending'. */
  path: OrderStep[];
  payment?: 'none' | 'succeeded' | 'refunded';
  rating?: number;
  reviewBody?: string;
  reviewSoftDeleted?: string;
  idempotencySuffix: string;
}

const orders: OrderSpec[] = [
  // 1. Fresh, awaiting a seller decision -- the default storefront case.
  { buyerIndex: 0, sellerIndex: 0, placedDaysAgo: 0, path: [], payment: 'none', idempotencySuffix: 'a',
    lines: [{ slug: 'obi-leather-tote', quantity: 1 }] },
  { buyerIndex: 2, sellerIndex: 2, placedDaysAgo: 1, path: [], payment: 'none', idempotencySuffix: 'b',
    lines: [{ slug: 'calabar-bonny-pepper', quantity: 2 }, { slug: 'ogiri-spice-blend', quantity: 3 }] },
  { buyerIndex: 3, sellerIndex: 1, placedDaysAgo: 2, path: [], payment: 'none', idempotencySuffix: 'c',
    lines: [{ slug: 'kaduna-stone-mug', quantity: 4 }] },

  // 2. Accepted, waiting for the buyer to pay.
  { buyerIndex: 1, sellerIndex: 0, placedDaysAgo: 4, path: [{ to: 'accepted', actor: 'seller', on: 3 }], payment: 'none', idempotencySuffix: 'd',
    lines: [{ slug: 'aso-oke-belt', quantity: 1 }] },
  { buyerIndex: 0, sellerIndex: 1, placedDaysAgo: 2, path: [{ to: 'accepted', actor: 'seller', on: 1 }], payment: 'none', idempotencySuffix: 'e',
    lines: [{ slug: 'nok-terracotta-bowl', quantity: 2 }] },
  { buyerIndex: 3, sellerIndex: 2, placedDaysAgo: 6, path: [{ to: 'accepted', actor: 'seller', on: 5 }], payment: 'none', idempotencySuffix: 'f',
    lines: [{ slug: 'aro-palm-oil', quantity: 1 }] },

  // 3. Paid, awaiting dispatch.
  { buyerIndex: 1, sellerIndex: 1, placedDaysAgo: 7, idempotencySuffix: 'g', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 6 }, { to: 'paid', actor: 'system', on: 6 }],
    lines: [{ slug: 'aso-rock-espresso-set', quantity: 1 }] },
  { buyerIndex: 2, sellerIndex: 0, placedDaysAgo: 5, idempotencySuffix: 'h', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 4 }, { to: 'paid', actor: 'system', on: 3 }],
    lines: [{ slug: 'yoruba-grain-wallet', quantity: 1 }] },

  // 4. Shipped, in transit.
  { buyerIndex: 0, sellerIndex: 2, placedDaysAgo: 9, idempotencySuffix: 'i', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 8 }, { to: 'paid', actor: 'system', on: 8 }, { to: 'shipped', actor: 'seller', on: 2 }],
    lines: [{ slug: 'ogba-ado-crayfish', quantity: 3 }] },
  { buyerIndex: 3, sellerIndex: 0, placedDaysAgo: 10, idempotencySuffix: 'j', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 9 }, { to: 'paid', actor: 'system', on: 8 }, { to: 'shipped', actor: 'seller', on: 3 }],
    lines: [{ slug: 'danfo-card-holder', quantity: 1 }] },

  // 5. Completed, reviewable. completed_at must be inside the 30-day window.
  { buyerIndex: 0, sellerIndex: 0, placedDaysAgo: 16, idempotencySuffix: 'k', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 15 }, { to: 'paid', actor: 'system', on: 14 }, { to: 'shipped', actor: 'seller', on: 9 }, { to: 'completed', actor: 'buyer', on: 5 }],
    lines: [{ slug: 'obi-leather-tote', quantity: 1 }, { slug: 'danfo-card-holder', quantity: 2 }],
    rating: 5, reviewBody: 'The tote is beautifully made and arrived in three days. The card holders are a gift I keep reaching for.' },
  { buyerIndex: 1, sellerIndex: 1, placedDaysAgo: 20, idempotencySuffix: 'l', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 19 }, { to: 'paid', actor: 'system', on: 18 }, { to: 'shipped', actor: 'seller', on: 12 }, { to: 'completed', actor: 'buyer', on: 8 }],
    lines: [{ slug: 'aso-rock-espresso-set', quantity: 1 }],
    rating: 4, reviewBody: 'Solid espresso set. One cup is slightly smaller than the other, which the seller was upfront about.' },
  { buyerIndex: 2, sellerIndex: 2, placedDaysAgo: 12, idempotencySuffix: 'm', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 11 }, { to: 'paid', actor: 'system', on: 10 }, { to: 'shipped', actor: 'seller', on: 6 }, { to: 'completed', actor: 'buyer', on: 4 }],
    lines: [{ slug: 'calabar-bonny-pepper', quantity: 4 }, { slug: 'ogba-ado-crayfish', quantity: 1 }],
    rating: 5, reviewBody: 'Fresher than anything in the supermarkets. The pepper is properly hot.' },
  { buyerIndex: 3, sellerIndex: 2, placedDaysAgo: 11, idempotencySuffix: 'n', payment: 'succeeded',
    path: [{ to: 'accepted', actor: 'seller', on: 10 }, { to: 'paid', actor: 'system', on: 9 }, { to: 'shipped', actor: 'seller', on: 4 }, { to: 'completed', actor: 'buyer', on: 1 }],
    lines: [{ slug: 'nsukka-ukazi-leaves', quantity: 6 }],
    rating: 4, reviewBody: 'Good leaves, quick delivery. Packaging could be more sealed.' },

  // 6. Completed, then refunded -- a return. The review survives the refund,
  //    because 006_reviews.sql keys eligibility on having *reached* completed.
  { buyerIndex: 1, sellerIndex: 0, placedDaysAgo: 24, idempotencySuffix: 'o', payment: 'refunded',
    path: [{ to: 'accepted', actor: 'seller', on: 23 }, { to: 'paid', actor: 'system', on: 22 }, { to: 'shipped', actor: 'seller', on: 14 }, { to: 'completed', actor: 'buyer', on: 10 }, { to: 'refunded', actor: 'admin', on: 6 }],
    lines: [{ slug: 'aso-oke-belt', quantity: 1 }],
    rating: 3, reviewBody: 'Belt arrived well made but the size ran small. Returning it.' },

  // 7. Rejected by the seller -- declined, never paid, no money to return.
  { buyerIndex: 0, sellerIndex: 1, placedDaysAgo: 8, idempotencySuffix: 'p', payment: 'none',
    path: [{ to: 'rejected', actor: 'seller', on: 7 }],
    lines: [{ slug: 'sallah-dinner-plates', quantity: 1 }] },
  { buyerIndex: 2, sellerIndex: 0, placedDaysAgo: 13, idempotencySuffix: 'q', payment: 'none',
    path: [{ to: 'rejected', actor: 'seller', on: 12 }],
    lines: [{ slug: 'yoruba-grain-wallet', quantity: 3 }] },

  // 8. Cancelled by the buyer: once before the seller responded, once after.
  //    Both are modelled, because the second exercises an edge that the first
  //    does not reach.
  { buyerIndex: 3, sellerIndex: 1, placedDaysAgo: 3, idempotencySuffix: 'r', payment: 'none',
    path: [{ to: 'cancelled', actor: 'buyer', on: 2 }],
    lines: [{ slug: 'kaduna-stone-mug', quantity: 2 }] },
  { buyerIndex: 1, sellerIndex: 2, placedDaysAgo: 6, idempotencySuffix: 's', payment: 'none',
    path: [{ to: 'accepted', actor: 'seller', on: 5 }, { to: 'cancelled', actor: 'buyer', on: 4 }],
    lines: [{ slug: 'aro-palm-oil', quantity: 1 }] },

  // 9. Refunded before delivery -- captured, then returned to the seller. The
  //    machine offers no 'paid -> cancelled' edge for a user precisely because
  //    that would be a refund wearing the wrong name.
  { buyerIndex: 2, sellerIndex: 1, placedDaysAgo: 15, idempotencySuffix: 't', payment: 'refunded',
    path: [{ to: 'accepted', actor: 'seller', on: 14 }, { to: 'paid', actor: 'system', on: 13 }, { to: 'refunded', actor: 'admin', on: 11 }],
    lines: [{ slug: 'nok-terracotta-bowl', quantity: 1 }] },
];

/**
 * Advances an order one edge through the real state machine.
 *
 * Sets the actor through a transaction-local GUC because the guard trigger
 * reads `app.actor_role` / `app.actor_id`. There is deliberately no backdoor
 * for "trusted" callers: the seed exercises the same path as the API.
 */
async function advance(
  db: SeedTx,
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
  actor: { role: string; userId: string | null },
  when: Date
): Promise<void> {
  if (actor.userId) {
    await db.query(`SELECT set_config('app.actor_id', $1, true)`, [actor.userId]);
  }
  await db.query(`SELECT set_config('app.actor_role', $1, true)`, [actor.role]);

  const stamp = (column: string, whenStatus: OrderStatus) =>
    `CASE WHEN $2::order_status = '${whenStatus}'::order_status THEN $3::timestamptz ELSE ${column} END`;

  await db.query(
    `UPDATE orders
        SET status = $2::order_status,
            accepted_at  = ${stamp('accepted_at', 'accepted')},
            paid_at      = ${stamp('paid_at', 'paid')},
            shipped_at   = ${stamp('shipped_at', 'shipped')},
            completed_at = ${stamp('completed_at', 'completed')},
            rejected_at  = ${stamp('rejected_at', 'rejected')},
            cancelled_at = ${stamp('cancelled_at', 'cancelled')},
            refunded_at  = ${stamp('refunded_at', 'refunded')}
      WHERE id = $1 AND status = $4::order_status`,
    [orderId, to, when.toISOString(), from]
  );
}

const daysAgoDate = (days: number): Date =>
  new Date(Date.now() - days * 86_400_000);

async function seedOrders(db: SeedTx, opts: SeedOptions): Promise<void> {
  for (const spec of orders) {
    // Each spec is isolated so a failure names the offending order rather than
    // surfacing as one opaque error at the end of a long transaction. The
    // transaction still rolls back as a unit, so nothing partial is persisted.
    try {
      await seedOneOrder(db, spec, opts);
    } catch (error) {
      const err = error as { code?: string; message?: string; constraint?: string };
      throw new Error(
        `order spec "${spec.idempotencySuffix}" (buyer ${spec.buyerIndex} -> ` +
          `seller ${spec.sellerIndex}, path ${spec.path.map((s) => s.to).join(' > ') || 'pending only'}): ` +
          `${err.code ?? '?'} ${err.message ?? String(error)}` +
          (err.constraint ? ` [${err.constraint}]` : '')
      );
    }
  }
}

async function seedOneOrder(db: SeedTx, spec: OrderSpec, opts: SeedOptions): Promise<void> {
  {
    // No default: every order states its lines explicitly, because a silent
    // default would let a spec pick a product belonging to a different seller
    // and the database would (correctly) refuse it.
    const lines = spec.lines;
    if (!lines || lines.length === 0) {
      throw new Error(`order spec "${spec.idempotencySuffix}" has no lines`);
    }

    const seller = SELLERS.find((s) => s.index === spec.sellerIndex);
    if (!seller) throw new Error(`bad sellerIndex ${spec.sellerIndex}`);

    const orderId = uuid(nextOrder++);
    const placedAt = daysAgoDate(spec.placedDaysAgo);

    // --- Money, computed exactly as the database would verify it -----------
    let subtotal = 0;
    let tax = 0;
    const lineRows = lines.map((line) => {
      const p = product(line.slug);
      const lineTotal = p.priceMinor * line.quantity;
      const lineTax = Math.round((lineTotal * p.taxRateBp) / 10_000);
      subtotal += lineTotal;
      tax += lineTax;
      return { p, quantity: line.quantity, lineTotal, lineTax };
    });

    const shipping = opts.shippingFor(subtotal);
    const total = subtotal + tax + shipping;

    const ship = SHIPPING[spec.buyerIndex];
    if (!ship) throw new Error(`bad buyerIndex ${spec.buyerIndex}`);

    await db.query(
      `INSERT INTO orders (
         id, public_code, buyer_id, seller_id, status, currency_code,
         subtotal_minor, tax_minor, shipping_minor, total_minor,
         shipping_name, shipping_line1, shipping_line2, shipping_city,
         shipping_region, shipping_postal_code, shipping_country_code,
         idempotency_key, placed_at
       ) VALUES (
         $1, 'ORD-AAAAAA', $2, $3, 'pending', $4,
         $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15,
         $16, $17::timestamptz
       )`,
      [
        orderId, U.buyers[spec.buyerIndex], U.sellers[spec.sellerIndex], seller.currency,
        subtotal, tax, shipping, total,
        ship.name, ship.line1, ship.line2, ship.city,
        ship.region, ship.postal, ship.country,
        `seed-checkout-${spec.idempotencySuffix}-${orderId.slice(-6)}`,
        placedAt.toISOString(),
      ]
    );

    for (const line of lineRows) {
      await db.query(
        `INSERT INTO order_items (
           id, order_id, product_id, name_snapshot,
           unit_price_minor, tax_rate_bp, quantity,
           line_total_minor, line_tax_minor
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          uuid(nextLine++), orderId, line.p.id, line.p.name,
          line.p.priceMinor, line.p.taxRateBp, line.quantity,
          line.lineTotal, line.lineTax,
        ]
      );
    }

    // --- Walk the machine ---------------------------------------------------
    const buyerId = U.buyers[spec.buyerIndex];
    const sellerId = U.sellers[spec.sellerIndex];
    if (!buyerId) throw new Error(`bad buyerIndex ${spec.buyerIndex}`);
    if (!sellerId) throw new Error(`bad sellerIndex ${spec.sellerIndex}`);

    let current: OrderStatus = 'pending';
    for (const step of spec.path) {
      const userId =
        step.actor === 'seller' ? sellerId
        : step.actor === 'buyer' ? buyerId
        : step.actor === 'admin' ? (U.admin ?? null)
        : null;

      await advance(db, orderId, current, step.to, { role: step.actor, userId },
        daysAgoDate(step.on));
      current = step.to;
    }

    // Money may only be captured on a path that has passed through 'paid'.
    if ((spec.payment === 'succeeded' || spec.payment === 'refunded')
        && !['paid', 'shipped', 'completed', 'refunded'].includes(current)) {
      throw new Error(
        `order spec "${spec.idempotencySuffix}" claims a ${spec.payment} payment ` +
          `but its path ends at "${current}", which never captured money`
      );
    }

    // The public code is the natural provider reference: it is unique (enforced),
    // human-meaningful, and stable.
    const { rows: coded } = await db.query<{ public_code: string }>(
      'SELECT public_code FROM orders WHERE id = $1',
      [orderId]
    );
    const publicCode = coded[0]?.public_code;
    if (!publicCode) throw new Error(`order ${orderId} has no public_code`);

    // --- Payments ----------------------------------------------------------
    if (spec.payment === 'succeeded' || spec.payment === 'refunded') {
      const paidStep = spec.path.find((s) => s.to === 'paid');
      const succeededAt = daysAgoDate(paidStep?.on ?? spec.placedDaysAgo);
      await db.query(
        `INSERT INTO payments (
           id, order_id, amount_minor, currency_code, state,
           provider, provider_reference, idempotency_key, succeeded_at
         ) VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8::timestamptz)`,
        [
          uuid(nextPayment++), orderId, total, seller.currency,
          'stubpay', `stub_${publicCode.replace('-', '')}`,
          `seed-pay-${spec.idempotencySuffix}-${orderId.slice(-6)}`,
          succeededAt.toISOString(),
        ]
      );

      if (spec.payment === 'refunded') {
        const refundStep = spec.path.find((s) => s.to === 'refunded');
        if (!refundStep) {
          throw new Error(
            `order spec "${spec.idempotencySuffix}" refunds the payment but its ` +
              `path has no 'refunded' step, so the order is not in a refunded state`
          );
        }
        await db.query(
          `UPDATE payments
              SET state = 'refunded', refunded_at = $2::timestamptz
            WHERE order_id = $1 AND state = 'succeeded'`,
          [orderId, daysAgoDate(refundStep.on).toISOString()]
        );
      }
    }

    // --- Reviews -----------------------------------------------------------
    if (spec.rating !== undefined) {
      await db.query(
        `INSERT INTO reviews (
           id, order_id, author_id, subject_seller_id, rating, body, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [uuid(nextReview++), orderId, buyerId, sellerId, spec.rating, spec.reviewBody ?? null]
      );
    }
    if (spec.reviewSoftDeleted) {
      await db.query(
        `UPDATE reviews SET deleted_at = now(), deleted_reason = $2
          WHERE order_id = $1`,
        [orderId, spec.reviewSoftDeleted]
      );
    }
  }
}

/**
 * Wipes and re-inserts the full demo dataset.
 *
 * Callers decide when to run it. `scripts/seed.ts` runs it on demand; the
 * app's cold-start bootstrap runs it only against an empty database. Anything
 * else must not truncate a live database behind an application's back.
 */
export async function seedDatabase(db: SeedDb, opts: SeedOptions): Promise<SeedSummary> {
  // Truncate rather than delete: the tables are small, and TRUNCATE also
  // resets any sequence and does not fire per-row triggers, which keeps a
  // re-seed from tripping the rating aggregate mid-flight.
  await db.exec(`
    TRUNCATE payments, reviews, order_items, orders, products,
             seller_profiles, users RESTART IDENTITY CASCADE;
  `);

  await db.transaction(async (tx) => {
    // --- Admin ------------------------------------------------------------
    await tx.query(
      `INSERT INTO users (id, email, full_name, role, password_hash)
       VALUES ($1, 'ops@marketplace.test', 'Marketplace Operations', 'admin', $2)`,
      [U.admin, opts.passwordHash]
    );

    // --- Sellers and buyers ------------------------------------------------
    for (const seller of SELLERS) {
      await tx.query(
        `INSERT INTO users (id, email, full_name, role, password_hash)
         VALUES ($1, $2, $3, 'seller', $4)`,
        [U.sellers[seller.index], seller.email, seller.name, opts.passwordHash]
      );
      await tx.query(
        `INSERT INTO seller_profiles (
           user_id, shop_name, slug, description, status, payout_currency
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          U.sellers[seller.index], seller.shop, seller.slug,
          seller.description, seller.status, seller.currency,
        ]
      );
    }

    for (const buyer of BUYERS) {
      await tx.query(
        `INSERT INTO users (id, email, full_name, role, password_hash)
         VALUES ($1, $2, $3, 'buyer', $4)`,
        [U.buyers[BUYERS.indexOf(buyer)], buyer.email, buyer.name, opts.passwordHash]
      );
    }

    // --- Products ----------------------------------------------------------
    for (const p of orderedProducts) {
      const unlimited = p.stock === undefined;
      await tx.query(
        `INSERT INTO products (
           id, seller_id, name, slug, description, price_minor, currency_code,
           tax_rate_bp, status, stock_policy, stock_quantity, category,
           created_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'NGN', $7, $8, $9, $10, $11,
           $12::timestamptz
         )`,
        [
          p.id, U.sellers[p.sellerIndex], p.name, p.slug, p.description,
          p.priceMinor, p.taxRateBp, p.status ?? 'active',
          unlimited ? 'unlimited' : 'tracked', unlimited ? null : (p.stock ?? 0),
          p.category, daysAgoDate(60).toISOString(),
        ]
      );
    }

    await seedOrders(tx, opts);
  });

  const { rows: counts } = await db.query<{ table_name: string; n: bigint }>(`
    SELECT 'users' AS table_name, count(*) AS n FROM users
    UNION ALL SELECT 'seller_profiles', count(*) FROM seller_profiles
    UNION ALL SELECT 'products', count(*) FROM products
    UNION ALL SELECT 'orders', count(*) FROM orders
    UNION ALL SELECT 'order_items', count(*) FROM order_items
    UNION ALL SELECT 'payments', count(*) FROM payments
    UNION ALL SELECT 'reviews', count(*) FROM reviews
    ORDER BY 1
  `);

  const { rows: statuses } = await db.query<{ status: string; n: bigint }>(
    `SELECT status::text, count(*) AS n FROM orders GROUP BY 1 ORDER BY 1`
  );

  return { counts, statuses };
}