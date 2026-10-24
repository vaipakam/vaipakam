// Post-deploy review of the recycling account and loop closure on
// `/analytics`, against the deployed indexer (#1349 M5, #1956). Read-only:
// no wallet, no keys, sends nothing.
//
//   SITE_URL=https://<the deployment you just made> node e2e/live/live-analytics-recycling.mjs
//
// The live-only half of COVERAGE.md's "Recycling account + loop closure,
// deployed-capture half" row. The CI-Anvil spec renders fixed responses;
// only the deployed indexer holds the cron-captured backing reading and the
// event-folded day history, so only a live drive can check that the deployed
// app states what the deployed indexer published.
//
// How: the page is loaded as a visitor, and the two bodies IT receives from
// `/metrics/recycling` and `/metrics/loop-closure` are kept as the oracle.
// `analyticsRecyclingReview.mjs` then compares the rendered page with those
// same bodies — the verdict and its relation, the custody line, the
// reading's block, moment and contract (and that the contract is the Diamond
// `packages/contracts/src/deployments.json` ships for the chain), the
// programme days and their estimate badges, the window note, and the loop
// closure's recorded moment and calendar days. It also requires the body's
// `backing.pendingMigration` to be null: a non-null value names a schema
// update the indexer's deploy did not apply.
//
// Exit 0 PASS, 1 FAIL (the page and the indexer disagree, or the indexer
// answered with an error), 2 BLOCKED (no browser, the site could not be
// loaded, the page did not render English, or the page's requests to the
// indexer never got an answer, so nothing could be compared).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { blocked, requireSiteUrl, trackBrowser } from './driver.mjs';
import { reviewAnalytics } from './analyticsRecyclingReview.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));

const site = requireSiteUrl().replace(/\/+$/, '');
const copy = readJson('apps/app/src/i18n/locales/en.json').copy;
const bundle = readJson('packages/contracts/src/deployments.json');

let browser;
try {
  browser = await chromium.launch({
    ...(process.env.LIVE_CHROMIUM_PATH ? { executablePath: process.env.LIVE_CHROMIUM_PATH } : {}),
  });
  trackBrowser(browser);
} catch (err) {
  await blocked('could not start Chromium', err);
}

const ctx = await browser.newContext({ locale: 'en-US' });
const page = await ctx.newPage();

// The page's own answers from the indexer, by route. A request that fails
// outright (no response) is recorded too: that is "could not compare",
// not a finding about the product.
const bodies = { recycling: null, loop: null };
const failed = [];
const reading = new Set();
const route = (url) => {
  const p = new URL(url).pathname;
  return p === '/metrics/recycling' ? 'recycling' : p === '/metrics/loop-closure' ? 'loop' : null;
};
page.on('response', (res) => {
  const which = route(res.url());
  if (!which) return;
  const read = (async () => {
    let json = null;
    let parseError = null;
    try {
      json = await res.json();
    } catch (err) {
      parseError = String(err.message ?? err);
    }
    bodies[which] = { url: res.url(), status: res.status(), json, parseError };
  })();
  reading.add(read);
});
page.on('requestfailed', (req) => {
  if (route(req.url())) failed.push(`${req.url()} — ${req.failure()?.errorText ?? 'failed'}`);
});

try {
  const res = await page.goto(`${site}/analytics`, { waitUntil: 'networkidle', timeout: 90_000 });
  if (!res || !res.ok()) throw new Error(`HTTP ${res?.status() ?? 'no response'}`);
} catch (err) {
  await blocked(`could not load ${site}/analytics`, err);
}

const lang = await page.evaluate(() => document.documentElement.lang || navigator.language);
if (!/^en\b/i.test(lang)) await blocked(`the page did not render English (lang ${lang}); this drive compares English copy`);

// Wait for both sections to settle on an answer — the verdict cell or the
// withheld notice, and the loop closure's recorded-moment line — or for
// their unavailable notices.
try {
  await page.waitForFunction(
    () => {
      const q = (id) => document.querySelector(`[data-testid="${id}"]`);
      const rec = q('recycling-backed') || q('recycling-backing-unavailable') || q('recycling-unavailable');
      const loop = q('loop-recorded-before') || q('loop-unavailable');
      return Boolean(rec && loop);
    },
    null,
    { timeout: 60_000 },
  );
} catch (err) {
  if (!bodies.recycling || !bodies.loop) {
    await blocked(
      `the page's indexer requests never got an answer${failed.length ? ': ' + failed.join('; ') : ''}`,
      err,
    );
  }
  // Answers arrived and the page still rendered neither section: the page's fault.
}

// Let a body still being read land before it is looked for.
await Promise.allSettled([...reading]);
for (const which of ['recycling', 'loop']) {
  if (!bodies[which]) {
    await blocked(`the page never received /metrics/${which === 'loop' ? 'loop-closure' : 'recycling'}${failed.length ? ': ' + failed.join('; ') : ''}`);
  }
}

const snap = await page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('[data-testid]')) {
    out[el.getAttribute('data-testid')] = {
      text: el.textContent ?? '',
      verdict: el.getAttribute('data-verdict'),
      status: el.getAttribute('data-status'),
    };
  }
  return out;
});
await browser.close();

let fails = 0;
const report = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

const rec = bodies.recycling;
const loop = bodies.loop;
report('the indexer answered /metrics/recycling', rec.status === 200 && rec.json, `HTTP ${rec.status}${rec.parseError ? ', ' + rec.parseError : ''}`);
report('the indexer answered /metrics/loop-closure', loop.status === 200 && loop.json, `HTTP ${loop.status}${loop.parseError ? ', ' + loop.parseError : ''}`);
report('the page rendered the recycling account', !('recycling-unavailable' in snap));
report('the page rendered the loop closure', !('loop-unavailable' in snap));

// Compared only against answers the indexer served as answers: an error
// body would turn one finding (reported above) into a page of noise.
if (rec.status === 200 && rec.json && loop.status === 200 && loop.json) {
  const chainId = Number(new URL(rec.url).searchParams.get('chainId'));
  console.log(`info: chain ${chainId}, indexer ${new URL(rec.url).origin}, site ${site}`);
  const diamond = bundle[String(chainId)]?.diamond ?? null;
  for (const c of reviewAnalytics({ rec: rec.json, loop: loop.json, snap, copy, diamond, chainId })) {
    report(c.name, c.ok, c.detail);
  }
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
