/**
 * alpha02 e2e — fork tier. Runs the real app (vite dev server) against
 * an anvil fork of Base Sepolia and a fork-hydrated indexer stub; the
 * injected test wallet signs with ephemeral per-run keys. See
 * docs/TestScopes/Alpha02RegressionFlows.md for the flow inventory
 * this suite enforces.
 *
 * Serial on purpose: scenarios share one fork and create real chain
 * state; workers>1 would race nonces and offer books.
 */
import { defineConfig } from '@playwright/test';

const STUB_PORT = Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788);
// Single source for the fork RPC the BROWSER talks to — must match
// the anvil instance global-setup spawns (see e2e/lib/anvil.ts).
const ANVIL_URL = process.env.ALPHA02_E2E_ANVIL_URL ?? 'http://127.0.0.1:8545';

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Direct vite invocation (no pnpm indirection) with the Cloudflare
    // plugin disabled via ALPHA02_E2E — workerd startup stalled the
    // first CI run's 120s readiness window with zero output.
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 240_000,
    // Never reuse a server that happens to sit on the port: it would
    // have been started WITHOUT the fork-tier env below (public RPC +
    // production indexer) while the injected wallet signs on anvil —
    // silently misleading local results. --strictPort makes the clash
    // a loud failure instead.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ALPHA02_E2E: '1',
      VITE_DEFAULT_CHAIN_ID: '84532',
      VITE_BASE_SEPOLIA_RPC_URL: ANVIL_URL,
      VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
    },
  },
});
