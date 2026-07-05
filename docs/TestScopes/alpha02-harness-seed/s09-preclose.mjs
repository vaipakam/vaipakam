// Borrower: Advanced ON → close loan #6 early (precloseDirect).
// Verifies the pulled amount equals calculateRepaymentAmount.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'borrower' });
const { pub } = clientsFor(84532);
const WETH = '0x4200000000000000000000000000000000000006';
const erc20 = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];

// advanced mode for borrower profile
await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Experience level', { timeout: 30000 });
await page.locator('button:has-text("Advanced")').first().click();
await page.waitForTimeout(1500);

const loanId = process.env.LOAN_ID ?? '6';
await page.goto(SITE + '/positions/' + loanId, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await shot('s09-1-loan-advanced');
const b = await page.textContent('body');
console.log('close-early card present:', /close .*early|close early/i.test(b));
console.log('position NFT row present:', /position NFT/i.test(b));
console.log('keeper per-loan card present:', /keeper/i.test(b));

const closeBtn = page.locator('button', { hasText: /close.*early|early.*close/i }).first();
if (!(await closeBtn.isVisible().catch(() => false))) {
  console.log('NO CLOSE-EARLY BUTTON; buttons:', JSON.stringify(await page.locator('button:visible').allTextContents()));
  await done(); process.exit(2);
}
const before = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('borrower')] });
const quote = await pub.readContract({ address: DIAMOND, abi: abiOf('RepayFacet'), functionName: 'calculateRepaymentAmount', args: [BigInt(loanId)] });
console.log('chain quote (calculateRepaymentAmount):', quote);
await closeBtn.click();
await page.waitForTimeout(2500);
await shot('s09-2-preclose-review');
const r = await page.textContent('body');
console.log('review mentions full-term:', /full-term|whole term/i.test(r));
const confirm = page.getByRole('button', { name: /^confirm/i }).first();
let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  await confirm.click();
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/closed early|loan closed|settled/i.test(t)) { console.log(`CLOSED (attempt ${attempt})`); ok = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s09-3-after');
const after = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('borrower')] });
const loan = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [BigInt(loanId)] });
console.log('loan status (1=Repaid):', loan.status, '| pulled:', before - after, '| quote was:', quote);
await done();
