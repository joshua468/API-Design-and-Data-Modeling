/**
 * Runs the five workflow queries and proves the indexes are used.
 *
 * The task asks for five queries, one per important action, and a query plan on
 * the two heaviest showing that the documented indexes are actually used. Both
 * halves of that have a trap, and both traps are handled explicitly here rather
 * than papered over.
 *
 * TRAP 1: the .sql files are the source of truth, not a copy in this file.
 * `db/queries/*.sql` are readable on their own and can be pasted into psql. If
 * this runner carried its own copy of the SQL, the two would drift and the
 * evidence would be evidence about a query nobody runs. So the runner reads the
 * files, splits them, and supplies bindings. The only thing defined here is
 * which bindings each file gets, resolved by description rather than by a
 * hard-coded id so the runner keeps working when the seed is re-shaped.
 *
 * TRAP 2: a 14-row table gets a sequential scan, and that is the planner
 * being correct.
 *
 * The seed is deliberately small -- the task asks for a small dataset -- but
 * PostgreSQL will scan 14 rows rather than walk a b-tree, because a scan of 14
 * rows really is cheaper than a b-tree descent. EXPLAIN on the seeded database
 * therefore reports `Seq Scan`, and reporting that as "my index is unused" would
 * be a false negative; reporting it as "my index works" would be a lie.
 *
 * So the plan is measured twice, and both results are printed:
 *
 *   Phase A -- the seeded database, exactly as shipped. Whatever the planner
 *              says here is the truth about 14 rows, and it is reported even
 *              though it is not the evidence anyone wants.
 *   Phase B -- the same query against ~10-20k synthetic rows loaded inside a
 *              transaction that is then ROLLED BACK. The seeded database is
 *              untouched, and the plan at realistic cardinality is the plan
 *              that matters.
 *
 * Phase B is what the "index use" claim rests on, and the runner asserts it
 * rather than asking the reader to eyeball it: the named index must appear and
 * a sequential scan on the driving table must not. `SET enable_seqscan = off`
 * would produce a flattering plan and prove nothing, so it is not used anywhere
 * in this file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, type Queryable } from './lib/db.ts';

const QUERIES_DIR = resolve(process.cwd(), 'db/queries');

/** The five important actions from the requirements page, in order. */
interface QueryFile {
  readonly file: string;
  readonly action: string;
  readonly answers: string;
  /**
   * Bindings, one array *per statement* in the file, in $1, $2, ... order.
   *
   * Per-statement rather than one shared array because parameter *types* are
   * per-statement: in 05 the first statement's $2 is an `order_code_t` and the
   * second's $2 is a `limit` integer. Sharing one array would mean lying to the
   * type system. Each inner array is what that statement actually expects.
   */
  readonly bindings: (db: Queryable) => Promise<readonly (readonly unknown[])[]>;
  /** Set on the two heaviest: measured in Phase A and Phase B, and asserted. */
  readonly heavy?: {
    readonly index: string;
    readonly table: string;
  };
}

// ---------------------------------------------------------------------------
// Statement splitting
// ---------------------------------------------------------------------------

