/**
 * ESLint flat config.
 *
 * `eslint-config-next` 16 ships native flat configs, so these are spread
 * directly. The previous `FlatCompat` bridge from `@eslint/eslintrc` was not
 * needed and actively broken: bridging `next/core-web-vitals` through the
 * eslintrc validator crashes on a circular structure in the React plugin, so
 * `eslint .` could not run at all.
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      '.pglite/**',
      'next-env.d.ts',
      // Generated EXPLAIN/query evidence, checked in as artefacts rather than
      // hand-written source.
      'evidence/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // The data layer is genuinely untyped at the boundary (PGlite returns
      // unknown column shapes), so rows cross it as `unknown` and are narrowed
      // immediately. `any` would erase that narrowing and is banned outright.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      // Scripts report progress on stdout; that is their output.
      'no-console': 'off',

      // This rule resolves hrefs against a `pages` directory. There is none:
      // the project is App Router only, and the rule cannot map a route to a
      // file without it. Left on it just prints "Pages directory cannot be
      // found" on every run, which trains you to ignore lint output.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
];

export default config;
