// Watch-only live review of one loan's page (live tier, run after each
// deploy), through the shared watch-only wallet (watch-wallet.cjs): nothing
// can be sent. Prints the page per device, checks nothing scrolls sideways,
// and saves full-page screenshots.
// Usage: node e2e/live/position-watch.cjs <address> <loanId> [<loanId>...]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, ...IDS] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
async function session(b, opts, label, id) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL(`positions/${id}`, BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.getByTestId('position-status').waitFor({ timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const main = (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  console.log(`===== loan ${id} ${label}\n${main}\nerrors: ${JSON.stringify(errs)}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-position-${id}-${label}.png`, fullPage: true });
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  for (const id of IDS) {
    await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop', id);
    await session(b, { ...devices['Pixel 7'] }, 'phone', id);
  }
  await b.close();
})();
