// Watch-only live review of Settings › Approvals (#3180; ACC-32;
// RB-APPROVALS; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs). The deployed build reads the watched
// wallet's standing approvals to the live Diamond (and to it through Permit2
// where Permit2 is deployed) for every asset its records on this network
// name; the driver prints the section on desktop and phone and changes
// nothing. The watch wallet cannot sign, so no approval can be withdrawn;
// that is covered by the CI-Anvil spec (46-approvals.spec.ts).
// Usage: node e2e/live/approvals-watch.cjs <address>  (screenshots go to
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
  const section = p.getByTestId('settings-approvals');
  await section.waitFor({ timeout: 60000 });
  await p
    .waitForFunction(() => !/Checking your approvals/.test(document.querySelector('[data-testid="settings-approvals"]')?.textContent ?? ''), null, { timeout: 90000 })
    .catch(() => console.log('(the approvals were still being checked after 90 s)'));
  console.log(`===== ${label} (${p.url()})`);
  console.log(`--- approvals: ${(await section.innerText()).replace(/\n+/g, ' · ')}`);
  const rows = section.getByTestId('settings-approval-row');
  for (let i = 0; i < (await rows.count()); i++) {
    const r = rows.nth(i);
    console.log(`row ${i}: ${await r.getAttribute('data-kind')} ${await r.getAttribute('data-asset')}`);
  }
  await section.screenshot({ path: `${OUT}/live-approvals-${label}.png` });
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
