/**
 * Live check — the wallet SDKs' own analytics stay silent on page load
 * (#1824, shipped in #1836).
 *
 * WHAT IT ASSERTS: loading a connected-app origin, with no wallet
 * installed and without touching the connect dialog, produces ZERO
 * requests to the wallet vendors' telemetry hosts.
 *
 * WHY THIS IS THE RIGHT MOMENT TO CHECK. The exposure is not gated on
 * opening the wallet dialog, which is how the spec originally described
 * it. `reconnectOnMount` defaults true, and `@wagmi/core`'s `reconnect`
 * loops over EVERY configured connector calling `getProvider()` BEFORE
 * it ever consults `isAuthorized()` — so each SDK is constructed, and
 * each SDK's telemetry starts, for every visitor. A check that first
 * clicked "connect" would be testing a later and narrower thing.
 *
 * WHY A PASS HERE MEANS SOMETHING. "No requests observed" is worthless
 * unless the probe can see the requests when they DO happen, which is
 * the trap #1778 was built to avoid. This was calibrated against the
 * pre-fix configuration on a local dev server: with
 * `preference.telemetry` absent, a fresh context produced two POSTs
 * (`cca-lite.coinbase.com/amp` and `/metrics`) on load; restoring the
 * setting on the same server produced none. Re-run that way if the
 * check ever goes quiet for a suspicious reason — a silent probe and a
 * fixed app look identical from the outside.
 *
 * Requests are counted at ATTEMPT time, not on response: an SDK that
 * tries to phone home and is blocked by the network still tried, and
 * on a locked-down network that attempt is itself the reported symptom.
 *
 * WHAT A PASS DOES NOT COVER. On these apps only the Coinbase SDK is
 * constructed at load — no `wc@2:*` storage appears — so the
 * WalletConnect path is NOT EXERCISED by this check at all, and the
 * output says so per host rather than printing one combined line that
 * would imply otherwise. Two independent reasons it would stay silent
 * anyway on a first visit: its provider is not built here, and its
 * EventClient submits only events a previous session persisted
 * (`Core.initialize()` never calls the `init()` that would emit a
 * fresh one). Exercising it needs prepared returning-visitor state —
 * tracked in #1840, deliberately not faked here, because seeding a
 * vendor's internal storage shape would couple this drive to an
 * undocumented format that has already changed between adjacent patch
 * releases.
 *
 * FAILING CLOSED. Silence only means something if the code path ran,
 * so a run must prove it did: the response must be a success, the app
 * must have rendered, and `cbwsdk.store` must exist — that key is
 * written by the Coinbase SDK, so it witnesses construction rather
 * than inferring it from a timer. An HTML 404, a broken bundle, or
 * initialization slower than the window all now FAIL instead of
 * reporting a quiet pass (Codex #1838 r1 P1).
 *
 * Usage (operator machine):
 *   node apps/www/e2e/live/live-wallet-telemetry.mjs \
 *     https://defi.vaipakam.com/ https://alpha01.vaipakam.com/ https://alpha02.vaipakam.com/
 *
 * From the agent container, add the two launch overrides and the
 * host-side setup described in this directory's README:
 *   PW_CHROMIUM_EXE=/opt/pw-browsers/chromium PW_PROXY="$HTTPS_PROXY" node …
 *
 * Exits non-zero if any origin emits telemetry, so it can gate a
 * release step.
 */
import { chromium } from 'playwright';

/** Hosts each SDK reports to when its telemetry is left enabled. */
const TELEMETRY_HOSTS = ['cca-lite.coinbase.com', 'pulse.walletconnect.org'];

/** Time after load for `reconnectOnMount` to build every provider. The
 *  beacons are not sent during navigation — they follow provider
 *  construction, which happens after first paint. */
const SETTLE_MS = 12_000;

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: live-wallet-telemetry.mjs <origin> [origin…]');
  process.exit(2);
}

