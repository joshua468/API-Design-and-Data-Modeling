/**
 * Constraint proofs.
 *
 * Every entry attempts something that must fail, and asserts that it failed for
 * the *stated reason* -- a SQLSTATE and, where the schema names one, the
 * constraint. Asserting only "it threw" would pass a proof triggered by a typo
 * in the test, which is the main way a suite like this lies to you.
 *
 * Each proof runs inside a transaction that is always rolled back, so the
 * suite is safe to run repeatedly against seeded data and leaves no residue.
 *
 * There are also CONTROL cases, which must succeed. Without them the suite only
 * demonstrates that the database rejects things, which is a much weaker claim
 * than "the database rejects exactly the invalid states and accepts the valid
 * ones". A constraint that rejects everything passes every proof in the first
 * group.
 */
import { openDb } from './lib/db.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
interface Db {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[]; affectedRows: number }>;
  exec(sql: string): Promise<void>;
}

interface Violation {
  code?: string;
  constraint?: string;
  message?: string;
  detail?: string;
}

interface Proof {
  /** Grouping used for the summary table. */
  group: string;
  name: string;
  /** What the attempt was, in one line. Printed on success so the reader sees
   *  what was actually blocked, not merely that a test passed. */
  attempt: string;
  /** Assert the failure names this constraint. */
  constraint?: string;
  /** Assert the failure carries this SQLSTATE. */
  sqlstate?: string;
  run: (db: Db) => Promise<void>;
}

interface Control {
  group: string;
  name: string;
  attempt: string;
  run: (db: Db) => Promise<void>;
}

const proofs: Proof[] = [];
const controls: Control[] = [];

