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
 *     https://app.vaipakam.com/
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
 * BOTH settings are required, unconditionally. There is deliberately no
 * "this build has no WalletConnect connector, so excuse the missing
 * flag" branch: an earlier draft had one, and it could not be made
 * sound. The connector sits behind
 * `...(WC_PROJECT_ID ? [walletConnect({…})] : [])` with the env var
 * substituted at build time, so a build without a project id really can
 * ship without the call site — but nothing in the bundle reliably says
 * so. ConnectKit generates its OWN WalletConnect config whose minified
 * shape is nearly identical to ours, so any marker that claims "our
 * block is present" can be satisfied by library code.
 *
 * Rather than guess, absence is reported as NOT CONFIRMED naming both
 * causes, and counted as a configuration failure. That is the honest
 * direction: a deployment that legitimately omits the connector gets
 * looked at by a person once, whereas excusing absence automatically
 * would silently excuse a regression too.
 */
const MINIFIED_FALSE = String.raw`(?:!1|false)`;

/**
 * Anchored to the LOCAL OPTION OBJECT, not to a bundle-wide property
 * fragment (Codex #1857 r1). A bare `telemetryEnabled\s*:\s*false` is
 * satisfied by any `_telemetryEnabled:false` a dependency happens to
 * contribute, so a real regression could pass the moment unrelated code
 * grew a similar substring. These match the adjacency our own call
 * produces — verified against the deployed bundle, which minifies to
 * `showQrModal:!1,telemetryEnabled:!1,metadata:{…}` and
 * `preference:{options:\`all\`,telemetry:!1}`.
 */
const WC_CONFIGURED = new RegExp(
  String.raw`showQrModal\s*:\s*` + MINIFIED_FALSE + String.raw`\s*,\s*telemetryEnabled\s*:\s*` + MINIFIED_FALSE,
);
const CB_CONFIGURED = new RegExp(
  String.raw`preference\s*:\s*\{[^{}]{0,160}?telemetry\s*:\s*` + MINIFIED_FALSE,
);

/**
 * What this check can and cannot conclude, stated because an earlier
 * draft claimed more.
 *
 * It can CONFIRM a setting shipped. It cannot reliably prove a benign
 * absence. The first attempt tried to distinguish "our connector was
 * dead-code-eliminated because this build has no project id" from "the
 * setting regressed", using a marker token — and no such token survives
 * scrutiny: ConnectKit generates its own WalletConnect config whose
 * minified shape (`showQrModal:!1,projectId:…,metadata:{…}`) is nearly
 * identical to ours, so a marker reads as "our call is present" on a
 * build where it is not.
 *
 * So absence is reported as NOT CONFIRMED with both possible causes
 * named, and treated as a failure of the CONFIGURATION check — never
 * silently excused, and never dressed up as proof of a leak either.
 */
