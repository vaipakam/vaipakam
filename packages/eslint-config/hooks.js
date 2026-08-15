/**
 * The shared `react-hooks/rules-of-hooks` guard (#1601, consolidated in #1609).
 *
 * Five packages carry a narrow hook-order guard instead of a full ESLint
 * config, each for its own reason, each recorded in the header of its own
 * `eslint.hooks.config.js`. Those reasons genuinely differ and are NOT
 * shared — what is shared is the guard itself, which was byte-identical in
 * all five apart from one `globalIgnores` entry.
 *
 * Five copies meant five places to update when the rule set changed and,
 * worse for a guard, five places to quietly weaken the check for one package
 * without it being obvious in review. That drift had already started: three
 * of the copies carried a comment written about `apps/www`, pasted into
 * packages it did not describe.
 *
 * ## Why the guard is shaped the way it is
 *
 * It enables exactly ONE rule, and the two design choices below both exist to
 * keep it that way in practice, not just on paper. Changing either makes the
 * guard report dozens of problems it does not care about — and a guard that
 * cries wolf is one people learn to ignore, which is precisely how these
 * packages' lint came to go unrun in the first place. Do not "tidy" them.
 *
 * 1. `react-refresh` and `@typescript-eslint` are REGISTERED but none of
 *    their rules are enabled. Without registration, every existing
 *    `eslint-disable-next-line @typescript-eslint/no-explicit-any` /
 *    `react-refresh/only-export-components` in the source becomes a hard
 *    "Definition for rule ... was not found" ERROR, and the guard fails for
 *    reasons that have nothing to do with hooks.
 * 2. `reportUnusedDisableDirectives` is off. Those same disable comments ARE
 *    unused here, by design — the rules they suppress are not enabled — and
 *    reporting them would bury the one signal this config exists to surface.
 *
 * ## Verifying a change to this file
 *
 * The guard is proven by MUTATION, never by a green run: reinstate a
 * conditional hook in a consumer and confirm the check names it. A
 * consolidation that silently stopped linting a package would look exactly
 * like success otherwise. See `packages/eslint-config/README.md`.
 */
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Build the hook-order guard for one package.
 *
 * @param {object} [options]
 * @param {string[]} [options.extraIgnores] Paths to ignore on top of `dist`.
 *   Used by packages that keep Node build scripts alongside their React
 *   source: nothing in those can violate the rules of hooks, and they carry
 *   `no-console` disable comments that would otherwise surface as unused
 *   directives from a guard that enables no such rule.
 * @returns {import('eslint').Linter.Config[]}
 */
export default function hooksGuard({ extraIgnores = [] } = {}) {
  return defineConfig([
    globalIgnores(['dist', ...extraIgnores]),
    {
      files: ['**/*.{ts,tsx}'],
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
        reportUnusedDisableDirectives: 'off',
      },
      rules: {
        'react-hooks/rules-of-hooks': 'error',
      },
    },
  ])
}
