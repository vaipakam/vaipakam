/**
 * live-desk-i18n-capture.mjs — read-only per-locale Rate-Desk i18n capture.
 *
 * For each active locale, seeds the `vaipakam:language` preference, loads
 * `/desk` on the deployed site, screenshots it, and scrapes any rendered
 * `copy.desk.*` text + tooltip `title` attributes. No wallet, no signing —
 * pure observation, for the post-deploy visual half of an i18n review (see
 * `docs/DesignsAndPlans/RateDeskI18nLiveReview-2026-07-22.md`).
 *
 * Usage (from apps/alpha02/e2e/live/):
 *   node live-desk-i18n-capture.mjs
 *   SITE_URL=https://<branch-preview>.workers.dev node live-desk-i18n-capture.mjs
 *   LIVE_PROXY_SETUP=./my-egress-shim.mjs node live-desk-i18n-capture.mjs
 *
 * Env:
 *   SITE_URL            — default https://alpha02.vaipakam.com
 *   DESK_I18N_LOCALES   — comma list; default en,zh,ta,de,fr,es,ar,ja,ko,hi
 *   LIVE_PROXY_SETUP    — optional egress-shim module (same knob driver.mjs
 *                         uses): imported before any page traffic so its
 *                         undici dispatcher swap routes the page fetches
 *                         below through the accepted proxy stack. Every page
 *                         request is served from THIS process via undici, so
 *                         setting the var actually takes effect (Chromium's
 *                         own TLS is never used for page traffic).
 *   LIVE_CHROMIUM_PATH  — override the Chromium binary (same knob driver.mjs
 *                         uses) when a pinned Playwright build mismatches the
 *                         installed browser (e.g. a sandbox image).
 *
 * Exit codes follow the three-verdict contract in `run-live-batch.mjs`
 * (#1581): 0 when every locale captured cleanly, 1 when a locale loaded but
 * did not switch language or rendered no desk (a regression this drive
 * found), 2 when it could not capture at all — no browser, nowhere to write
 * the artifacts, or a site that never answered the first load. Before the
 * migration all three collapsed into 1, so a sandbox without a usable
 * Chromium was reported as a desk-i18n defect.
 *
 * NB: some desk strings (positions, own orders) only render with a connected
 * wallet + live data — this read-only pass confirms the language switch and
 * the publicly-rendered desk chrome (market header, tape, ladder, tooltips).
 */

// Egress shim (optional) — MUST run before we capture `globalThis.fetch`, so
// a swapped undici dispatcher is the one the route handler below uses.
if (process.env.LIVE_PROXY_SETUP) {
  await import(process.env.LIVE_PROXY_SETUP);
}
const ufetch = globalThis.fetch;

import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

// Dynamic, not a static import: a static one is HOISTED above the shim
// block above, so driver.mjs would capture its own `globalThis.fetch`
// before this file's documented shim ordering had run. This drive owns
// that ordering deliberately, so it reaches the shared BLOCKED exits
// (#1581) without disturbing it — the shared exits are the point, since a
// second local copy is how two definitions of "BLOCKED" start diverging.
const { blockedSync, precondition, trackBrowser } = await import('./driver.mjs');

const SITE = process.env.SITE_URL || 'https://alpha02.vaipakam.com';
const OUT = new URL('./shots/desk-i18n/', import.meta.url).pathname;
try {
  // The screenshots and report ARE this drive's output — nowhere to write
  // them means it captured nothing, which is BLOCKED, not a defect.
  //
  // `mkdirSync(recursive)` alone was not enough (Codex #1621 r1): on an
  // EXISTING but non-writable directory it succeeds without touching
  // write permission, and the failure then surfaced at the very end —
  // screenshot errors are swallowed by design, so the first hard error
  // was the closing `writeFileSync`, exiting 1 after ten locales of work
  // and labelling "nowhere to write" an i18n regression. Probe an actual
  // write, so the drive stops in the first second with the true cause.
  mkdirSync(OUT, { recursive: true });
  const probe = `${OUT}.write-probe`;
  writeFileSync(probe, '');
  rmSync(probe, { force: true });
} catch (err) {
  blockedSync(`cannot write to the capture output directory\n  path: ${OUT}\n  ${err.message}`);
}

