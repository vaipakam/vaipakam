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
 *
 * Env:
 *   SITE_URL                 — default https://alpha02.vaipakam.com
 *   DESK_I18N_LOCALES        — comma list; default en,zh,ta,de,fr,es,ar,ja,ko,hi
 *   PW_CHROMIUM_EXECUTABLE   — override the Chromium binary (only needed when
 *                              the pinned @playwright/test build mismatches the
 *                              installed browser, e.g. a sandbox image)
 *   HTTPS_PROXY / HTTP_PROXY — routed through automatically when set (for
 *                              sandboxes whose gateway resets direct Chromium TLS)
 *
 * NB: some desk strings (positions, own orders) only render with a connected
 * wallet + live data — this read-only pass confirms the language switch and
 * the publicly-rendered desk chrome (market header, tape, ladder, tooltips).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'https://alpha02.vaipakam.com';
const OUT = new URL('./shots/desk-i18n/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const LOCALES = (process.env.DESK_I18N_LOCALES || 'en,zh,ta,de,fr,es,ar,ja,ko,hi')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;

const report = {};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PW_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE }
    : {}),
  ...(PROXY ? { proxy: { server: PROXY } } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const lng of LOCALES) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: lng,
    ignoreHTTPSErrors: true,
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
    rec.ok = true;
  } catch (e) {
    rec.error = String(e).slice(0, 300);
  }
  await page.screenshot({ path: `${OUT}${lng}-desk.png`, fullPage: true }).catch(() => {});
  report[lng] = rec;
  console.log(
    `[${lng}] ok=${rec.ok} htmlLang=${rec.htmlLang} dir=${rec.dir} titles=${rec.titles.length} textLines=${rec.deskText.length}${rec.error ? ' ERR=' + rec.error : ''}`,
  );
  await ctx.close();
}

writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
console.log('\nWrote', `${OUT}report.json`);
await browser.close();
