/**
 * WATCH-ONLY live check: does each DEPLOYED locale chunk actually carry a
 * given copy key, with its TRANSLATED value rather than an English one?
 *
 * Why this exists (Codex #1698 r1): the English string lives in the main
 * `copy` chunk, while every translated locale is a separately lazy-loaded
 * chunk and a missing key falls back to English SILENTLY. So finding the
 * English text in the deployed bundle proves English delivery and nothing
 * more — a stale or missing locale chunk looks identical to a correct one
 * from the outside. Any live review that credits "the i18n gate shipped"
 * on the strength of the English string is crediting an unverified claim.
 *
 * Two assertions per locale, and the second is the load-bearing one:
 *   1. the key name appears in a chunk the app actually loaded for that
 *      language (proves the chunk shipped and is reachable), and
 *   2. the locale's OWN translated text is in it, while the English text
 *      is NOT (proves the value shipped, not a baked-in fallback).
 *
 * Requests are pumped through node's fetch rather than the browser's own
 * stack, because in this sandbox the egress gateway resets TLS on every
 * routed page request — the same reason `live-position-observe.mjs`
 * installs a `ctx.route('**\/*')` pump. No wallet, no signing, no key:
 * this drive cannot touch state.
 *
 * Usage:
 *   node live-locale-delivery.mjs                       # default key + site
 *   COPY_KEY=figuresMoved node live-locale-delivery.mjs
 *   SITE_URL=https://<preview>.workers.dev node live-locale-delivery.mjs
 *
 * Verdicts (the three-verdict contract, #1581):
 *   0 PASS    — every locale carries the key with its own translation
 *   1 FAIL    — a locale is missing the key, or carries English for it
 *   2 BLOCKED — the site or a chunk could not be read at all
 */
import { chromium } from '@playwright/test';

const SITE = process.env.SITE_URL ?? 'https://alpha02.vaipakam.com';
const KEY = process.env.COPY_KEY ?? 'figuresMoved';

/** Locale → a distinctive fragment of that locale's own translation, and
 *  the English text that must NOT appear in its place. Fragments are
 *  deliberately short and mid-sentence so ordinary re-wording of the rest
 *  of the string does not turn this into a false FAIL. */
const EXPECT = {
  es: 'Las cifras cambiaron',
  fr: 'Les chiffres ont évolué',
  de: 'Die Zahlen haben sich',
  ja: '確認中に数値が変わった',
  zh: '审核期间数字发生了变化',
  hi: 'figures बदल गए',
  ar: 'تغيّرت الأرقام أثناء',
  ta: 'எண்கள் மாறியதால்',
  ko: '검토 중에 숫자가 변경되어',
};
const ENGLISH = 'The figures moved while you were reviewing';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const rows = [];
let blocked = 0;

for (const [loc, fragment] of Object.entries(EXPECT)) {
  const ctx = await browser.newContext();
  const chunks = [];
  let keySeen = false;
  let localeChunkBody = null;

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    try {
      const res = await fetch(req.url(), {
        method: req.method(),
        headers: req.headers(),
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer(),
        redirect: 'follow',
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const headers = {};
      // Drop the encoding/length headers: fetch has already decompressed.
      res.headers.forEach((v, k) => {
        if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) headers[k] = v;
      });
      if (/\/assets\/.*\.js/.test(req.url()) && buf.includes(KEY)) {
        keySeen = true;
        const name = req.url().split('/assets/')[1];
        chunks.push(name);
        if (new RegExp(`/${loc}-`).test(req.url())) localeChunkBody = buf.toString('utf8');
      }
      await route.fulfill({ status: res.status, headers, body: buf });
    } catch {
      await route.abort();
    }
  });
  await ctx.addInitScript((l) => localStorage.setItem('vaipakam:language', l), loc);

  const page = await ctx.newPage();
  try {
    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForTimeout(2_500);
  } catch (e) {
    rows.push({ loc, verdict: 'BLOCKED', why: String(e).split('\n')[0].slice(0, 90) });
    blocked += 1;
    await ctx.close();
    continue;
  }
  const htmlLang = await page.getAttribute('html', 'lang');
  await ctx.close();

  if (!keySeen || localeChunkBody === null) {
    rows.push({ loc, htmlLang, verdict: 'FAIL', why: `no loaded ${loc} chunk carries ${KEY}`, chunks });
    continue;
  }
  const hasOwn = localeChunkBody.includes(fragment);
  const hasEnglish = localeChunkBody.includes(ENGLISH);
  rows.push({
    loc, htmlLang, chunks,
    verdict: hasOwn && !hasEnglish ? 'PASS' : 'FAIL',
    ...(hasOwn ? {} : { why: 'translated value absent' }),
    ...(hasEnglish ? { why: 'English text shipped in the locale chunk' } : {}),
  });
}
await browser.close();

for (const r of rows) console.log(JSON.stringify(r));
const failed = rows.filter((r) => r.verdict === 'FAIL');
if (blocked && !failed.length) {
  console.log(`\nBLOCKED: ${blocked} locale(s) unreadable — nothing verified.`);
  process.exit(2);
}
if (failed.length) {
  console.log(`\nFAIL: ${failed.map((r) => r.loc).join(', ')} — key "${KEY}" not delivered translated.`);
  process.exit(1);
}
console.log(`\nPASS: all ${rows.length} locale(s) deliver "${KEY}" with their own translation.`);
