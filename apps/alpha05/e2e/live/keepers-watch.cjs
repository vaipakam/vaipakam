// Watch-only live review of Settings › Keepers (#3180; ACC-34; RB-KEEPERS;
// live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs). The deployed build reads the watched wallet's keeper
// settings on the live Diamond in one block (the master switch, each approved
// keeper and its actions) and names this app's keeper from the deployment
// record; the driver prints the section on desktop and phone, in Basic and
// in Advanced, and changes nothing. The watch wallet cannot sign, so no
// change can be made; that is covered by the CI-Anvil spec (47-keepers.spec.ts).
// Usage: node e2e/live/keepers-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}settings`, { waitUntil: 'networkidle' });
  await p.getByTestId('settings-display').waitFor({ timeout: 60000 });
  await connect(p);
  const section = p.getByTestId('settings-keepers');
  await section.waitFor({ timeout: 60000 });
  await section
    .getByTestId('settings-keepers-state')
    .waitFor({ timeout: 90000 })
    .catch(() => console.log('(the keeper settings were still being read after 90 s)'));
  console.log(`===== ${label} (${p.url()})`);
  const state = section.getByTestId('settings-keepers-state');
  if (await state.count()) console.log(`state: access=${await state.getAttribute('data-access')} count=${await state.getAttribute('data-count')}`);
  console.log(`--- basic: ${(await section.innerText()).replace(/\n+/g, ' · ')}`);
  await section.screenshot({ path: `${OUT}/live-keepers-${label}-basic.png` });
  await p.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
  console.log(`--- advanced: ${(await section.innerText()).replace(/\n+/g, ' · ')}`);
  await section.screenshot({ path: `${OUT}/live-keepers-${label}-advanced.png` });
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
