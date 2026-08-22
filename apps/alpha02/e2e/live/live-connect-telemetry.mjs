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
//   PROVEN — WalletConnect's relay really initializes. A project id was
//     configured on 2026-08-22, so the connector now ships; ConnectKit
//     surfaces it as "Other Wallets", NOT as the string "WalletConnect"
//     (that is its label whenever `showQrModal: false`, and keying on
//     the product name found nothing while the connector was plainly
//     there). Selecting it opens `wss://relay.walletconnect.org`, which
//     is how this drive knows the SDK started rather than assuming it.
//
//   NOT PROVEN, AND SAID SO — that `telemetryEnabled: false` works.
//     The zero this drive records for `pulse.walletconnect.org` is
//     reported as OBSERVED, never as a pass, because the same probe
//     against `telemetryEnabled: true` ALSO records zero. Calibrated
//     twice on 2026-08-22: once with a dummy project id (relay auth
//     retried four times) and once with the REAL id (single clean relay
//     connection, so the id was genuinely valid) — no beacons either
//     way. WalletConnect Core evidently emits on later session
//     lifecycle, not on initialization, and reaching that needs a human
//     scanning the QR with a real wallet.
//
//     A negative that has never been seen failing is decoration. This
//     one is labelled rather than counted, and the gap is real work
//     still owed, not a box ticked.
//
// Usage:
//   node e2e/live/live-connect-telemetry.mjs
//   SITE_URL=http://localhost:4319 node e2e/live/live-connect-telemetry.mjs
//
// Exit: 0 pass, 1 fail, 2 blocked (setup/precondition, nothing observed).
import { addressOf, blockedSync, launch, SITE, visit } from './driver.mjs';

/** The two endpoints #1836 turned off. Watched for the whole session. */
const TELEMETRY_HOSTS = ['cca-lite.coinbase.com', 'pulse.walletconnect.org'];

/** How long to let the SDK talk after it is selected. The calibration
 *  run had all six beacons within ~4 s; 9 s is slack, not a guess. */
const SDK_SETTLE_MS = 9_000;

/** WalletConnect's relay handshake, measured at ~2 s on the live deploy. */
const WC_SETTLE_MS = 10_000;

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
  // Nothing here needs to sign or send. Left writable, a compromised or
  // simply broken SITE could have the injected provider sign a message
  // or broadcast a transaction against a funded Base Sepolia wallet,
  // and this drive would neither prevent nor record it (Codex #1894 r2).
  readOnly: true,
  // The persistent profile carries connectkit state from earlier runs,
  // which would skip the very step this drive exists to walk.
  freshProfile: true,
});

const context = page.context();
watch(context, 'page');
// The SDK opens its own window; its requests are not the main page's.
context.on('page', (p) => watch(p, 'popup'));

/** Every socket the session opens, collected from launch. WalletConnect's
 *  relay can be opened while the modal is first built, so a listener
 *  attached at the WC step would miss it. */
const sockets = [];
// OPENED, not merely requested (Codex #1894 r1). Playwright emits
// `websocket` when the handshake is SENT, so a relay that rejects the
// project id — or an egress that blocks the socket — still produced an
// entry, and the drive reported the rail healthy and the project id
// usable on the strength of an attempt. A socket counts only once a
// frame has crossed it and no error arrived first.
page.on('websocket', (ws) => {
  const record = { url: ws.url(), framed: false, errored: false };
  sockets.push(record);
  ws.on('framereceived', () => { record.framed = true; });
  ws.on('framesent', () => { record.framed = true; });
  ws.on('socketerror', () => { record.errored = true; });
});

