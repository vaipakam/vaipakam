// Watch-only live review of the risk-access step (live tier, run after each
// deploy), through the shared watch-only wallet (watch-wallet.cjs). Base
// Sepolia runs with the risk-access gate on, so a wallet at the lowest level
// sees offers whose pair needs a higher one: the list row says a step is
// needed, the review states the block in place, and the step's receipt is
// read. The wallet refuses the signature, so nothing can be sent. A full raise,
// a waiting period and a pair agreement are covered by the CI-Anvil spec
// (09-risk-access.spec.ts); this checks the deployed build against the chain.
// Usage: node e2e/live/risk-watch.cjs <address>  (screenshots go to $LIVE_OUT
// or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/borrow');
const OUT = process.env.LIVE_OUT ?? '/tmp';
const flat = (s) => s.replace(/\n+/g, '\n');

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  const lending = p.getByTestId('pick-lending').locator('select');
  const collateral = p.getByTestId('pick-collateral').locator('select');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const collOpts = await collateral.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  let row = null;
  for (const l of lendOpts) {
    for (const c of collOpts) {
      if (l === c) continue;
      await lending.selectOption(l);
      await collateral.selectOption(c);
      await p.waitForTimeout(6000);
      const r = p.locator('[data-offer-id][data-risk-step="true"]').first();
      if (await r.count()) { row = r; console.log(`===== ${label}: pair ${l} / ${c}`); break; }
    }
    if (row) break;
  }
  if (!row) {
    console.log(`===== ${label}: no listed offer needs a risk-access step for this wallet`);
  } else {
    console.log(`--- row\n${flat(await row.innerText())}`);
    await p.screenshot({ path: `${OUT}/live-risk-${label}-row.png`, fullPage: false });
    await row.getByRole('button', { name: 'Review this offer' }).click();
    const gate = p.locator('.accept-offer').getByTestId('risk-gate');
    await gate.waitFor({ timeout: 60000 });
    await p.waitForTimeout(3000);
    console.log(`--- gate (plan ${await gate.getAttribute('data-risk-plan')})\n${flat(await gate.innerText())}`);
    await gate.scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${OUT}/live-risk-${label}-gate.png`, fullPage: false });
    const open = gate.getByTestId('risk-open');
    if (await open.count()) {
      await open.click();
      const step = p.getByTestId('risk-step');
      await step.locator('.receipt').waitFor({ timeout: 60000 });
      await p.waitForTimeout(2000);
      console.log(`--- receipt\n${flat(await step.locator('.receipt').innerText())}`);
      await step.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${OUT}/live-risk-${label}-receipt.png`, fullPage: false });
      await step.getByRole('button', { name: 'Confirm in wallet' }).click();
      await p.waitForTimeout(8000);
      console.log(`--- after the wallet refused\n${flat(await step.innerText()).slice(0, 600)}`);
    }
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
