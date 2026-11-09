// Watch-only live review of Claim everything (LN-51, RB-CLAIM-ALL) on Claims
// (live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): nothing can be sent. Opens Claims as <address> and
// prints the Claim everything section: each payout listed with its switch
// (on or off), what it pays, every source named as left out, and the batch
// button or what stops it. When the batch is offered, it opens the review
// and prints the receipt, then leaves it unsigned. Checks that nothing
// scrolls sideways and saves full-page screenshots per device.
// Usage: node e2e/live/claim-all-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('claims', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByRole('region', { name: 'Claim everything' });
  await section
    .locator('[data-testid="claim-all-legs"], [data-testid="claim-all-empty"], [data-testid="claim-all-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  console.log(`===== Claims ${label}\n${(await section.count()) ? await text(section) : 'no Claim everything section'}`);
  const legs = section.locator('[data-claim-leg]');
  for (let n = 0; n < (await legs.count()); n++) {
    const leg = legs.nth(n);
    console.log(`leg ${await leg.getAttribute('data-claim-leg')}: ${(await leg.getByRole('checkbox').isChecked()) ? 'on' : 'off'}`);
  }
  const review = section.getByTestId('claim-all-review');
  if ((await review.count()) && (await review.isEnabled())) {
    await review.click();
    const receipt = section.getByTestId('claim-all-panel').locator('.receipt');
    await receipt.waitFor({ timeout: 60000 }).catch(() => {});
    await p.waitForTimeout(3000);
    console.log(`----- review (unsigned)\n${(await receipt.count()) ? await text(receipt) : 'no receipt shown'}`);
  } else {
    const stop = section.getByTestId('claim-all-stop');
    console.log(`batch: ${(await stop.count()) ? `stopped (${await stop.getAttribute('data-code')})` : 'not offered'}`);
  }
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-claim-all-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