/** Runs `fn` in a transaction that is always rolled back. */
async function sandbox<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  await db.exec('BEGIN');
  try {
    const result = await fn(db);
    await db.exec('ROLLBACK');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Moves an order through the state machine as a specific actor.
 * The GUCs are transaction-local, so the rollback at the end of each proof
 * restores them automatically -- no cleanup step to forget.
 */
async function transition(
  db: Db,
  orderId: string,
  to: string,
  actor: 'buyer' | 'seller' | 'system' | 'admin',
  actorId: string | null
): Promise<void> {
  await db.query(`SELECT set_config('app.actor_role', $1, true)`, [actor]);
  await db.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId ?? '']);
  await db.query(`UPDATE orders SET status = $2::order_status WHERE id = $1`, [
    orderId,
    to,
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures, resolved by description rather than by hard-coded id, so the proofs
// keep working when the seed is re-shaped.
// ---------------------------------------------------------------------------
interface Fixture {
  buyer: string;
  otherBuyer: string;
  seller: string;
  otherSeller: string;
  admin: string;
  activeProduct: string;
  secondProduct: string;
  pendingOrder: string;
  acceptedOrder: string;
  paidOrder: string;
  completedOrder: string;
  rejectedOrder: string;
  cancelledOrder: string;
  refundedOrder: string;
  completedWithReview: string;
  /**
   * The buyer and seller of one specific order.
   *
   * Authorisation proofs have to use this rather than the global fixtures: an
   * order's seller is not arbitrary, so pairing a seeded order with an
   * unrelated seller makes the proof fail for the wrong reason -- which is how
   * a suite like this ends up asserting something it never tested.
   */
  parties: (orderId: string) => Promise<{ buyer: string; seller: string }>;
  /** A seller who is guaranteed not to own the given order. */
  strangerSeller: (orderId: string) => Promise<string>;
}

async function fixtures(db: Db): Promise<Fixture> {
  const one = async <T>(sql: string, params: readonly unknown[] = []): Promise<T> => {
    const { rows } = await db.query<T>(sql, params);
    const row = rows[0];
    if (!row) throw new Error(`fixture query returned nothing: ${sql.slice(0, 70)}`);
    return row;
  };

  const byStatus = async (status: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM orders WHERE status = $1::order_status ORDER BY created_at LIMIT 1',
      [status]
    );
    const row = rows[0];
    if (!row) throw new Error(`no seeded order in status "${status}"`);
    return row.id;
  };

  const parties = async (
    orderId: string
  ): Promise<{ buyer: string; seller: string }> => {
    const { rows } = await db.query<{ buyer_id: string; seller_id: string }>(
      'SELECT buyer_id, seller_id FROM orders WHERE id = $1', [orderId]
    );
    const row = rows[0];
    if (!row) throw new Error(`no order ${orderId}`);
    return { buyer: row.buyer_id, seller: row.seller_id };
  };

  const strangerSeller = async (orderId: string): Promise<string> => {
    const owner = await parties(orderId);
    return (
      await one<{ user_id: string }>(
        `SELECT user_id FROM seller_profiles
          WHERE status = 'active' AND user_id <> $1
          ORDER BY slug LIMIT 1`,
        [owner.seller]
      )
    ).user_id;
  };

  const firstProduct = (
    await one<{ id: string }>(`SELECT id FROM products WHERE status = 'active' ORDER BY slug LIMIT 1`)
  ).id;

  return {
    buyer: (await one<{ id: string }>(
      `SELECT id FROM users WHERE role = 'buyer' ORDER BY email LIMIT 1`)).id,
    otherBuyer: (await one<{ id: string }>(
      `SELECT id FROM users WHERE role = 'buyer' ORDER BY email DESC LIMIT 1`)).id,
    seller: (await one<{ id: string }>(
      `SELECT user_id AS id FROM seller_profiles WHERE status = 'active' ORDER BY slug LIMIT 1`)).id,
    otherSeller: (await one<{ id: string }>(
      `SELECT user_id AS id FROM seller_profiles WHERE status = 'active' ORDER BY slug DESC LIMIT 1`)).id,
    admin: (await one<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)).id,
    activeProduct: firstProduct,
    secondProduct: (await one<{ id: string }>(
      `SELECT id FROM products p WHERE p.status = 'active'
         AND p.seller_id = (SELECT seller_id FROM products WHERE id = $1)
       LIMIT 1`, [firstProduct])).id,
    pendingOrder: await byStatus('pending'),
    acceptedOrder: await byStatus('accepted'),
    paidOrder: await byStatus('paid'),
    completedOrder: await byStatus('completed'),
    rejectedOrder: await byStatus('rejected'),
    cancelledOrder: await byStatus('cancelled'),
    refundedOrder: await byStatus('refunded'),
    completedWithReview: (await one<{ order_id: string }>(
      `SELECT order_id FROM reviews ORDER BY created_at LIMIT 1`)).order_id,
    parties,
    strangerSeller,
  };
}

// ===========================================================================
// PROOFS -- each must be rejected
// ===========================================================================

// --- 1. The order state machine -------------------------------------------

proofs.push({
  group: 'state machine',
  name: 'paid -> cancelled is not a legal edge',
  attempt: 'cancel an order after payment was captured',
  constraint: 'orders_illegal_status_transition',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    // The buyer is the actor who *is* allowed to cancel -- so the only thing
    // wrong with this is the edge. Authorisation is proven separately.
    const { buyer } = await f.parties(f.paidOrder);
    await transition(db, f.paidOrder, 'cancelled', 'buyer', buyer);
  },
});

proofs.push({
  group: 'state machine',
  name: 'a rejected order is terminal',
  attempt: 'accept an order the seller already rejected',
  constraint: 'orders_illegal_status_transition',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { seller } = await f.parties(f.rejectedOrder);
    await transition(db, f.rejectedOrder, 'accepted', 'seller', seller);
  },
});

proofs.push({
  group: 'state machine',
  name: 'a refunded order is terminal',
  attempt: 'ship an order that has already been refunded',
  constraint: 'orders_illegal_status_transition',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { seller } = await f.parties(f.refundedOrder);
    await transition(db, f.refundedOrder, 'shipped', 'seller', seller);
  },
});

