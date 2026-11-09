// Watch-only live review of extension reserves (LN-62, RB-RESERVE) on Claims
// (live tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): nothing can be sent. Opens Claims as <address> and
// prints the Extension reserves section: each loan with a reserve left, its
// amount and whether an extension can still draw on it, or the empty or
// failed state. When <loanId> is given, it also looks that loan up by number
// (the chain-only path) and prints what it shows. Checks that no "not on
// this page yet" line remains, that nothing scrolls sideways, and saves
// full-page screenshots per device.
// Usage: node e2e/live/reserve-watch.cjs <address> [loanId]
// (screenshots go to $LIVE_OUT or /tmp; $LIVE_URL overrides the origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const [ADDR, LOAN] = process.argv.slice(2);
const BASE = process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/';
const OUT = process.env.LIVE_OUT ?? '/tmp';
const text = async (loc) => (await loc.innerText()).replace(/\n+/g, '\n');

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR, false);
  await p.goto(new URL('claims', BASE).href, { waitUntil: 'networkidle' });
  await connect(p);
  const section = p.getByRole('region', { name: 'Extension reserves' });
  await section
    .locator('[data-testid="reserve-rows"], [data-testid="reserve-empty"], [data-testid="reserve-failed"]')
    .first()
    .waitFor({ timeout: 90000 })
    .catch(() => {});
  await p.waitForTimeout(3000);
  console.log(`===== Claims ${label}\n${(await section.count()) ? await text(section) : 'no Extension reserves section'}`);
  console.log(`"not on this page yet" lines: ${await p.getByTestId('claims-not-yet').count()}`);
  if (LOAN) {
    await section.getByTestId('reserve-lookup').fill(LOAN);
    await p.waitForTimeout(6000);
    const row = section.locator(`[data-reserve-row="${LOAN}"]`);
    const none = section.getByTestId('reserve-lookup-nothing');
    console.log(`lookup #${LOAN}: ${(await row.count()) ? await text(row) : (await none.count()) ? await text(none) : 'nothing shown yet'}`);
  }
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await p.screenshot({ path: `${OUT}/live-reserve-claims-${label}.png`, fullPage: true });
  console.log(`errors: ${JSON.stringify(errs)}`);
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
