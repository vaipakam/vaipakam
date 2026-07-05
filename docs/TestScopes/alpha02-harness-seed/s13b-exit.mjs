import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';
const { page, shot, done } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);
const WETH = '0x4200000000000000000000000000000000000006';
const erc20 = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];

await page.goto(SITE + '/positions/7', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
// select offer #14 candidate row (it's a button)
const offerRow = page.locator('button', { hasText: /Offer #14/i }).first();
console.log('offer #14 row visible:', await offerRow.isVisible().catch(() => false));
const before = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('lender')] });
await offerRow.click();
await page.waitForTimeout(1000);
await page.getByRole('button', { name: /review exit/i }).click();
await page.waitForTimeout(2500);
await shot('s13b-1-review');
const r = await page.textContent('body');
console.log('review shows receive figure:', /receive/i.test(r), '| consent checkbox:', await page.locator('input[type="checkbox"]:visible').count());
const consent = page.locator('input[type="checkbox"]:visible').last();
if (await consent.isVisible().catch(() => false)) await consent.click({ force: true });
await page.waitForTimeout(400);
const confirm = page.getByRole('button', { name: /confirm|sell/i }).last();
console.log('confirm label:', (await confirm.textContent().catch(()=>''))?.trim());
let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  if (!(await confirm.isVisible().catch(()=>false))) break;
  await confirm.click();
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/sold|exited|position sold|no longer this loan|complete/i.test(t)) { console.log(`SOLD (attempt ${attempt})`); ok = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(()=>[]);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s13b-2-after');
const after = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('lender')] });
const loan = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [7n] });
console.log('loan7 lender after:', loan.lender);
console.log('newLender is:', addressOf('newLender'));
console.log('lender WETH delta:', after - before);
await done();
