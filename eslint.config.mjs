// Flat ESLint config for the whole workspace.
//
// There was no ESLint config in this repo at all. That was survivable under
// ESLint 8, which fell back to built-in defaults; ESLint 9 removed that
// fallback, so every `lint` script failed - and because the CI lint job runs
// first and every other job `needs: lint`, one missing file was hiding the
// test, build, security and docker jobs behind a red X.
//
// The rules below are deliberately scoped to correctness (undefined
// identifiers, unreachable code, broken promises) rather than style. A style
// sweep across a codebase this size would be a separate decision, and a lint
// run nobody can keep green is worth no more than no lint at all.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Build output, vendored code and generated clients are not ours to lint.
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.expo/**',
      '**/generated/**',
      '**/*.d.ts',
      'packages/contracts/artifacts/**',
      'packages/contracts/cache/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2024,
      },
    },
    rules: {
      // This codebase uses `any` at API and SDK boundaries where the upstream
      // types are wrong or absent. Worth seeing, not worth failing a build.
      '@typescript-eslint/no-explicit-any': 'warn',

      // A leading underscore is the established way here to mark a binding as
      // intentionally unused (caught params, destructured rest).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // The base rule double-reports on TypeScript; the plugin version above
      // is the one that understands types and imports.
      'no-unused-vars': 'off',

      // Next.js and Expo both inject globals the base rule cannot see, and
      // TypeScript already catches genuinely undefined identifiers.
      'no-undef': 'off',

      // `empty` catch blocks are used on purpose for best-effort work
      // (telemetry, notifications) that must never break the caller.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // Config and build scripts are plain Node. `require()` is the correct call
    // there - tailwind.config.ts loads its plugins that way by design, and the
    // scripts run through ts-node rather than a bundler.
    files: [
      '**/*.config.{js,cjs,mjs,ts}',
      '**/scripts/**/*.{js,cjs,mjs,ts}',
      'scripts/**/*.{js,cjs,mjs,ts}',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  {
    // shadcn/ui components are generated with `interface Props extends
    // React.XHTMLAttributes<T> {}`. The empty interface is the library's own
    // idiom - it exists so the prop type has a name to extend later - so this
    // is a disagreement with upstream, not a defect in our code.
    files: ['**/components/ui/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },

  {
    // React Native resolves static assets through require(), and the Expo
    // native modules here are required lazily inside handlers on purpose, so
    // importing them at module scope cannot fail the screen on load.
    files: ['apps/mobile/**/*.{ts,tsx,js,jsx}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  {
    files: ['**/*.{test,spec}.{ts,tsx,js,jsx}', '**/__tests__/**'],
    languageOptions: { globals: { ...globals.jest } },
  }
);
