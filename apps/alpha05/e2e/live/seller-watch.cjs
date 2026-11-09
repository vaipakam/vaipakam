// Watch-only live review of "Interest from positions you sold" on Claims
// (live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): nothing can be sent. Opens Claims as <address> and
// prints the seller section (the loans the index lists, what each owes and
// waits in the vault, or that nothing is owed, or that the index could not
// list them). When <loanId> is given, it looks that loan up by its number,
// which reads the chain alone, and prints the section again. Checks nothing
// scrolls sideways and saves full-page screenshots per device.
// Usage: node e2e/live/seller-watch.cjs <address> [loanId]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, LOAN] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('claims', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByRole('region', { name: 'Interest from positions you sold' });
  await section
    .locator('[data-testid="seller-rows"], [data-testid="seller-empty"], [data-testid="seller-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(2000);
  console.log(`===== Seller interest ${label}\n${await text(section)}`);
  if (LOAN) {
    await section.getByTestId('seller-lookup').fill(LOAN);
    await section
      .locator(`[data-seller-row="${LOAN}"], [data-testid="seller-lookup-nothing"]`)
      .first()
      .waitFor({ timeout: 90000 })
      .catch(() => {});
    await p.waitForTimeout(2000);
    console.log(`===== Seller interest ${label}, loan #${LOAN} looked up\n${await text(section)}`);
  }
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-seller-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
