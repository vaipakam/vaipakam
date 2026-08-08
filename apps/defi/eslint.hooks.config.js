/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this exists separately from `eslint.config.js` (#1521)
 * ---------------------------------------------------------
 * The full config reports ~277 errors on this app today, almost all
 * `no-explicit-any`. That backlog is why no CI job has ever run defi's
 * lint, and that in turn is how a real hook-order crash — the Create
 * Offer cadence field dropping two `useMemo`s when the asset-type
 * dropdown changed — sat in production unnoticed.
 *
 * Fixing the backlog is a separate piece of work. Waiting for it before
 * guarding ANYTHING is what let the crash class survive, so this config
 * enforces the one rule the app is now clean against. It is wired into
 * `pnpm --filter @vaipakam/defi typecheck`, which CI already runs, so a
 * reintroduced conditional hook fails the build instead of shipping.
 *
 * Deliberately NOT a copy of the main config with rules switched off:
 * that would drift. It declares only what it needs.
 *
 * When the `no-explicit-any` backlog is cleared, fold this into the
 * main config and delete the file — the guard belongs there, not here.
 */
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    // The other two plugins are REGISTERED but none of their rules are
    // enabled. Without registration, every existing
    // `eslint-disable-next-line @typescript-eslint/no-explicit-any` /
    // `react-refresh/only-export-components` in the source becomes a
    // hard "Definition for rule ... was not found" error — 9 of them —
    // and the guard fails for reasons that have nothing to do with
    // hooks. A guard that reports problems it does not care about is
    // one people learn to ignore, which is the habit that let defi's
    // lint go unrun for months in the first place.
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
