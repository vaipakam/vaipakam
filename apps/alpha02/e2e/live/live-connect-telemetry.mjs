// #1836 post-deploy live review — the wallet CONNECT path on production
// alpha02, and whether it phones home.
//
// The app-load half of #1836 was verified on 2026-08-20 by
// `apps/www/e2e/live/live-wallet-telemetry.mjs`: no requests to
// `cca-lite.coinbase.com` or `pulse.walletconnect.org` while the page
// loads. That drive could not have caught a regression in the flag this
// issue is about, and the reason is the whole point of this file.
//
// MEASURED 2026-08-22 against a local build with `telemetry: true`
// restored: page load produced ZERO beacons, opening the connect modal
// produced ZERO, and SELECTING the Coinbase connector produced SIX —
// five `POST /amp` and one `POST /metrics`. The Coinbase Wallet SDK
// emits on connector initialization, which happens when the user picks
// it, not when the bundle loads. A load-time probe watches the one
// moment nothing is sent.
//
// So this drive walks the real first-visit connect path and watches the
// whole session: load, modal, connector selection, the completed
// connect, and a reload as a returning visitor.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT
//
//   PROVEN — `preference.telemetry: false` holds on the deployed build
//     through Coinbase SDK initialization. The SDK really does start
//     (the drive requires the `keys.coinbase.com` popup, which is the
//     SDK opening its own connect window); it simply sends nothing.
//     The calibration above is what makes that negative trustworthy:
//     the same probe against `telemetry: true` fails loudly.
//
//   PROVEN — the injected-connector connect flow works end to end on
//     the deployed site against real Base Sepolia: first visit renders
//     disconnected, the connect completes, the account renders, and the
//     session survives a reload.
//
//   NOT PROVEN — completing a connect INSIDE Coinbase Wallet. That
//     needs a real wallet and a human; the drive stops at the popup.
//     Nothing beyond SDK initialization is claimed.
//
//   NOT APPLICABLE HERE — WalletConnect. alpha02 builds that connector
//     only when `WC_PROJECT_ID` is set, and it is not set on this
//     deploy: the connect modal offers Coinbase, MetaMask and the
//     injected test wallet only, and NO shipped chunk references
//     `pulse.walletconnect.org`. The drive asserts that absence rather
//     than quietly passing a check with nothing behind it — if a
//     project id is ever configured, this assert fails and tells the
//     next person to extend the drive instead of letting an
//     unexercised connector reach production.
//
// Usage:
//   node e2e/live/live-connect-telemetry.mjs
//   SITE_URL=http://localhost:4319 node e2e/live/live-connect-telemetry.mjs
//
// Exit: 0 pass, 1 fail, 2 blocked (setup/precondition, nothing observed).
import { addressOf, blockedSync, launch, precondition, SITE, visit } from './driver.mjs';

/** The two endpoints #1836 turned off. Watched for the whole session. */
const TELEMETRY_HOSTS = ['cca-lite.coinbase.com', 'pulse.walletconnect.org'];

/** How long to let the SDK talk after it is selected. The calibration
 *  run had all six beacons within ~4 s; 9 s is slack, not a guess. */
const SDK_SETTLE_MS = 9_000;

const beacons = [];
const steps = [];
let phase = 'launch';

