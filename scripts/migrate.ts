/**
 * Migration runner.
 *
 * Applies every `db/migrations/*.sql` file in filename order, exactly once,
 * inside a transaction, and records what it applied in `schema_migrations`.
 *
 * Two properties matter more than they look:
 *
 *  1. **A migration runs in a transaction, or not at all.** Every file here is
 *     transactional DDL, so a failure halfway through rolls the whole file
 *     back. Without that, a failed `007` would leave a half-applied schema that
 *     no later run could fix, because the runner would consider the file
 *     applied.
 *
 *  2. **The version row is written in the same transaction as the DDL.** A
 *     crash between "DDL committed" and "version recorded" is the classic way a
 *     migration runner double-applies. Keeping both in one transaction makes
 *     the state unrepresentable.
 *
 * PGlite holds an exclusive lock on its data directory, so this script cannot
 * run while `next dev` is up. That is intentional: it fails loudly rather than
 * letting a seed half-apply against a live server.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataPath, openConn } from './lib/db.ts';

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

interface AppliedRow {
  version: string;
}

async function main(): Promise<void> {
  const db = await openConn();

  // Bootstrap. Created outside the migration history because it is the runner's
  // own bookkeeping, not part of the domain schema.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await db.query<AppliedRow>(
    'SELECT version FROM schema_migrations'
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  const target =
    process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === ''
      ? dataPath()
      : process.env.DATABASE_URL;

  console.log(`\nMigrating ${target}`);
  console.log(`  ${files.length} migration file(s), ${appliedSet.size} already applied\n`);

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  = ${file} (already applied)`);
      continue;
    }

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    // Checksum guards against a migration being edited after it shipped. A
    // mismatch is fatal rather than ignorable: silently accepting it would
    // mean the file in the repo and the schema in the database have diverged,
    // and nobody would find out until the divergence caused an incident.
    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);

    const started = Date.now();
    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query(
          `INSERT INTO schema_migrations (version, checksum, duration_ms)
           VALUES ($1, $2, $3)`,
          [file, checksum, Date.now() - started]
        );
      });
    } catch (error) {
      const err = error as { code?: string; message?: string; detail?: string; hint?: string };
      console.error(`\n  FAILED ${file}`);
      console.error(`    SQLSTATE ${err.code ?? '(none)'}: ${err.message ?? String(error)}`);
      if (err.detail) console.error(`    detail: ${err.detail}`);
      if (err.hint) console.error(`    hint:   ${err.hint}`);
      console.error('\n  The file was rolled back; the database is unchanged.\n');
      process.exit(1);
    }

    const ms = Date.now() - started;
    console.log(`  + ${file} (${ms}ms)`);
    count += 1;
  }

  // Verify recorded checksums for already-applied files. Cheap, and it turns a
  // silent history rewrite into a build failure.
  const { rows: history } = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations'
  );
  for (const row of history) {
    const file = resolve(MIGRATIONS_DIR, row.version);
    let current = '';
    try {
      const { createHash } = await import('node:crypto');
      current = createHash('sha256')
        .update(readFileSync(file, 'utf8'))
        .digest('hex')
        .slice(0, 16);
    } catch {
      continue;
    }
    if (current !== row.checksum) {
      console.error(
        `\n  CHECKSUM MISMATCH for ${row.version}\n` +
          `    applied: ${row.checksum}\n` +
          `    on disk: ${current}\n` +
          '  A migration file was modified after it was applied.\n'
      );
      process.exit(1);
    }
  }

  console.log(
    count === 0
      ? '  Database already up to date.\n'
      : `  Applied ${count} migration(s).\n`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
