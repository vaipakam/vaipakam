import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Lint for apps/alpha02 (#1516). Scoped DELIBERATELY to the correctness
// rules that a type-checker cannot see, not to style.
//
// The motivating defect: #1511 shipped a `useCallback` below the page's
// loading/not-found early returns, so the hook was skipped on the first
// render and called on the second — "Rendered more hooks than during the
// previous render", a hard crash on every load of the position page. It
// survived fourteen review rounds, `tsc -b --noEmit`, the production
// build and a green preview deploy, because none of those can see it.
// `react-hooks/rules-of-hooks` catches it in under a second.
//
// A full style ruleset over an existing codebase is a separate, noisier
// change; keeping this narrow is what lets it be enforcing from day one
// instead of advisory forever.
export default defineConfig([
  globalIgnores(['dist', 'node_modules', '.wrangler', 'playwright-report']),
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Everything from the recommended sets is advisory here — the
      // point of this config is the hooks rules below. Turning the
      // style/typing opinions on over an existing codebase would bury
      // the signal we actually added this for.
      ...Object.fromEntries(
        Object.keys({
          ...js.configs.recommended.rules,
        }).map((r) => [r, 'off']),
      ),
      // …with the narrow exceptions that catch real bugs rather than
      // taste. Each of these is a "this code cannot be doing what its
      // author meant" rule.
      'no-cond-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable': 'error',
      'require-atomic-updates': 'off', // too noisy on async React handlers
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off', // tsc already covers this
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  // The reason this config exists.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // Take EVERY rule the recommended set turns on and drop it to a
      // warning, then re-assert the one that blocks. Derived rather
      // than hand-listed on purpose: the v7 recommended set enables 16
      // rules, 12 of them as errors, and naming the deferred ones
      // individually would silently start blocking the moment the
      // plugin adds a seventeenth (#1529 review — an earlier draft of
      // this file downgraded three and left nine erroring, which
      // contradicted the policy stated above).
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.flat.recommended.rules ?? {}).map(
          (rule) => [rule, 'warn'],
        ),
      ),

      // ERROR, and clean at zero violations as of this commit — so it
      // is enforcing from day one rather than a backlog that never
      // gets paid down. This is the rule that would have caught the
      // #1511 crash, and the only one this config blocks on.
      'react-hooks/rules-of-hooks': 'error',
    },
  },
])
