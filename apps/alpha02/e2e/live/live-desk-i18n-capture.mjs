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
 * Exit code: non-zero if ANY locale failed to load OR did not switch to the
 * requested language (so `run-live-batch.mjs`, which judges PASS by child
 * exit status, cannot report a blocked/regressed run as green).
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
import { mkdirSync, writeFileSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'https://alpha02.vaipakam.com';
const OUT = new URL('./shots/desk-i18n/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const LOCALES = (process.env.DESK_I18N_LOCALES || 'en,zh,ta,de,fr,es,ar,ja,ko,hi')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// A read-only capture never mutates state. Chain READS are JSON-RPC POSTs, so
// POST can't be blanket-blocked; instead a POST is allowed only when its body
// is JSON-RPC whose every method avoids the signing/broadcast set — anything
// else is aborted and logged (mirrors driver.mjs's read-only HTTP guard).
const RPC_WRITE_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData_v4',
]);
function readOnlyViolation(req) {
  const method = req.method().toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  const body = req.postData();
  if (body) {
    try {
      const parsed = JSON.parse(body);
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (calls.every((c) => c && typeof c.jsonrpc === 'string')) {
        const bad = calls.find((c) => RPC_WRITE_METHODS.has(c.method));
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
  if (lng === 'ar') return String(dir || '').toLowerCase() === 'rtl';
  return true;
}

const report = {};
const blockedRequests = [];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.LIVE_CHROMIUM_PATH
    ? { executablePath: process.env.LIVE_CHROMIUM_PATH }
    : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const lng of LOCALES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: lng,
    ignoreHTTPSErrors: true,
  });

  // Serve every page request from THIS process via undici (so LIVE_PROXY_SETUP
  // takes effect) AND enforce the read-only guard on the way through.
  await ctx.route('**/*', async (route) => {
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
  });

  // Seed the language BEFORE the app boots — the shared i18n factory reads
  // `vaipakam:language` from localStorage on init.
  await ctx.addInitScript((code) => {
    try {
      window.localStorage.setItem('vaipakam:language', code);
    } catch {}
  }, lng);

  const page = await ctx.newPage();
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
  try {
    await page.goto(`${SITE}/desk`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000); // SPA boot + lazy locale chunk activation

    rec.htmlLang = await page.getAttribute('html', 'lang').catch(() => null);
    rec.dir = await page.getAttribute('html', 'dir').catch(() => null);
    rec.langOk = languageMatches(lng, rec.htmlLang, rec.dir);
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
    // Success = page rendered SOME desk text AND the language actually switched.
    rec.ok = rec.langOk && rec.deskText.length > 0;
    if (!rec.langOk) {
      rec.error = `language did not switch: html lang="${rec.htmlLang}" dir="${rec.dir}" (wanted ${lng})`;
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
const failed = Object.values(report).filter((r) => !r.ok);
if (failed.length || blockedRequests.length) {
  console.error(
    `\nFAIL: ${failed.length}/${LOCALES.length} locale(s) did not capture cleanly` +
      (blockedRequests.length ? ` + ${blockedRequests.length} blocked non-read request(s)` : '') +
      `: ${failed.map((r) => `${r.lng}(${r.error || 'no desk text'})`).join(', ')}`,
  );
  process.exitCode = 1;
}
