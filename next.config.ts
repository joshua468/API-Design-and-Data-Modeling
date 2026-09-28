import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PGlite is a native/wasm module and must never be pulled into a client
  // bundle. Keeping the server external stops Next from tracing it into the
  // browser graph, which is the failure that otherwise shows up as a confusing
  // "Module not found: fs" at build time.
  serverExternalPackages: ['@electric-sql/pglite'],
  // The cold-start bootstrap reads db/migrations/*.sql with readdirSync, which
  // file tracing cannot follow statically. Ship the SQL files alongside the
  // server code so the embedded database can self-seed on a fresh instance.
  outputFileTracingIncludes: {
    '/*': ['./db/migrations/*.sql'],
  },
  typedRoutes: true,
};

export default nextConfig;
