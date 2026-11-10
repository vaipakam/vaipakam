// Watch-only live review of closing a rental (#3180; NFT-05; RB-RENT-CLOSE;
// live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs). The deployed build opens the given rental's loan page
// for the watched wallet's network and prints its actions: for the renter,
// "Close the rental" is opened and the review's receipt and any blocker are
// printed; for anyone else, how a rental ends. The watch wallet cannot sign,
// so nothing is closed; closing is covered by the CI-Anvil spec
// (53-rent-close.spec.ts). Given a loan that is not a rental, it prints that
// page's actions, so the rental rows can be seen to stay away from it.
// Usage: node e2e/live/rent-close-watch.cjs <address> <loanId>
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed
// origin; $LIVE_CHAIN_ID picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const LOAN = process.argv[3];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}positions/${LOAN}`, { waitUntil: 'networkidle' });
  await connect(p);
  const actions = p.getByRole('region', { name: 'Actions' });
  await actions.waitFor({ timeout: 90000 }).catch(() => console.log('(no actions section: the position has ended or was not read)'));
  console.log(`===== ${label} (${p.url()})`);
  if (await actions.count()) console.log(`--- actions: ${(await actions.innerText()).replace(/\n+/g, ' · ')}`);
  await p.screenshot({ path: `${OUT}/live-rent-close-${label}-page.png`, fullPage: true });
  const open = p.getByTestId('rent-close-open');
  if (await open.count()) {
    await open.click();
    const flow = p.getByTestId('rent-close-panel');
    await flow
      .locator('.receipt')
      .waitFor({ timeout: 90000 })
      .catch(() => console.log('(the review was still being read after 90 s)'));
    console.log(`--- review: ${(await flow.innerText()).replace(/\n+/g, ' · ')}`);
    await flow.screenshot({ path: `${OUT}/live-rent-close-${label}-review.png` });
  }
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  if (!ADDR || !LOAN) throw new Error('usage: node e2e/live/rent-close-watch.cjs <address> <loanId>');
  const b = await chromium.launch();
  await view(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await view(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
