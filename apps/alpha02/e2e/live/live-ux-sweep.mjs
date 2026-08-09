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
 *   UX_SWEEP_SESSIONS=main,disconnected,arb
 *                         restrict which sessions run (see SESSIONS):
 *                         `main` = the three connected-Base passes,
 *                         `disconnected` = first-visit desktop+mobile
 *                         with NO wallet session, `arb` = connected on
 *                         Arbitrum Sepolia over the chain-scoped routes
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
import {
  launch,
  ensureConnected,
  addressOf,
  blockedSync,
  LiveSetupError,
  SITE,
  visit,
} from './driver.mjs';

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

/** Chain-scoped surfaces — the subset worth re-sweeping on a second
 *  network (VPFI availability, vault, faucet, book/desk market data,
 *  settings alert rails). Route-agnostic chrome (help, 404, nft) reads
 *  the same on every chain and stays on the main session only. */
const CHAIN_SCOPED_ROUTES = [
  '/',
  '/offers',
  '/desk',
  '/vault',
  '/vpfi',
  '/settings',
  '/faucet',
];

/**
 * Sessions × passes (2026-07-13 second-pass review): a session is one
 * launched browser profile (role, chain, connect-or-not); each runs
 * its own passes. The original three connected-Base passes keep their
 * names (and artifact filenames) unchanged; two dimensions the first
 * review missed are now first-class:
 *   - `disconnected` — the FIRST-VISIT experience (no wallet session),
 *     desktop + mobile. Uses a fresh role profile so a remembered
 *     ConnectKit session can't silently connect it.
 *   - `arb` — connected on Arbitrum Sepolia, chain-scoped routes only:
 *     the per-chain availability states (VPFI registration, faucet
 *     mocks, market data) are exactly what differs by network.
 * UX_SWEEP_SESSIONS=main,disconnected,arb (comma list) restricts which
 * sessions run — e.g. topping up an earlier run without redoing the
 * three main passes. PROBE_ONLY keeps its historical meaning: one
 * basic-desktop probe pass on the main session.
 */
const SESSIONS = [
  {
    key: 'main',
    role: 'lender',
    chainId: 84532,
    connect: true,
    harvestLoanDetail: true,
    passes: PROBE_ONLY
      ? [{ name: 'basic-desktop', mode: 'basic', viewport: 'desktop' }]
      : [
          { name: 'basic-desktop', mode: 'basic', viewport: 'desktop' },
          { name: 'basic-mobile', mode: 'basic', viewport: 'mobile' },
          { name: 'advanced-desktop', mode: 'advanced', viewport: 'desktop' },
        ],
  },
  {
    key: 'disconnected',
    role: 'newLender',
    chainId: 84532,
    connect: false,
    // A fresh wallet must not LOOK fresh yet report accounts: with the
    // driver's permissive default, wagmi treats the announced provider
    // as already-authorized and silently connects — the pass would
    // capture connected states while claiming to be the first-visit
    // evidence. preAuthorized:false makes eth_accounts return [] until
    // an explicit eth_requestAccounts, like a real un-approved wallet;
    // allowRequestAccounts:false additionally REJECTS (4001 + logged)
    // any account request the page fires on its own, so an app
    // regression can't silently flip this session connected mid-pass;
    // freshProfile runs on a throwaway browser profile so storage from
    // earlier runs (dismissed banners, mode flags, connectkit state)
    // can't taint the first-visit evidence (Codex #1181 P2 ×2).
    preAuthorized: false,
    allowRequestAccounts: false,
    freshProfile: true,
    harvestLoanDetail: false,
    passes: [
      { name: 'disconnected-desktop', mode: 'basic', viewport: 'desktop' },
      { name: 'disconnected-mobile', mode: 'basic', viewport: 'mobile' },
    ],
  },
  {
    key: 'arb',
    role: 'newBorrower',
    chainId: 421614,
    connect: true,
    harvestLoanDetail: false,
    routes: CHAIN_SCOPED_ROUTES,
    passes: [{ name: 'arb-desktop', mode: 'basic', viewport: 'desktop' }],
  },
];

const sessionsEnv = process.env.UX_SWEEP_SESSIONS;
const sessionKeys = (sessionsEnv ?? (PROBE_ONLY ? 'main' : 'main,disconnected,arb'))
  .split(',')
  .map((s) => s.trim());
// Fail FAST on a typo'd or stale session key: this selector controls
// which evidence gets produced, and silently dropping `disconnect`
// (say) would let a review report ship missing a whole coverage
// dimension while exiting 0 (Codex #1181 P2).
// Both exits are BLOCKED, not FAIL (#1581): a mis-set selector means the
// sweep gathered nothing, so the surfaces it covers are still unswept —
// the batch must not report that as evidence the app regressed.
const knownKeys = new Set(SESSIONS.map((s) => s.key));
const unknown = sessionKeys.filter((k) => !knownKeys.has(k));
if (unknown.length > 0) {
  blockedSync(
    `UX_SWEEP_SESSIONS names unknown session(s): ${unknown.join(', ')} — known: ${[...knownKeys].join(', ')}`,
  );
}
const activeSessions = SESSIONS.filter((s) => sessionKeys.includes(s.key));
if (activeSessions.length === 0) {
  blockedSync('UX_SWEEP_SESSIONS selected no sessions — nothing to sweep');
}

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

