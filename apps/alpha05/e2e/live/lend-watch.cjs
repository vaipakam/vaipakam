// Watch-only live review of Lend (live tier, run after each deploy), through
// the shared watch-only wallet (watch-wallet.cjs): the page lists the pair's
// open borrow requests, opens a funding's full review, and the wallet refuses the signature,
// so nothing can be sent. A full funding is covered by the CI-Anvil spec
// (15-lend.spec.ts); this checks the deployed build against Base Sepolia.
// Usage: node e2e/live/lend-watch.cjs <address>  (screenshots go to $LIVE_OUT
// or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/lend');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  // Each suggested lending token in turn, until a pair lists a request.
  const lending = p.getByTestId('pick-lending').locator('select');
  const collateral = p.getByTestId('pick-collateral').locator('select');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const collOpts = await collateral.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  let found = null;
  for (const l of lendOpts) {
    for (const c of collOpts) {
      if (l === c) continue;
      await lending.selectOption(l);
      await collateral.selectOption(c);
      const region = p.getByRole('region', { name: 'Requests you can fund' });
      await p.waitForTimeout(6000);
      const rows = region.locator('[data-offer-id]');
      if ((await rows.count()) > 0) { found = { l, c, rows }; break; }
    }
    if (found) break;
  }
  const main = async () => (await p.locator('main').innerText()).replace(/\n+/g, '\n');
  if (!found) {
    console.log(`===== ${label}: no pair lists a request\n${await main()}`);
    await p.screenshot({ path: `${OUT}/live-lend-${label}-empty.png`, fullPage: true });
  } else {
    console.log(`===== ${label}: pair ${found.l} / ${found.c}`);
    await p.screenshot({ path: `${OUT}/live-lend-${label}-list.png`, fullPage: true });
    const takeable = found.rows.and(p.locator('[data-takeable="true"]')).first();
    if (await takeable.count()) {
      await takeable.getByRole('button', { name: /Fund this request|Review this request/ }).click();
      const review = p.locator('.accept-offer').first();
      await review.waitFor({ timeout: 60000 });
      await p.waitForTimeout(6000);
      console.log(`--- review\n${(await review.innerText()).replace(/\n+/g, '\n')}`);
      await p.screenshot({ path: `${OUT}/live-lend-${label}-review.png`, fullPage: true });
    } else console.log(`--- no takeable row for this wallet\n${await main()}`);
  }
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await session(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await session(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
