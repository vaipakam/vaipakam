// Watch-only live review of the Borrow page's two ways and rate ladder
// (#3319; live tier, run after each deploy), through the shared watch-only
// wallet (watch-wallet.cjs): for each pair the page suggests, the two ways
// are read, the standing-lenders line is read (lenders ready, none, or
// unread), the ladder's steps are listed with their heads, and a highest
// rate of 0% is typed to read the "hidden" count. The wallet refuses every
// signature, so nothing can be sent. The figures are checked against the
// chain by the CI-Anvil spec (56-borrow-ways.spec.ts); this checks the
// deployed build against Base Sepolia.
// Usage: node e2e/live/borrow-ways-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/borrow');
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
  for (const c of collOpts.filter((v) => v !== l)) {
    await lending.selectOption(l);
    await collateral.selectOption(c);
    console.log(`===== ${label}: pair ${l} / ${c}`);
    const ways = p.getByRole('region', { name: 'Two ways to borrow' });
    await ways.waitFor({ timeout: 60000 });
    await p.waitForTimeout(8000);
    console.log(`--- ways: ${(await ways.locator('h3').allInnerTexts()).join(' | ')}`);
    console.log(`--- standing: ${(await ways.getByTestId('standing-lenders').innerText()).replace(/\n/g, ' ')}`);
    const offers = p.getByRole('region', { name: 'Offers you can take' });
    const heads = await offers.locator('.ladder-head').allInnerTexts();
    console.log(`--- ladder (${heads.length} steps): ${heads.join(' / ') || '(no open offer)'}`);
    const limit = offers.getByTestId('limit-rate');
    if ((await limit.count()) > 0) {
      await limit.fill('0');
      await p.waitForTimeout(500);
      const hidden = offers.getByTestId('hidden-rate');
      console.log(`--- limit 0%: ${(await hidden.count()) > 0 ? await hidden.innerText() : '(nothing hidden)'}`);
      await limit.fill('');
    }
    await p.screenshot({ path: `${OUT}/live-borrow-ways-${label}-${c.slice(2, 8)}.png`, fullPage: true });
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