proofs.push({
  group: 'state machine',
  name: 'a buyer cannot accept their own order',
  attempt: 'the buyer performs the seller-only accept transition',
  constraint: 'orders_illegal_status_transition',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { buyer } = await f.parties(f.pendingOrder);
    await transition(db, f.pendingOrder, 'accepted', 'buyer', buyer);
  },
});

proofs.push({
  group: 'state machine',
  name: 'a seller cannot confirm their own delivery',
  attempt: 'the seller performs the buyer-only complete transition',
  constraint: 'orders_illegal_status_transition',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { seller } = await f.parties(f.paidOrder);
    await transition(db, f.paidOrder, 'completed', 'seller', seller);
  },
});

proofs.push({
  group: 'state machine',
  name: 'the wrong party cannot drive a legal transition',
  attempt: "a seller who is not this order's seller tries to ship it",
  constraint: 'orders_actor_not_authorized',
  sqlstate: '42501',
  run: async (db) => {
    const f = await fixtures(db);
    await transition(
      db,
      f.paidOrder,
      'shipped',
      'seller',
      await f.strangerSeller(f.paidOrder)
    );
  },
});

proofs.push({
  group: 'state machine',
  name: 'no step can be skipped',
  attempt: 'mark an order paid while accepted_at is still NULL',
  constraint: 'orders_progress_no_gaps',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    // A trigger-free path to an incoherent history: null out accepted_at and let
    // the no-gaps CHECK catch the contradiction. This is the invariant that a
    // per-status check alone would miss.
    await db.query(`UPDATE orders SET paid_at = now() WHERE id = $1`, [f.paidOrder]);
    await db.query(`UPDATE orders SET accepted_at = NULL WHERE id = $1`, [f.paidOrder]);
  },
});

proofs.push({
  group: 'state machine',
  name: 'status and its timestamps must agree',
  attempt: 'stamp paid_at onto a cancelled order',
  constraint: 'orders_status_timestamp_agreement',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    // Chosen so that orders_progress_no_gaps and orders_progress_monotonic are
    // both *satisfied* (a paid_at needs an accepted_at, and both must be at or
    // after placed_at). That leaves orders_status_timestamp_agreement as the
    // single violated rule, which is what makes this an isolated proof rather
    // than three checks failing in an ambiguous order.
    //
    // The transition trigger is declared BEFORE UPDATE OF status, so it does not
    // fire here at all: this column is exactly the defence-in-depth case.
    await db.query(
      `UPDATE orders
          SET accepted_at = placed_at + interval '1 minute',
              paid_at    = placed_at + interval '2 minutes'
        WHERE id = $1`,
      [f.cancelledOrder]
    );
  },
});

proofs.push({
  group: 'state machine',
  name: 'history cannot be backdated',
  attempt: 'record accepted_at before the order was placed',
  constraint: 'orders_progress_monotonic',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { seller } = await f.parties(f.pendingOrder);
    await transition(db, f.pendingOrder, 'accepted', 'seller', seller);
    await db.query(`UPDATE orders SET accepted_at = placed_at - interval '1 day' WHERE id = $1`, [
      f.pendingOrder,
    ]);
  },
});

// --- 2. Money --------------------------------------------------------------

proofs.push({
  group: 'money',
  name: 'money is never negative',
  attempt: 'price a product at -500 minor units',
  constraint: 'minor_units_non_negative',
  sqlstate: '23514',
  run: async (db) => {
    await db.query(`UPDATE products SET price_minor = -500 WHERE id = $1`, [
      (await fixtures(db)).activeProduct,
    ]);
  },
});

proofs.push({
  group: 'money',
  name: 'order totals must add up',
  attempt: 'set total_minor to something other than subtotal + tax + shipping',
  constraint: 'orders_total_identity',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    await db.query(
      `UPDATE orders SET total_minor = subtotal_minor + tax_minor + shipping_minor + 1 WHERE id = $1`,
      [f.paidOrder]
    );
  },
});

