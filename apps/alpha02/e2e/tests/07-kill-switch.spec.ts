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
  // Fail closed BEFORE spawning: if anything already answers on the
  // port, the readiness probe below could hit that stale listener
  // before our --strictPort child observes the conflict and exits
  // (round 5). Nothing may be listening when we start.
  const stale = await fetch(KILL_BASE).then(
    () => true,
    () => false,
  );
  if (stale) {
    throw new Error(
      `something is already listening on ${KILL_BASE} — kill it before running the kill-switch spec`,
    );
  }
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
    // Fail closed on a stale port: with --strictPort our child EXITS
    // when 4174 is already taken, so a response from the port would
    // be some other (possibly unset) server — misleading kill-switch
    // results, not ours (round 4).
    if (killServer.exitCode !== null) {
      throw new Error(
        `kill-switch vite exited with ${killServer.exitCode} — port ${KILL_PORT} already in use?`,
      );
    }
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
  // Hold the review in the would-be-signable state for the SAME
  // window the control case needs to prove enablement (60s in
  // consentAndWaitEnabled), re-ticking consent through any
  // late-disclosure resets. A short fixed wait could pass because
  // some OTHER async gate (fees/liquidity/security) hadn't cleared
  // yet, missing a canSign that lost its kill check (round 5). If
  // the button ever enables, the kill gate is broken — fail at once.
  const holdUntil = Date.now() + 60_000;
  for (;;) {
    const consent = page.locator('input[type="checkbox"]:visible').first();
    if (!(await consent.isChecked().catch(() => true))) {
      await consent.check().catch(() => {});
    }
    expect(await post.isEnabled(), 'kill gate must hold the sign button closed').toBe(false);
    if (Date.now() > holdUntil) break;
    await page.waitForTimeout(1_000);
  }
  // The banner must still be up at the end of the hold.
  await expect(page.getByText(KILL_COPY).first()).toBeVisible();
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
