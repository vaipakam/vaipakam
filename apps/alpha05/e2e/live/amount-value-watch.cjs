// Watch-only live review of the numeraire equivalent beside typed amounts
// (RB-CLICKS, #3225; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs): on Borrow, the request form is filled
// for each pair the page suggests and the value line under the amount and
// the collateral is read (a figure for a priced asset, "no price" for an
// unpriced one); then, if any lender offer is takeable, its review is opened
// and the two value rows read. The wallet refuses every signature, so
// nothing can be sent. The figures are checked against the chain by the
// CI-Anvil spec (55-amount-value.spec.ts); this checks the deployed build
// against Base Sepolia.
// Usage: node e2e/live/amount-value-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/borrow');
const OUT = process.env.LIVE_OUT ?? '/tmp';

async function line(p, id) {
  const el = p.getByTestId(id);
  if ((await el.count()) === 0) return '(none)';
  return `[${await el.getAttribute('data-equivalent')}] ${await el.innerText()}`;
}

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
  for (const c of collOpts.filter((v) => v !== l)) {
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2000);
    await lending.selectOption(l);
    await collateral.selectOption(c);
    console.log(`===== ${label}: pair ${l} / ${c}`);
    await p.getByTestId('request-open').click();
    await p.getByTestId('request-duration').getByRole('radio').first().waitFor({ timeout: 60000 });
    await p.getByTestId('request-amount').fill('0.01');
    // An NFT collateral has no typed amount, so it has no value line.
    const coll = p.getByTestId('request-collateral');
    if (await coll.isVisible().catch(() => false)) await coll.fill('50');
    await p.waitForTimeout(8000);
    console.log(`--- amount: ${await line(p, 'request-amount-value')}`);
    console.log(`--- collateral: ${await line(p, 'request-collateral-value')}`);
    await p.screenshot({ path: `${OUT}/live-amount-value-${label}-${c.slice(2, 8)}.png`, fullPage: false });
  }
  // A takeable lender offer's review, when the book has one for the pair.
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(6000);
  const take = p.getByRole('region', { name: 'Offers you can take' }).locator('[data-takeable="true"]').first();
  if ((await take.count()) > 0) {
    await take.getByRole('button', { name: 'Take this offer' }).click();
    const receipt = p.locator('.accept-offer .receipt');
    await receipt.waitFor({ timeout: 60000 });
    const rows = (await receipt.innerText()).split('\n').filter((t, i, all) => /value now/.test(t) || /value now/.test(all[i - 1] ?? ''));
    console.log(`--- review value rows: ${rows.join(' · ')}`);
  } else console.log('--- no takeable offer for the suggested pair, review not read');
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