/**
 * Splits a .sql file into statements.
 *
 * Quote- and comment-aware, because splitting on `;` alone would corrupt any
 * statement containing a semicolon inside a string literal -- and this
 * directory's files do. A naive split here would produce confusing syntax
 * errors that look like a bug in the query rather than in the runner.
 *
 * Not a full SQL parser, and does not need to be: it is correct for the
 * statement forms these files use (plain SELECTs with string literals, and
 * `--` comments) and it will not silently mangle a `$$`-quoted body, it will
 * just split inside one. The DO block that matters for the migration lives in
 * db/migrations, which this runner does not read.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1]!;

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        buf += ch;
      }
      continue;
    }
    if (inString) {
      buf += ch;
      if (ch === "'") {
        if (next === "'") {
          buf += next;
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === ';') {
      if (buf.trim() !== '') out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') out.push(buf.trim());
  return out;
}

// ---------------------------------------------------------------------------
// Fixture resolution
// ---------------------------------------------------------------------------

interface Fixtures {
  readonly category: string;
  readonly sellerId: string;
  readonly buyerId: string;
  readonly orderId: string;
  readonly publicCode: string;
  readonly provider: string;
  readonly providerReference: string;
}

async function one<T>(db: Queryable, sql: string, params: readonly unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`fixture query returned no rows:\n  ${sql.trim()}`);
  }
  return row;
}

async function resolveFixtures(db: Queryable): Promise<Fixtures> {
  // A category that actually has active products, so the browse query has a
  // filter to use. A category matching nothing would return no rows and
  // therefore no plan nodes to inspect at all.
  const cat = await one<{ category: string }>(
    db,
    `SELECT p.category
       FROM products p
       JOIN seller_profiles sp ON sp.user_id = p.seller_id
      WHERE p.status = 'active' AND sp.status = 'active'
      GROUP BY p.category
      ORDER BY count(*) DESC, p.category
      LIMIT 1`
  );

  const seller = await one<{ user_id: string }>(
    db,
    `SELECT user_id FROM seller_profiles WHERE status = 'active' ORDER BY created_at, user_id LIMIT 1`
  );

  const buyer = await one<{ id: string }>(
    db,
    `SELECT id FROM users WHERE role = 'buyer' AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1`
  );

  // An order that has line items, because 05 asserts against `order_items` and
  // an order with no lines proves nothing.
  const order = await one<{ id: string; public_code: string }>(
    db,
    `SELECT o.id, o.public_code
       FROM orders o
      WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)
      ORDER BY o.created_at, o.id
      LIMIT 1`
  );

  const payment = await one<{ provider: string; provider_reference: string }>(
    db,
    `SELECT provider, provider_reference
       FROM payments
      WHERE provider_reference IS NOT NULL
      ORDER BY created_at
      LIMIT 1`
  );

  return {
    category: cat.category,
    sellerId: seller.user_id,
    buyerId: buyer.id,
    orderId: order.id,
    publicCode: order.public_code,
    provider: payment.provider,
    providerReference: payment.provider_reference,
  };
}

/**
 * The seller whose queue is non-empty.
 *
 * Resolved separately from the first active seller because it is not
 * necessarily the same one, and 04's index is partial on `status = 'pending'`:
 * binding it to a seller with no pending orders would return an empty result
 * and prove nothing.
 */
async function queueSellerId(db: Queryable): Promise<string> {
  const r = await one<{ seller_id: string }>(
    db,
    `SELECT seller_id FROM orders WHERE status = 'pending' ORDER BY created_at, seller_id LIMIT 1`
  );
  return r.seller_id;
}

// ---------------------------------------------------------------------------
// The five action queries, plus the supporting reads
// ---------------------------------------------------------------------------