let failed = false;
try {
  console.log(`live-connect-telemetry — ${SITE}`);

  // ── 1. First visit is genuinely disconnected ──────────────────────
  phase = 'load';
  await visit(page, '/');
  const connectCta = page.getByRole('button', { name: /connect wallet/i }).first();
  const ctaVisible = await connectCta.isVisible().catch(() => false);
  if (!ctaVisible) {
    // A product FAIL, not a precondition (Codex #1894 r1). The fresh
    // profile and `preAuthorized: false` mean a first-time visitor was
    // authorized WITHOUT clicking anything — which is a wallet-state
    // regression, not a missing precondition. Calling it BLOCKED would
    // file the most interesting result this drive can produce under
    // "could not observe".
    step(
      'first visit renders disconnected',
      'FAIL',
      'no connect CTA — the session was authorized without a click',
    );
    failed = true;
  } else {
    step('first visit renders disconnected', 'PASS', 'connect CTA present');
  }

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
  // "Other Wallets" IS the WalletConnect entry — ConnectKit labels it
  // that way whenever `showQrModal: false`. Keying on the product name
  // reported it missing while the connector was plainly in the bundle.
  const wcEntry = page.getByRole('button', { name: /other wallets/i }).first();
  const offersWalletConnect = await wcEntry.isVisible().catch(() => false);
  step(
    'WalletConnect is offered',
    offersWalletConnect ? 'PASS' : 'FAIL',
    offersWalletConnect
      ? 'as "Other Wallets"'
      : 'no WC entry — VITE_WALLETCONNECT_PROJECT_ID is unset in the BUILD (it is a Vite compile-time value; a Worker variable cannot supply it)',
  );
  if (!offersWalletConnect) failed = true;

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
  // EXACT host (Codex #1894 r1). `includes('coinbase.com')` accepts
  // `coinbase.com.evil` and any other Coinbase page, so a broken or
  // spoofed connector could satisfy the calibration precondition without
  // the SDK ever starting — and the zero-beacon result would then mean
  // nothing at all.
  let popupHost = '';
  try {
    popupHost = new URL(popupUrl).host;
  } catch {
    blockedSync(`the connector opened an unparseable URL: ${popupUrl}`);
  }
  if (popupHost !== 'keys.coinbase.com') {
    blockedSync(`the connector opened ${popupHost}, not keys.coinbase.com`);
  }
  step('Coinbase SDK initializes', 'PASS', popupHost);

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

  // ── 3b. WalletConnect: initialization proven, telemetry NOT ───────
  phase = 'walletconnect-selected';
  const wcBefore = beacons.length;
  const cta2 = page.getByRole('button', { name: /connect wallet/i }).first();
  if (await cta2.isVisible().catch(() => false)) await cta2.click();
  await page.waitForTimeout(1_500);
  await page
    .getByRole('button', { name: /other wallets/i })
    .first()
    .click({ timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(WC_SETTLE_MS);
  // Collected from launch, not awaited here: ConnectKit can open the
  // relay while the modal is first built, which is BEFORE this step —
  // a listener attached now would miss it and report a working rail as
  // broken, which is what the first run of this step did.
  const relayOpened = sockets.some(
    (s) => s.url.includes('relay.walletconnect.org') && s.framed && !s.errored,
  );

  step(
    'WalletConnect relay initializes',
    relayOpened ? 'PASS' : 'FAIL',
    relayOpened
      ? 'wss://relay.walletconnect.org opened and exchanged a frame'
      : 'no relay socket exchanged a frame — attempted but never established',
  );
  if (!relayOpened) failed = true;

  const wcBeacons = beacons.filter(
    (b) => b.phase === 'walletconnect-selected' && b.url.includes('pulse.walletconnect.org'),
  ).length;
  // OBSERVED, never PASS. The same probe records zero with
  // `telemetryEnabled: true`, so a zero here is not evidence the flag
  // works — see the header. Reported so the number is on the record
  // without pretending it settles anything.
  // ASYMMETRIC on purpose (Codex #1894 r2). The missing calibration is
  // what makes a ZERO inconclusive — the same probe reads zero with the
  // flag on. It says nothing about a POSITIVE count, which is direct
  // evidence that telemetry a build claims to have disabled phoned home.
  // Treating both alike let that evidence exit 0.
  if (wcBeacons > 0) {
    step(
      'WalletConnect telemetry',
      'FAIL',
      `${wcBeacons} beacon(s) to pulse.walletconnect.org — telemetryEnabled:false did not hold`,
    );
    failed = true;
  } else {
    step(
      'WalletConnect telemetry (NOT calibrated — observation only)',
      'OBSERVED',
      '0 beacons; this probe reads zero with the flag ON too, so zero cannot prove the flag',
    );
  }
  void wcBefore;

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
  // NOT `precondition` (Codex #1894 r2). If the page crashes or closes
  // during this poll, `innerText` throws and precondition exits 2 —
  // BLOCKED, "nothing could be observed" — discarding every Coinbase and
  // WalletConnect step already recorded above. A crash here is a failed
  // connection, which is a finding, so it stays in the verdict.
  let connected = false;
  {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let body = '';
      try {
        body = (await page.locator('body').innerText()).toLowerCase();
      } catch {
        break;
      }
      if (body.includes(fragment)) { connected = true; break; }
      await page.waitForTimeout(1_000);
    }
  }
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

  // WHOLE SESSION, not per phase (Codex #1894 r1). Each step measures
  // its own window, so a Coinbase beacon arriving late — queued, retried,
  // or simply after a window closed — landed in no step's count, and the
  // run could print "0 beacons" having seen one. The Coinbase half IS
  // calibrated, so any count at all is a failure.
  const coinbaseTotal = beacons.filter((b) =>
    b.url.includes('cca-lite.coinbase.com'),
  ).length;
  step(
    'no Coinbase telemetry at any point in the session',
    coinbaseTotal === 0 ? 'PASS' : 'FAIL',
    `${coinbaseTotal} beacon(s) across every phase`,
  );
  if (coinbaseTotal !== 0) failed = true;

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
