/**
 * live-ux-sweep.mjs — whole-site UI/UX evidence sweep for review sessions.
 *
 * NOT a pass/fail driver: it gathers the raw evidence a UI/UX review
 * needs — full-page screenshots of EVERY route (desktop + mobile in
 * Basic mode, desktop again in Advanced), the console stream, failed /
 * slow / heavy network calls, and basic landmarks (title, h1 count,
 * horizontal-overflow probe) — into e2e/live/shots/ux-sweep/ plus one
 * report.json. A reviewer (human or agent) then reads the artifacts
 * and writes the findings doc (docs/FindingsAndFixes/…). Committing
 * the sweep keeps periodic UX audits reproducible instead of being
 * rebuilt in a scratchpad each time.
 *
 * Run (from apps/alpha02/e2e/live/):
 *   TESTNET_WALLETS_FILE=~/secrets/wallets.json node live-ux-sweep.mjs
 * Options:
 *   SITE_URL=…            target a preview instead of production
 *   UX_SWEEP_ROUTES=/a,/b restrict the route list (comma-separated)
 *   UX_SWEEP_PROBE_ONLY=1 skip screenshots + extra passes; one
 *                         basic-desktop pass collecting only the
 *                         devtools probe (storage/perf/SW) — for
 *                         topping up an earlier full run
 *
 * Per-route devtools probe (the report's `devtools` key): local/
 * session-storage keys with sizes, IndexedDB database names, cookie
 * count, service-worker + Cache API state, navigation/paint timings,
 * JS heap, and buffered long-task count — the tabs a human would open
 * for troubleshooting, captured mechanically.
 *
 * Read-only by design: the sweep connects the wallet (so authed
 * surfaces render their real state) but never signs, posts, or sends
 * a transaction. Known environment noise (the sandbox proxy's page-WS
 * resets, the CSP-blocked Cloudflare beacon) is tagged, not dropped —
 * the report distinguishes "expected here" from "real console error".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, ensureConnected, addressOf, SITE } from './driver.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'shots', 'ux-sweep');

/** Every real (non-redirect) route in App.tsx, in nav order. */
const STATIC_ROUTES = [
  '/',
  '/borrow',
  '/lend',
  '/rent',
  '/positions',
  // '/positions/:loanId' resolved dynamically below
  '/claims',
  '/offers',
  '/desk',
  '/vault',
  '/activity',
  '/vpfi',
  '/nft',
  '/nft/1', // verifier deep-link verdict card (Codex #1154 P3)
  '/settings',
  '/faucet',
  '/help',
  '/definitely-not-a-page', // NotFound surface
];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }, // iPhone 14-ish
};

const PROBE_ONLY = process.env.UX_SWEEP_PROBE_ONLY === '1';

/** Passes: what the review actually needs, kept to a manageable set. */
const PASSES = PROBE_ONLY
  ? [{ name: 'basic-desktop', mode: 'basic', viewport: 'desktop' }]
  : [
      { name: 'basic-desktop', mode: 'basic', viewport: 'desktop' },
      { name: 'basic-mobile', mode: 'basic', viewport: 'mobile' },
      { name: 'advanced-desktop', mode: 'advanced', viewport: 'desktop' },
    ];

/** The DevTools-tabs-in-one-call probe. Runs in the page; every field
 *  is fail-soft so one blocked API doesn't sink the rest. */
async function devtoolsProbe(page) {
  return page
    .evaluate(async () => {
      const out = {};
      const kb = (s) => Math.round((s.length * 2) / 102.4) / 10; // UTF-16 → KB
      try {
        out.localStorage = Object.keys(localStorage).map((k) => ({
          key: k,
          kb: kb(localStorage.getItem(k) ?? ''),
        }));
      } catch (e) { out.localStorage = String(e); }
      try {
        out.sessionStorage = Object.keys(sessionStorage).map((k) => ({
          key: k,
          kb: kb(sessionStorage.getItem(k) ?? ''),
        }));
      } catch (e) { out.sessionStorage = String(e); }
      try {
        out.indexedDbNames = (await indexedDB.databases()).map((d) => d.name);
      } catch (e) { out.indexedDbNames = String(e); }
      try { out.cookieCount = document.cookie ? document.cookie.split(';').length : 0; }
      catch (e) { out.cookieCount = String(e); }
      try {
        const regs = await navigator.serviceWorker?.getRegistrations?.();
        out.serviceWorkers = (regs ?? []).map((r) => r.active?.scriptURL ?? r.scope);
        out.cacheStorageKeys = (await caches?.keys?.()) ?? [];
      } catch (e) { out.serviceWorkers = String(e); }
      try {
        const nav = performance.getEntriesByType('navigation')[0];
        out.timing = nav && {
          ttfbMs: Math.round(nav.responseStart - nav.requestStart),
          domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          loadMs: Math.round(nav.loadEventEnd - nav.startTime),
          transferKb: Math.round((nav.transferSize ?? 0) / 1024),
        };
        out.paints = Object.fromEntries(
          performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]),
        );
        out.longTasks = performance.getEntriesByType('longtask')?.length ?? null;
      } catch (e) { out.timing = String(e); }
      try {
        // Chromium-only; fine — the sweep always runs Chromium.
        const m = performance.memory;
        if (m) out.jsHeapMb = Math.round(m.usedJSHeapSize / 1048576);
      } catch { /* unavailable */ }
      return out;
    })
    .catch((e) => ({ error: String(e).slice(0, 200) }));
}