proofs.push({
  group: 'money',
  name: 'line totals must equal unit price x quantity',
  attempt: 'overstate a line total by one minor unit',
  constraint: 'order_items_line_total_identity',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    // PostgreSQL has no LIMIT on UPDATE, so target one row through its ctid.
    await db.query(
      `UPDATE order_items SET line_total_minor = line_total_minor + 1
        WHERE ctid = (SELECT ctid FROM order_items WHERE order_id = $1 LIMIT 1)`,
      [f.pendingOrder]
    );
  },
});

proofs.push({
  group: 'money',
  name: 'line tax must match the snapshotted rate',
  attempt: 'recompute a line with a different tax rate than it records',
  constraint: 'order_items_line_tax_identity',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    await db.query(
      `UPDATE order_items SET tax_rate_bp = tax_rate_bp + 100
        WHERE ctid = (SELECT ctid FROM order_items WHERE order_id = $1 LIMIT 1)`,
      [f.pendingOrder]
    );
  },
});

proofs.push({
  group: 'money',
  name: 'a successful payment must equal the order total',
  attempt: 'record a captured payment for less than the order is worth',
  constraint: 'payments_amount_matches_order_total',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    // The order is already paid and its payment already settled. Rolling the
    // payment back to pending first is what lets this proof reach the
    // reconciliation check instead of tripping the immutability trigger on the
    // way there -- otherwise the proof would pass for the wrong reason.
    await db.query(
      `UPDATE payments SET state = 'pending', succeeded_at = NULL, refunded_at = NULL
        WHERE order_id = $1`,
      [f.paidOrder]
    );
    await db.query(`UPDATE payments SET amount_minor = 1 WHERE order_id = $1`, [f.paidOrder]);
    await db.query(
      `UPDATE payments SET state = 'succeeded', succeeded_at = now() WHERE order_id = $1`,
      [f.paidOrder]
    );
  },
});

proofs.push({
  group: 'money',
  name: 'one order, one live payment',
  attempt: 'capture a second payment against an order that is already paid',
  constraint: 'payments_single_live_per_order',
  sqlstate: '23505',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ total_minor: number; currency_code: string }>(
      'SELECT total_minor, currency_code FROM orders WHERE id = $1', [f.paidOrder]
    );
    const order = rows[0];
    if (!order) throw new Error('paid order disappeared');
    await db.query(
      `INSERT INTO payments (order_id, amount_minor, currency_code, state,
                             provider, provider_reference, idempotency_key, succeeded_at)
       VALUES ($1, $2, $3, 'succeeded', 'stubpay', 'stub_double_charge', $4, now())`,
      [f.paidOrder, order.total_minor, order.currency_code, 'proof-double-charge-0001']
    );
  },
});

proofs.push({
  group: 'money',
  name: 'settled payment fields are immutable',
  attempt: 'change the amount on a payment that has already succeeded',
  constraint: 'payments_settled_fields_immutable',
  sqlstate: '42501',
  run: async (db) => {
    const f = await fixtures(db);
    await db.query(
      `UPDATE payments SET amount_minor = amount_minor - 1 WHERE order_id = $1`,
      [f.paidOrder]
    );
  },
});

// --- 3. Ownership and authorisation ---------------------------------------

proofs.push({
  group: 'ownership',
  name: 'only the buyer may review an order',
  attempt: 'a different user reviews someone else\'s order',
  constraint: 'reviews_author_must_be_buyer',
  sqlstate: '42501',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ seller_id: string }>(
      'SELECT seller_id FROM orders WHERE id = $1', [f.completedOrder]
    );
    const seller = rows[0];
    if (!seller) throw new Error('completed order disappeared');
    await db.query(
      `INSERT INTO reviews (order_id, author_id, subject_seller_id, rating)
       VALUES ($1, $2, $3, 5)`,
      [f.completedOrder, f.otherBuyer, seller.seller_id]
    );
  },
});

