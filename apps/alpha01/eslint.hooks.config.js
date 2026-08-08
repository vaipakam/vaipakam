/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this is separate from the app's own `eslint.config.js` (#1521)
 * -----------------------------------------------------------------
 * `apps/alpha01` HAS a full config with the react-hooks plugin, but
 * its `typecheck` script never ran it and CI never typechecked the
 * app at all — so the config was decorative. Wiring `eslint .` in
 * wholesale would fail on a real backlog of react-hooks v7 findings
 * (`set-state-in-effect`, `preserve-manual-memoization`) unrelated to
 * hook ORDER.
 *
 * This enforces the one rule the app is already clean against, so the
 * v7 backlog can be worked separately without leaving hook order
 * unguarded in the meantime.
 *
 * When the v7 backlog is cleared, run the full `eslint .` in
 * `typecheck` and delete this file.
 */
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `scripts/**` are Node build scripts, not React code — nothing in
  // them can violate the rules of hooks. They are ignored so their
  // `no-console` disable comments don't surface as unused-directive
  // warnings from a guard that deliberately enables no such rule.
  globalIgnores(['dist', 'scripts/**']),
  {
    files: ['**/*.{ts,tsx}'],
    // The other two plugins are REGISTERED but none of their rules are
    // enabled. Without registration, every existing
    // `eslint-disable-next-line @typescript-eslint/no-explicit-any` /
    // `react-refresh/only-export-components` in the source becomes a
    // hard "Definition for rule ... was not found" error, and the
    // guard fails for reasons that have nothing to do with hooks. (www
    // carries such comments even though nothing has ever linted it.) A
    // guard that reports problems it does not care about is one people
    // learn to ignore.
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      '@typescript-eslint': tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2020,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // Those same disable comments ARE unused here, by design — the
      // rules they suppress are off. Reporting them would add 33
      // warnings saying nothing about hook order.
      reportUnusedDisableDirectives: 'off',
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
])
