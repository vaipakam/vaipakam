// Borrower opens loan #5 in My positions and repays in full; then the
// borrower claims collateral back from Claims. Chain-verified.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done, consoleErrors } = await launch({ role: 'borrower' });
const { pub } = clientsFor(84532);
const loanAbi = abiOf('LoanFacet');

await page.goto(SITE + '/positions', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await shot('s06-1-positions');
const body = await page.textContent('body');
console.log('positions shows a loan row:', /loan/i.test(body), '| mentions WETH:', body.includes('WETH'));

// open the loan detail (row link → /positions/5)
await page.goto(SITE + '/positions/5', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await shot('s06-2-loan5');
const d = await page.textContent('body');
console.log('detail shows due:', /due|repay/i.test(d));
console.log('shows full-term interest note:', /full-term/i.test(d));
console.log('shows borrower NFT id row:', d.includes('#12') || /position NFT/i.test(d));

// repay: the primary action button
const repayBtn = page.getByRole('button', { name: /^repay/i }).first();
console.log('repay button visible:', await repayBtn.isVisible().catch(() => false));
await repayBtn.click();
await page.waitForTimeout(1500);
await shot('s06-3-repay-review');
// ConfirmReceipt appears (one-confirm-surface) → confirm
const confirm = page.getByRole('button', { name: /confirm/i }).first();
if (await confirm.isVisible().catch(() => false)) {
  await confirm.click();
}
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  const t = await page.textContent('body');
  if (/repayment confirmed/i.test(t)) { console.log('REPAID at', i * 2, 's'); break; }
  const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
  if (err.length) { console.log('ERROR BANNER:', JSON.stringify(err)); break; }
}
await shot('s06-4-after-repay');
const loan = await pub.readContract({ address: DIAMOND, abi: loanAbi, functionName: 'getLoanDetails', args: [5n] });
console.log('loan status on-chain (1=Repaid):', loan.status);

// claims: borrower reclaims collateral
await page.goto(SITE + '/claims', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await shot('s06-5-claims');
const c = await page.textContent('body');
console.log('claims mentions collateral/tCOL:', /tCOL|collateral/i.test(c));
const claimBtn = page.getByRole('button', { name: /^claim/i }).first();
if (await claimBtn.isVisible().catch(() => false)) {
  await claimBtn.click();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/claimed|collected|is ready|in your wallet|complete/i.test(t) && !(await claimBtn.isVisible().catch(() => false))) { console.log('CLAIM done ~', i * 2, 's'); break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log('CLAIM ERROR:', JSON.stringify(err)); break; }
  }
  await shot('s06-6-claimed');
} else {
  console.log('no claim button yet (indexer lag?) — body sample:', c.replace(/\s+/g, ' ').slice(0, 300));
}
// chain: borrower tCOL back in wallet? (claims go to wallet or vault — check both)
const erc20 = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];
console.log('borrower wallet tCOL:', await pub.readContract({ address: '0xf2c65cd941fe681b575adc8dfc155bf612675037', abi: erc20, functionName: 'balanceOf', args: [addressOf('borrower')] }));
console.log('console errors:', JSON.stringify(consoleErrors.filter((e) => !/Analytics/.test(e)).slice(0, 5)));
await done();
