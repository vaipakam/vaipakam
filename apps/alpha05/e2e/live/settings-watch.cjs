// Watch-only live review of Settings (#3180; ACC-06, ACC-13, ACC-14, ACC-15
// status, ACC-35, ACC-61; RB-SETTINGS; live tier, run after each deploy),
// through the shared watch-only wallet (watch-wallet.cjs). The deployed build
// reads the watched wallet's Terms acceptance and fee-discount consent from
// the live Diamond; the driver prints each section on desktop and phone,
// reaches the page from the navigation, and changes nothing but this
// browser's own display settings. The watch wallet cannot sign, so no
// transaction can be sent; the settings flows are covered by the CI-Anvil
// spec (44-settings.spec.ts).
// Usage: node e2e/live/settings-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(ORIGIN, { waitUntil: 'networkidle' });
  const more = p.getByRole('navigation', { name: 'Quick access' }).getByRole('button', { name: 'More' });
  if (await more.isVisible()) await more.click();
  await p.getByTestId('nav-settings').click();
  await p.getByTestId('settings-display').waitFor({ timeout: 60000 });
  await connect(p);
  await p
    .waitForFunction(() => !/Reading your Terms acceptance/.test(document.querySelector('[data-testid="settings-legal"]')?.textContent ?? ''), null, { timeout: 60000 })
    .catch(() => console.log('(the Terms line was still reading after 60 s)'));
  console.log(`===== ${label} (${p.url()})`);
  for (const id of ['settings-display', 'settings-legal', 'settings-fees', 'settings-alerts', 'settings-privacy']) {
    const s = p.getByTestId(id);
    console.log(`--- ${id}: ${(await s.count()) ? (await s.innerText()).replace(/\n+/g, ' · ') : '(absent)'}`);
  }
  const terms = p.getByTestId('settings-terms');
  if (await terms.count()) console.log('terms state:', await terms.getAttribute('data-terms'));
  await p.screenshot({ path: `${OUT}/live-settings-${label}.png`, fullPage: true });
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
