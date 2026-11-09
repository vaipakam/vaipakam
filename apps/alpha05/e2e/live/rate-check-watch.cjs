// Watch-only live review of the rate warning before posting (#3357,
// RB-RATE-CHECK; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs). On the lend form and the borrow form
// the pair is picked and the term left at its default; the rate note is read
// before a rate is typed, then at a low and a high rate, so the deployed
// build is seen reading the deployed index's recent loans (or saying there
// are none, or that the index could not be read). Nothing is reviewed or
// signed. The verdicts themselves are covered by the CI-Anvil spec
// (40-rate-check.spec.ts).
// Usage: node e2e/live/rate-check-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_COLLATERAL
// picks the collateral token, so a pair with recent loans can be read)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function side(b, opts, label, which) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}${which}`, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  const lending = p.getByTestId('pick-lending').locator('select');
  const collateral = p.getByTestId('pick-collateral').locator('select');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const collOpts = await collateral.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const l = lendOpts[0];
  const want = process.env.LIVE_COLLATERAL?.toLowerCase();
  const c = (want && collOpts.find((v) => v.toLowerCase() === want)) || collOpts.find((v) => v !== l);
  await lending.selectOption(l);
  await collateral.selectOption(c);
  console.log(`===== ${label} ${which}: pair ${l} / ${c}`);
  await p.getByTestId(which === 'lend' ? 'lend-offer-open' : 'request-open').click();
  await p.getByTestId('request-duration').getByRole('radio').first().waitFor({ timeout: 60000 });
  const check = p.getByTestId('rate-check');
  await check.waitFor({ timeout: 30000 });
  await p.waitForTimeout(5000);
  console.log(`--- no rate: ${await check.innerText()}`);
  for (const rate of ['1', '30']) {
    await p.getByTestId('request-rate').fill(rate);
    await p.waitForTimeout(800);
    console.log(`--- rate ${rate}% [${await check.getAttribute('data-verdict')}]: ${(await check.innerText()).replace(/\n+/g, ' ')}`);
  }
  console.log('review enabled:', await p.getByTestId('request-review').isEnabled());
  await check.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/live-rate-check-${which}-${label}.png`, fullPage: false });
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  for (const which of ['lend', 'borrow']) {
    await side(b, { viewport: { width: 1280, height: 900 } }, 'desktop', which);
    await side(b, { ...devices['Pixel 7'] }, 'phone', which);
  }
  await b.close();
})();
