// Watch-only live review of posting a lending offer (live tier, run after
// each deploy), through the shared watch-only wallet (watch-wallet.cjs): the
// form is filled with exact figures (the wallet's balance of the amount lent
// is read, since that is what locks), the protocol's dry run answers from the
// watched address, and the review, its consequences (including where the
// offer is managed while this app's Offers page is not built) and the gate
// are read. The wallet refuses every signature, so nothing can be sent. A full
// post is covered by the CI-Anvil spec (16-lend-offer.spec.ts); this checks
// the deployed build against Base Sepolia.
// Usage: node e2e/live/lend-offer-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin)
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
  const lending = p.getByTestId('pick-lending').locator('select');
  const collateral = p.getByTestId('pick-collateral').locator('select');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const collOpts = await collateral.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const l = lendOpts[0];
  const c = collOpts.find((v) => v !== l);
  await lending.selectOption(l);
  await collateral.selectOption(c);
  console.log(`===== ${label}: pair ${l} / ${c}`);
  await p.getByTestId('lend-offer-open').click();
  await p.getByTestId('request-duration').getByRole('radio').first().waitFor({ timeout: 60000 });
  console.log(
    `--- amount hint: ${await p
      .locator('.request-form .field-hint')
      .first()
      .innerText()
      .catch(() => '(none)')}`,
  );
  await p.getByTestId('request-amount').fill('0.01');
  await p.getByTestId('request-collateral').fill('50');
  await p.getByTestId('request-rate').fill('6.5');
  await p.getByTestId('request-expiry').selectOption('7d');
  await p.waitForTimeout(1500);
  console.log(`--- summary: ${await p.getByTestId('request-summary').innerText()}`);
  await p.screenshot({ path: `${OUT}/live-lend-offer-${label}-form.png`, fullPage: false });
  await p.getByTestId('request-review').click();
  const flow = p.locator('.post-request');
  await flow.locator('.receipt').waitFor({ timeout: 60000 });
  await p.waitForTimeout(6000);
  console.log(`--- review\n${(await flow.innerText()).replace(/\n+/g, '\n')}`);
  console.log(
    'manage link:',
    await p
      .getByTestId('request-manage-link')
      .getAttribute('href')
      .catch(() => null),
  );
  console.log('confirm enabled:', await flow.getByRole('button', { name: 'Confirm in wallet' }).isEnabled());
  await p.screenshot({ path: `${OUT}/live-lend-offer-${label}-review.png`, fullPage: true });
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
