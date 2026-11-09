// Watch-only live review of posting a request to rent an NFT (#3180;
// NFT-02; RB-RENT-REQUEST; live tier, run after each deploy), through the
// shared watch-only wallet (watch-wallet.cjs). The deployed build opens the
// request form on Rent for the watched wallet's network, fills it for the
// given token (or the first suggested test collection and token 1), and
// prints the review's receipt and any blocker (a short wallet, a token that
// does not exist yet). The watch wallet cannot sign, so nothing is posted;
// posting is covered by the CI-Anvil spec (51-rent-request.spec.ts).
// Usage: node e2e/live/rent-request-watch.cjs <address> [collection] [tokenId]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed
// origin; $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const COLLECTION = process.argv[3];
const TOKEN = process.argv[4] ?? '1';
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}rent`, { waitUntil: 'networkidle' });
  await p.getByRole('heading', { level: 1, name: 'Rent an NFT' }).waitFor({ timeout: 60000 });
  await connect(p);
  const open = p.getByTestId('rent-request-open');
  await open.waitFor({ timeout: 60000 });
  await open.click();
  const form = p.getByTestId('rent-request-form');
  await form.waitFor({ timeout: 30000 });
  if (COLLECTION) {
    await form.getByTestId('rent-request-nft').selectOption('other');
    await form.getByTestId('rent-request-nft-address').fill(COLLECTION);
  }
  await form.getByTestId('rent-request-token-id').fill(TOKEN);
  await form.getByTestId('rent-request-fee').fill('1');
  await form.getByTestId('rent-request-days').fill('3');
  console.log(`===== ${label} (${p.url()})`);
  console.log(`--- form: ${(await form.innerText()).replace(/\n+/g, ' · ')}`);
  await p.screenshot({ path: `${OUT}/live-rent-request-${label}-form.png`, fullPage: true });
  await form.getByTestId('rent-request-continue').click();
  const flow = p.getByTestId('rent-request-flow');
  await flow
    .locator('.receipt')
    .waitFor({ timeout: 90000 })
    .catch(() => console.log('(the request review was still being read after 90 s)'));
  console.log(`--- review: ${(await flow.innerText()).replace(/\n+/g, ' · ')}`);
  await flow.screenshot({ path: `${OUT}/live-rent-request-${label}-review.png` });
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
