/**
 * Stands in for the `server-only` package under Vitest.
 *
 * `src/server/env.ts` does `import 'server-only'`, which is a real guard: the
 * package's main entry throws unless it is resolved through React's
 * `react-server` export condition. That is exactly right in a Next.js build and
 * exactly wrong in a plain Node test process, where there is no client bundle to
 * protect -- the import is guarding against nothing.
 *
 * So `vitest.config.ts` aliases the specifier to this file, which does nothing.
 * The alternative is to delete the guard from the source so tests can run, which
 * would remove a protection that stops a secret being bundled into the browser.
 * Aliasing keeps the guard where it belongs and confines the exception to the
 * test runner.
 */
export {};
