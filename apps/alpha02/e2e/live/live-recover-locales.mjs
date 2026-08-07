// #1560 post-deploy live review — does /recover actually RENDER in each
// advertised language on production?
//
// This is a different question from the one the coverage guard answers,
// and neither implies the other:
//
//  - `check-locale-coverage` reads the JSON on disk. It proves the KEYS
//    EXIST in every bundle and that interpolation tokens survived. It
//    cannot prove the deployed app ever SERVES that bundle: locale
//    resources are code-split and fetched at runtime, so a chunk that
//    404s, a build that drops a locale from the split, or a language
//    detector that never switches all leave the guard perfectly green
//    while the reader sees English.
//  - The fork/Vite tier cannot close that gap either. It serves assets
//    from a dev server with a different chunking story than the
//    deployed Worker, so "the chunk loads" there is not evidence about
//    production.
//
// Hence: seed the language preference, load the real deployed page, and
// assert on what actually rendered.
//
// A row passes only when ALL THREE hold:
//   1. `<html lang>` switched to the requested locale — proves the
//      language actually took effect rather than the seed being ignored.
//   2. The <h1> is non-empty — an empty string would otherwise satisfy
//      "not English" and pass a naive check while the page rendered
//      nothing (the i18next `returnEmptyString` failure mode).
//   3. The <h1> differs from the ENGLISH SOURCE. This is the one that
//      catches a silent fallback: `copy.*` resolves via
//      `i18n.t(key, { defaultValue: englishSource })`, so a missing
//      resource renders the English text with no error anywhere. Equal
//      to English means untranslated, not translated-identically —
//      these strings have no plausible identical translation in any of
//      the nine.
//
// Arabic additionally asserts `dir="rtl"`: a bundle can be fully
// translated and still ship unreadable if the document direction never
// flips.
//
// Read-only — it navigates and reads the DOM, and rides driver.mjs's
// route shim + read-only RPC guard like every other live drive. It
// never connects a wallet: /recover renders its language-bearing chrome
// unconnected, and a drive that needs no key should not hold one.
//
// Usage (from apps/alpha02/e2e/live/):
//   LIVE_CHROMIUM_PATH=/opt/pw-browsers/chromium \
//   TESTNET_WALLETS_FILE=~/secrets/vaipakam-dev-wallets.json \
//     node live-recover-locales.mjs
//
// SITE_URL overrides the target (defaults to production).
import { launch, SITE } from './driver.mjs';

// The nine advertised translations. Deliberately NOT imported from the
// app: this drive's job is to check the DEPLOYED build against the set
// we believe we ship, and importing the build's own list would make the
// two agree by construction — a locale silently dropped from the split
// would then be silently dropped from the check too.
const LOCALES = ['ar', 'de', 'es', 'fr', 'hi', 'ja', 'ko', 'ta', 'zh'];

const RTL_LOCALES = new Set(['ar']);

// The English source for `copy.recover.title`. Kept here rather than
// read from en.json so that an accidental edit to the English catalog
// cannot make the fallback check vacuous by matching both sides.
const EN_TITLE = 'Recover stuck tokens';

/** @param {import('@playwright/test').Page} page */
async function probe(page, code) {
  await page.goto(`${SITE}/recover`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  // The locale chunk is fetched after hydration; give it room to land
  // so a slow fetch reads as slow rather than as untranslated.
  await page.waitForFunction(
    () => (document.querySelector('h1')?.textContent ?? '').trim() !== '',
    undefined,
    { timeout: 30_000 },
  ).catch(() => {});

  const lang = await page.evaluate(() => document.documentElement.lang || '');
  const dir = await page.evaluate(() => document.documentElement.dir || 'ltr');
  const h1 = (
    (await page.locator('h1').first().textContent().catch(() => '')) ?? ''
  ).trim();

  const problems = [];
  if (!lang.startsWith(code)) problems.push(`lang="${lang}" (wanted ${code})`);
  if (h1 === '') problems.push('h1 empty');
  else if (h1 === EN_TITLE) problems.push('h1 is the English source — fell back');
  if (RTL_LOCALES.has(code) && dir !== 'rtl') problems.push(`dir="${dir}" (wanted rtl)`);

  return { lang, dir, h1, problems };
}

const rows = [];
for (const code of LOCALES) {
  // A fresh profile per locale: the persistent profile would carry the
  // previous locale's `vaipakam:language` and localStorage-cached
  // resources, so a run could pass on a stale bundle.
  const { ctx, page } = await launch({
    role: 'lender',
    readOnly: true,
    freshProfile: true,
    preAuthorized: false,
  });
  try {
    await ctx.addInitScript((c) => {
      try {
        window.localStorage.setItem('vaipakam:language', c);
      } catch {
        /* storage disabled — the lang assertion below will catch it */
      }
    }, code);
    rows.push({ code, ...(await probe(page, code)) });
  } catch (err) {
    rows.push({
      code,
      lang: '?',
      dir: '?',
      h1: '',
      problems: [`drive error: ${String(err).slice(0, 120)}`],
    });
  } finally {
    await ctx.close();
  }
}

let failed = 0;
for (const r of rows) {
  if (r.problems.length > 0) {
    failed++;
    console.log(`FAIL ${r.code}  ${r.problems.join('; ')}  h1="${r.h1}"`);
  } else {
    console.log(`ok   ${r.code}  lang=${r.lang} dir=${r.dir}  h1="${r.h1}"`);
  }
}

console.log('');
if (failed > 0) {
  console.log(
    `live recover locales: ${failed} of ${rows.length} locale(s) FAILED`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `live recover locales: all ${rows.length} render /recover in their own language`,
  );
}
