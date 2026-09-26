/**
 * app e2e ("fork tier" by name; no longer a fork — #2334). Runs the real
 * app (vite dev server) against a local anvil carrying the repository's
 * CURRENT contracts, deployed from source by global setup and presented as
 * Base Sepolia, plus a chain-hydrated indexer stub; the injected test
 * wallet signs with ephemeral per-run keys. See
 * docs/TestScopes/Alpha02RegressionFlows.md for the flow inventory
 * this suite enforces.
 *
 * Serial on purpose: scenarios share one chain and create real chain
 * state; workers>1 would race nonces and offer books.
 */
import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// One id per suite run (#2334). Global setup stamps it beside the e2e
// deployments bundle it writes, and every reader — the app through vite,
// the harness through `e2e/lib/artifacts.ts` — accepts the bundle only
// under this id, so a file left by an earlier run can never be read as
// this run's. `??=` because Playwright evaluates this config again in each
// worker, and a worker must keep the id its parent chose (workers inherit
// the parent's environment).
process.env.APP_E2E_RUN_ID ??= randomUUID();

const STUB_PORT = Number(process.env.APP_E2E_STUB_PORT ?? 8788);
// Single source for the anvil RPC the BROWSER talks to — must match
// the anvil instance global-setup spawns (see e2e/lib/anvil.ts).
const ANVIL_URL = process.env.APP_E2E_ANVIL_URL ?? 'http://127.0.0.1:8545';

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
    // plugin disabled via APP_E2E — workerd startup stalled the
    // first CI run's 120s readiness window with zero output.
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 240_000,
    // Never reuse a server that happens to sit on the port: it would
    // have been started WITHOUT the e2e env below (public RPC +
    // production indexer) while the injected wallet signs on anvil —
    // silently misleading local results. --strictPort makes the clash
    // a loud failure instead.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      APP_E2E: '1',
      APP_E2E_RUN_ID: process.env.APP_E2E_RUN_ID,
      VITE_DEFAULT_CHAIN_ID: '84532',
      VITE_BASE_SEPOLIA_RPC_URL: ANVIL_URL,
      VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
    },
  },
});
