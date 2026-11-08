// Watch-only live review of repaying a loan in full (live tier, run after
// each deploy), through the shared watch-only wallet (watch-wallet.cjs):
// nothing can be sent. Opens the loan's page as <address>, opens the repay
// review, prints the receipt per device (the payoff now and by the moment
// ahead, read from the live protocol at that block time), checks nothing
// scrolls sideways, and saves full-page screenshots. Stops at the review.
// Usage: node e2e/live/repay-watch.cjs <address> <loanId>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, ID] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL(`positions/${ID}`, BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.getByTestId('position-status').waitFor({ timeout: 90000 }).catch(() => {});
  const open = p.getByTestId('repay-open');
  if (await open.isVisible({ timeout: 30000 }).catch(() => false)) {
    await open.click();
    await p.locator('[data-testid="repay-panel"] .receipt').waitFor({ timeout: 90000 }).catch(() => {});
    await p.waitForTimeout(3000);
  } else {
    const why = await p
      .getByTestId('repay-refusal')
      .innerText()
      .catch(() => '(no repay action and no refusal shown)');
    console.log(`repay not offered: ${why}`);
  }
  const main = (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  console.log(`===== repay loan ${ID} ${label}\n${main}\nerrors: ${JSON.stringify(errs)}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-repay-${ID}-${label}.png`, fullPage: true });
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