proofs.push({
  group: 'ownership',
  name: 'an order cannot mix two sellers',
  attempt: 'add a line from a different seller\'s product',
  constraint: 'order_items_single_seller_per_order',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    await db.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, unit_price_minor,
                                tax_rate_bp, quantity, line_total_minor, line_tax_minor)
       SELECT $1, p.id, p.name, p.price_minor, p.tax_rate_bp, 1, p.price_minor, 0
         FROM products p
        WHERE p.seller_id <> (SELECT seller_id FROM orders WHERE id = $1)
          AND p.status = 'active'
        LIMIT 1`,
      [f.pendingOrder]
    );
  },
});

proofs.push({
  group: 'ownership',
  name: 'a seller profile requires a seller account',
  attempt: 'attach a shop to a buyer account',
  constraint: 'seller_profiles_role_must_be_seller',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    await db.query(
      `INSERT INTO seller_profiles (user_id, shop_name, slug, status, payout_currency)
       VALUES ($1, 'Buyer Shop', 'buyer-shop-proof', 'active', 'NGN')`,
      [f.buyer]
    );
  },
});

proofs.push({
  group: 'ownership',
  name: 'a suspended seller cannot publish',
  attempt: "set a product active while its seller's profile is suspended",
  constraint: 'products_seller_must_be_active',
  sqlstate: '23514',
  run: async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      `SELECT p.id, sp.user_id
         FROM products p JOIN seller_profiles sp ON sp.user_id = p.seller_id
        WHERE sp.status = 'suspended' AND p.status = 'draft'
        LIMIT 1`
    );
    const row = rows[0];
    if (!row) throw new Error('no draft product belonging to a suspended seller');
    // Suspend the seller of an active product, then re-assert the product's
    // active status. The trigger re-runs on UPDATE, which is the point: the
    // check is not only about insert.
    await db.query(
      `UPDATE seller_profiles SET status = 'suspended'
        WHERE user_id = (SELECT seller_id FROM products WHERE id = $1)`,
      [row.id]
    );
    await db.query(`UPDATE products SET status = 'active' WHERE id = $1`, [row.id]);
  },
});

// --- 4. Review eligibility -------------------------------------------------

proofs.push({
  group: 'reviews',
  name: 'a review requires a delivered order',
  attempt: 'review an order that is still awaiting dispatch',
  constraint: 'reviews_order_must_be_completed',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ buyer_id: string; seller_id: string }>(
      'SELECT buyer_id, seller_id FROM orders WHERE id = $1', [f.paidOrder]
    );
    const order = rows[0];
    if (!order) throw new Error('paid order disappeared');
    await db.query(
      `INSERT INTO reviews (order_id, author_id, subject_seller_id, rating)
       VALUES ($1, $2, $3, 4)`,
      [f.paidOrder, order.buyer_id, order.seller_id]
    );
  },
});

proofs.push({
  group: 'reviews',
  name: 'an order can be reviewed only once',
  attempt: 'a second review on the same order by the same buyer',
  constraint: 'reviews_one_per_order_per_author',
  sqlstate: '23505',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ author_id: string; subject_seller_id: string }>(
      'SELECT author_id, subject_seller_id FROM reviews WHERE order_id = $1',
      [f.completedWithReview]
    );
    const review = rows[0];
    if (!review) throw new Error('no seeded review to duplicate');
    await db.query(
      `INSERT INTO reviews (order_id, author_id, subject_seller_id, rating, body)
       VALUES ($1, $2, $3, 1, 'duplicate attempt')`,
      [f.completedWithReview, review.author_id, review.subject_seller_id]
    );
  },
});

proofs.push({
  group: 'reviews',
  name: 'rating is bounded 1..5',
  attempt: 'submit a rating of 6 stars',
  constraint: 'rating_one_to_five',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ id: string; subject_seller_id: string }>(
      'SELECT id, subject_seller_id FROM reviews WHERE order_id = $1',
      [f.completedWithReview]
    );
    const review = rows[0];
    if (!review) throw new Error('no seeded review to mutate');
    await db.query(`UPDATE reviews SET rating = 6 WHERE id = $1`, [review.id]);
  },
});

proofs.push({
  group: 'reviews',
  name: 'the reviewed seller must be the order seller',
  attempt: 'attach a review to the wrong seller',
  constraint: 'reviews_subject_must_be_order_seller',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ buyer_id: string }>(
      'SELECT buyer_id FROM orders WHERE id = $1', [f.completedOrder]
    );
    const order = rows[0];
    if (!order) throw new Error('completed order disappeared');
    await db.query(
      `INSERT INTO reviews (order_id, author_id, subject_seller_id, rating)
       VALUES ($1, $2, $3, 5)`,
      [f.completedOrder, order.buyer_id, f.otherSeller]
    );
  },
});

// --- 5. Uniqueness and immutability ---------------------------------------

proofs.push({
  group: 'uniqueness',
  name: 'email is unique regardless of case',
  attempt: "register ADAEZE@example.test alongside adaeze@example.test",
  constraint: 'users_email_lower_key',
  sqlstate: '23505',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1', [f.buyer]
    );
    const buyer = rows[0];
    if (!buyer) throw new Error('buyer disappeared');
    await db.query(
      `INSERT INTO users (email, full_name, role, password_hash)
       VALUES ($1, 'Case Test', 'buyer', repeat('x', 40))`,
      [buyer.email.toUpperCase()]
    );
  },
});

proofs.push({
  group: 'uniqueness',
  name: 'checkout retries are idempotent per buyer',
  attempt: 'reuse an idempotency key that already created an order',
  constraint: 'orders_buyer_idempotency_key',
  sqlstate: '23505',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ idempotency_key: string; seller_id: string }>(
      'SELECT idempotency_key, seller_id FROM orders WHERE id = $1', [f.pendingOrder]
    );
    const order = rows[0];
    if (!order) throw new Error('pending order disappeared');
    await db.query(
      `INSERT INTO orders (buyer_id, seller_id, currency_code, subtotal_minor, tax_minor,
                           shipping_minor, total_minor, shipping_name, shipping_line1,
                           shipping_city, shipping_country_code, idempotency_key)
       VALUES ($1, $2, 'NGN', 0, 0, 0, 0, 'Retry Attempt', '1 Test Street',
               'Lagos', 'NG', $3)`,
      [f.buyer, order.seller_id, order.idempotency_key]
    );
  },
});

proofs.push({
  group: 'uniqueness',
  name: 'one line per product per order',
  attempt: 'add the same product twice to one order',
  constraint: 'order_items_one_line_per_product',
  sqlstate: '23505',
  run: async (db) => {
    const f = await fixtures(db);
    // Compute the tax honestly, so the *only* thing wrong with this row is that
    // the product already appears on the order.
    await db.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, unit_price_minor,
                                tax_rate_bp, quantity, line_total_minor, line_tax_minor)
       SELECT order_id, product_id, name_snapshot, unit_price_minor, tax_rate_bp,
              1, unit_price_minor, tax_on(unit_price_minor, tax_rate_bp)
         FROM order_items WHERE order_id = $1 LIMIT 1`,
      [f.pendingOrder]
    );
  },
});

