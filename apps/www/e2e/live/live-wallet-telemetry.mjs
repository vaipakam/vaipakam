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
 * WalletConnect note: on a first visit it legitimately sends nothing
 * even when enabled — its EventClient submits only events a previous
 * session persisted, and `Core.initialize()` never calls the `init()`
 * that would emit a fresh one. So a pass here is strong evidence for
 * Coinbase and weak evidence for WalletConnect; the WalletConnect
 * setting is verified by reading the resolved config, not by this.
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

let failures = 0;
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
    await page.goto(url, { timeout: 45_000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    console.log(`FAIL  ${url} — navigation: ${String(e).split('\n')[0]}`);
    failures++;
    await ctx.close();
    continue;
  }

  if (hits.length > 0) {
    console.log(`FAIL  ${url} — ${hits.length} telemetry request(s) on load:`);
    for (const h of hits) console.log(`        ${h}`);
    failures++;
  } else {
    console.log(`PASS  ${url} — no requests to ${TELEMETRY_HOSTS.join(' / ')} on load`);
  }
  await ctx.close();
}

await browser.close();
console.log(
  failures === 0
    ? `\n${targets.length} origin(s) clean.`
    : `\n${failures} of ${targets.length} origin(s) emitted telemetry.`,
);
process.exit(failures === 0 ? 0 : 1);