/** Console/network noise that is environmental in the review sandbox —
 *  tagged so the report separates it from real defects. The beacon
 *  check extracts the first URL token from the message and compares
 *  its PARSED ORIGIN (never a substring/regex host match, so a
 *  lookalike domain can't self-tag as noise — same shape as the #1145
 *  CodeQL fix; js/regex/missing-regexp-anchor rejects any un-anchored
 *  hostname-looking pattern, and a mid-message URL can't be
 *  ^-anchored). */
const BEACON_ORIGIN = 'https://static.cloudflareinsights.com';
function classifyNoise(text) {
  const urlToken = text.match(/https?:\/\/[^\s'"]+/);
  if (urlToken) {
    try {
      if (new URL(urlToken[0]).origin === BEACON_ORIGIN) return 'csp-beacon';
    } catch {
      /* not a parseable URL — fall through */
    }
  }
  if (/WebSocket connection.*ws\/chain.*failed/.test(text)) return 'sandbox-page-ws';
  return null;
}

function slugOf(route) {
  return route === '/' ? 'home' : route.replace(/^\//, '').replace(/[/:]/g, '-');
}

/** Harvest a real loan-detail route from the RENDERED /positions page
 *  instead of querying the indexer with a wallets-file-derived address
 *  (CodeQL js/file-data-in-outbound-network-request — and honestly the
 *  better source: the sweep reviews what the user can actually reach,
 *  so the link should come from the page itself). */
async function resolveLoanDetailRoute(page) {
  try {
    await page.goto(`${SITE}/positions`, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    const href = await page
      .$$eval('a[href^="/positions/"]', (as) => as.map((a) => a.getAttribute('href'))[0] ?? null)
      .catch(() => null);
    if (href && /^\/positions\/\d+$/.test(href)) return href;
  } catch {
    /* fall through — detail page skipped, recorded in the report */
  }
  return null;
}

const routesEnv = process.env.UX_SWEEP_ROUTES;
const routes = routesEnv ? routesEnv.split(',').map((s) => s.trim()) : [...STATIC_ROUTES];

fs.mkdirSync(OUT_DIR, { recursive: true });
const report = {
  site: SITE,
  wallet: addressOf('lender'),
  startedAt: null, // stamped by the caller reading report.json mtime; Date.now is fine here (plain node, not a Workflow)
  passes: [],
};
report.startedAt = new Date().toISOString();

const { page, done, blockedRequests } = await launch({ role: 'lender', headless: true, readOnly: true });

// One console/request tap for the lifetime of the context.
let sink = null;
// Bind every network entry to the sink of the route that STARTED the
// request: background refetches and slow indexer/RPC calls can resolve
// after the loop has moved to the next route, and attributing them by
// arrival time corrupts per-route evidence (Codex #1154 r4 P2).
const sinkByRequest = new WeakMap();
page.on('request', (req) => {
  if (sink) sinkByRequest.set(req, sink);
});
page.on('console', (msg) => {
  if (!sink) return;
  const text = msg.text();
  sink.console.push({ level: msg.type(), text: text.slice(0, 500), noise: classifyNoise(text) });
});
page.on('pageerror', (err) => {
  sink?.pageErrors.push(String(err).slice(0, 500));
});
page.on('requestfailed', (req) => {
  const s = sinkByRequest.get(req) ?? sink;
  const text = `${req.method()} ${req.url()} — ${req.failure()?.errorText}`;
  s?.network.failed.push({ entry: text.slice(0, 400), noise: classifyNoise(text) });
});
page.on('response', async (res) => {
  // The route that STARTED this request owns its bytes — not whichever
  // route is current when the response (or the sizes() await below)
  // lands (Codex #1154 r3+r4 P2).
  const s = sinkByRequest.get(res.request()) ?? sink;
  if (!s) return;
  const url = res.url();
  const status = res.status();
  s.network.responses += 1;
  // The driver's undici route shim strips upstream content-length;
  // Playwright re-synthesizes it on fulfill, but don't depend on that:
  // prefer the CDP-measured body size (Codex #1154 P2).
  let bytes = 0;
  try {
    const sizes = await res.request().sizes();
    bytes = sizes.responseBodySize > 0 ? sizes.responseBodySize : 0;
  } catch {
    /* sizes unavailable for this request type */
  }
  if (!bytes) {
    try {
      bytes = Number(res.headers()['content-length'] ?? 0);
    } catch {
      /* streamed */
    }
  }
  s.network.bytes += bytes;
  if (status >= 400) s.network.errors.push({ status, url: url.slice(0, 300) });
  if (bytes > 500_000) s.network.heavy.push({ bytes, url: url.slice(0, 300) });
});

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await ensureConnected(page);

if (!routesEnv) {
  const detail = await resolveLoanDetailRoute(page);
  if (detail) routes.splice(routes.indexOf('/claims'), 0, detail);
  else report.loanDetailSkipped = 'no /positions/:id link found on the rendered positions page';
}

for (const pass of PASSES) {
  const passReport = { name: pass.name, routes: [] };
  report.passes.push(passReport);
  await page.setViewportSize(VIEWPORTS[pass.viewport]);
  // Mode is a localStorage flag read by ModeProvider at mount.
  // localStorage on a persistent profile survives navigations, so ONE
  // evaluate before the pass is deterministic. Never addInitScript
  // here: init scripts accumulate for the page's lifetime with no
  // ordering guarantee across passes, so a stale 'basic' script could
  // overwrite the advanced pass's flag on any later navigation (Codex
  // #1154 P2). The per-route landmark probe records the EFFECTIVE mode
  // so a mode mix-up is visible in the report, not silent.
  await page.evaluate((m) => localStorage.setItem('alpha02.mode', m), pass.mode);

  for (const route of routes) {
    const slug = slugOf(route);
    sink = {
      console: [],
      pageErrors: [],
      network: { responses: 0, bytes: 0, errors: [], failed: [], heavy: [] },
    };
    const started = Date.now();
    let navError = null;
    try {
      await page.goto(`${SITE}${route}`, { waitUntil: 'load', timeout: 45_000 });
      // Let data views settle: brief idle wait, tolerant of the polls.
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
      await page.waitForTimeout(1_500);
    } catch (e) {
      navError = String(e).slice(0, 300);
    }
    const loadMs = Date.now() - started;
    // A failed navigation may never have committed — the previous
    // route would still be loaded, so screenshot/landmarks/devtools
    // would silently describe the WRONG page. Record the failure with
    // null artifacts instead (Codex #1154 r4 P2).
    let shot = null;
    let shotError = null;
    let devtools = null;
    if (navError === null) {
      if (!PROBE_ONLY) {
        const shotPath = path.join(OUT_DIR, `${pass.name}--${slug}.png`);
        // Never leave a stale capture from an earlier run answering
        // for this one (the shots dir is reused across sweeps).
        fs.rmSync(shotPath, { force: true });
        try {
          await page.screenshot({ path: shotPath, fullPage: true });
          shot = shotPath;
        } catch (e) {
          shotError = String(e).slice(0, 200);
        }
      }
      devtools = await devtoolsProbe(page);
    }
    const landmarks = navError !== null ? null : await page
      .evaluate(() => ({
        mode: localStorage.getItem('alpha02.mode'),
        title: document.title,
        h1: [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim()).slice(0, 3),
        hasHorizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        buttonsWithoutText: [...document.querySelectorAll('button')].filter(
          (b) => !b.textContent?.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title'),
        ).length,
        imagesWithoutAlt: [...document.querySelectorAll('img')].filter((i) => !i.alt).length,
      }))
      .catch(() => null);
    passReport.routes.push({
      route,
      shot: shot ? path.relative(HERE, shot) : null,
      shotError,
      loadMs,
      navError,
      landmarks,
      devtools,
      console: sink.console,
      pageErrors: sink.pageErrors,
      network: sink.network,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[${pass.name}] ${route} — ${loadMs}ms, ${sink.network.responses} responses, ` +
        `${sink.network.errors.length} http-errors, ` +
        `${sink.console.filter((c) => c.level === 'error' && !c.noise).length} real console errors`,
    );
    sink = null;
  }
}

// The read-only route guard aborts + logs any page-initiated backend
// write; a non-empty list means some surface tried to mutate state
// during a read-only audit — surface it loudly in report + exit code.
report.blockedWriteRequests = blockedRequests;

const reportName = PROBE_ONLY ? 'report-devtools.json' : 'report.json';
fs.writeFileSync(path.join(OUT_DIR, reportName), JSON.stringify(report, null, 2));
// eslint-disable-next-line no-console
console.log(`\nSweep complete → ${path.relative(process.cwd(), OUT_DIR)}/${reportName}`);
if (blockedRequests.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `READ-ONLY VIOLATIONS: ${blockedRequests.length} page-initiated write(s) were blocked — see blockedWriteRequests in the report`,
  );
}
// The sweep's last pass leaves 'advanced' in the PERSISTENT lender
// profile that every live driver reuses — reset to the app default so
// a later focused review doesn't silently start on the wrong surface
// (Codex #1154 r3 P2).
await page
  .evaluate(() => localStorage.setItem('alpha02.mode', 'basic'))
  .catch(() => {});
await done().catch(() => {});
process.exit(blockedRequests.length > 0 ? 2 : 0);
