import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

import { cloudflare } from "@cloudflare/vite-plugin";

// Stamp the current git commit + build timestamp into the bundle so the
// DiagnosticsDrawer's "Frontend build" row can show what code is live.
// Vite picks up `VITE_*` env vars from `process.env` and exposes them as
// `import.meta.env.VITE_*` — assigning here, before `defineConfig`,
// makes them available to source code without any custom `define`.
process.env.VITE_BUILD_HASH = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();
process.env.VITE_BUILD_TIME = new Date().toISOString();


// Deploy-env guard — same as apps/alpha02 (live-review incident
// 2026-07-14): warn on a bare build without VITE_INDEXER_ORIGIN, fail
// when the deploy script sets REQUIRE_INDEXER_ORIGIN=1.
function checkIndexerOrigin(mode: string, command: string): void {
  if (command !== 'build') return;
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (env.VITE_INDEXER_ORIGIN || process.env.VITE_INDEXER_ORIGIN) return;
  const msg =
    'VITE_INDEXER_ORIGIN is not set — this build will run WITHOUT the ' +
    'indexer. Create apps/defi/.env.local before building for deploy.';
  if (process.env.REQUIRE_INDEXER_ORIGIN) {
    throw new Error(`[deploy-env guard] ${msg}`);
  }
  console.warn(`\n[deploy-env guard] WARNING: ${msg}\n`);
}

export default defineConfig(({ mode, command }) => {
  checkIndexerOrigin(mode, command);
  return {
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
    // Cover BOTH the central `test/` suite and source-colocated `*.test.*`
    // files (#1076): a colocated test outside this glob would never run —
    // exactly the silent-rot gap the CI lane exists to close.
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
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
        // On-chain vault / lock interaction hooks — thin wrappers over
        // Diamond reads; integration-tested via Foundry, not vitest.
        'src/hooks/useVaultRental.ts',
        'src/hooks/useVaultUpgrade.ts',
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
};
});
