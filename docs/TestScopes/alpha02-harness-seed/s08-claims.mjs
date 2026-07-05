// Post-repay claims: borrower reclaims collateral, lender collects
// principal + interest. Chain-verified balances before/after.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const role = process.env.ROLE;
const { page, shot, done } = await launch({ role });
const { pub } = clientsFor(84532);
const erc20 = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];
const tCOL = '0xf2c65cd941fe681b575adc8dfc155bf612675037';
const WETH = '0x4200000000000000000000000000000000000006';
const token = role === 'borrower' ? tCOL : WETH;
const before = await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [addressOf(role)] });
console.log(role, 'balance before:', before);

await page.goto(SITE + '/claims', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await shot(`s08-${role}-claims`);
const c = await page.textContent('body');
console.log('claims page mentions loan #5:', c.includes('#5'), '| nothing-to-claim?', /nothing to claim/i.test(c));
// The row is a LINK to the position page; the real claim button is
// there (Claim Center = index, PositionDetails = action surface).
const row = page.locator('a.item-row', { hasText: 'Loan #5' }).first();
if (!(await row.isVisible().catch(() => false))) {
  console.log('NO CLAIM ROW — sample:', c.replace(/\s+/g, ' ').slice(0, 350));
  await done();
  process.exit(2);
}
await row.click();
await page.waitForTimeout(4500);
await shot(`s08-${role}-position`);
const claimBtn = page.locator('button', { hasText: /claim/i }).first();
console.log('claim button on position page:', await claimBtn.isVisible().catch(() => false), '|', (await claimBtn.textContent().catch(() => ''))?.trim());
await claimBtn.click();
await page.waitForTimeout(1200);
await shot(`s08-${role}-receipt`);
const confirm2 = page.getByRole('button', { name: /^confirm/i }).first();
console.log('confirm visible:', await confirm2.isVisible().catch(() => false));
await confirm2.click();
let after = before;
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000);
  after = await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [addressOf(role)] });
  if (after > before) { console.log('CLAIMED at ~', i * 2, 's — delta:', after - before); break; }
  const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
  if (err.length) { console.log('CLAIM ERROR:', JSON.stringify(err)); break; }
}
await shot(`s08-${role}-after`);
console.log(role, 'balance after:', after);
await done();
