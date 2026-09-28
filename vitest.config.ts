import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  // `src/server/env.ts` does `import 'server-only'`, which throws in any process
  // that is not a Next.js server build. The guard is real and worth keeping --
  // it is what stops a secret from reaching the client bundle -- but in a plain
  // Node test process there is no bundle to protect, so the specifier is aliased
  // to an empty module. The exception lives here rather than in the source.
  'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
};

/**
 * Every database-backed test points here rather than at `.pglite`.
 *
 * PGlite locks its data directory exclusively, and the app's handle is cached on
 * `globalThis` for the whole single-fork process. Pointing the tests at the
 * development database would mean `npm test` reads whatever state you last left
 * it in -- and fails outright whenever `next dev` is running.
 */
const testEnv = { PGLITE_DATA_DIR: '.pglite-test' };

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    // Two projects rather than one config with an environment override.
    //
    // `environmentMatchGlobs` did this and is deprecated in Vitest 3, so it
    // printed a warning on every run. More importantly a per-glob environment
    // makes the environment a property of a filename: rename a test and it
    // silently changes runtime. Naming the two environments as projects states
    // the actual split -- DOM for components, plain Node for the data layer.
    //
    // PGlite initialises far more predictably without jsdom's global patching,
    // so the API and constraint tests must stay in the node project.
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'api',
          globals: true,
          environment: 'node',
          env: testEnv,
          // Repeated on each project because the root-level testTimeout is NOT
          // inherited once `projects` is in play. It was silently 5s, and the
          // first database-backed test in a file always pays for warming up an
          // embedded PostgreSQL -- so the suite failed on timing, not on logic.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'components',
          globals: true,
          environment: 'jsdom',
          env: testEnv,
          include: ['tests/**/*.test.tsx'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
    setupFiles: ['./tests/setup.ts'],
    // Builds and seeds `.pglite-test` in a subprocess before any test file
    // runs, because both scripts hold the directory lock until they exit. See
    // tests/global-setup.ts for why this cannot run in-process.
    globalSetup: ['./tests/global-setup.ts'],
    // One worker on purpose. PGlite embeds PostgreSQL and holds an exclusive
    // lock on its data directory, so parallel test files would deadlock on
    // startup rather than fail informatively.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
