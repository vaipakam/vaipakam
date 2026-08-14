import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Grouped `case` labels that share one body are idiomatic, and the rule
      // already permits them — but only while the case is EMPTY, and a comment
      // between two labels stops it counting as empty. `LoanTimeline.tsx`
      // groups a dozen event kinds onto one icon and documents WHY two of them
      // joined the group (`#393 v1-d.2`, `T-090 Sub 3`); those two notes, and
      // nothing else, are what the rule was reporting.
      //
      // This does NOT weaken the check that matters. Verified against a probe:
      // a case carrying an actual statement and falling into the next is still
      // reported. Only label groups with no body are allowed through — which
      // is the construct the code is using.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // Honour the leading-underscore convention this codebase already
      // writes. Six declarations were named `_hasActiveListing`, `_knob`,
      // `_drop`, `_anchor` and `_id` — the conventional way to say "bound
      // deliberately, not used" for a destructured field, a placeholder
      // parameter, or a discarded tuple slot. `no-unused-vars` has no such
      // convention by default, so it flagged all six and the intent written
      // into the names counted for nothing.
      //
      // `caughtErrors: 'all'` keeps a silently swallowed `catch (e)` reported
      // unless it is spelled `_e`; the ignore pattern is a way to state
      // intent, not a way to opt out of the rule.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Ban direct `usePublicClient` from wagmi. Bare wagmi returns the
      // WALLET-current chain's client, which diverges from the app-
      // selected chain (ChainContext) whenever the user changes the
      // chain dropdown ahead of their wallet's chain switch. Every
      // probe / read / multicall that picks up the wrong client then
      // hits the previous chain's RPC against the new chain's
      // addresses. Use `useDiamondPublicClient` (in
      // `contracts/useDiamond.ts`) — it pins to chain.chainId and
      // provides a transport-only http fallback.
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'wagmi',
          importNames: ['usePublicClient'],
          message:
            'Use `useDiamondPublicClient` from `contracts/useDiamond` instead. ' +
            'Bare wagmi usePublicClient returns the wallet-current chain client, ' +
            'which diverges from the app-selected chain on dropdown switch ahead ' +
            'of the wallet switch.',
        }],
      }],
    },
  },
  // Carve-out: useDiamond.ts is the canonical home of the wrapper —
  // it MUST import `usePublicClient` from wagmi to build the wrapper.
  // Suppress the rule there so the wrapper definition compiles.
  {
    files: ['src/contracts/useDiamond.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
])
