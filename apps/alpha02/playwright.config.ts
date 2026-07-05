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
    command: 'pnpm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_DEFAULT_CHAIN_ID: '84532',
      VITE_BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:8545',
      VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
    },
  },
});
