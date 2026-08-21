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
 * loops over configured connectors calling `getProvider()` BEFORE it
 * ever consults `isAuthorized()`, so a connector's SDK is constructed —
 * and its telemetry starts — for every visitor. Observed here for the
 * COINBASE connector specifically: `cbwsdk.store` appears on load while
 * no `wc@2:*` key does. Do not read this as "every SDK"; WalletConnect
 * is not constructed at load on these apps (#1840). A check that first
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

/** Time after load for `reconnectOnMount` to build the COINBASE
 *  provider — not "every provider": WalletConnect is not constructed at
 *  load on these apps, so this window is not WalletConnect coverage
 *  (#1840). Beacons are not sent during navigation; they follow
 *  provider construction, which happens after first paint. */
const SETTLE_MS = 12_000;

/**
 * Second, independent check: does the DEPLOYED BUNDLE actually carry the
 * telemetry-off settings? (#1840)
 *
 * Watching traffic cannot answer this for WalletConnect. Its provider is
 * not constructed at load, and even constructed it submits only events a
 * previous session persisted — so `telemetryEnabled` could regress to its
 * enabled default and every traffic observation would still come back
 * clean. Reading the shipped JavaScript closes that gap without needing a
 * wallet or a returning-visitor session.
 *
 * It is deliberately a check on CONFIGURATION, not behaviour, and is
 * reported separately for that reason — it proves the option shipped, not
 * that the vendor honours it.
 *
 * The conditional matters, and was found the hard way. The connector sits
 * behind `...(WC_PROJECT_ID ? [walletConnect({…})] : [])`, and Vite
 * substitutes that env var at build time — so a build with no project id
 * has its whole WalletConnect call site dead-code-eliminated. Observed on
 * a sibling app: the Coinbase half of the same commit shipped while the
 * WalletConnect half was simply absent. Demanding the flag unconditionally
 * would report a leak on a deployment that cannot have one. The rule is
 * therefore: if OUR call site is in the bundle, the flag must be too.
 *
 * `universal:` is the call-site marker — it comes from the
 * `metadata.redirect: { universal }` only we pass. Library code carries
 * `projectId:` and the string "walletconnect" whether or not our call
 * survives, so neither of those can serve as the discriminator.
 */
const MINIFIED_FALSE = String.raw`(?:!1|false)`;
const WC_FLAG = new RegExp(String.raw`telemetryEnabled\s*:\s*` + MINIFIED_FALSE);
const WC_CALLSITE = /universal\s*:/;
const CB_FLAG = new RegExp(String.raw`[^A-Za-z]telemetry\s*:\s*` + MINIFIED_FALSE);

/** Fetch every same-origin script the page references and concatenate it.
 *  Uses the page's own request context so the container proxy applies. */
async function deployedScripts(page, origin) {
  const srcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]')).map((s) => s.src),
  );
  let joined = '';
  for (const src of srcs) {
    if (!src.startsWith(origin)) continue;
    const r = await page.request.get(src).catch(() => null);
    if (r && r.ok()) joined += await r.text();
  }
  return joined;
}

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