function step(name, verdict, detail) {
  steps.push({ name, verdict, detail });
  const mark = verdict === 'PASS' ? 'PASS' : verdict === 'OBSERVED' ? '····' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function watch(target, label) {
  target.on('request', (r) => {
    const url = r.url();
    if (TELEMETRY_HOSTS.some((h) => url.includes(h))) {
      beacons.push({ phase, label, method: r.method(), url });
    }
  });
}

const { page, done } = await launch({
  role: 'lender',
  startChainId: 84532,
  // A REAL first visit: `eth_accounts` answers [] until the page asks.
  // With the permissive default wagmi treats the announced provider as
  // already connected and there is no connect flow left to review.
  preAuthorized: false,
  allowRequestAccounts: true,
  // The persistent profile carries connectkit state from earlier runs,
  // which would skip the very step this drive exists to walk.
  freshProfile: true,
});

const context = page.context();
watch(context, 'page');
// The SDK opens its own window; its requests are not the main page's.
context.on('page', (p) => watch(p, 'popup'));

let failed = false;
try {
  console.log(`live-connect-telemetry — ${SITE}`);

  // ── 1. First visit is genuinely disconnected ──────────────────────
  phase = 'load';
  await visit(page, '/');
  const connectCta = page.getByRole('button', { name: /connect wallet/i }).first();
  const ctaVisible = await connectCta.isVisible().catch(() => false);
  if (!ctaVisible) {
    // Not a telemetry failure — the session is not the one being
    // reviewed, so everything below would measure the wrong thing.
    blockedSync('first visit did not render the connect CTA; the session is not disconnected');
  }
  step('first visit renders disconnected', 'PASS', 'connect CTA present');

  const loadBeacons = beacons.length;
  step('page load sends no telemetry', loadBeacons === 0 ? 'PASS' : 'FAIL', `${loadBeacons} beacon(s)`);
  if (loadBeacons !== 0) failed = true;

  // ── 2. The connector list is the one this drive covers ────────────
  phase = 'modal';
  await connectCta.click();
  await page.waitForTimeout(2_000);
  const modalText = await page.locator('body').innerText();
  const offersCoinbase = /coinbase/i.test(modalText);
  if (!offersCoinbase) {
    blockedSync('the connect modal offers no Coinbase connector; nothing to initialize');
  }
  const offersWalletConnect = /walletconnect/i.test(modalText);
  step(
    'WalletConnect is absent, as this deploy expects',
    offersWalletConnect ? 'FAIL' : 'PASS',
    offersWalletConnect
      ? 'a WalletConnect connector is now offered — this drive does not exercise it; extend it before shipping'
      : 'no WC_PROJECT_ID configured',
  );
  if (offersWalletConnect) failed = true;

  const modalBeacons = beacons.length - loadBeacons;
  step('opening the modal sends no telemetry', modalBeacons === 0 ? 'PASS' : 'FAIL', `${modalBeacons} beacon(s)`);
  if (modalBeacons !== 0) failed = true;

  // ── 3. The moment that actually emits ─────────────────────────────
  phase = 'coinbase-selected';
  const popupSeen = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), SDK_SETTLE_MS);
    context.once('page', (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });
  await page.getByText('Coinbase', { exact: false }).first().click({ timeout: 5_000 });
  const popup = await popupSeen;
  await page.waitForTimeout(SDK_SETTLE_MS);

  // Without the popup the SDK did not initialize, and a zero-beacon
  // reading below would be measuring nothing at all — the exact false
  // pass this drive exists to avoid.
  if (!popup) {
    blockedSync('the Coinbase SDK never opened its connect window; nothing was initialized to measure');
  }
  const popupUrl = popup.url();
  if (!popupUrl.includes('coinbase.com')) {
    blockedSync(`the connector opened ${popupUrl}, which is not the Coinbase SDK`);
  }
  step('Coinbase SDK initializes', 'PASS', new URL(popupUrl).host);

  const sdkBeacons = beacons.length - loadBeacons - modalBeacons;
  step(
    'selecting Coinbase sends no telemetry',
    sdkBeacons === 0 ? 'PASS' : 'FAIL',
    sdkBeacons === 0
      ? 'preference.telemetry:false holds through SDK init'
      : `${sdkBeacons} beacon(s) — the fix has regressed`,
  );
  if (sdkBeacons !== 0) failed = true;

  await popup.close().catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1_000);

  // ── 4. A connect that actually completes ──────────────────────────
  // The injected connector is the one this container can carry through
  // to a connected session; the Coinbase branch above stops at the
  // popup by necessity.
  phase = 'connect';
  const before = beacons.length;
  const cta = page.getByRole('button', { name: /connect wallet/i }).first();
  if (await cta.isVisible().catch(() => false)) await cta.click();
  await page.waitForTimeout(1_000);
  await page
    .getByText('Vaipakam Test Wallet', { exact: false })
    .first()
    .click({ timeout: 8_000 })
    .catch(() => {});
  const account = addressOf('lender');
  const fragment = account.slice(2, 6).toLowerCase();
  const connected = await precondition('the wallet connects', async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const body = (await page.locator('body').innerText()).toLowerCase();
      if (body.includes(fragment)) return true;
      await page.waitForTimeout(1_000);
    }
    return false;
  });
  step(
    'connect completes and renders the account',
    connected ? 'PASS' : 'FAIL',
    connected ? `…${fragment}…` : 'the account never appeared',
  );
  if (!connected) failed = true;

  // ── 5. The returning visitor ──────────────────────────────────────
  // A restored session re-initializes connectors, and any queued
  // beacons a previous session persisted would flush here.
  phase = 'reload';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);
  const stillConnected = (await page.locator('body').innerText())
    .toLowerCase()
    .includes(fragment);
  step(
    'the session survives a reload',
    stillConnected ? 'PASS' : 'FAIL',
    stillConnected ? 'returning visitor stays connected' : 'the session was lost',
  );
  if (!stillConnected) failed = true;

  const afterConnect = beacons.length - before;
  step(
    'connecting and returning send no telemetry',
    afterConnect === 0 ? 'PASS' : 'FAIL',
    `${afterConnect} beacon(s)`,
  );
  if (afterConnect !== 0) failed = true;

  // ── Verdict ───────────────────────────────────────────────────────
  console.log('');
  if (beacons.length > 0) {
    console.log('Telemetry observed:');
    for (const b of beacons) console.log(`  [${b.phase}/${b.label}] ${b.method} ${b.url}`);
    console.log('');
  }
  const failures = steps.filter((s) => s.verdict === 'FAIL');
  if (failed || failures.length > 0) {
    console.error(`live-connect-telemetry: FAIL — ${failures.length} step(s)`);
    process.exitCode = 1;
  } else {
    console.log(`live-connect-telemetry: PASS — ${steps.length} steps, 0 beacons`);
  }
} finally {
  await done();
}
