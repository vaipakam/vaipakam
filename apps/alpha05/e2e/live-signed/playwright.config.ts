/**
 * Signed live journeys (#3180): the deployed alpha05 site against a live
 * TEST network, driven by the dev test wallets, which sign real testnet
 * transactions. Unlike e2e/live/*.cjs (watch-only), this suite moves test
 * tokens, so it runs only where the test-wallet keys already live (the
 * owner's desktop) and only against Base Sepolia, Arbitrum Sepolia or BNB
 * Testnet; the fixture refuses any other chain.
 *
 *   LIVE_CHAIN_ID=84532 LIVE_WALLETS_FILE=~/secrets/vaipakam-dev-wallets.json \
 *     pnpm --filter @vaipakam/alpha05 exec playwright test -c e2e/live-signed
 *
 * LIVE_URL (default https://alpha05.vaipakam.com) picks the site;
 * LIVE_RPC_URL the node (default the network's public endpoint);
 * LIVE_DEVICE=phone runs on a phone viewport instead of the desktop.
 * Serial: the journeys share wallets and build on each other's state.
 */
import { defineConfig, devices } from '@playwright/test';

const phone = process.env.LIVE_DEVICE === 'phone';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.live\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  outputDir: process.env.LIVE_OUT ?? 'test-results/live-signed',
  use: {
    baseURL: process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [phone ? { name: 'phone', use: { ...devices['Pixel 7'] } } : { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } }],
});
