// Watch-only live review of NFT collateral on Borrow (NFT-13; live tier, run
// after each deploy), through the shared watch-only wallet (watch-wallet.cjs).
// It picks a test NFT collection as collateral and checks that the deployed
// build reads its standard from the contract, opens the request form with a
// token-number field, says live what the typed token is (a malformed number,
// a token that does not exist, and, with HELD_ID, a token the watched wallet
// or another wallet holds), and that a review of a token the wallet does not
// hold names the block and offers nothing to sign. The wallet refuses every
// signature, so nothing can be sent. A full post is covered by the CI-Anvil
// spec (10-nft-collateral.spec.ts).
// Usage: node e2e/live/nft-watch.cjs <address> [heldTokenId]  (screenshots
// go to $LIVE_OUT or /tmp; $LIVE_URL overrides the deployed origin)
const { chromium, devices } = require('playwright');
const { watchedPage, connect } = require('./watch-wallet.cjs');
const ADDR = process.argv[2];
const HELD = process.argv[3] ?? null;
const URL = (process.env.LIVE_URL ?? 'https://alpha05.vaipakam.com/').replace(/\/?$/, '/borrow');
const OUT = process.env.LIVE_OUT ?? '/tmp';
const MISSING = '987654321987654321';

async function session(b, opts, label) {
  const { ctx, p, errs } = await watchedPage(b, opts, ADDR);
  await p.goto(URL, { waitUntil: 'networkidle' });
  await connect(p);
  await p.waitForTimeout(4000);
  const lending = p.getByTestId('pick-lending').locator('select');
  const pick = p.getByTestId('pick-collateral');
  const lendOpts = await lending.locator('option').evaluateAll((os) => os.map((o) => o.value).filter((v) => /^0x/.test(v)));
  const nftOpts = await pick.locator('option').evaluateAll((os) => os.filter((o) => /NFT/i.test(o.textContent ?? '') && /^0x/.test(o.value)).map((o) => ({ v: o.value, t: o.textContent })));
  console.log(`===== ${label}: NFT options ${JSON.stringify(nftOpts)}`);
  await lending.selectOption(lendOpts[0]);
  await pick.locator('select').selectOption(nftOpts[0].v);
  const std = pick.locator('[data-asset-standard]');
  await std.waitFor({ timeout: 30000 });
  console.log(`--- standard ${await std.getAttribute('data-asset-standard')}: ${(await std.innerText()).replace(/\n+/g, ' ')}`);
  await p.screenshot({ path: `${OUT}/live-nft-${label}-picker.png`, fullPage: false });
  await p.getByTestId('request-open').click();
  const id = p.getByTestId('request-token-id');
  await id.waitFor({ timeout: 60000 });
  const standing = p.getByTestId('request-token-standing');
  await id.fill('7.5');
  await id.blur();
  await p.waitForTimeout(800);
  console.log('--- malformed:', (await p.locator('.post-request, form, main').first().innerText()).includes('whole digits'));
  for (const [what, value] of [['missing', MISSING], ...(HELD ? [['held', HELD]] : [])]) {
    await id.fill(value);
    await p.waitForTimeout(5000);
    console.log(`--- ${what}: [${await standing.getAttribute('data-tone').catch(() => null)}] ${await standing.innerText().catch(() => '(none)')}`);
  }
  await id.fill(MISSING);
  await p.getByTestId('request-amount').fill('0.01');
  await p.getByTestId('request-rate').fill('6.5');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/live-nft-${label}-form.png`, fullPage: false });
  await p.getByTestId('request-review').click();
  const flow = p.locator('.post-request');
  await flow.waitFor({ timeout: 60000 });
  await p.waitForTimeout(8000);
  console.log(`--- review\n${(await flow.innerText()).replace(/\n+/g, '\n')}`);
  console.log('consent shown:', await flow.getByTestId('request-consent').count());
  console.log('confirm enabled:', await flow.getByRole('button', { name: 'Confirm in wallet' }).isEnabled().catch(() => null));
  await p.screenshot({ path: `${OUT}/live-nft-${label}-review.png`, fullPage: true });
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
