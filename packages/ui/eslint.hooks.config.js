/**
 * A one-rule ESLint config: `react-hooks/rules-of-hooks`, as an error.
 *
 * Why a LIBRARY package needs its own guard (#1521)
 * -------------------------------------------------
 * `packages/ui` is not deployed on its own, and I first used that as
 * the reason to leave it unguarded. That was the wrong test. These
 * components are compiled INTO deployable surfaces — `apps/defi`
 * imports them from eleven files — so a conditional hook here crashes
 * a real page.
 *
 * The per-app guards cannot cover it: each runs `eslint .` from its own
 * directory and does not follow imports across the workspace boundary.
 * Without this file, a conditional hook in a shared component leaves
 * every app's CI green and still breaks the app at runtime.
 *
 * The rule of thumb is "does this code reach a deployed surface", not
 * "is this package deployed".
 *
 * When this package gets a full config, fold this rule into it and
 * delete the file.
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
