// Watch-only live review of Settings › Risk access (#3180; ACC-33;
// RB-RISK-SETTINGS; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs). The deployed build reads the watched
// wallet's risk level, why it differs from its choice, whether the network
// enforces it, and strict mode, from the live Diamond; the driver prints the
// section in Basic and in Advanced on desktop and phone, and changes nothing
// but this browser's own mode setting. The watch wallet cannot sign, so no
// transaction can be sent; the changes are covered by the CI-Anvil spec
// (45-risk-settings.spec.ts).
// Usage: node e2e/live/risk-settings-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function print(p, label) {
  const risk = p.getByTestId('settings-risk');
  await risk.waitFor({ timeout: 60000 });
  await p
    .waitForFunction(() => !/Reading your risk access/.test(document.querySelector('[data-testid="settings-risk"]')?.textContent ?? ''), null, { timeout: 60000 })
    .catch(() => console.log('(the risk section was still reading after 60 s)'));
  console.log(`--- ${label}: ${(await risk.innerText()).replace(/\n+/g, ' · ')}`);
  const state = risk.getByTestId('settings-risk-state');
  if (await state.count()) {
    const attrs = {};
    for (const a of ['data-effective', 'data-held', 'data-stale', 'data-strict', 'data-gate']) attrs[a] = await state.getAttribute(a);
    console.log('state:', JSON.stringify(attrs));
  }
}

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}settings`, { waitUntil: 'networkidle' });
  await p.getByTestId('settings-display').waitFor({ timeout: 60000 });
  await p.getByTestId('settings-mode').getByRole('button', { name: 'Basic' }).click();
  await connect(p);
  console.log(`===== ${label} (${p.url()})`);
  await print(p, 'basic');
  await p.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
  await print(p, 'advanced');
  await p.getByTestId('settings-risk').screenshot({ path: `${OUT}/live-risk-settings-${label}.png` });
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