// The sweep's whole output is these artifacts — nowhere to write them is
// a missing precondition, not a finding (#1581).
//
// Probe an actual write, because `mkdirSync(recursive)` on an EXISTING
// directory succeeds without testing write access (Codex #1621 r2).
// Without the probe the first hard failure was a screenshot `rmSync`
// mid-sweep — which exits 1 AND leaves the browser open — or, in
// probe-only mode, the closing `writeFileSync` after the whole sweep had
// run. Both report "nowhere to write" as a product finding, and the
// first one does it after wasting the run.
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const probe = path.join(OUT_DIR, '.write-probe');
  fs.writeFileSync(probe, '');
  fs.rmSync(probe, { force: true });
} catch (err) {
  blockedSync(`cannot write to the sweep output directory\n  path: ${OUT_DIR}\n  ${err.message}`);
}
const report = {
  site: SITE,
  startedAt: null, // stamped by the caller reading report.json mtime; Date.now is fine here (plain node, not a Workflow)
  sessions: [],
  passes: [],
};
report.startedAt = new Date().toISOString();
// Every selected session's credential, resolved BEFORE any evidence is
// gathered (Codex #1621 r3). `addressOf` and `launch`'s own `walletFor`
// both exit BLOCKED synchronously and both run outside the try below, so
// a wallet file with a valid lender but no borrower let session 1 record
// a real read-only violation and then had session 2 exit 2 — replacing a
// proven finding with "verified nothing", the very thing
// `onSetupFailure: 'throw'` was added to prevent. Resolving them here
// makes a missing credential a precondition again: nothing has been
// observed yet, so exiting is honest and costs no evidence.
for (const s of activeSessions) addressOf(s.role);
const allBlockedRequests = [];
// Sessions whose browser never started. Reported at the end rather than
// exited on, so a finding from a session that DID run still wins.
const setupFailures = [];
// Set once the site has actually served a page. Keyed to the first load
// that HAPPENS, not to activeSessions[0] (Codex #1621 r4): if session 0's
// setup failed, session 1 is the run's first load and skipped the probe,
// so an unreachable target exited 1 and leaked that session's browser.
let reachabilityProven = false;
const backgroundNetworkBySession = {};

