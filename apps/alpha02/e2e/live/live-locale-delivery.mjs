/**
 * WATCH-ONLY live check: does the DEPLOYED build serve a given copy key in
 * every language, with that language's OWN text rather than English?
 *
 * Why this exists (Codex #1698 r1): English lives in the main `copy` chunk
 * while every translation is a separately lazy-loaded chunk, and a missing
 * key falls back to English SILENTLY. Finding the English string in the
 * deployed bundle therefore proves English delivery and nothing more — a
 * stale or missing locale chunk is externally indistinguishable from a
 * correct one. `check-locale-coverage` cannot close this: it reads the
 * SOURCE bundles at build time, and the gap being tested here is between a
 * build that passes that gate and what production actually serves.
 *
 * Expectations are DERIVED from the committed locale catalogs for whichever
 * key is requested (#1698 r2) — never hard-coded. Hard-coding one key's
 * fragments made `COPY_KEY` a lie: any other key would have been checked
 * against the first key's text and passed while shipping English.
 *
 * FALSE-FAIL note, learned the hard way, twice. The first version waited on
 * `networkidle`: run 1 passed all nine locales, run 2 reported seven FAIL,
 * while a direct fetch of those same chunks showed every translation
 * present. The second version fixed the wait but only recorded the chunk
 * body when it already contained the key — making the missing-key FAIL
 * branch unreachable, so a genuinely absent translation would have been
 * reported BLOCKED (Codex #1698 r3). Hence the rule this file now enforces
 * everywhere: FAIL requires having READ the artefact and found it wrong.
 * Anything that stopped us reading it is BLOCKED. A spurious "translation
 * missing" sends someone hunting a shipped bug that does not exist, which
 * is worse than the unverified claim this driver was written to replace.
 *
 * Watch-only is ENFORCED, not advertised (Codex #1698 r2): the route pump
 * default-DENIES any non-GET/HEAD request. Omitting a wallet stops signing,
 * but it does not make ordinary HTTP endpoints read-only, and a regressed
 * or hostile SITE_URL must not be able to POST through this shim.
 *
 * Usage:
 *   node live-locale-delivery.mjs
 *   COPY_KEY=offset.figuresMoved node live-locale-delivery.mjs
 *   SITE_URL=https://<preview>.workers.dev node live-locale-delivery.mjs
 *   LIVE_CHROMIUM_PATH=/path/to/chromium node live-locale-delivery.mjs
 *
 * Verdicts (the three-verdict contract, #1581 — registered in
 * run-live-batch.mjs's THREE_VERDICT_DRIVERS so exit 2 is not relabelled):
 *   0 PASS    — every language serves the key with its own text
 *   1 FAIL    — a chunk was READ and carries English, or lacks the key
 *   2 BLOCKED — setup, transport, or activation stopped the observation
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(HERE, '..', '..', 'src', 'i18n', 'locales');
const SITE = process.env.SITE_URL ?? 'https://alpha02.vaipakam.com';
const KEY_PATH = process.env.COPY_KEY ?? 'offset.figuresMoved';
/** Languages whose activation must also flip document direction. */
const RTL = new Set(['ar', 'he', 'fa', 'ur']);

const blockedExit = (why, extra) => {
  console.log(JSON.stringify({ verdict: 'BLOCKED', why, ...(extra ?? {}) }));
  console.log(`\nBLOCKED: ${why} — nothing verified.`);
  process.exit(2);
};

/** Resolve a dotted path under `copy` in a locale catalog. */
const at = (obj, dotted) =>
  dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj?.copy);

