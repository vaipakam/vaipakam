// Watch-only live review of Rent (#3180; NFT-02, NFT-03, NFT-38; RB-RENT;
// live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs). The deployed build reads the rental book from the
// index for the watched wallet's network and prints it (or its empty state
// and the faucet link); when a listing id is given, the driver opens that
// listing's page and its rental review, and prints the receipt and any
// blocker. The watch wallet cannot sign, so nothing is rented; renting is
// covered by the CI-Anvil spec (49-rent.spec.ts).
// Usage: node e2e/live/rent-watch.cjs <address> [listingId]  (screenshots go
// to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin;
// $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const LISTING = process.argv[3];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}rent`, { waitUntil: 'networkidle' });
  await p.getByRole('heading', { level: 1, name: 'Rent an NFT' }).waitFor({ timeout: 60000 });
  await connect(p);
  const book = p.getByTestId('offer-book');
  await book.waitFor({ timeout: 60000 });
  await book
    .getByTestId('offer-book-count')
    .waitFor({ timeout: 90000 })
    .catch(() => console.log('(the rental book was still being read after 90 s)'));
  console.log(`===== ${label} (${p.url()})`);
  console.log(`--- book: ${(await book.innerText()).replace(/\n+/g, ' · ')}`);
  if (await p.getByTestId('rent-empty').count()) console.log(`--- empty: ${await p.getByTestId('rent-empty').innerText()}`);
  console.log(`--- list: ${(await p.getByTestId('rent-list').innerText()).replace(/\n+/g, ' · ')}`);
  await p.screenshot({ path: `${OUT}/live-rent-${label}-book.png`, fullPage: true });
  if (LISTING) {
    await p.goto(`${ORIGIN}offers/${LISTING}`, { waitUntil: 'networkidle' });
    const facts = p.getByTestId('offer-facts');
    await facts.waitFor({ timeout: 90000 });
    console.log(`--- facts: ${(await facts.innerText()).replace(/\n+/g, ' · ')}`);
    const take = p.getByTestId('offer-page-take');
    if (await take.count()) {
      await take.click();
      const flow = p.getByTestId('rent-accept');
      await flow
        .locator('.receipt')
        .waitFor({ timeout: 90000 })
        .catch(() => console.log('(the rental review was still being read after 90 s)'));
      console.log(`--- review: ${(await flow.innerText()).replace(/\n+/g, ' · ')}`);
      await flow.screenshot({ path: `${OUT}/live-rent-${label}-review.png` });
    } else {
      console.log(`--- action: ${(await p.getByTestId('offer-action').innerText()).replace(/\n+/g, ' · ')}`);
    }
  }
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await view(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await view(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
