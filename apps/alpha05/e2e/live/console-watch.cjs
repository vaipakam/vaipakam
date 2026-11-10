// Watch-only live check of the browser console with a wallet connected
// (#3476). It drives the shared watch-only wallet (watch-wallet.cjs), so
// nothing can be sent. It walks the main routes on desktop and phone, and
// prints every app console error or warning, every report the page's
// report-only connect-src list raises, every failed request and every host
// the page reached. It exits non-zero on any of them, so a connected session
// that is not clean fails the live review.
// Usage: node e2e/live/console-watch.cjs <address>  ($LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/$/, '');
const ROUTES = ['/', '/borrow', '/lend', '/offers', '/positions', '/claims', '/vault', '/rewards', '/settings'];
let failures = 0;

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  const found = [];
  const hosts = new Set();
  p.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') found.push(`[console ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  p.on('requestfailed', (r) => {
    // A navigation the next goto cancels is not a failure of the page.
    if (r.failure()?.errorText === 'net::ERR_ABORTED' && r.url().startsWith(ORIGIN) && !r.url().includes('/assets/')) return;
    found.push(`[request failed] ${r.url().slice(0, 160)} ${r.failure()?.errorText}`);
  });
  p.on('request', (r) => {
    try {
      hosts.add(new URL(r.url()).host);
    } catch {}
  });
  await p.exposeFunction('__cspReport', (v) => found.push(`[csp report] ${v}`));
  await p.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__cspReport(`${e.disposition} ${e.effectiveDirective} ${e.blockedURI}`));
  });
  await p.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await connect(p);
  for (const route of ROUTES) {
    await p.goto(`${ORIGIN}${route}`, { waitUntil: 'networkidle' }).catch((e) => found.push(`[goto] ${route} ${e.message}`));
    await p.waitForTimeout(6000);
  }
  // Open the wallet control while connected: the account surface must not
  // reach any host the page does not name either.
  await p.getByTestId('wallet-chip').first().click().catch(() => {});
  await p.waitForTimeout(4000);
  await p.keyboard.press('Escape').catch(() => {});
  for (const e of errs) found.push(`[page error] ${e}`);
  console.log(`===== ${label}\nhosts: ${[...hosts].sort().join(' ')}`);
  console.log(found.length ? found.join('\n') : 'clean');
  failures += found.length;
  await ctx.close();
}

(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
  process.exit(failures ? 1 : 0);
})();