const browser = await chromium.launch({
  ...(process.env.PW_CHROMIUM_EXE ? { executablePath: process.env.PW_CHROMIUM_EXE } : {}),
  ...(process.env.PW_PROXY
    ? { proxy: { server: process.env.PW_PROXY, bypass: 'localhost,127.0.0.1' } }
    : {}),
});

let emitted = 0;
let unverified = 0;
for (const url of targets) {
  // A FRESH context per origin: telemetry state can be influenced by
  // stored data, and reusing one would let an earlier origin's storage
  // decide a later origin's result.
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();

  const hits = [];
  page.on('request', (r) => {
    try {
      if (TELEMETRY_HOSTS.includes(new URL(r.url()).hostname)) {
        hits.push(`${r.method()} ${r.url().slice(0, 100)}`);
      }
    } catch {
      /* not a parseable URL — cannot be one of our hosts */
    }
  });

  try {
    // `domcontentloaded`, not `networkidle`: the connected app holds
    // long-lived connections (RPC / websocket), so networkidle never
    // settles and the check would time out on a perfectly healthy app.
    const resp = await page.goto(url, { timeout: 45_000, waitUntil: 'domcontentloaded' });

    // FAIL CLOSED (Codex #1838 r1 P1). `page.goto` resolves happily on
    // an HTML 404/500, and a fixed delay proves nothing about whether
    // the app hydrated or the SDK was ever constructed. Without these
    // gates an error shell or a broken bundle produces a silent PASS —
    // which is this drive's own stated failure mode, aimed at itself.
    const status = resp?.status() ?? 0;
    if (!resp?.ok()) throw new Error(`HTTP ${status}`);

    // Witness 1 — the app rendered something, so this is not a shell.
    await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, {
      timeout: 30_000,
    });

    // Witness 2, the load-bearing one — `cbwsdk.store` is written by
    // the Coinbase Wallet SDK itself, so its presence proves the SDK
    // was CONSTRUCTED: the exact code path whose telemetry this drive
    // is checking actually ran. Silence without this witness would mean
    // nothing at all.
    await page.waitForFunction(() => localStorage.getItem('cbwsdk.store') !== null, {
      timeout: 30_000,
    });

    // Only now is the settle window meaningful: the SDK exists, so if
    // it were going to report, this is when.
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    console.log(`FAIL  ${url} — not verifiably exercised: ${String(e).split('\n')[0]}`);
    unverified++;
    await ctx.close();
    continue;
  }

  // Report per host rather than as one combined line. WalletConnect's
  // provider is not constructed at load on these apps (no `wc@2:*`
  // storage appears), so folding it into a single "no requests to A /
  // B" claim would assert coverage this run does not have.
  const wcExercised = await page.evaluate(() =>
    Object.keys(localStorage).some((k) => k.startsWith('wc@2:')),
  );

  if (hits.length > 0) {
    console.log(`FAIL  ${url} — ${hits.length} telemetry request(s) on load:`);
    for (const h of hits) console.log(`        ${h}`);
    emitted++;
  } else {
    console.log(`PASS  ${url} — Coinbase SDK constructed and silent (cbwsdk.store present)`);
    console.log(
      wcExercised
        ? '        WalletConnect: provider constructed, also silent'
        : '        WalletConnect: NOT EXERCISED on a first visit — see header (#1840)',
    );
  }
  await ctx.close();
}

await browser.close();
// Report the two failure kinds SEPARATELY. Collapsing them once made
// this drive announce "1 of 1 origin(s) emitted telemetry" for a page
// that emitted nothing and had simply failed the readiness gate —
// a false accusation in the same breath as a check about honest
// reporting.
const clean = targets.length - emitted - unverified;
console.log(
  `\n${clean} clean, ${emitted} emitting telemetry, ${unverified} not verifiably exercised ` +
    `(of ${targets.length}).`,
);
process.exit(emitted + unverified === 0 ? 0 : 1);
