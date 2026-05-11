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
