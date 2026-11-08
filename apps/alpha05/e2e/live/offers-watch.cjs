// Watch-only live review of the Offers page (OFF-46, OFF-48, OFF-49,
// RB-OFFERS-MINE, RB-OFFER-CANCEL) (live tier, run after each deploy),
// through the shared watch-only wallet (watch-wallet.cjs): nothing can be
// sent. Opens Offers as <address> and prints the page: the state filters
// with their counts and every row under All, then the review of the first
// Cancel or Clean up button it finds, left unsigned. Checks that nothing
// scrolls sideways and saves full-page screenshots per device.
// Usage: node e2e/live/offers-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('offers', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const main = p.locator('main.offers');
  await main
    .locator('[data-testid="offers-mine"], [data-testid="offers-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  console.log(`===== Offers ${label}\n${(await main.count()) ? await text(main) : 'no Offers page'}`);
  const all = p.getByTestId('offers-filter-all');
  if (await all.count()) {
    await all.click();
    await p.waitForTimeout(1000);
    const rows = p.locator('[data-testid^="offer-row-"]');
    console.log(`----- all offers (${await rows.count()} rows)`);
    for (let n = 0; n < (await rows.count()); n++) console.log(`${await rows.nth(n).getAttribute('data-offer-id')}\n${await text(rows.nth(n))}`);
  }
  const action = p.locator('[data-testid^="offer-cancel-"]').first();
  if (await action.count()) {
    const id = (await action.getAttribute('data-testid')).replace('offer-cancel-', '');
    await action.click();
    const panel = p.getByTestId(`offer-cancel-panel-${id}`);
    await panel
      .locator('.receipt')
      .waitFor({ timeout: 60000 })
      .catch(() => {});
    await p.waitForTimeout(3000);
    console.log(`----- cancel review for offer ${id} (unsigned)\n${(await panel.count()) ? await text(panel) : 'no review shown'}`);
  } else console.log('----- no offer this wallet can cancel or clean up');
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-offers-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
