// Watch-only live review of Alerts (#3180, ACC-48, RB-INBOX; live tier, run
// after each deploy), through the shared watch-only wallet (watch-wallet.cjs).
// The deployed build reads the deployed index's inbox for the watched wallet:
// the page's rows (or its empty or failed line), the unreadable count, and the
// header bell's name and count, on desktop and phone. Nothing is signed. The
// page marks what it showed as seen in this throwaway browser profile only.
// The inbox rules themselves are covered by the CI-Anvil spec (41-alerts.spec.ts).
// Usage: node e2e/live/alerts-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}`, { waitUntil: 'networkidle' });
  await connect(p);
  const bell = p.getByTestId('inbox-bell');
  await bell.waitFor({ timeout: 60000 });
  await p.waitForTimeout(6000);
  console.log(`===== ${label}: bell before opening "${await bell.getAttribute('aria-label')}" unread=${await bell.getAttribute('data-unread')}`);
  await bell.click();
  await p.waitForURL(/\/alerts$/);
  const inbox = p.getByTestId('alerts-inbox');
  await inbox.waitFor({ timeout: 30000 });
  await p.waitForFunction(() => !document.querySelector('[data-testid="alerts-inbox"]')?.textContent?.includes('Reading this wallet'), null, { timeout: 30000 });
  for (const id of ['alerts-failed', 'alerts-empty', 'alerts-unreadable', 'alerts-fresh']) {
    const el = p.getByTestId(id);
    if (await el.count()) console.log(`--- ${id}: ${await el.innerText()}`);
  }
  const rows = p.getByTestId('alerts-rows').locator('li');
  const n = await rows.count();
  console.log(`--- rows on screen: ${n}`);
  for (let i = 0; i < Math.min(n, 8); i++) console.log(`    [${await rows.nth(i).getAttribute('data-alert')}] ${(await rows.nth(i).innerText()).replace(/\n+/g, ' · ')}`);
  console.log('more button:', await p.getByTestId('alerts-more').count());
  console.log(`bell after opening "${await bell.getAttribute('aria-label')}" unread=${await bell.getAttribute('data-unread')}`);
  await p.screenshot({ path: `${OUT}/live-alerts-${label}.png`, fullPage: false });
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
