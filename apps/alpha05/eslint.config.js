import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Lint for apps/alpha05. The same shape as apps/app's config (#1516): every
// preset is flattened to advisory FIRST and the rules this app blocks on
// are re-asserted after, so a preset gaining a rule never quietly starts
// failing `typecheck`. Scoped to correctness rules a type-checker cannot
// see. Verify with `npx eslint --print-config src/main.tsx`.

const rulesOf = (preset) =>
  (Array.isArray(preset) ? preset : [preset]).flatMap((c) => Object.keys(c?.rules ?? {}))

const BLOCKING_CORE = {
  'no-cond-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unreachable': 'error',
  'no-restricted-syntax': [
    'error',
    {
      // viem's `multicall({ allowFailure: true })` reports a provider failure
      // as every call failing (#2996). A failure-tolerant aggregate goes
      // through the shared reads module, which tells the two apart.
      selector:
        "CallExpression[callee.property.name='multicall'] Property[key.name='allowFailure'][value.value=true]",
      message:
        'Read a failure-tolerant aggregate through src/shared/reads: viem multicall reports a provider failure as every call failing.',
    },
    {
      // RB-RAILS — a deadline is never computed from start + duration in app
      // code; it is read from the protocol's clock view, which credits paused
      // time (#668 / #935, owner decision D2).
      selector: "BinaryExpression[operator='*'] > MemberExpression[property.name='durationDays']",
      message: 'Never compute a deadline from durationDays; read the loan clock view (LibLoanClock) instead.',
    },
  ],
}

const BLOCKING_HOOKS = {
  // All five promoted from day one: this app starts at zero violations and
  // stays there, instead of inheriting a sweep.
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/refs': 'error',
  'react-hooks/exhaustive-deps': 'error',
  'react-hooks/set-state-in-effect': 'error',
  'react-hooks/purity': 'error',
}

export default defineConfig([
  globalIgnores(['dist', 'node_modules', '.wrangler']),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs', 'e2e/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...Object.fromEntries(
        [...rulesOf(js.configs.recommended), ...rulesOf(tseslint.configs.recommended)].map((rule) => [
          rule,
          'off',
        ]),
      ),
      ...BLOCKING_CORE,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      ...Object.fromEntries(
        rulesOf(reactHooks.configs.flat.recommended).map((rule) => [rule, 'warn']),
      ),
      ...BLOCKING_HOOKS,
    },
  },
])