const LOCALES = (process.env.DESK_I18N_LOCALES || 'en,zh,ta,de,fr,es,ar,ja,ko,hi')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// A selector that normalises to NOTHING is BLOCKED, not PASS (Codex
// #1621 r2). `DESK_I18N_LOCALES=",,,"` is non-empty, so the `||` default
// does not apply, and the filter then leaves an empty list: the loop ran
// zero times, the report was written empty, and the drive exited 0 —
// the batch reporting "captured cleanly" about a run that captured
// nothing. Same rule as live-ux-sweep.mjs's empty session selection.
if (LOCALES.length === 0) {
  blockedSync(
    `DESK_I18N_LOCALES=${JSON.stringify(process.env.DESK_I18N_LOCALES)} selects` +
      ` no locales — nothing to capture.`,
  );
}

// A read-only capture never mutates state. Chain READS are JSON-RPC POSTs, so
// POST can't be blanket-blocked; instead a POST is allowed only when its body
// is JSON-RPC whose every method avoids the signing/broadcast/dev-mutator set
// — anything else is aborted and logged (mirrors driver.mjs's read-only HTTP
// guard, extended: an allowlist of read methods would risk aborting a
// legitimate read the app issues and silently breaking the capture, so the
// denylist is instead widened to cover the dev-chain state-mutating families
// (anvil_/hardhat_/evm_/…) a preview target might expose).
const RPC_WRITE_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
]);
const RPC_WRITE_PREFIXES = ['anvil_', 'hardhat_', 'evm_', 'ganache_', 'tenderly_', 'wallet_'];
function isWriteRpc(method) {
  const m = String(method || '');
  return RPC_WRITE_METHODS.has(m) || RPC_WRITE_PREFIXES.some((p) => m.startsWith(p));
}
function readOnlyViolation(req) {
  const method = req.method().toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const body = req.postData();
  if (body) {
    try {
      const parsed = JSON.parse(body);
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (calls.every((c) => c && typeof c.jsonrpc === 'string')) {
        const bad = calls.find((c) => isWriteRpc(c.method));
        return bad ? `json-rpc ${bad.method}` : null; // read-shaped RPC — allowed
      }
    } catch {
      /* not JSON — fall through to block */
    }
  }
  return `${method} (non-RPC mutating request)`;
}

/** Does the rendered <html lang>/<dir> match the requested locale? The whole
 *  point of this driver is to confirm the language switch, so a row is only a
 *  success when the app actually flipped to it (and RTL for Arabic). */
function languageMatches(lng, htmlLang, dir) {
  const base = String(htmlLang || '').toLowerCase().split('-')[0];
  if (base !== lng.toLowerCase()) return false;
  const d = String(dir || '').toLowerCase();
  // Arabic must be RTL; every other (LTR) locale must NOT be mirrored, so a
  // direction regression that stamps rtl on de/fr/en is caught too.
  return lng === 'ar' ? d === 'rtl' : d !== 'rtl';
}

/**
 * Serve every page request from THIS process via undici (so
 * LIVE_PROXY_SETUP takes effect) AND enforce the read-only guard on the
 * way through. Defined once rather than per locale — it closes over
 * nothing loop-scoped, and hoisting it lets the whole per-locale setup
 * sit inside one guarded block (Codex #1621 r2).
 */
