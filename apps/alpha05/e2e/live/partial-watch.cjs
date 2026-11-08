// Watch-only live review of paying part of a loan (live tier, run after each
// deploy), through the shared watch-only wallet (watch-wallet.cjs): nothing
// can be sent. Opens the loan's page as <address> (the borrower position's
// holder), opens the pay-part form, types <amount>, opens the review, prints
// the form and the receipt per device, checks nothing scrolls sideways, and
// saves full-page screenshots. Stops at the review.
// Usage: node e2e/live/partial-watch.cjs <address> <loanId> <amount>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, ID, AMOUNT] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL(`positions/${ID}`, BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p.getByTestId('position-status').waitFor({ timeout: 90000 }).catch(() => {});
  const open = p.getByTestId('partial-open');
  if (await open.isVisible({ timeout: 30000 }).catch(() => false)) {
    await open.click();
    const form = p.getByTestId('partial-form');
    await form.waitFor({ timeout: 30000 });
    await p.waitForTimeout(2000);
    console.log(`----- form ${label}\n${(await form.innerText()).replace(/\n+/g, '\n')}`);
    await p.screenshot({ path: `${OUT}/live-partial-${ID}-${label}-form.png`, fullPage: true });
    await p.getByTestId('partial-amount').fill(AMOUNT ?? '0');
    await p.getByTestId('partial-review').click();
    await p.locator('[data-testid="partial-panel"] .receipt').waitFor({ timeout: 90000 }).catch(() => {});
    await p.waitForTimeout(3000);
  } else {
    const why = await p
      .getByTestId('partial-refusal')
      .innerText()
      .catch(() => '(no pay-part action and no refusal shown)');
    console.log(`pay part not offered: ${why}`);
  }
  const main = (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  console.log(`===== pay part of loan ${ID} ${label}\n${main}\nerrors: ${JSON.stringify(errs)}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-partial-${ID}-${label}.png`, fullPage: true });
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
