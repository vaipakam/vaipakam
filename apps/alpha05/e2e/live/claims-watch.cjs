// Watch-only live review of collecting loan payouts (live tier, run after each
// deploy), through the shared watch-only wallet (watch-wallet.cjs): nothing
// can be sent. Opens Claims as <address>, prints the loan payouts it lists
// (or that there is none) and the note naming what the page does not yet
// collect; then, when <loanId> is given, opens that loan's page and prints
// its payout section, opening the review when a side is offered. Checks
// nothing scrolls sideways and saves full-page screenshots per device. Stops
// at the review.
// Usage: node e2e/live/claims-watch.cjs <address> [loanId]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, ID] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('claims', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p
    .locator('[data-testid="claims-loan-rows"], [data-testid="claims-empty"], [data-testid="claims-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(2000);
  console.log(`===== Claims ${label}\n${await text(p.locator('main'))}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-claims-${label}.png`, fullPage: true });
  if (ID) {
    await p.goto(new URL(`positions/${ID}`, BASE).href, { waitUntil: 'networkidle' });
    await p
      .getByTestId('position-status')
      .waitFor({ timeout: 90000 })
      .catch(() => {});
    await p.waitForTimeout(3000);
    const section = p.getByRole('region', { name: 'Your payout' });
    if (await section.isVisible().catch(() => false)) {
      const open = section.locator('[data-testid^="loan-claim-open-"]').first();
      if (await open.isVisible().catch(() => false)) {
        await open.click();
        await p
          .locator('[data-testid^="loan-claim-panel-"] .receipt')
          .waitFor({ timeout: 90000 })
          .catch(() => {});
        await p.waitForTimeout(2000);
      }
      console.log(`----- loan ${ID} payout ${label}\n${await text(section)}`);
    } else {
      console.log(`loan ${ID}: no payout section for this wallet (status: ${await p.getByTestId('position-status').innerText().catch(() => 'unread')})`);
    }
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/live-claims-loan-${ID}-${label}.png`, fullPage: true });
  }
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
