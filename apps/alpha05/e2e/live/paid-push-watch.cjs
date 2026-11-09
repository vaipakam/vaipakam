// Watch-only live review of Alerts › Paid push alerts (#3180 Alerts slice 3,
// ACC-53, RB-PAID-PUSH; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs). The deployed build reads the fee per
// loan side and the watched wallet's stored cap from the live Diamond, and
// asks the deployed alert service whether it charges on this network; the
// driver prints the card on desktop and phone and opens nothing. The watch
// wallet cannot sign, so no transaction can be sent; the agree and withdraw
// flows are covered by the CI-Anvil spec (43-paid-push.spec.ts).
// Usage: node e2e/live/paid-push-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  let pushStatus = null;
  p.on('response', async (r) => {
    if (new URL(r.url()).pathname === '/push/status') pushStatus = `${r.status()} ${await r.text().catch(() => '')}`;
  });
  await p.goto(`${ORIGIN}alerts`, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByTestId('paid-push');
  await section.waitFor({ timeout: 60000 });
  await p
    .waitForFunction(() => !/Reading your agreement|Checking what this deployment offers/.test(document.querySelector('[data-testid="paid-push"]')?.textContent ?? ''), null, {
      timeout: 60000,
    })
    .catch(() => console.log('(the card was still reading after 60 s)'));
  console.log(`===== ${label}`);
  console.log(`--- paid-push: ${(await section.innerText()).replace(/\n+/g, ' · ')}`);
  const billing = p.getByTestId('paid-push-billing');
  if (await billing.count()) console.log('billing:', await billing.getAttribute('data-billing'));
  const consent = p.getByTestId('paid-push-consent');
  if (await consent.count()) console.log('stored cap:', await consent.getAttribute('data-cap'));
  console.log('push status answer:', pushStatus);
  await section.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/live-paid-push-${label}.png`, fullPage: true });
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
