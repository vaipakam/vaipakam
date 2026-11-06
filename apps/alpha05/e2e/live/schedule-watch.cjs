// Watch-only live review of a borrow request's interest schedule and Full
// fee tariff in Advanced mode (live tier, run after each deploy), through the
// shared watch-only wallet (watch-wallet.cjs). The form asks the protocol on
// Base Sepolia which schedules the typed terms admit and whether the tariff
// is switched on; the first open finer schedule is chosen, the tariff is
// opted into when the switch is on, and the review is read. The wallet
// refuses every signature, so nothing can be sent. Full posts are covered by
// the CI-Anvil specs (13-request-cadence, 14-request-tariff); this checks the
// deployed build against the live protocol.
// Usage: node e2e/live/schedule-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_AMOUNT
// overrides the principal typed, default 1)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/borrow');
const OUT = process.env.LIVE_OUT ?? '/tmp';
const AMOUNT = process.env.LIVE_AMOUNT ?? '1';

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
  await p.getByTestId('request-amount').fill(AMOUNT);
  await p.getByTestId('request-collateral').fill('5000');
  await p.getByTestId('request-rate').fill('6.5');
  // A 90-day loan: a monthly schedule fits inside it, a quarterly one does
  // not, so both an open and a closed schedule are read.
  const durations = p.getByTestId('request-duration');
  console.log(`--- terms: ${(await durations.innerText()).replace(/\n+/g, ' | ')}`);
  await durations.getByRole('radio', { name: /^90 days/ }).check();
  await p.waitForTimeout(6000);
  const cadence = p.getByTestId('request-cadence');
  console.log(`--- schedules\n${(await cadence.innerText()).replace(/\n+/g, '\n')}`);
  const radios = cadence.getByRole('radio');
  for (let i = 1; i < (await radios.count()); i++) {
    if (await radios.nth(i).isEnabled()) {
      await radios.nth(i).check();
      console.log('chose schedule', i);
      break;
    }
  }
  const tariff = p.getByTestId('request-tariff');
  if ((await tariff.count()) > 0) {
    const opt = p.getByTestId('request-tariff-opt');
    if (await opt.isEnabled()) {
      await opt.check();
      await p.waitForTimeout(4000);
    }
    console.log(`--- tariff\n${(await tariff.innerText()).replace(/\n+/g, '\n')}`);
    console.log(`--- backstop: ${await p.getByTestId('request-backstop').innerText()}`);
  } else {
    console.log('--- tariff: not in this build');
  }
  console.log(
    `--- summary: ${await p
      .getByTestId('request-summary')
      .innerText()
      .catch(() => '(none)')}`,
  );
  await cadence.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/live-schedule-${label}-form.png`, fullPage: false });
  if ((await tariff.count()) > 0) {
    await tariff.scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${OUT}/live-tariff-${label}-form.png`, fullPage: false });
  }
  await p.getByTestId('request-review').click();
  const flow = p.locator('.post-request');
  await flow.locator('.receipt').waitFor({ timeout: 60000 });
  await p.waitForTimeout(8000);
  console.log(`--- review\n${(await flow.innerText()).replace(/\n+/g, '\n')}`);
  console.log(
    'confirm enabled:',
    await flow
      .getByRole('button', { name: 'Confirm in wallet' })
      .isEnabled()
      .catch(() => false),
  );
  await p.screenshot({ path: `${OUT}/live-schedule-${label}-review.png`, fullPage: true });
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
