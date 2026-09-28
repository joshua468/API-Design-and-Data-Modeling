/**
 * Server-only environment access.
 *
 * Two rules this module exists to enforce:
 *
 *  1. Secrets are read here and nowhere else, so there is exactly one file to
 *     audit for accidental exposure. Nothing in `src/components` may import it.
 *  2. A missing or example value is a startup failure in production, not a
 *     silent default. The most common way a demo secret reaches production is
 *     a fallback expression that nobody reads twice.
 *
 * `import 'server-only'` is the belt to that braces: it is a real package-level
 * guard that turns an accidental client import into a build error rather than a
 * leaked value in the browser bundle.
 */
import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(): void {
  // Next.js loads .env.local for the app itself, but the standalone scripts
  // (migrate, seed, verify-constraints) do not go through Next's runtime. Rather
  // than add a dotenv dependency, parse the two conventional files ourselves.
  // They are read, never written, and never parsed into the client bundle.
  for (const name of ['.env.local', '.env']) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Real environment variables win: a container-injected value must not be
      // clobbered by a checked-out file.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadDotEnv();

const INSECURE = 'dev-only-insecure-secret-change-me';

function readSecret(name: string, fallback: string): string {
  const value = process.env[name];
  if (value && value !== '' && value !== INSECURE) return value;

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${name} must be set to a real secret in production. ` +
        `Refusing to start with a development value.`
    );
  }
  return fallback;
}

export const env = {
  /**
   * Connection string for the networked PostgreSQL server the app runs against.
   *
   * Set this and `next dev`/`next build` use the Prisma data layer (real
   * server). Leave it unset and the app falls back to the embedded PGlite
   * database, which keeps a checkout runnable with no external service. The
   * vitest suite forces the PGlite path regardless, so tests never open a
   * network connection by accident.
   */
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  /** PGlite persists to a directory, not a connection string. */
  dataDir: process.env['PGLITE_DATA_DIR'] ?? '.pglite',
  sessionSecret: readSecret('SESSION_SECRET', INSECURE),
  seedDemoPassword: process.env['SEED_DEMO_PASSWORD'] ?? 'portfolio-demo-password',
  paymentProvider: process.env['PAYMENT_PROVIDER_NAME'] ?? 'stubpay',
  isProduction: process.env['NODE_ENV'] === 'production',
} as const;
