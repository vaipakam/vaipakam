/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why this app has no other ESLint config (#1521)
 * -----------------------------------------------
 * `apps/www` carried NO lint configuration at all until this file. The
 * gap was found the expensive way: the #1521 fix moved a conditional
 * hook in `apps/defi`'s `LiveValue`, and review pointed out that copy
 * is dead code — the component the docs actually render is this app's,
 * and it still had the violation. A defi-scoped guard could never have
 * seen it, and neither could anything else, because nothing linted www.
 *
 * So the guard is introduced here at the same time as the fix, scoped
 * to the one rule the app is now clean against rather than blocked on
 * standing up a full config for a previously-unlinted app (which would
 * surface an unrelated backlog and stall the fix). It is wired into
 * `pnpm --filter @vaipakam/www typecheck`, which CI already runs.
 *
 * Deliberately NOT a copy of another app's config with rules switched
 * off: that would drift. It declares only what it needs.
 *
 * When www gets a full config, fold this rule into it and delete the
 * file — the guard belongs there, not here.
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
