/**
 * alpha05 e2e: the real app (Vite dev server) against a local Anvil carrying
 * the repository's CURRENT contracts, deployed from source by global setup
 * and presented as Base Sepolia (`@vaipakam/anvil-harness`), plus a stand-in
 * for the two Workers the app reads (the indexer's health route and the
 * read-only RPC proxy's route, `e2e/lib/indexer-stub.mjs`); the injected
 * test wallet signs with ephemeral per-run keys. Its own tier, keyed on
 * apps/alpha05 (`.github/workflows/alpha05-e2e.yml`), separate from
 * apps/app's suite.
 *
 * Serial on purpose: scenarios share one chain and create real chain state.
 */
import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// One id per suite run. Global setup stamps it beside the e2e deployments
// bundle it writes, and every reader (the app through Vite, the harness
// through `e2e/lib/artifacts.ts`) accepts the bundle only under this id, so
// a file left by an earlier run can never be read as this run's. `??=`
// because Playwright evaluates this config again in each worker, and a
// worker must keep the id its parent chose.
process.env.APP_E2E_RUN_ID ??= randomUUID();
// `--list` collects specs WITHOUT running global setup, so no chain exists
// and no bundle is stamped; the mark lets the deployment loader answer "no
// deployment" for collection instead of refusing. Keyed to this run's id so
// a value left exported in a shell cannot unlock a real run.
if (process.argv.includes('--list')) process.env.APP_E2E_LIST_ONLY = process.env.APP_E2E_RUN_ID;

/** The stub serves the indexer's routes AND the RPC proxy's `/rpc/:chainId`
 *  route, so one origin stands in for both Workers. Its own port, and
 *  Anvil's, differ from apps/app's so the two suites can run side by side. */
const STUB_PORT = Number(process.env.ALPHA05_E2E_STUB_PORT ?? 8789);
const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;
const APP_PORT = 4175;

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
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // About half of the app's readers are on phones (owner, 2026-11-05), so
  // every spec runs twice: on a desktop window and on a phone-sized touch
  // device. A layout that only works on one of them fails here.
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
    url: `http://127.0.0.1:${APP_PORT}`,
    timeout: 240_000,
    // Never reuse a server that happens to sit on the port: it would have
    // been started WITHOUT the e2e env below (the live proxy and indexer)
    // while the injected wallet signs on Anvil. --strictPort makes the
    // clash a loud failure instead.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      APP_E2E: '1',
      APP_E2E_RUN_ID: process.env.APP_E2E_RUN_ID,
      VITE_DEFAULT_CHAIN_ID: '84532',
      // alpha05 never takes a per-chain RPC URL (endpoints.ts refuses one):
      // the stub stands in for the read-only proxy, whose route for the
      // chain forwards to Anvil. The public endpoint behind it is the real
      // Base Sepolia, where the fixture Diamond has no code, so a read that
      // fell through would fail loudly rather than pass on live state.
      VITE_RPC_PROXY_ORIGIN: STUB_ORIGIN,
      VITE_INDEXER_ORIGIN: STUB_ORIGIN,
      VITE_AGENT_ORIGIN: STUB_ORIGIN,
      VITE_WALLETCONNECT_PROJECT_ID: '',
    },
  },
});
