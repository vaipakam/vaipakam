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
const INDEXER = process.env.INDEXER_ORIGIN ?? 'https://indexer.vaipakam.com';
const CHAIN_ID = 84532;

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
  '/settings',
  '/faucet',
  '/help',
  '/definitely-not-a-page', // NotFound surface
];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }, // iPhone 14-ish
};

/** Passes: what the review actually needs, kept to a manageable set. */
const PASSES = [
  { name: 'basic-desktop', mode: 'basic', viewport: 'desktop' },
  { name: 'basic-mobile', mode: 'basic', viewport: 'mobile' },
  { name: 'advanced-desktop', mode: 'advanced', viewport: 'desktop' },
];

/** Console/network noise that is environmental in the review sandbox —
 *  tagged so the report separates it from real defects. */
function classifyNoise(text) {
  if (/static\.cloudflareinsights\.com/.test(text)) return 'csp-beacon';
  if (/WebSocket connection.*ws\/chain.*failed/.test(text)) return 'sandbox-page-ws';
  return null;
}

function slugOf(route) {
  return route === '/' ? 'home' : route.replace(/^\//, '').replace(/[/:]/g, '-');
}

async function resolveLoanDetailRoute() {
  try {
    const res = await fetch(
      `${INDEXER}/loans/by-participant?chainId=${CHAIN_ID}&wallet=${addressOf('lender')}&limit=1`,
    );
    const body = await res.json();
    const id = body?.loans?.[0]?.loanId ?? body?.loans?.[0]?.loan_id;
    if (id !== undefined && id !== null) return `/positions/${id}`;
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

const { page, context, close } = await launch({ role: 'lender', headless: true });

if (!routesEnv) {
  const detail = await resolveLoanDetailRoute();
  if (detail) routes.splice(routes.indexOf('/claims'), 0, detail);
  else report.loanDetailSkipped = 'no loan found via /loans/by-participant';
}

// One console/request tap for the lifetime of the context.
let sink = null;
page.on('console', (msg) => {
  if (!sink) return;
  const text = msg.text();
  sink.console.push({ level: msg.type(), text: text.slice(0, 500), noise: classifyNoise(text) });
});
page.on('pageerror', (err) => {
  sink?.pageErrors.push(String(err).slice(0, 500));
});
page.on('requestfailed', (req) => {
  const text = `${req.method()} ${req.url()} — ${req.failure()?.errorText}`;
  sink?.network.failed.push({ entry: text.slice(0, 400), noise: classifyNoise(text) });
});
page.on('response', async (res) => {
  if (!sink) return;
  const url = res.url();
  const status = res.status();
  sink.network.responses += 1;
  let bytes = 0;
  try {
    bytes = Number(res.headers()['content-length'] ?? 0);
  } catch {
    /* streamed */
  }
  sink.network.bytes += bytes;
  if (status >= 400) sink.network.errors.push({ status, url: url.slice(0, 300) });
  if (bytes > 500_000) sink.network.heavy.push({ bytes, url: url.slice(0, 300) });
});

await page.goto(SITE, { waitUntil: 'domcontentloaded' });
await ensureConnected(page);

for (const pass of PASSES) {
  const passReport = { name: pass.name, routes: [] };
  report.passes.push(passReport);
  await page.setViewportSize(VIEWPORTS[pass.viewport]);
  // Mode is a localStorage flag read by ModeProvider at mount — set it
  // before the route navigation so the pass renders in the right mode.
  await page.addInitScript(
    (m) => localStorage.setItem('alpha02.mode', m),
    pass.mode,
  );
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
    const shot = path.join(OUT_DIR, `${pass.name}--${slug}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const landmarks = await page
      .evaluate(() => ({
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
      shot: path.relative(HERE, shot),
      loadMs,
      navError,
      landmarks,
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

fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
// eslint-disable-next-line no-console
console.log(`\nSweep complete → ${path.relative(process.cwd(), OUT_DIR)}/report.json`);
await close?.().catch(() => {});
await context?.close?.().catch(() => {});
process.exit(0);
