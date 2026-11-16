// Watch-only live review of Activity (#3677, RB-ACTIVITY; live tier, run
// after each deploy), through the shared watch-only wallet (watch-wallet.cjs).
// The deployed build reads the deployed index's wallet filter for the watched
// wallet: the page's notices (still reading older history, not-final events,
// unreadable rows, a failed read), its first lines with what each folds under
// it, and whether more pages follow, on desktop and phone. Nothing is signed.
// The page's rules themselves are covered by the CI-Anvil spec (84-activity.spec.ts).
// Usage: node e2e/live/activity-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_CHAIN_ID
// picks the network, as in watch-wallet.cjs)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function view(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}positions`, { waitUntil: 'networkidle' });
  await connect(p);
  await p.getByTestId('positions-activity-link').click();
  await p.waitForURL(/\/activity$/);
  const page = p.getByTestId('activity');
  await page.waitFor({ timeout: 30000 });
  await p.waitForFunction(() => !document.querySelector('[data-testid="activity"]')?.textContent?.includes('Reading this wallet'), null, { timeout: 60000 });
  console.log(`===== ${label}`);
  for (const id of ['activity-failed', 'activity-incomplete', 'activity-complete-unknown', 'activity-unreadable', 'activity-pending-unknown', 'activity-empty', 'activity-end']) {
    const el = p.getByTestId(id);
    if (await el.count()) console.log(`--- ${id}: ${await el.innerText()}`);
  }
  const pending = p.getByTestId('activity-pending').locator(':scope > ul > li');
  console.log(`--- not-final lines: ${await pending.count()}`);
  const rows = p.getByTestId('activity-rows').locator(':scope > li');
  const n = await rows.count();
  console.log(`--- lines on screen: ${n}`);
  for (let i = 0; i < Math.min(n, 10); i++) console.log(`    [${await rows.nth(i).getAttribute('data-kind')}] ${(await rows.nth(i).innerText()).replace(/\n+/g, ' · ')}`);
  console.log('more button:', await p.getByTestId('activity-more').count());
  await p.screenshot({ path: `${OUT}/live-activity-${label}.png`, fullPage: false });
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
