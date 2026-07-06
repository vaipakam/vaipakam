/** #1056 — write-path kill switch under the fork tier.
 *
 *  The switch is a BUILD-env flag (VITE_DISABLED_FLOWS), so the main
 *  webServer — built with it unset — can't exercise the killed state.
 *  This spec spawns its OWN vite dev server on a second port with
 *  `VITE_DISABLED_FLOWS=all` and the same fork-tier env, then drives
 *  the lend flow to the review card and asserts the operator pause is
 *  real: banner shown, sign button held closed even after consent.
 *  A control case on the standard server asserts the banner never
 *  leaks into a build with the flag unset (the production posture the
 *  live sweep `e2e/live/live-killswitch-regression.mjs` re-checks
 *  post-deploy).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect } from '../lib/wallet-fixture';
import { consentAndWaitEnabled, lenderOfferFormToReview } from '../lib/flows';
import { ANVIL_URL } from '../lib/anvil';

const KILL_PORT = 4174;
const KILL_BASE = `http://127.0.0.1:${KILL_PORT}`;
const STUB_PORT = Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788);
const KILL_COPY = /switched off right now/i;

let killServer: ChildProcess | undefined;

test.beforeAll(async () => {
  killServer = spawn(
    'node',
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(KILL_PORT),
      '--strictPort',
    ],
    {
      env: {
        ...process.env,
        ALPHA02_E2E: '1',
        VITE_DEFAULT_CHAIN_ID: '84532',
        VITE_BASE_SEPOLIA_RPC_URL: ANVIL_URL,
        VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
        VITE_DISABLED_FLOWS: 'all',
      },
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(KILL_BASE);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('kill-switch vite not ready');
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(() => {
  killServer?.kill('SIGTERM');
});

test('a killed flow shows the pause banner and holds the sign button closed', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  const post = await lenderOfferFormToReview(page, KILL_BASE);
  await expect(page.getByText(KILL_COPY).first()).toBeVisible({
    timeout: 30_000,
  });
  // Consent alone must NOT open the button — the kill gate sits in
  // canSign, independent of the consent machinery.
  const consent = page.locator('input[type="checkbox"]:visible').first();
  await consent.check();
  await page.waitForTimeout(2_000);
  await expect(post).toBeDisabled();
});

test('control: the SAME review on an unset build enables the sign button', async ({
  launchWallet,
}) => {
  // Drive the identical form on the standard server and prove the
  // normal gates CLEAR (button enables) with no banner — so the
  // killed case's disabled button can only be the kill gate, not a
  // hydration/consent/liquidity gate that happens to be closed
  // (round 3).
  const { page } = await launchWallet('lender');
  const post = await lenderOfferFormToReview(page);
  await consentAndWaitEnabled(page, post);
  await expect(post).toBeEnabled();
  await expect(page.getByText(KILL_COPY)).toHaveCount(0);
});
