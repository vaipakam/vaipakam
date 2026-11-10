// Watch-only live review of the price-move guard on an offer's page (#3358;
// RB-PRICE-GUARD; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): nothing can be sent. Opens Offers as
// <address>, then the page of the wallet's own first offer and of the book's
// first offer, and prints what each shows about the guard: the guard section
// (its limit, status and whether a limit can be typed), the creator's line
// saying this network's protocol has no guard yet, or nothing. Until a
// network's protocol carries the guard, the creator sees that line and
// everyone else sees nothing; setting, changing and removing a guard is
// covered by the CI-Anvil spec (62-offer-price-guard.spec.ts). Checks that
// nothing scrolls sideways and saves screenshots per device.
// Usage: node e2e/live/price-guard-watch.cjs <address>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin;
// $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, ' · ');

/** Print the guard as one offer's page shows it. */
async function guardOn(p, id, label, which) {
  await p.goto(new URL(`offers/${id}`, BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p
    .locator('[data-testid="offer-state"], [data-testid="offer-no-terms"]')
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  await p.waitForTimeout(4000);
  const guard = p.getByTestId('guard');
  const absent = p.getByTestId('guard-absent');
  console.log(`----- ${which} offer #${id} (${label})`);
  if (await guard.count()) {
    console.log(`guard on=${await guard.getAttribute('data-on')} status=${await guard.getAttribute('data-status')}`);
    console.log(`guard: ${await text(guard)}`);
    console.log(`limit box shown: ${(await guard.getByTestId('guard-input').count()) > 0}`);
  } else if (await absent.count()) console.log(`no guard on this network: ${await text(absent)}`);
  else console.log('no guard section (no guard, and the reader cannot set one)');
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-price-guard-${which}-${label}.png`, fullPage: true });
}

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('offers', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  await p
    .locator('[data-testid="offers-mine"], [data-testid="offers-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  const all = p.getByTestId('offers-filter-all');
  if (await all.count()) await all.click();
  const mine = p.locator('[data-testid^="offer-row-"]').first();
  const mineId = (await mine.count()) ? await mine.getAttribute('data-offer-id') : null;
  const book = p.getByTestId('offer-book');
  await book
    .locator('[data-testid="offer-book-count"], [data-testid="offer-book-failed"]')
    .first()
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  const first = book.locator('[data-testid^="book-row-"]').first();
  const bookId = (await first.count()) ? await first.getAttribute('data-offer-id') : null;
  if (mineId) await guardOn(p, mineId, label, 'own');
  else console.log(`----- (${label}) the watched wallet has no offer`);
  if (bookId && bookId !== mineId) await guardOn(p, bookId, label, 'book');
  else if (!bookId) console.log(`----- (${label}) the book shows no offer to open`);
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
