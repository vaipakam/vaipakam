// Watch-only live review of the Protection page (#3415 slice 1; ACC-41;
// RB-ADDRESS-GUARD; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs). The deployed build reads the watched
// wallet's protected mode, destinations and waiting requests on the live
// Diamond in one block; the driver prints the destinations and saved-address
// sections on desktop and phone, types a look-alike of the watched address
// into the address box to show it refused, and opens a damaged proof link to
// show it refused. It saves nothing (the browser's list is the driver's own
// throwaway context) and signs nothing; signing and every destination change
// are covered by the CI-Anvil spec (60-protection.spec.ts).
// Usage: node e2e/live/protection-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

/** Same first and last three hex digits as the watched address, a different middle. */
function lookalikeOf(a) {
  const low = a.toLowerCase();
  const middle = low.slice(5, -3) === '0'.repeat(34) ? '1'.repeat(34) : '0'.repeat(34);
  return `${low.slice(0, 5)}${middle}${low.slice(-3)}`;
}

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}protection`, { waitUntil: 'networkidle' });
  await connect(p);
  const dests = p.getByTestId('destinations');
  await dests.waitFor({ timeout: 60000 });
  await p
    .waitForFunction(() => !document.querySelector('[data-testid="destinations"]')?.textContent?.includes('Reading your destinations'), null, {
      timeout: 90000,
    })
    .catch(() => console.log('(the destinations were still being read after 90 s)'));
  console.log(`===== ${label} (${p.url()})`);
  console.log(`--- destinations: ${(await dests.innerText()).replace(/\n+/g, ' · ')}`);
  await dests.screenshot({ path: `${OUT}/live-protection-${label}-destinations.png` });
  const book = p.getByTestId('address-book');
  console.log(`--- saved addresses: ${(await book.innerText()).replace(/\n+/g, ' · ')}`);

  // The look-alike of the watched wallet is refused, and nothing can be saved.
  await book.locator('#book-label').fill('Look-alike check');
  await book.locator('#book-address').fill(lookalikeOf(ADDR));
  const entry = book.getByTestId('address-book-entry-input');
  console.log(`look-alike: candidate=${await entry.getAttribute('data-candidate')} save disabled=${await book.getByTestId('address-book-save').isDisabled()}`);
  await book.screenshot({ path: `${OUT}/live-protection-${label}-lookalike.png` });

  // A damaged proof link is refused before anything can be signed.
  await p.goto(`${ORIGIN}protection?prove=damaged`, { waitUntil: 'networkidle' });
  const prove = p.getByTestId('prove-control');
  await prove.waitFor({ timeout: 60000 });
  console.log(`--- damaged link: ${(await prove.innerText()).replace(/\n+/g, ' · ')}`);
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
