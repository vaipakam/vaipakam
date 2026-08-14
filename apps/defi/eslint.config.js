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