proofs.push({
  group: 'immutability',
  name: 'paid orders are frozen',
  attempt: 'change a line on an order that has been paid',
  constraint: 'order_items_immutable_after_payment',
  sqlstate: '42501',
  run: async (db) => {
    const f = await fixtures(db);
    await db.query(`UPDATE order_items SET quantity = 99 WHERE order_id = $1`, [f.paidOrder]);
  },
});

proofs.push({
  group: 'immutability',
  name: 'an archived product cannot be sold',
  attempt: 'add an archived product to a new order',
  constraint: 'order_items_product_must_be_active',
  sqlstate: '23514',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ id: string; name: string; price_minor: number }>(
      `SELECT id, name, price_minor FROM products WHERE status = 'archived' LIMIT 1`
    );
    const product = rows[0];
    if (!product) throw new Error('no archived product in the seed');
    await db.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, unit_price_minor,
                                tax_rate_bp, quantity, line_total_minor, line_tax_minor)
       VALUES ($1, $2, $3, $4, 0, 1, $4, 0)`,
      [f.pendingOrder, product.id, product.name, product.price_minor]
    );
  },
});

// ===========================================================================
// CONTROLS -- each must succeed, proving the constraints are not blanket bans
// ===========================================================================

controls.push({
  group: 'state machine',
  name: 'the happy path is walkable',
  attempt: 'accept -> pay -> ship -> complete, each as the correct actor',
  run: async (db) => {
    const f = await fixtures(db);
    const { buyer, seller } = await f.parties(f.pendingOrder);
    await transition(db, f.pendingOrder, 'accepted', 'seller', seller);
    await transition(db, f.pendingOrder, 'paid', 'system', null);
    await transition(db, f.pendingOrder, 'shipped', 'seller', seller);
    await transition(db, f.pendingOrder, 'completed', 'buyer', buyer);
  },
});

controls.push({
  group: 'state machine',
  name: 'self-transitions are not transitions',
  attempt: "re-stamp an order's status with its current value",
  run: async (db) => {
    const f = await fixtures(db);
    await transition(db, f.paidOrder, 'paid', 'system', null);
  },
});

controls.push({
  group: 'money',
  name: 'a full-amount payment is accepted',
  attempt: 'record a captured payment equal to the order total',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ total_minor: number; currency_code: string }>(
      'SELECT total_minor, currency_code FROM orders WHERE id = $1', [f.paidOrder]
    );
    const order = rows[0];
    if (!order) throw new Error('paid order disappeared');
    // Roll the payment back to pending first so this is a genuine capture, not
    // an update of an existing succeeded row.
    await db.query(
      `UPDATE payments SET state = 'pending', succeeded_at = NULL, amount_minor = $2
        WHERE order_id = $1`, [f.paidOrder, order.total_minor]
    );
    await db.query(
      `UPDATE payments SET state = 'succeeded', succeeded_at = now() WHERE order_id = $1`,
      [f.paidOrder]
    );
  },
});

controls.push({
  group: 'ownership',
  name: 'the buyer may review their own delivered order',
  attempt: 'insert a review as the buyer on a completed order',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ id: string; buyer_id: string; seller_id: string }>(
      'SELECT id, buyer_id, seller_id FROM orders WHERE id = $1', [f.completedOrder]
    );
    const order = rows[0];
    if (!order) throw new Error('completed order disappeared');
    // The seed already reviews every completed order, so clear one inside this
    // sandbox to obtain an unreviewed one. Rolled back with everything else.
    await db.query('DELETE FROM reviews WHERE order_id = $1', [order.id]);
    await db.query(
      `INSERT INTO reviews (order_id, author_id, subject_seller_id, rating, body)
       VALUES ($1, $2, $3, 5, 'Control proof: a legitimate review.')`,
      [order.id, order.buyer_id, order.seller_id]
    );
  },
});

controls.push({
  group: 'money',
  name: 'zero tax is legal',
  attempt: 'add a line to a tax-exempt product with a 0 bp rate',
  run: async (db) => {
    const f = await fixtures(db);
    const { rows } = await db.query<{ id: string; name: string; price_minor: number }>(
      `SELECT id, name, price_minor FROM products WHERE tax_rate_bp = 0 AND status = 'active' LIMIT 1`
    );
    const product = rows[0];
    if (!product) throw new Error('no tax-exempt product in the seed');
    const { rows: sellerRows } = await db.query<{ seller_id: string }>(
      'SELECT seller_id FROM products WHERE id = $1', [product.id]
    );
    const seller = sellerRows[0];
    if (!seller) throw new Error('product has no seller');
    await db.query(
      `INSERT INTO orders (buyer_id, seller_id, currency_code, subtotal_minor, tax_minor,
                           shipping_minor, total_minor, shipping_name, shipping_line1,
                           shipping_city, shipping_country_code, idempotency_key)
       VALUES ($1, $2, 'NGN', $3, 0, 0, $3, 'Control Buyer', '1 Control Way',
               'Lagos', 'NG', 'control-proof-zero-tax')`,
      [f.otherBuyer, seller.seller_id, product.price_minor]
    );
    const { rows: orderRows } = await db.query<{ id: string }>(
      `SELECT id FROM orders WHERE idempotency_key = 'control-proof-zero-tax'`
    );
    const order = orderRows[0];
    if (!order) throw new Error('control order was not created');
    await db.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, unit_price_minor,
                                tax_rate_bp, quantity, line_total_minor, line_tax_minor)
       VALUES ($1, $2, $3, $4, 0, 1, $4, 0)`,
      [order.id, product.id, product.name, product.price_minor]
    );
  },
});