// ---- Expectations, derived from the committed catalogs -------------------
let english;
const expect = new Map();
try {
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  english = at(en, KEY_PATH);
  if (typeof english !== 'string' || !english) {
    blockedExit(`en.json has no string at copy.${KEY_PATH}`);
  }
  for (const f of fs.readdirSync(LOCALES_DIR)) {
    if (!f.endsWith('.json') || f === 'en.json') continue;
    const loc = f.replace(/\.json$/, '');
    const value = at(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8')), KEY_PATH);
    // A catalog without this key is a repo PRECONDITION gap, not a
    // deployment defect: it is in KNOWN_GAPS or simply untranslated, and
    // this drive has nothing to assert for it. Skipping is the honest move
    // — asserting English-absence there would fail every ungated locale.
    if (typeof value === 'string' && value && value !== english) expect.set(loc, value);
  }
} catch (e) {
  blockedExit(`could not read locale catalogs: ${String(e).slice(0, 90)}`);
}
if (!expect.size) blockedExit(`no translated catalog carries copy.${KEY_PATH}`);

// ---- Browser ------------------------------------------------------------
// Guarded: a missing Chromium or a bad LIVE_CHROMIUM_PATH is the harness
// failing to start, never a product FAIL (Codex #1698 r2).
let browser;
try {
  browser = await chromium.launch({
    args: ['--no-sandbox'],
    ...(process.env.LIVE_CHROMIUM_PATH
      ? { executablePath: process.env.LIVE_CHROMIUM_PATH }
      : {}),
  });
} catch (e) {
  blockedExit(`Chromium would not launch: ${String(e).split('\n')[0].slice(0, 90)}`);
}

const rows = [];
let blocked = 0;

for (const [loc, translated] of [...expect.entries(), ['en', english]]) {
  const ctx = await browser.newContext();
  const chunks = [];
  const readFailures = [];
  const refusedWrites = [];
  let body = null;      // the chunk we are judging, once READ
  let offHost = null;

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!['GET', 'HEAD'].includes(req.method())) {
      refusedWrites.push(`${req.method()} ${req.url().slice(0, 80)}`);
      await route.abort();
      return;
    }
    try {
      // Manual redirects (Codex #1698 r2): following them here and
      // fulfilling at the ORIGINAL url would let a preview that redirects
      // to production pass by inspecting production's chunks while
      // appearing to stay on the preview host. Hand the 3xx back and let
      // Chromium follow it, so the final target is observable.
      const res = await fetch(req.url(), {
        method: req.method(),
        headers: req.headers(),
        redirect: 'manual',
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const headers = {};
      res.headers.forEach((v, k) => {
        if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) headers[k] = v;
      });
      // Record EVERY matching chunk, regardless of contents: capturing only
      // chunks that already contain the key is what made FAIL unreachable.
      const isTarget =
        loc === 'en'
          ? /\/assets\/copy-[^/]*\.js/.test(req.url())
          : new RegExp(`/assets/${loc}-[^/]*\\.js`).test(req.url());
      if (isTarget) {
        chunks.push(req.url().split('/assets/')[1]);
        body = buf.toString('utf8');
      }
      await route.fulfill({ status: res.status, headers, body: buf });
    } catch (e) {
      readFailures.push(`${req.url().split('/assets/')[1] ?? req.url()}: ${String(e).slice(0, 60)}`);
      await route.abort();
    }
  });
  await ctx.addInitScript((l) => localStorage.setItem('vaipakam:language', l), loc);

  const page = await ctx.newPage();
  const target = loc === 'en' ? /\/assets\/copy-[^/]*\.js/ : new RegExp(`/assets/${loc}-[^/]*\\.js`);
  const arrival = page.waitForResponse((r) => target.test(r.url()), { timeout: 45_000 }).catch(() => null);
  try {
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await arrival;
    await page.waitForTimeout(500);
    const finalUrl = new URL(page.url());
    if (finalUrl.host !== new URL(SITE).host) offHost = finalUrl.host;
  } catch (e) {
    rows.push({ loc, verdict: 'BLOCKED', why: String(e).split('\n')[0].slice(0, 90) });
    blocked += 1;
    await ctx.close();
    continue;
  }
  const htmlLang = await page.getAttribute('html', 'lang');
  const htmlDir = await page.getAttribute('html', 'dir');
  await ctx.close();

  const block = (why, extra) => {
    rows.push({ loc, htmlLang, htmlDir, verdict: 'BLOCKED', why, chunks, ...(extra ?? {}) });
    blocked += 1;
  };
  if (offHost) { block(`navigation left ${new URL(SITE).host} for ${offHost}`); continue; }
  if (refusedWrites.length) { block('page attempted a write this drive refuses', { refusedWrites: refusedWrites.slice(0, 3) }); continue; }
  if (htmlLang !== loc) { block(`app served <html lang="${htmlLang}">, not ${loc}`); continue; }
  if (RTL.has(loc) && htmlDir !== 'rtl') { block(`${loc} activated without dir="rtl" (got "${htmlDir}")`); continue; }
  if (body === null) {
    block(
      readFailures.length
        ? `${readFailures.length} asset read(s) failed before the ${loc} chunk arrived`
        : `no ${loc} chunk observed within the wait`,
      readFailures.length ? { readFailures: readFailures.slice(0, 3) } : undefined,
    );
    continue;
  }

  // Read the chunk: from here a wrong answer IS a product FAIL.
  const hasOwn = body.includes(translated);
  const hasEnglish = loc !== 'en' && body.includes(english);
  rows.push({
    loc, htmlLang, htmlDir, chunks,
    verdict: hasOwn && !hasEnglish ? 'PASS' : 'FAIL',
    ...(hasOwn ? {} : { why: `chunk read but lacks the ${loc} text for copy.${KEY_PATH}` }),
    ...(hasEnglish ? { why: 'English text shipped in the locale chunk (silent fallback)' } : {}),
  });
}
await browser.close();

for (const r of rows) console.log(JSON.stringify(r));
const failed = rows.filter((r) => r.verdict === 'FAIL');
if (failed.length) {
  console.log(`\nFAIL: ${failed.map((r) => r.loc).join(', ')} — copy.${KEY_PATH} not delivered translated.`);
  process.exit(1);
}
if (blocked) {
  console.log(`\nBLOCKED: ${blocked} language(s) unobservable — ${rows.length - blocked} verified, not all.`);
  process.exit(2);
}
console.log(`\nPASS: all ${rows.length} language(s) deliver copy.${KEY_PATH} with their own text.`);
