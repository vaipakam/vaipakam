import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  // The /help routes import the canonical user-guide Markdown files
  // from `../docs/` via `?raw`. Vite's dev server defaults to
  // restricting fs reads to the project root; allow one level up so
  // those imports resolve in `npm run dev`. Production builds bundle
  // the file content so this setting has no effect there.
  server: {
    fs: {
      allow: ['..'],
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/contracts/abis/**',
        'src/**/*.css',
        // External REST API client + its thin React wrapper — covering
        // these adds no signal (they're all fetch / pagination / rate-limit
        // plumbing against a third-party service).
        'src/lib/coingecko.ts',
        'src/hooks/useCoinGecko.ts',
        // Live Ethereum event-log indexer. Only exercised meaningfully
        // against a real RPC provider with historical logs.
        'src/lib/logIndex.ts',
        'src/hooks/useLogIndex.ts',
        // On-chain escrow / lock interaction hooks — thin wrappers over
        // Diamond reads; integration-tested via Foundry, not vitest.
        'src/hooks/useEscrowRental.ts',
        'src/hooks/useEscrowUpgrade.ts',
        'src/hooks/usePositionLock.ts',
        // Pure render of usePositionLock output; no logic.
        'src/components/app/TransferLockWarning.tsx',
      ],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 100,
        branches: 90,
      },
    },
  },
})