// ===========================================================================
// Runner
// ===========================================================================
interface Outcome {
  group: string;
  name: string;
  attempt: string;
  passed: boolean;
  expected: string;
  actual: string;
}

function describe(v: Violation): string {
  return [v.constraint, v.code].filter(Boolean).join(' / ') || '(no SQLSTATE)';
}

function reason(v: Violation): string {
  return (v.message ?? '').split('\n').at(0)?.slice(0, 110) ?? '';
}

async function main(): Promise<void> {
  const pg = await openDb();
  const db: Db = { query: pg.query, exec: pg.exec };

  const outcomes: Outcome[] = [];

  for (const proof of proofs) {
    const expected = [proof.constraint, proof.sqlstate].filter(Boolean).join(' / ');
    try {
      await sandbox(db, proof.run);
      outcomes.push({
        group: proof.group,
        name: proof.name,
        attempt: proof.attempt,
        passed: false,
        expected,
        actual: 'SUCCEEDED -- the database accepted an invalid state',
      });
    } catch (error) {
      const v = error as Violation;
      const actual = describe(v);
      const constraintOk = !proof.constraint || v.constraint === proof.constraint;
      const stateOk = !proof.sqlstate || v.code === proof.sqlstate;
      const passed = constraintOk && stateOk;
      outcomes.push({
        group: proof.group,
        name: proof.name,
        attempt: proof.attempt,
        passed,
        expected,
        actual: `${passed ? '' : `WANT ${expected} but got `}${actual} -- ${reason(v)}`,
      });
    }
  }

  for (const control of controls) {
    try {
      await sandbox(db, control.run);
      outcomes.push({
        group: control.group,
        name: control.name,
        attempt: control.attempt,
        passed: true,
        expected: 'accepted',
        actual: 'accepted',
      });
    } catch (error) {
      const v = error as Violation;
      outcomes.push({
        group: control.group,
        name: control.name,
        attempt: control.attempt,
        passed: false,
        expected: 'accepted',
        actual: `REJECTED -- ${describe(v)} ${reason(v)}`,
      });
    }
  }

  // Grouped output, so the shape of the coverage is visible at a glance.
  let lastGroup = '';
  for (const o of outcomes) {
    if (o.group !== lastGroup) {
      console.log(`\n  ${o.group.toUpperCase()}`);
      lastGroup = o.group;
    }
    const mark = o.passed ? '  PASS' : '  FAIL';
    console.log(`${mark}  ${o.name}`);
    console.log(`        rejected: ${o.attempt}`);
    console.log(`        ${o.actual}`);
  }

  const failed = outcomes.filter((o) => !o.passed);
  console.log(
    `\n  ${outcomes.length - failed.length}/${outcomes.length} checks passed ` +
      `(${proofs.length} must-reject, ${controls.length} must-accept)\n`
  );

  if (failed.length > 0) {
    console.log(`  ${failed.length} FAILED:`);
    for (const f of failed) console.log(`    - ${f.name}: ${f.actual}`);
    console.log('');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
