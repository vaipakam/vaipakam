// Lender instant-exits loan #7 by selling the position into New
// Lender's open buy offer #13. Verify lender NFT transfers + payout.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);
const WETH = '0x4200000000000000000000000000000000000006';
const erc20 = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];

// advanced already on for lender; go to loan 7
await page.goto(SITE + '/positions/7', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await shot('s13-1-loan7-lender');
const b = await page.textContent('body');
console.log('early-exit card present:', /early exit|sell.*position|instant exit/i.test(b));
console.log('buttons:', JSON.stringify(await page.locator('button:visible').allTextContents()));

// find the exit action (EarlyExitFlow) — a picker of matching offers
const exitBtn = page.locator('button', { hasText: /sell|exit|early/i }).first();
if (!(await exitBtn.isVisible().catch(() => false))) {
  console.log('NO EXIT CONTROL — sample:', b.replace(/\s+/g, ' ').slice(0, 500));
  await done(); process.exit(2);
}
const before = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('lender')] });
const loanBefore = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [7n] });
console.log('loan7 lender before:', loanBefore.lender);
await exitBtn.click();
await page.waitForTimeout(3000);
await shot('s13-2-exit-picker');
const p2 = await page.textContent('body');
console.log('picker mentions offer #13:', p2.includes('#13'), '| shows a payout figure:', /receive|payout|you.?ll get/i.test(p2));
// choose offer 13 row / first offer
const chooseRow = page.locator('button', { hasText: /choose|select|use this/i }).first();
if (await chooseRow.isVisible().catch(() => false)) { await chooseRow.click(); await page.waitForTimeout(2500); }
await shot('s13-3-exit-review');
// consent + confirm
const consent = page.locator('input[type="checkbox"]:visible').last();
if (await consent.isVisible().catch(() => false)) await consent.click({ force: true });
await page.waitForTimeout(400);
const confirm = page.getByRole('button', { name: /confirm|sell/i }).last();
let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  if (!(await confirm.isVisible().catch(() => false))) break;
  await confirm.click();
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/sold|exited|position sold|complete/i.test(t)) { console.log(`SOLD (attempt ${attempt})`); ok = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s13-4-after');
const after = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('lender')] });
const loanAfter = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [7n] });
console.log('loan7 lender after:', loanAfter.lender, '(newLender =', addressOf('newLender') + ')');
console.log('lender WETH delta:', after - before);
await done();