const QUERY_FILES: QueryFile[] = [
  {
    file: '01_browse_products.sql',
    action: '1. A buyer browses the catalogue',
    answers: 'A filtered, price-sorted, paginated page of active products.',
    bindings: async (db) => {
      const f = await resolveFixtures(db);
      return [[f.category, 10, 0, null]];
    },
    heavy: { index: 'products_category_browse_idx', table: 'products' },  },
  {
    file: '02_seller_catalog.sql',
    action: '2. A buyer opens a shop page',
    answers: "One seller's active products, newest first.",
    bindings: async (db) => {
      const f = await resolveFixtures(db);
      return [[f.sellerId, 10, 0]];
    },
  },
  {
    file: '03_buyer_orders.sql',
    action: '3. A buyer checks what they have ordered',
    answers: "A buyer's orders, newest first, with an item count per order.",
    bindings: async (db) => {
      const f = await resolveFixtures(db);
      return [[f.buyerId, null, 10, 0]];
    },
  },
  {
    file: '04_seller_orders.sql',
    action: '4. A seller works their queue',
    answers: "The seller's actionable orders, oldest first (FIFO).",
    bindings: async (db) => [[await queueSellerId(db), 10, 0]],
    heavy: { index: 'orders_seller_queue_idx', table: 'orders' },
  },
  {
    file: '05_order_detail.sql',
    action: '5. A buyer opens one order',
    answers: 'The order, its line items, and its payment history.',
    // Three statements, three parameter lists. Each numbers from $1 with no
    // gaps, because PostgreSQL infers a parameter's type from its use site and
    // rejects a skipped $2 with 42P18. Statement 1 resolves the order by uuid OR
    // public code; statements 2 and 3 address it by uuid alone.
    bindings: async (db) => {
      const f = await resolveFixtures(db);
      return [
        [f.orderId, f.publicCode],
        [f.orderId, 50, 0],
        [f.orderId, 50, 0],
      ];
    },
  },
  {
    file: '06_payment_lookup.sql',
    action: 'Supporting: resolve a provider webhook',
    answers: 'The payment and its order, from a provider reference.',
    bindings: async (db) => {
      const f = await resolveFixtures(db);
      return [[f.provider, f.providerReference]];
    },
  },
  {
    file: '07_seller_reviews.sql',
    action: "Supporting: a buyer reads a seller's reviews",
    answers: 'Live reviews newest first, plus the maintained rating aggregate.',
    bindings: async (db) => {
      const f = await resolveFixtures(db);
      return [
        [f.sellerId, 10, 0],
        [f.sellerId],
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// Scaling, for Phase B
// ---------------------------------------------------------------------------

const SCALE_PRODUCTS = 20_000;
const SCALE_ORDERS = 10_000;

/**
 * Loads synthetic rows so the planner sees realistic cardinality, then the
 * caller rolls the transaction back.
 *
 * Every row is a *valid* row, not a shortcut around the constraints. That is
 * the point: this script must not be the reason a constraint is unproven. Each
 * insert satisfies the same CHECKs and fires the same triggers a real import
 * would, and the money on the synthetic orders is arithmetically consistent
 * with its line items so that `orders_totals_match_items` has nothing to
 * complain about.
 *
 * The orders are all 'pending' on purpose. That status is skipped by
 * guard_added_line_totals (004:701) -- a pending order is a basket under
 * construction, so its totals are legitimately provisional. Loading them any
 * other way would trip the very invariant this repository is built to prove.
 */
async function loadScaleData(db: Queryable): Promise<void> {
  const f = await resolveFixtures(db);

  await db.query(
    `INSERT INTO products
       (seller_id, name, slug, description, price_minor, currency_code,
        tax_rate_bp, status, stock_policy, stock_quantity, category)
     SELECT sp.user_id,
            'Scale product ' || n,
            'scale-product-' || n,
            'Synthetic catalogue row generated to give the planner realistic cardinality.',
            1000 + n,
            sp.payout_currency,
            750,
            'active',
            'tracked',
            100,
            $1
       FROM generate_series(1, $2) AS n
       CROSS JOIN LATERAL (
            SELECT user_id, payout_currency
              FROM seller_profiles
             WHERE status = 'active'
             ORDER BY user_id
             LIMIT 1
       ) sp`,
    [f.category, SCALE_PRODUCTS]
  );

  // One pending order per row, each with exactly one line whose totals agree
  // with the order header. `order_items` is inserted in the same transaction.
  await db.query(
    `INSERT INTO orders
       (buyer_id, seller_id, status, currency_code,
        subtotal_minor, tax_minor, shipping_minor, total_minor,
        shipping_name, shipping_line1, shipping_city, shipping_country_code,
        idempotency_key)
     SELECT $1,
            $2,
            'pending',
            $3,
            5000, 0, 0, 5000,
            'Scale Buyer', '1 Scale Street', 'Lagos', 'NG',
            'scale-order-key-' || n
       FROM generate_series(1, $4) AS n`,
    [f.buyerId, await queueSellerId(db), 'NGN', SCALE_ORDERS]
  );

  await db.query(
    `INSERT INTO order_items
       (order_id, product_id, name_snapshot, unit_price_minor,
        tax_rate_bp, quantity, line_total_minor, line_tax_minor)
     SELECT o.id,
            p.id,
            'Scale product',
            5000,
            0,
            1,
            5000,
            0
       FROM orders o
       JOIN LATERAL (
            SELECT id FROM products
             WHERE status = 'active'
             ORDER BY id
             LIMIT 1
       ) p ON TRUE
      WHERE o.idempotency_key LIKE 'scale-order-key-%'`
  );
}

// ---------------------------------------------------------------------------
// EXPLAIN
// ---------------------------------------------------------------------------

interface PlanText {
  readonly text: string;
}

async function explain(
  db: Queryable,
  sql: string,
  params: readonly unknown[]
): Promise<PlanText> {
  const { rows } = await db.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`,
    params
  );
  return { text: rows.map((r) => r['QUERY PLAN']).join('\n') };
}

function indent(text: string, pad = '      '): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const pg = await openDb();
  const db: Queryable = pg;

  console.log('\n  FIVE WORKFLOW QUERIES');
  console.log('  =====================\n');

  // ---- Run every file, printing shape rather than full rows --------------
  for (const spec of QUERY_FILES) {
    const path = resolve(QUERIES_DIR, spec.file);
    const statements = splitStatements(readFileSync(path, 'utf8'));
    const paramSets = await spec.bindings(db);

    if (paramSets.length !== statements.length) {
      throw new Error(
        `${spec.file} has ${statements.length} statement(s) but ` +
          `${paramSets.length} binding array(s) were supplied.`
      );
    }

    console.log(`  ${spec.action}`);
    console.log(`    ${spec.answers}`);
    console.log(`    ${spec.file}  (${statements.length} statement(s))`);
    console.log(
      `    bindings: ${paramSets
        .map((p) => `[${p.map((v) => JSON.stringify(v)).join(', ')}]`)
        .join(' ')}`
    );
    console.log('');

    for (const [i, sql] of statements.entries()) {
      const started = Date.now();
      const { rows } = await db.query(sql, paramSets[i]!);
      const ms = Date.now() - started;
      console.log(`    -> [${i}] ${rows.length} row(s) in ${ms}ms`);
      if (rows.length > 0) {
        const first = rows[0] as Record<string, unknown>;
        const preview = Object.entries(first)
          .slice(0, 6)
          .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
          .join(', ');
        console.log(`       first: ${preview}`);
      }
    }
    console.log('');
  }

  // ---- Phase A: the seeded database, reported honestly -------------------
  console.log('  PHASE A -- QUERY PLAN ON THE SEEDED DATABASE');
  console.log('  ==========================================');
  console.log('');
  console.log('  The seed is small on purpose. At this cardinality PostgreSQL is');
  console.log('  correct to prefer a sequential scan, and a b-tree descent over a');
  console.log('  handful of rows is genuinely more expensive. What follows is the');
  console.log('  truthful plan for the shipped data -- not the plan the indexes were');
  console.log('  chosen for, and not the claim being made.');
  console.log('');

  const heavySpecs = QUERY_FILES.filter((q) => q.heavy !== undefined);

  for (const spec of heavySpecs) {
    const statements = splitStatements(readFileSync(resolve(QUERIES_DIR, spec.file), 'utf8'));
    const sql = statements[0]!;
    const params = (await spec.bindings(db))[0]!;
    const plan = await explain(db, sql, params);

    console.log(`  ${spec.action}`);
    console.log(`    expecting index: ${spec.heavy!.index}`);
    console.log(indent(plan.text, '    '));
    console.log('');
  }

  // ---- Phase B: realistic cardinality, rolled back -----------------------
  console.log('  PHASE B -- QUERY PLAN AT REALISTIC CARDINALITY');
  console.log('  ==============================================');
  console.log('');
  console.log(`  Loading ${SCALE_PRODUCTS} products and ${SCALE_ORDERS} orders inside a`);
  console.log('  transaction that is rolled back afterwards, so the seeded database');
  console.log('  is unchanged. Every synthetic row is a valid row: the same CHECKs');
  console.log('  and triggers apply, and the order totals agree with their lines.');
  console.log('');
  console.log('  enable_seqscan is left at its default. Turning it off would produce a');
  console.log('  flattering plan and prove nothing about the shipped schema.');
  console.log('');

  await db.exec('BEGIN');
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const scaleStart = Date.now();
    await loadScaleData(db);
    console.log(`  loaded in ${Date.now() - scaleStart}ms\n`);

    for (const spec of heavySpecs) {
      const statements = splitStatements(readFileSync(resolve(QUERIES_DIR, spec.file), 'utf8'));
      const sql = statements[0]!;
      const params = (await spec.bindings(db))[0]!;
      const plan = await explain(db, sql, params);

      const indexUsed = plan.text.includes(spec.heavy!.index);
      const seqScanned = new RegExp(`Seq Scan on ${spec.heavy!.table}\\b`).test(plan.text);

      console.log(`  ${spec.action}`);
      console.log(`    expecting index: ${spec.heavy!.index}`);
      console.log(indent(plan.text, '    '));
      console.log('');
      console.log(`    index used:    ${indexUsed ? 'YES' : 'NO'}`);
      console.log(`    seq scan on ${spec.heavy!.table}: ${seqScanned ? 'YES' : 'no'}`);
      console.log('');

      checks.push({
        name: `${spec.file} uses ${spec.heavy!.index}`,
        ok: indexUsed && !seqScanned,
        detail: indexUsed
          ? seqScanned
            ? `index present but a Seq Scan on ${spec.heavy!.table} also appears`
            : 'index scan, no sequential scan on the driving table'
          : 'the named index does not appear in the plan',
      });
    }
  } finally {
    await db.exec('ROLLBACK');
    console.log('  ROLLED BACK. The seeded database is untouched.\n');
  }

  // ---- Summary -----------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  console.log('  SUMMARY');
  console.log('  =======');
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`        ${c.detail}`);
  }
  console.log('');
  console.log(
    `  ${checks.length - failed.length}/${checks.length} index checks passed. ` +
      `Phase A output is included above for honesty, not as the claim.`
  );
  console.log('');

  if (failed.length > 0) {
    console.log('  FAILED: the documented index is not the one the planner chose.');
    console.log('');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
