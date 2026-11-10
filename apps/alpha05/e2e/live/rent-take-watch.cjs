// Watch-only live review of taking a renter's request (#3180; NFT-01 /
// NFT-02; RB-RENT-TAKE; live tier, run after each deploy), through the
// shared watch-only wallet (watch-wallet.cjs). The deployed build opens the
// given request's page for the watched wallet's network, prints its facts,
// opens "Rent out your NFT" and prints the review's receipt and any blocker
// (a token the watched wallet does not hold is said there). The watch wallet
// cannot sign, so nothing is rented out; taking a request is covered by the
// CI-Anvil spec (52-rent-take.spec.ts).
// Usage: node e2e/live/rent-take-watch.cjs <address> <requestId>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed
// origin; $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const REQUEST = process.argv[3];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}offers/${REQUEST}`, { waitUntil: 'networkidle' });
  await p.getByRole('heading', { level: 1, name: `Offer #${REQUEST}` }).waitFor({ timeout: 60000 });
  await connect(p);
  const facts = p.getByTestId('offer-facts');
  await facts.waitFor({ timeout: 90000 });
  console.log(`===== ${label} (${p.url()})`);
  console.log(`--- facts: ${(await facts.innerText()).replace(/\n+/g, ' · ')}`);
  await p.screenshot({ path: `${OUT}/live-rent-take-${label}-page.png`, fullPage: true });
  const take = p.getByTestId('offer-page-take');
  if (await take.count()) {
    await take.click();
    const flow = p.getByTestId('rent-take');
    await flow
      .locator('.receipt')
      .waitFor({ timeout: 90000 })
      .catch(() => console.log('(the review was still being read after 90 s)'));
    console.log(`--- review: ${(await flow.innerText()).replace(/\n+/g, ' · ')}`);
    await flow.screenshot({ path: `${OUT}/live-rent-take-${label}-review.png` });
  } else {
    console.log(`--- action: ${(await p.getByTestId('offer-action').innerText()).replace(/\n+/g, ' · ')}`);
  }
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  if (!ADDR || !REQUEST) throw new Error('usage: node e2e/live/rent-take-watch.cjs <address> <requestId>');
  const b = await chromium.launch();
  await view(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await view(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
