// Watch-only live review of Home (live tier, run after each deploy), through
// the shared watch-only wallet (watch-wallet.cjs): nothing can be sent.
// Usage: node e2e/live/home-watch.cjs <address>  (screenshots go to $LIVE_OUT or /tmp;
// $LIVE_URL overrides the deployed origin, e.g. a local preview build)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
// The provider carries the node's revert data on its errors, as real wallets
// do; LIVE_DROP_REVERT_DATA=1 drops it, as some wallets do, to check the
// page asks another source instead of showing an unidentified refusal.
const DROP = process.env.LIVE_DROP_REVERT_DATA === '1';
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, DROP);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p.getByText(/^Synced .* ago through /).first().waitFor({ timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(3000);
  const main = (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  console.log(`===== ${label}\n${main}\nerrors: ${JSON.stringify(errs)}`);
  const width = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  console.log('scrollWidth/innerWidth', width);
  await p.screenshot({ path: `${process.env.LIVE_OUT ?? '/tmp'}/live-home-${label}.png`, fullPage: true });
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
