// Watch-only live review of the protected-account payout queue on Claims
// (live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): nothing can be sent. Opens Claims as <address> and
// prints the queue section (the account's mode, each queued row with its
// request code, or that protected mode is off). When <lookup> is given, it
// switches to Advanced mode, looks that account up and prints its queue, as
// a secondary signer would see it. Checks nothing scrolls sideways and saves
// full-page screenshots per device.
// Usage: node e2e/live/queue-watch.cjs <address> [lookup]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, LOOKUP] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');
async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  if (LOOKUP) await ctx.addInitScript(() => window.localStorage.setItem('app.mode', 'advanced'));
  await p.goto(new URL('claims', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByRole('region', { name: 'Payouts waiting in your queue' });
  await section
    .locator('[data-testid^="queue-rows-"], [data-testid^="queue-off-"], [data-testid^="queue-empty-"], [data-testid^="queue-failed-"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(2000);
  if (LOOKUP) {
    await section.getByTestId('queue-lookup').fill(LOOKUP);
    await section
      .locator(`[data-queue-account="${LOOKUP.toLowerCase()}"]`)
      .waitFor({ timeout: 90000 })
      .catch(() => {});
    await p.waitForTimeout(3000);
  }
  console.log(`===== Queue ${label}\n${await text(section)}`);
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-queue-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
