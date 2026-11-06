// Watch-only live review of Positions (live tier, run after each deploy),
// through the shared watch-only wallet (watch-wallet.cjs): nothing can be
// sent. It prints the page per device and each side choice, checks nothing
// scrolls sideways, and saves full-page screenshots.
// Usage: node e2e/live/positions-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin, e.g. a preview)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = new globalThis.URL('positions', process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').href;
const OUT = process.env.LIVE_OUT ?? '/tmp';
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p
    .getByText(/^Synced .* ago through /)
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  const counts = async () =>
    p.evaluate(() => ({
      payouts: document.querySelectorAll('[data-payout]').length,
      live: document.querySelectorAll('section[aria-labelledby="home-loans"] [data-loan-id]').length,
      ended: document.querySelectorAll('section[aria-labelledby="positions-ended"] [data-loan-id]').length,
    }));
  const main = (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  console.log(`===== ${label}\n${main}\ncounts(all): ${JSON.stringify(await counts())}\nerrors: ${JSON.stringify(errs)}`);
  const side = p.getByRole('group', { name: 'Which positions to show' });
  if (await side.count()) {
    for (const name of ['Lent', 'Borrowed', 'All']) {
      await side.getByRole('button', { name }).click();
      await p.waitForTimeout(300);
      console.log(`counts(${name}): ${JSON.stringify(await counts())}`);
    }
  }
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-positions-${label}.png`, fullPage: true });
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
