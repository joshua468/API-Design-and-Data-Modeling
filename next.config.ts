import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PGlite is a native/wasm module and must never be pulled into a client
  // bundle. Keeping the server external stops Next from tracing it into the
  // browser graph, which is the failure that otherwise shows up as a confusing
  // "Module not found: fs" at build time.
  serverExternalPackages: ['@electric-sql/pglite'],
  typedRoutes: true,
};

export default nextConfig;
