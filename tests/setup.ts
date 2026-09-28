/**
 * Test environment setup.
 *
 * Runs for the `components` project (jsdom). The `api` project runs in plain
 * Node and does not need DOM matchers, so the jest-dom import is guarded rather
 * than unconditional: importing it where there is no `document` is at best
 * wasted work and at worst an error, and a setup file that cannot be shared
 * between the two projects is a setup file somebody will eventually copy.
 */
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

export {};