for (const session of activeSessions) {
  const routes = routesEnv
    ? routesEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : [...(session.routes ?? STATIC_ROUTES)];
  // A selector that normalises to NOTHING is BLOCKED, not PASS (Codex
  // #1621 r6) — the same rule DESK_I18N_LOCALES got, on the sibling
  // selector I did not revisit. `UX_SWEEP_ROUTES=",,,"` is non-empty, so
  // the default does not apply; unfiltered it produced empty route names
  // that re-visited SITE and exited 0 having swept none of the routes
  // asked for.
  if (routes.length === 0) {
    blockedSync(
      `UX_SWEEP_ROUTES=${JSON.stringify(routesEnv)} selects no routes —` +
        ` nothing to sweep.`,
    );
  }

  report.sessions.push({
    key: session.key,
    role: session.role,
    wallet: addressOf(session.role),
    chainId: session.chainId,
    connected: session.connect,
    passes: session.passes.map((p) => p.name),
  });

// This sweep launches once PER SESSION and accumulates findings across
// them in `allBlockedRequests`, so it is evidence-accumulating in the
// same way live-recover-locales.mjs is (Codex #1621 r2). If session 1
// caught a page-initiated write — a proven product defect — and session
// 3's browser fails to start, exiting BLOCKED there would replace that
// finding with "verified nothing". Take the error back and decide at
// the end, where the evidence is.
let launched;
try {
  launched = await launch({
    role: session.role,
    startChainId: session.chainId,
    headless: true,
    readOnly: true,
    onSetupFailure: 'throw',
    preAuthorized: session.preAuthorized ?? true,
    allowRequestAccounts: session.allowRequestAccounts ?? true,
    freshProfile: session.freshProfile ?? false,
  });
} catch (err) {
  if (!(err instanceof LiveSetupError)) throw err;
  // Record and carry on to the next session: the verdict is decided at
  // the end, where a finding from an earlier session can outrank this.
  setupFailures.push({
    key: session.key,
    why: String(err.cause?.message ?? err.cause ?? err).split('\n')[0].slice(0, 200),
  });
  console.error(`session ${session.key}: browser setup failed — ${err.message}`);
  continue;
}
const { page, done, blockedRequests } = launched;

// One console/request tap for the lifetime of the context.
let sink = null;
// Bind every network entry to the sink of the route that STARTED the
// request: background refetches and slow indexer/RPC calls can resolve
// after the loop has moved to the next route, and attributing them by
// arrival time corrupts per-route evidence (Codex #1154 r4 P2).
const sinkByRequest = new WeakMap();
// Requests that start while NO route sink is active (initial connect,
// the detail-route harvest, the gap between routes) belong to no
// route — charge them to a separate background bucket instead of
// whichever route happens to be current when they complete (Codex
// #1154 r5 P2). Surfaced in the report as backgroundNetwork.
const backgroundSink = {
  network: { responses: 0, bytes: 0, errors: [], failed: [], heavy: [] },
};
page.on('request', (req) => {
  sinkByRequest.set(req, sink ?? backgroundSink);
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
  const s = sinkByRequest.get(req) ?? backgroundSink;
  const text = `${req.method()} ${req.url()} — ${req.failure()?.errorText}`;
  s?.network.failed.push({ entry: text.slice(0, 400), noise: classifyNoise(text) });
});
page.on('response', async (res) => {
  // The route that STARTED this request owns its bytes — not whichever
  // route is current when the response (or the sizes() await below)
  // lands (Codex #1154 r3+r4 P2).
  const s = sinkByRequest.get(res.request()) ?? backgroundSink;
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

// The FIRST session's initial load is this sweep's reachability probe:
// if the site never answers there is no evidence to gather, so BLOCKED
// (#1581). Later sessions keep exiting 1 — by then the site is known to
// serve, and the per-route loop below already records its own nav
// failures as findings rather than crashing.
if (!reachabilityProven) {
  await visit(page, '/');
  reachabilityProven = true;
} else {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
}
if (session.connect) {
  await ensureConnected(page);
}

if (!routesEnv && session.harvestLoanDetail) {
  const detail = await resolveLoanDetailRoute(page);
  if (detail) routes.splice(routes.indexOf('/claims'), 0, detail);
  else report.loanDetailSkipped = 'no /positions/:id link found on the rendered positions page';
}

for (const pass of session.passes) {
  const passReport = {
    name: pass.name,
    session: session.key,
    chainId: session.chainId,
    connected: session.connect,
    routes: [],
  };
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
    if (!PROBE_ONLY) {
      // Remove any capture from an earlier run FIRST — even when this
      // navigation failed — so the reused shots dir never carries
      // stale visual evidence for a route the report marks null
      // (Codex #1154 r5 P2).
      fs.rmSync(path.join(OUT_DIR, `${pass.name}--${slug}.png`), { force: true });
    }
    if (navError === null) {
      if (!PROBE_ONLY) {
        const shotPath = path.join(OUT_DIR, `${pass.name}--${slug}.png`);
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

// Session close-out: aggregate this launch's read-only violations and
// background bucket, reset the PERSISTENT profile's mode flag to the
// app default so a later focused review doesn't silently start on the
// wrong surface (Codex #1154 r3 P2), and release the context.
allBlockedRequests.push(
  ...blockedRequests.map((b) => ({ ...b, session: session.key })),
);
backgroundNetworkBySession[session.key] = backgroundSink.network;
await page
  .evaluate(() => localStorage.setItem('alpha02.mode', 'basic'))
  .catch(() => {});
await done().catch(() => {});
} // end session loop

// The read-only route guard aborts + logs any page-initiated backend
// write; a non-empty list means some surface tried to mutate state
// during a read-only audit — surface it loudly in report + exit code.
report.blockedWriteRequests = allBlockedRequests;
report.backgroundNetwork = backgroundNetworkBySession;

const reportName = PROBE_ONLY ? 'report-devtools.json' : 'report.json';
fs.writeFileSync(path.join(OUT_DIR, reportName), JSON.stringify(report, null, 2));
// eslint-disable-next-line no-console
console.log(`\nSweep complete → ${path.relative(process.cwd(), OUT_DIR)}/${reportName}`);
if (allBlockedRequests.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `READ-ONLY VIOLATIONS: ${allBlockedRequests.length} page-initiated write(s) were blocked — see blockedWriteRequests in the report`,
  );
}
// Exit 1, not 2. A page-initiated write during a read-only sweep is a
// REGRESSION in the app, and the batch runner reads 2 as "BLOCKED — ran
// but verified nothing", whose cause and remedy are the opposite of this
// one's (#1529 review round 5). This sweep verified plenty; what it found
// is a defect.
//
// A finding OUTRANKS an incomplete sweep (Codex #1621 r2), the same
// precedence live-recover-locales.mjs applies: reporting BLOCKED here
// would discard a proven write attempt because some later session's
// browser would not start.
if (allBlockedRequests.length > 0) process.exit(1);
if (setupFailures.length > 0) {
  console.error(
    `\nBLOCKED: ${setupFailures.length} of ${activeSessions.length} session(s)` +
      ` never started, so those surfaces are unswept and no finding came from` +
      ` the ones that did:\n` +
      setupFailures.map((f) => `  ${f.key}: ${f.why}`).join('\n'),
  );
  process.exit(2);
}
process.exit(0);
