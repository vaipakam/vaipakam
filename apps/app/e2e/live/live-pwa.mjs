// #2687 post-deploy review — the installable app and its service worker,
// as a visitor with no wallet. Read-only; sends nothing, needs no keys.
//
//   SITE_URL=https://<the deployment you just made> node e2e/live/live-pwa.mjs
//
// Checks what the website spec requires and what the app's worker promises
// (src/lib/swPolicy.ts):
//   - the page links a manifest the browser parses without errors, and a
//     persistent profile reports no installability errors;
//   - a production build registers its worker and the worker controls the
//     page;
//   - no page load is answered by the worker (a deploy replaces the shell
//     on the next load, and an old build never runs from a cache);
//   - no cross-origin request is answered by the worker (chain RPC, the
//     indexer, the agent and wallet services are never cached);
//   - every entry in Cache Storage is a shell file: `/assets/*`, the
//     manifest, the logo or an icon;
//   - the content security policy refused nothing.
//
// Exit 0 PASS, 1 FAIL (the served app broke one of the above), 2 BLOCKED
// (no browser, or the site could not be loaded at all).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { blocked, requireSiteUrl, trackBrowser, watchCspViolations } from './driver.mjs';

const site = requireSiteUrl().replace(/\/+$/, '');
const origin = new URL(site).origin;
const SHELL = (p) =>
  p.startsWith('/assets/') ||
  p.startsWith('/icons/') ||
  p === '/manifest.webmanifest' ||
  p === '/logo.svg';

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

// A persistent profile: Chromium reports every incognito context as
// not installable, which would hide the answer this drive is after.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pwa-'));
const cleanup = () => fs.rmSync(profile, { recursive: true, force: true });
let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    ...(process.env.LIVE_CHROMIUM_PATH ? { executablePath: process.env.LIVE_CHROMIUM_PATH } : {}),
  });
  trackBrowser(ctx);
  await watchCspViolations(ctx);
} catch (err) {
  await blocked('could not start Chromium', err, cleanup);
}

const page = await ctx.newPage();
const refused = [];
page.on('console', (m) => {
  if (/Refused to|Content Security Policy/i.test(m.text())) refused.push(m.text().slice(0, 200));
});
try {
  const res = await page.goto(`${site}/`, { waitUntil: 'networkidle', timeout: 60_000 });
  if (!res || !res.ok()) throw new Error(`HTTP ${res?.status() ?? 'no response'}`);
} catch (err) {
  await blocked(`could not load ${site}/`, err, cleanup);
}

const sw = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const ready = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 15_000)),
  ]);
  return { supported: true, ready, scope: (await navigator.serviceWorker.getRegistration())?.scope ?? null };
});
check('the production build registers its service worker', sw.supported && sw.ready, JSON.stringify(sw));

const cdp = await ctx.newCDPSession(page);
const manifest = await cdp.send('Page.getAppManifest');
check('the page links a manifest', Boolean(manifest.url), manifest.url || 'no manifest link');
check('the manifest parses without errors', manifest.errors.length === 0, JSON.stringify(manifest.errors));
const install = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors;
check('the browser reports no installability errors', install.length === 0, JSON.stringify(install));

// Reload and walk a few pages with the worker in control, recording who
// answered each response.
const seen = [];
page.on('response', (r) =>
  seen.push({ url: r.url(), fromSw: r.fromServiceWorker(), nav: r.request().isNavigationRequest() }),
);
for (const p of ['/', '/positions', '/offers', '/vpfi']) {
  await page.goto(`${site}${p}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => undefined);
}
const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
check('the worker controls the page after a reload', controlled);

const navFromSw = seen.filter((s) => s.nav && s.fromSw);
check('no page load is answered by the worker', navFromSw.length === 0, navFromSw.map((s) => s.url).join(', '));
const crossFromSw = seen.filter((s) => !s.url.startsWith(origin) && s.fromSw);
check(
  'no cross-origin request is answered by the worker',
  crossFromSw.length === 0,
  `${seen.filter((s) => !s.url.startsWith(origin)).length} cross-origin seen; from worker: ${crossFromSw.map((s) => s.url).join(', ')}`,
);
const assets = seen.filter((s) => s.url.startsWith(`${origin}/assets/`));
console.log(`info: ${assets.filter((s) => s.fromSw).length} of ${assets.length} build files answered by the worker`);

const cached = await page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    for (const req of await (await caches.open(name)).keys()) out.push({ name, url: req.url });
  }
  return out;
});
const foreign = cached.filter((c) => !c.url.startsWith(origin) || !SHELL(new URL(c.url).pathname));
check(
  'Cache Storage holds shell files only',
  foreign.length === 0,
  `${cached.length} entries in ${new Set(cached.map((c) => c.name)).size} cache(s)${foreign.length ? '; not shell: ' + foreign.map((c) => c.url).join(', ') : ''}`,
);
check('the content security policy refused nothing', refused.length === 0, refused.slice(0, 3).join(' | '));

await ctx.close();
cleanup();
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
