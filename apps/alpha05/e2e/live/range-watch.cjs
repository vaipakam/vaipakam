// Watch-only live review of a ranged borrow request in Advanced mode (live
// tier, run after each deploy), through the shared watch-only wallet
// (watch-wallet.cjs): a range, a floor collateral and a fill mode are typed,
// the protocol's dry runs answer from the watched address on Base Sepolia, and
// the review (both ends, the matching switch, what a match may lock and keep,
// the start-of-loan limit, what stays fixed) is read. The wallet refuses every
// signature, so nothing can be sent. A full post is covered by the CI-Anvil
// spec (12-request-advanced.spec.ts); this checks the deployed build.
// Usage: node e2e/live/range-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/borrow');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('app.mode', 'advanced');
    } catch {
      /* storage blocked: the run reports Basic */
    }
  });
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  const lending = p.getByTestId('pick-lending').locator('select');
  const collateral = p.getByTestId('pick-collateral').locator('select');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const collOpts = await collateral.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const l = lendOpts[0];
  const c = collOpts.find((v) => v !== l);
  await lending.selectOption(l);
  await collateral.selectOption(c);
  console.log(`===== ${label}: pair ${l} / ${c}`);
  await p.getByTestId('request-open').click();
  await p.getByTestId('request-duration').getByRole('radio').first().waitFor({ timeout: 60000 });
  console.log('advanced panel visible:', await p.getByTestId('request-advanced').isVisible());
  await p.getByTestId('request-amount').fill('0.01');
  await p.getByTestId('request-collateral').fill('50');
  await p.getByTestId('request-rate').fill('6.5');
  await p.getByTestId('request-expiry').selectOption('7d');
  await p.getByTestId('request-range').check();
  await p.getByTestId('request-amount-max').fill('0.02');
  await p.getByTestId('request-floor').fill('30');
  await p.getByTestId('request-floor').blur();
  await p.waitForTimeout(1500);
  console.log(`--- fill modes: ${await p.getByTestId('request-fill').innerText()}`);
  console.log(`--- summary: ${await p.getByTestId('request-summary').innerText()}`);
  await p.getByTestId('request-advanced').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/live-range-${label}-form.png`, fullPage: false });
  await p.getByTestId('request-review').click();
  const flow = p.locator('.post-request');
  await flow.locator('.receipt').waitFor({ timeout: 60000 });
  await p.waitForTimeout(6000);
  console.log(`--- review\n${(await flow.innerText()).replace(/\n+/g, '\n')}`);
  console.log('confirm enabled:', await flow.getByRole('button', { name: 'Confirm in wallet' }).isEnabled().catch(() => false));
  await p.screenshot({ path: `${OUT}/live-range-${label}-review.png`, fullPage: true });
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
