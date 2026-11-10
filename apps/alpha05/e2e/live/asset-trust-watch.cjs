// Watch-only live review of the asset trust tiers and token search (#3446,
// RB-ASSET-TRUST; live tier, run after each deploy), through the shared
// watch-only wallet (watch-wallet.cjs). On Borrow each suggested token is
// picked and its trust line read, so the deployed build is seen reading the
// deployed index's rankings (on the test networks, which the keeper does not
// rank, a test network or test token line; an index that cannot answer is
// stated). Then "Another token…" is searched by a short name and the hits
// printed. Nothing is reviewed or signed. The verdicts themselves are covered
// by the CI-Anvil spec (59-asset-trust.spec.ts).
// Usage: node e2e/live/asset-trust-watch.cjs <address>  (screenshots go to
// $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin; $LIVE_QUERY
// overrides the search text, default "eth")
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const ORIGIN = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/');
const OUT = process.env.LIVE_OUT ?? '/tmp';
const QUERY = process.env.LIVE_QUERY ?? 'eth';

async function run(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(`${ORIGIN}borrow`, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  const leg = p.getByTestId('pick-lending');
  const select = leg.locator('select');
  const options = await select.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  for (const a of options) {
    await select.selectOption(a);
    const trust = leg.getByTestId('asset-trust');
    await trust.waitFor({ timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(3000);
    const kind = (await trust.count()) ? await trust.getAttribute('data-trust') : '(no trust line)';
    const body = (await trust.count()) ? (await trust.innerText()).replace(/\n+/g, ' ') : '';
    console.log(`===== ${label} ${a} [${kind}] ${body}`);
  }
  await select.selectOption('other');
  await leg.getByRole('textbox').fill(QUERY);
  await p.waitForTimeout(4000);
  const search = leg.getByTestId('token-search');
  console.log(`--- search "${QUERY}": ${(await search.count()) ? (await search.innerText()).replace(/\n+/g, ' | ') : '(no search panel)'}`);
  await leg.scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${OUT}/live-asset-trust-${label}.png`, fullPage: false });
  console.log('errors:', JSON.stringify(errs));
  console.log('scrollWidth/innerWidth', await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
  await ctx.close();
}
(async () => {
  const b = await chromium.launch();
  await run(b, { viewport: { width: 1280, height: 900 } }, 'desktop');
  await run(b, { ...devices['Pixel 7'] }, 'phone');
  await b.close();
})();
