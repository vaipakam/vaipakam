/**
 * Writes the connected app's install icons (#2687) into `public/icons/`.
 *
 * The manifest needs raster icons. Browsers install from PNGs, and iOS reads
 * only `apple-touch-icon`. They are drawn from the same mark as
 * `public/logo.svg` (the indigo badge with the white V), so the installed
 * icon is the one the app already shows. The PNGs are committed. Re-run this
 * after changing the mark:
 *
 *   node scripts/generate-app-icons.mjs
 *
 * Rasterised with the Playwright Chromium the e2e tier already uses, so
 * this adds no image dependency. `src/lib/webManifest.test.ts` checks every
 * file the manifest names exists at the size it claims.
 *
 * Two shapes:
 *  - `any`: the badge as it appears in the app, rounded corners included.
 *  - full-bleed (maskable, and Apple's touch icon): a square badge with no
 *    rounding, because the platform applies its own mask. The V sits well
 *    inside the maskable safe zone (the central 80% circle).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(appDir, 'public', 'icons');

const BRAND = '#4f46e5';
const V_PATH = 'M18 18 L32 46 L46 18';

/** The mark on a 64-unit canvas; `rounded` keeps the badge's corner radius. */
function markSvg(rounded) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%">' +
    `<rect width="64" height="64"${rounded ? ' rx="14"' : ''} fill="${BRAND}"/>` +
    `<path d="${V_PATH}" fill="none" stroke="#ffffff" stroke-width="7" ` +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  );
}

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  { file: 'icon-maskable-512.png', size: 512, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
];

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch(
  process.env.LIVE_CHROMIUM_PATH ? { executablePath: process.env.LIVE_CHROMIUM_PATH } : {},
);
try {
  for (const { file, size, rounded } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${markSvg(rounded)}</body></html>`,
    );
    await page.screenshot({ path: resolve(outDir, file), omitBackground: true });
    await page.close();
    console.log(`[icons] ${file} ${size}x${size}`);
  }
} finally {
  await browser.close();
}
