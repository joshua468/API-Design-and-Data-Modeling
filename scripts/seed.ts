/**
 * Seed data entry point (CLI).
 *
 * The dataset itself lives in `src/server/db/seed-data.ts` so the same rows
 * can be produced by the app's cold-start bootstrap without changing the ids,
 * slugs, or order scenarios that `docs/evidence/` and the proofs depend on.
 * This file is only the shell that opens a connection, computes the two things
 * that differ between runners (the password hash and the shipping curve), and
 * prints the summary that `npm run db:seed` reports.
 *
 * Design goals of the dataset are documented beside the data in seed-data.ts:
 *
 *  1. **Constraint-respecting by construction.** The seed is the first thing
 *     that exercises the schema, and it is written to go through the same
 *     triggers the API does -- including the order state machine, which is
 *     advanced one legal edge at a time with a real actor.
 *
 *  2. **Deterministic.** Ids are derived from stable constants and no column
 *     uses `random()` or `now()` for its identity, so the same rows with the
 *     same ids appear on every run.
 *
 *  3. **Diverse on purpose.** Every order status is represented, including the
 *     awkward ones (a cancelled order that was accepted; a refunded order that
 *     had shipped).
 */
import { seedDatabase } from '../src/server/db/seed-data.ts';
import { hashPassword } from '../src/server/auth/password.ts';
import { shippingMinorFor } from '../src/lib/shipping.ts';
import { dataPath, openConn } from './lib/db.ts';

const DEMO_PASSWORD = process.env['SEED_DEMO_PASSWORD'] ?? 'portfolio-demo-password';

async function main(): Promise<void> {
  const db = await openConn();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const target =
    process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === ''
      ? dataPath()
      : process.env.DATABASE_URL;
  console.log(`\nSeeding ${target}`);

  const { counts, statuses } = await seedDatabase(db, {
    passwordHash,
    shippingFor: shippingMinorFor,
  });

  console.log('');
  for (const row of counts) {
    console.log(`  ${row.table_name.padEnd(16)} ${String(row.n).padStart(4)}`);
  }

  console.log('\n  orders by status:');
  for (const row of statuses) {
    console.log(`    ${row.status.padEnd(12)} ${String(row.n).padStart(3)}`);
  }

  console.log(`\n  Demo password for every seeded account: "${DEMO_PASSWORD}"`);
  console.log('  Buyer:  adaeze@example.test   Seller: hello@lagosleatherworks.test\n');
  process.exit(0);
}

main().catch((error) => {
  const err = error as {
    code?: string;
    message?: string;
    detail?: string;
    constraint?: string;
    statement?: string;
  };
  console.error('\nSEED FAILED');
  if (err?.code) console.error(`  SQLSTATE ${err.code}`);
  if (err?.message) console.error(`  ${err.message}`);
  if (err?.constraint) console.error(`  constraint: ${err.constraint}`);
  if (err?.detail) console.error(`  detail:    ${err.detail}`);
  if (err?.statement) console.error(`  statement: ${err.statement}`);
  console.error('');
  process.exit(1);
});