async function assertBundleSettings(page, origin) {
  // Resource timing, not `script[src]` (Codex #1857 r1). Vite fetches
  // statically and dynamically imported chunks through the module
  // loader, which creates no script element — so the DOM lists only the
  // entry, and configuration living in a chunk would read as absent.
  const urls = await page.evaluate((o) => {
    const fromTiming = performance
      .getEntriesByType('resource')
      .filter((e) => e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name))
      .map((e) => e.name);
    const fromDom = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src);
    // Parsed origin equality, NOT a prefix test: `https://app.example`
    // prefixes `https://app.example-cdn.com/wallet.js`, so `startsWith`
    // would admit a third-party script whose contents could satisfy both
    // patterns while the app's own bundle had regressed (Codex #1857 r3).
    return Array.from(new Set([...fromTiming, ...fromDom])).filter((u) => {
      try {
        return new URL(u).origin === o;
      } catch {
        return false;
      }
    });
  }, origin);

  if (urls.length === 0) return { ok: false, note: 'config NOT READ — no same-origin scripts observed' };

  // CONCURRENT, with a per-request deadline. Serially, 11 resources at
  // Playwright's 30s default is ~5.5 minutes of stall per origin on a
  // degraded deployment — the check would hang exactly when something
  // is wrong (Codex #1857 r4).
  const bodies = await Promise.all(
    urls.map(async (u) => {
      // `maxRedirects: 0` — `page.request.get` FOLLOWS redirects, so a
      // same-origin URL redirecting to a CDN would smuggle third-party
      // JavaScript past the origin filter above and could satisfy both
      // patterns while the app's own bundle had regressed. The final
      // URL is re-checked too, belt and braces.
      const r = await page.request
        .get(u, { maxRedirects: 0, timeout: 15_000 })
        .catch(() => null);
      if (!r || !r.ok()) return '';
      try {
        if (new URL(r.url()).origin !== origin) return '';
      } catch {
        return '';
      }
      return r.text().catch(() => '');
    }),
  );
  // Joined with a comment separator so a pattern cannot be formed
  // ACROSS a file boundary by concatenation.
  const js = bodies.filter(Boolean).join('\n/*|*/\n');
  if (!js) return { ok: false, note: 'config NOT READ — scripts could not be fetched' };

  const cb = CB_CONFIGURED.test(js);
  const wc = WC_CONFIGURED.test(js);
  if (cb && wc) return { ok: true, note: `config ok — coinbase + walletconnect (${urls.length} script(s))` };
  const missing = [!cb && 'coinbase', !wc && 'walletconnect'].filter(Boolean).join(' + ');
  return {
    ok: false,
    note:
      `config NOT CONFIRMED — ${missing}: either the setting regressed, or this ` +
      `build omits that connector entirely (both need a human to tell apart)`,
  };
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
let configBad = 0;
let configSkipped = 0;
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
  // Navigation reached the right origin — a weaker precondition than
  // full readiness, and the correct one for the config check: the
  // SERVED BUNDLE is evidence about what shipped whether or not the app
  // finished mounting (Codex #1857 r3).
  let navigatedOk = false;
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
    navigatedOk = true;

    // Witness 1 — the APP rendered, not merely "#root has children".
    // app ships a static `#boot-splash` INSIDE `#root` in its
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

  // Configuration evidence (#1840), reported SEPARATELY from traffic —
  // execution and configuration are different claims, and folding a
  // config failure into "not verifiably exercised" said the app never
  // ran when it demonstrably had (Codex #1857 r1). Skipped when
  // navigation failed or landed elsewhere: then the scripts are not
  // this deployment's, and reading them proves nothing. A mount that
  // times out does NOT suppress it — the bundle still shipped.
  // Null means "not evaluated"; the reporting below turns that into an
  // explicit SKIP rather than silently omitting one of the two evidence
  // lines and leaving the summary reading `0 config not confirmed`
  // (Codex #1857 r4). The README promises a line per check.
  let config = null;
  if (navigatedOk) {
    config = await assertBundleSettings(page, new URL(url).origin).catch((e) => ({
      ok: false,
      note: `config NOT READ — ${String(e).split('\n')[0]}`,
    }));
  }

  const didEmit = hits.length > 0;
  const isUnverified = readinessError !== null;
  const configFailed = config !== null && !config.ok;

  // Traffic evidence.
  if (didEmit) {
    console.log(`FAIL  ${url} — ${hits.length} telemetry request(s) on load:`);
    for (const h of hits) console.log(`        ${h}`);
    emitted++;
  }
  if (isUnverified) {
    console.log(`FAIL  ${url} — not verifiably exercised: ${readinessError}`);
    unverified++;
  }
  // A traffic PASS is reported on its own terms. Suppressing it when
  // the configuration check failed hid one kind of evidence behind the
  // other, which is the separation this drive exists to keep (Codex
  // #1857 r3). The origin still does not count as clean.
  if (!didEmit && !isUnverified) {
    console.log(`PASS  ${url} — Coinbase SDK constructed and silent (cbwsdk.store present)`);
    console.log(
      wcExercised
        ? '        WalletConnect: provider constructed, also silent'
        : '        WalletConnect: not exercised at load — see the config line',
    );
  }

  // Configuration evidence, independent of the above.
  if (config) {
    console.log(`${config.ok ? 'PASS  ' : 'FAIL  '}${url} — ${config.note}`);
    if (!config.ok) configBad++;
  } else {
    console.log(
      `SKIP  ${url} — config not inspected: navigation did not reach this origin`,
    );
    configSkipped++;
  }

  if (!didEmit && !isUnverified && !configFailed) clean++;

  await ctx.close();
}

await browser.close();

// Report the two failure kinds SEPARATELY, and count clean origins
// DIRECTLY rather than subtracting. An origin can be both emitting and
// unverified; subtracting each from the total counted it twice, so one
// bad target in a one-target run printed "-1 clean" (Codex #1838 r3).
// An impossible summary discredits the numbers beside it.
console.log(
  `\n${clean} clean, ${emitted} emitting telemetry, ${unverified} not verifiably exercised, ` +
    `${configBad} config not confirmed` +
    (configSkipped ? `, ${configSkipped} config skipped` : '') +
    ` (of ${targets.length}).`,
);
process.exit(emitted + unverified + configBad === 0 ? 0 : 1);
