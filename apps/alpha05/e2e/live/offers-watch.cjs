// Watch-only live review of the Offers page (OFF-39, OFF-40, OFF-41,
// OFF-45, OFF-46, OFF-48, OFF-49, RB-OFFERS-MINE, RB-OFFER-BOOK,
// RB-OFFER-PAGE, RB-OFFER-CANCEL) (live tier, run after each deploy),
// through the shared watch-only wallet (watch-wallet.cjs): nothing can be
// sent. Opens Offers as <address> and prints the page: the state filters
// with their counts and every row under All, then the review of the first
// Cancel or Clean up button it finds, left unsigned; then the offer book
// (its count line and first rows) and the page of the book's first offer,
// with what it offers the wallet, nothing clicked. First, without
// connecting, it opens Offers, an offer's page, Borrow and Lend and prints
// their prompts and how many offer-book requests the pages made (RB-OFFER-GATE:
// none). Checks that nothing
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
  const book = p.getByTestId('offer-book');
  await book
    .locator('[data-testid="offer-book-count"], [data-testid="offer-book-failed"]')
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  const bookRows = book.locator('[data-testid^="book-row-"]');
  console.log(`----- offer book (${await bookRows.count()} rows shown)`);
  if (await book.count()) console.log((await text(book)).split('\n').slice(0, 40).join('\n'));
  const first = book.locator('[data-testid^="book-link-"]').first();
  if (await first.count()) {
    await first.click();
    await p
      .locator('[data-testid="offer-state"], [data-testid="offer-no-terms"]')
      .first()
      .waitFor({ timeout: 60000 })
      .catch(() => {});
    await p.waitForTimeout(2000);
    console.log(`----- offer page ${p.url()}\n${await text(p.locator('main'))}`);
    console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
    await p.screenshot({ path: `${OUT}/live-offer-page-${label}.png`, fullPage: true });
  } else console.log('----- the book shows no offer to open');
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
/** RB-OFFER-GATE: before a wallet connects no page reads the offer book. */
async function visitor(b, opts, label) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const book = [];
  p.on('request', (r) => {
    if (r.url().includes('/offers/active')) book.push(r.url());
  });
  for (const path of ['offers', 'offers/1', 'borrow', 'lend']) {
    await p.goto(new URL(path, BASE).href, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2000);
    console.log(`===== visitor ${label} /${path}\n${await text(p.locator('main'))}`);
  }
  console.log(`visitor ${label}: offer-book requests before connecting = ${book.length}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await visitor(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await visitor(b, { ...devices['Pixel 7'] }, 'phone');
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