let clean = 0;
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

  let readinessError = null;
  try {
    // `domcontentloaded`, not `networkidle`: the connected app holds
    // long-lived connections (RPC / websocket), so networkidle never
    // settles and the check would time out on a perfectly healthy app.
    const resp = await page.goto(url, { timeout: 45_000, waitUntil: 'domcontentloaded' });

    const status = resp?.status() ?? 0;
    if (!resp?.ok()) throw new Error(`HTTP ${status}`);

    // A cross-origin redirect means the witnesses below would pass on
    // whatever app we LANDED on, not the one asked for — so a
    // misconfigured origin redirecting to a sibling app would report
    // clean while never being exercised (Codex #1838 r2).
    const landed = new URL(page.url()).origin;
    const asked = new URL(url).origin;
    if (landed !== asked) throw new Error(`redirected to ${landed}`);

    // Witness 1 — the APP rendered, not merely "#root has children".
    // alpha02 ships a static `#boot-splash` INSIDE `#root` in its
    // server HTML, so a children-count test is already true before any
    // React render and would bless a bundle that never mounted (Codex
    // #1838 r3). React replaces `#root`'s children on mount, so the
    // splash's disappearance is the app-owned signal that it did.
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        if (!root || root.children.length === 0) return false;
        return document.getElementById('boot-splash') === null;
      },
      { timeout: 30_000 },
    );

    // Witness 2, the load-bearing one — `cbwsdk.store` is written by
    // the Coinbase Wallet SDK itself, so its presence proves the SDK
    // was CONSTRUCTED: the exact code path whose telemetry this drive
    // is checking actually ran. Silence without this witness would mean
    // nothing at all.
    await page.waitForFunction(() => localStorage.getItem('cbwsdk.store') !== null, {
      timeout: 30_000,
    });
  } catch (e) {
    // Record rather than return: telemetry may already have been
    // observed, and an origin can be both emitting AND unverified.
    readinessError = String(e).split('\n')[0];
  }

  // ALWAYS observe for the full window, including after a readiness
  // failure. Beacons are scheduled after first paint, so closing the
  // context early would CANCEL an in-flight request and report "0
  // emitting telemetry" for an origin that was in fact regressing —
  // the readiness failure masking the privacy failure (Codex #1838 r3).
  await page.waitForTimeout(SETTLE_MS).catch(() => {});

  const wcExercised = await page
    .evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('wc@2:')))
    .catch(() => false);

  // Bundle assertion (#1840) — configuration evidence, independent of
  // traffic. Skipped when readiness failed: reading scripts off a page
  // that never mounted proves nothing about what the app would run.
  let bundleNote = null;
  if (readinessError === null) {
    const js = await deployedScripts(page, new URL(url).origin).catch(() => '');
    if (!js) {
      bundleNote = 'bundle NOT READ — could not fetch scripts';
    } else {
      const cbOk = CB_FLAG.test(js);
      const wcBuilt = WC_CALLSITE.test(js);
      const wcOk = WC_FLAG.test(js);
      if (!cbOk || (wcBuilt && !wcOk)) {
        bundleNote = `bundle MISSING setting — coinbase:${cbOk ? 'ok' : 'ABSENT'} ` +
          `walletconnect:${wcBuilt ? (wcOk ? 'ok' : 'ABSENT') : 'not built in'}`;
      } else {
        bundleNote = `bundle carries settings — coinbase:ok ` +
          `walletconnect:${wcBuilt ? 'ok' : 'not built in'}`;
      }
    }
  }
  const bundleFailed = bundleNote !== null && /MISSING|NOT READ/.test(bundleNote);

  const didEmit = hits.length > 0;
  const isUnverified = readinessError !== null || bundleFailed;

  if (didEmit) {
    console.log(`FAIL  ${url} — ${hits.length} telemetry request(s) on load:`);
    for (const h of hits) console.log(`        ${h}`);
    emitted++;
  }
  if (isUnverified) {
    console.log(
      `FAIL  ${url} — not verifiably exercised: ${readinessError ?? bundleNote}`,
    );
    unverified++;
  }
  if (!didEmit && !isUnverified) {
    clean++;
    console.log(`PASS  ${url} — Coinbase SDK constructed and silent (cbwsdk.store present)`);
    console.log(
      wcExercised
        ? '        WalletConnect: provider constructed, also silent'
        : '        WalletConnect: not exercised at load — covered by the bundle check below',
    );
    if (bundleNote) console.log(`        ${bundleNote}`);
  }

  await ctx.close();
}

await browser.close();

// Report the two failure kinds SEPARATELY, and count clean origins
// DIRECTLY rather than subtracting. An origin can be both emitting and
// unverified; subtracting each from the total counted it twice, so one
// bad target in a one-target run printed "-1 clean" (Codex #1838 r3).
// An impossible summary discredits the numbers beside it.
console.log(
  `\n${clean} clean, ${emitted} emitting telemetry, ${unverified} not verifiably exercised ` +
    `(of ${targets.length}).`,
);
process.exit(emitted + unverified === 0 ? 0 : 1);
