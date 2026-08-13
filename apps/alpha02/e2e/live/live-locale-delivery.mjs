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
 * FALSE-FAIL note, learned the hard way: an earlier version of this driver
 * waited for `networkidle` and then looked at whatever had loaded. Its first
 * run passed all nine locales; its SECOND reported seven as FAIL, while a
 * direct fetch of those same chunks showed every translation present. The
 * chunks simply had not arrived yet. So FAIL here requires having actually
 * READ the locale chunk and found it wrong — a chunk that never arrived is
 * BLOCKED, never FAIL. A spurious "translation missing" would send someone
 * hunting a shipped bug that does not exist, which is a worse outcome than
 * the unverified claim this driver was written to replace.
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
  const readFailures = [];
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
    } catch (e) {
      // A read that never happened is NOT a product defect. Record it so the
      // verdict can be BLOCKED rather than FAIL — exit 1 must always mean "the
      // app did something wrong", never "the harness could not look properly"
      // (the rule live-position-observe.mjs states and #1581 made uniform).
      // Without this, one reset TLS handshake on a locale chunk reports a
      // missing translation, which is the most misleading outcome available.
      readFailures.push({ url: req.url().split('/assets/')[1] ?? req.url(), why: String(e).slice(0, 80) });
      await route.abort();
    }
  });
  await ctx.addInitScript((l) => localStorage.setItem('vaipakam:language', l), loc);

  const page = await ctx.newPage();
  // Wait for the locale chunk BY NAME rather than for a quiet network. The
  // chunk is a lazy import fired when the language first activates, and it
  // races `networkidle` — every request here round-trips through node's fetch
  // via the sandbox proxy, so "idle" can arrive before the import resolves.
  // Waiting on the artefact we are here to inspect is both faster and the
  // only version that cannot silently observe nothing (see the FALSE-FAIL
  // note in the header).
  const localeChunk = page
    .waitForResponse((r) => new RegExp(`/assets/${loc}-[^/]*\\.js`).test(r.url()), { timeout: 45_000 })
    .catch(() => null);
  try {
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await localeChunk;
    await page.waitForTimeout(500);
  } catch (e) {
    rows.push({ loc, verdict: 'BLOCKED', why: String(e).split('\n')[0].slice(0, 90) });
    blocked += 1;
    await ctx.close();
    continue;
  }
  const htmlLang = await page.getAttribute('html', 'lang');
  await ctx.close();

  // Could the drive even put the app INTO this language? The i18n stack lets a
  // cookie outrank the seeded localStorage value, and a fresh context has no
  // cookie — but if that ever changes, or the picker stops stamping <html lang>,
  // the app would serve English and the locale chunk would never load. That is
  // the harness failing to set up the observation, not a missing translation,
  // so it must not be reported as FAIL.
  if (htmlLang !== loc) {
    rows.push({ loc, htmlLang, verdict: 'BLOCKED', why: `app served <html lang="${htmlLang}">, not ${loc}`, chunks });
    blocked += 1;
    continue;
  }
  // A chunk this drive never saw is a chunk this drive cannot judge. Reaching
  // FAIL requires having READ the locale chunk and found it wrong; anything
  // else is BLOCKED. This distinction is not pedantry — the first version of
  // this driver reported seven locales as FAIL on its second run purely
  // because the lazy chunks had not arrived before it looked, while a direct
  // fetch of those same chunks showed every translation present and correct.
  // A false "translation missing" sends someone hunting a shipped bug that
  // does not exist, which is a worse failure than the unverified claim this
  // driver was written to replace.
  if (localeChunkBody === null) {
    rows.push({
      loc, htmlLang, verdict: 'BLOCKED', chunks,
      why: readFailures.length
        ? `${readFailures.length} asset read(s) failed before the ${loc} chunk arrived`
        : `no ${loc} chunk observed within the wait — nothing judged`,
      ...(readFailures.length ? { readFailures: readFailures.slice(0, 3) } : {}),
    });
    blocked += 1;
    continue;
  }
  if (!keySeen) {
    rows.push({ loc, htmlLang, verdict: 'FAIL', why: `${loc} chunk loaded but lacks ${KEY}`, chunks });
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
