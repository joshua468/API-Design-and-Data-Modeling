/**
 * Prepares a dedicated database for the test run.
 *
 * WHY A SEPARATE DIRECTORY
 *
 * PGlite takes an exclusive lock on its data directory. The app's handle
 * (`src/server/db/client.ts`) caches itself on `globalThis` and the test files
 * share one process, so the first test file to open a database owns it for the
 * whole run. If that were `.pglite`, the tests would be reading the database you
 * develop against -- and `npm test` would fail outright while `next dev` was
 * running. The tests get `.pglite-test` instead, built from scratch every run.
 *
 * WHY SUBPROCESSES
 *
 * The lock is the whole reason. `scripts/seed.ts` and `scripts/migrate.ts` call
 * `main()` at import time and hold the directory open until they exit, so neither
 * can run in this process alongside the app's handle. Spawning them means each
 * takes the lock, does its work, and releases it on exit -- and it means the
 * tests exercise the *real* seed rather than a fixture maintained separately,
 * which is the only way the fixtures cannot drift from what ships.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEST_DATA_DIR = '.pglite-test';

function run(script: string, dataDir: string): void {
  // The scripts dispatch on `DATABASE_URL` (see scripts/lib/db.ts openConn).
  // The test database must be rebuilt in PGlite no matter what a local
  // `.env.local` says, or `next dev`'s server connection would leak into the
  // suite and the freshly-cleared `.pglite-test` would never be populated. The
  // flag has to win over the file because each subprocess re-reads `.env.local`.
  execFileSync(process.execPath, [resolve(process.cwd(), 'scripts', script)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PGLITE_DATA_DIR: dataDir,
      DB_FORCE_PGLITE: '1',
    },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

export default function setup(): void {
  const dataDir = TEST_DATA_DIR;
  const abs = resolve(process.cwd(), dataDir);

  // Rebuilt from nothing on every run. A test database that survives between
  // runs is a test database whose results depend on what ran before it, and
  // "it passed yesterday" stops being a statement about the code.
  rmSync(abs, { recursive: true, force: true });

  run('migrate.ts', dataDir);
  run('seed.ts', dataDir);
}