const routeThroughUndici =  async (route) => {
    const req = route.request();
    const violation = readOnlyViolation(req);
    if (violation) {
      blockedRequests.push({ reason: violation, url: req.url().slice(0, 300) });
      await route.abort('accessdenied').catch(() => {});
      return;
    }
    try {
      const resp = await ufetch(req.url(), {
        method: req.method(),
        headers: Object.fromEntries(
          Object.entries(await req.allHeaders()).filter(
            ([k]) =>
              !k.startsWith(':') &&
              !['host', 'content-length', 'accept-encoding'].includes(k.toLowerCase()),
          ),
        ),
        body: req.postDataBuffer() ?? undefined,
      });
      const body = Buffer.from(await resp.arrayBuffer());
      const headers = {};
      resp.headers.forEach((v, k) => {
        if (!['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(k)) {
          headers[k] = v;
        }
      });
      await route.fulfill({ status: resp.status, headers, body });
    } catch {
      await route.abort('failed');
    }
  };

const report = {};
const blockedRequests = [];

// No browser means no capture at all — BLOCKED, not a desk-i18n defect.
const browser = await precondition('launching a browser', () =>
  chromium.launch({
    headless: true,
    ...(process.env.LIVE_CHROMIUM_PATH
      ? { executablePath: process.env.LIVE_CHROMIUM_PATH }
      : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  }),
);
// Register it so a later BLOCKED exit closes it instead of leaving a
// Chromium behind. `launch()` does this for every other drive; this one
// builds its own per-locale context matrix, so it registers its own.
trackBrowser(browser);

// Locales whose per-locale browser context never came up. Recorded, not
// exited on (Codex #1621 r2): this drive ACCUMULATES findings across
// locales, so a context failure on locale 6 must not erase a real
// language regression found on locale 2. Same precedence rule as
// live-recover-locales.mjs and live-ux-sweep.mjs.
const setupFailures = [];
// Set once the site has actually served a page — see the probe below.
let reachabilityProven = false;

for (const [index, lng] of LOCALES.entries()) {
  let ctx;
  let page;
  try {
    ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: lng,
      ignoreHTTPSErrors: true,
    });
    await ctx.route('**/*', routeThroughUndici);
    // Seed the language BEFORE the app boots — the shared i18n factory
    // reads `vaipakam:language` from localStorage on init.
    await ctx.addInitScript((code) => {
      try {
        window.localStorage.setItem('vaipakam:language', code);
      } catch {}
    }, lng);
    page = await ctx.newPage();
  } catch (err) {
    // An invalid locale tag in DESK_I18N_LOCALES lands here, as does an
    // exhausted browser or a failed route install. Either way nothing was
    // captured for this row — and the context may be half-built, so close
    // it rather than leaking one per failed locale.
    await ctx?.close().catch(() => {});
    const why = String(err?.message ?? err).split('\n')[0].slice(0, 200);
    setupFailures.push({ lng, why });
    report[lng] = { lng, ok: false, blocked: why };
    console.log(`[${lng}] BLOCKED — context setup failed: ${why}`);
    continue;
  }

  const rec = {
    lng,
    url: `${SITE}/desk`,
    ok: false,
    langOk: false,
    htmlLang: null,
    dir: null,
    titles: [],
    deskText: [],
    error: null,
  };
  const openDesk = () =>
    page.goto(`${SITE}/desk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  try {
    // The reachability probe is the FIRST load that actually happens, not
    // whichever locale is index 0 (Codex #1621 r3). Keying it to the
    // index meant that if locale 0's context setup failed, locale 1 --
    // the first page load of the run -- skipped the probe entirely, and
    // an unreachable target was then recorded as an i18n regression on a
    // page that was never served.
    //
    // Once ANY load has succeeded the site is known to serve, so a later
    // failure is a finding rather than a blocked run (#1581).
    if (!reachabilityProven) {
      await precondition(`opening ${SITE}/desk`, openDesk);
      reachabilityProven = true;
    } else {
      await openDesk();
    }
    await page.waitForTimeout(7000); // SPA boot + lazy locale chunk activation

    rec.htmlLang = await page.getAttribute('html', 'lang').catch(() => null);
    rec.dir = await page.getAttribute('html', 'dir').catch(() => null);
    rec.langOk = languageMatches(lng, rec.htmlLang, rec.dir);
    // A desk-specific container must have rendered — otherwise `main` might
    // only hold a Suspense loading/error card (a failed /desk or locale chunk)
    // and the row would falsely pass on shell text alone.
    rec.deskPresent =
      (await page.$$('[class*="desk"], [class*="ladder"], [class*="tape"], [class*="book"]')).length > 0;
    rec.titles = await page
      .$$eval('[title]', (els) =>
        Array.from(new Set(els.map((e) => e.getAttribute('title')).filter(Boolean))).slice(0, 60),
      )
      .catch(() => []);
    rec.deskText = await page
      .$$eval('main, [class*="desk"], [class*="tape"], [class*="ladder"]', (els) =>
        Array.from(
          new Set(
            els
              .map((e) => (e.innerText || '').trim())
              .join('\n')
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s && s.length < 120),
          ),
        ).slice(0, 120),
      )
      .catch(() => []);
    // Success = the language actually switched AND a desk container rendered
    // real text (not just a Suspense loading/error shell).
    rec.ok = rec.langOk && rec.deskPresent && rec.deskText.length > 0;
    if (!rec.langOk) {
      rec.error = `language did not switch: html lang="${rec.htmlLang}" dir="${rec.dir}" (wanted ${lng})`;
    } else if (!rec.deskPresent) {
      rec.error = 'no desk container rendered (shell/loading card only)';
    } else if (rec.deskText.length === 0) {
      rec.error = 'desk container present but no text scraped';
    }
  } catch (e) {
    rec.error = String(e).slice(0, 300);
  }
  await page.screenshot({ path: `${OUT}${lng}-desk.png`, fullPage: true }).catch(() => {});
  report[lng] = rec;
  console.log(
    `[${lng}] ok=${rec.ok} langOk=${rec.langOk} htmlLang=${rec.htmlLang} dir=${rec.dir} titles=${rec.titles.length} textLines=${rec.deskText.length}${rec.error ? ' ERR=' + rec.error : ''}`,
  );
  await ctx.close();
}

if (blockedRequests.length) {
  console.log(`\nBlocked ${blockedRequests.length} non-read request(s):`);
  for (const b of blockedRequests.slice(0, 20)) console.log(`  ${b.reason} ${b.url}`);
}

writeFileSync(`${OUT}report.json`, JSON.stringify({ report, blockedRequests }, null, 2));
console.log('\nWrote', `${OUT}report.json`);
await browser.close();

// Fail loudly so run-live-batch.mjs (which reads the child exit code) can't
// report a blocked/regressed run as green.
// A real finding OUTRANKS an incomplete capture (Codex #1621 r2): a row
// that loaded and showed the wrong language is a defect, and reporting
// BLOCKED because some other locale's context failed would bury it.
const failed = Object.values(report).filter((r) => !r.ok && !r.blocked);
if (failed.length || blockedRequests.length) {
  console.error(
    `\nFAIL: ${failed.length}/${LOCALES.length} locale(s) did not capture cleanly` +
      (blockedRequests.length ? ` + ${blockedRequests.length} blocked non-read request(s)` : '') +
      (setupFailures.length ? ` (${setupFailures.length} more could not be checked)` : '') +
      `: ${failed.map((r) => `${r.lng}(${r.error || 'no desk text'})`).join(', ')}`,
  );
  process.exitCode = 1;
} else if (setupFailures.length) {
  console.error(
    `\nBLOCKED: ${setupFailures.length}/${LOCALES.length} locale(s) could not be` +
      ` captured and none of the rest found a problem, so those languages are` +
      ` still unreviewed:\n` +
      setupFailures.map((f) => `  ${f.lng}: ${f.why}`).join('\n'),
  );
  process.exitCode = 2;
}
