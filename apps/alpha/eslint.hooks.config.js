/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this app has no other ESLint config (#1521)
 * -----------------------------------------------
 * `apps/alpha` is a deployable Worker (`vaipakam-alpha`) that renders
 * React, and it carried NO lint configuration and no CI typecheck at
 * all. It was missed by the first pass of the #1521 sweep, which
 * checked the apps it happened to be working in rather than
 * enumerating `apps/*` — review caught the omission.
 *
 * The app is currently clean of this rule; the guard exists so it
 * stays that way. It is wired into `pnpm --filter @vaipakam/alpha
 * typecheck`, which CI now runs.
 *
 * When this app gets a full config, fold this rule into it and delete
 * the file — the guard belongs there, not here.
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
