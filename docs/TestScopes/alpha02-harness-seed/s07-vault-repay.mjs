// Borrower: withdraw the borrowed WETH from the vault via the UI,
// then repay loan #5, then claim collateral. Chain-verified.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'borrower' });
const { pub } = clientsFor(84532);
const WETH = '0x4200000000000000000000000000000000000006';
const erc20 = [{name:'balanceOf',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];

// 1. Vault page — see the WETH, withdraw 0.005 to wallet.
await page.goto(SITE + '/vault', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await shot('s07-1-vault');
const v = await page.textContent('body');
console.log('vault shows WETH:', v.includes('WETH'), '| shows 0.005:', v.includes('0.005'));
const wd = page.getByRole('button', { name: /withdraw/i }).first();
if (await wd.isVisible().catch(() => false)) {
  await wd.click();
  await page.waitForTimeout(1200);
  await shot('s07-2-withdraw-form');
  // amount input if any
  const amt = page.locator('input[inputmode="decimal"]:visible, input[placeholder="0.0"]:visible').first();
  if (await amt.isVisible().catch(() => false)) await amt.fill('0.005');
  const go = page.getByRole('button', { name: /confirm|withdraw/i }).last();
  await go.click();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const bal = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('borrower')] });
    if (bal >= 6000000000000000n - 100n) { console.log('WITHDRAWN — wallet WETH:', bal, 'at', i*2, 's'); break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log('WITHDRAW ERROR:', JSON.stringify(err)); break; }
  }
  await shot('s07-3-withdrawn');
} else {
  console.log('NO WITHDRAW CONTROL — body:', v.replace(/\s+/g, ' ').slice(0, 400));
}

// 2. Repay loan #5.
await page.goto(SITE + '/positions/5', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.getByRole('button', { name: /^repay/i }).first().click();
await page.waitForTimeout(1500);
await shot('s07-4-repay-review');
const rr = await page.textContent('body');
console.log('repay review shows full-term note:', /full-term|whole term/i.test(rr));
const confirm = page.getByRole('button', { name: /confirm/i }).first();
if (await confirm.isVisible().catch(() => false)) await confirm.click();
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  const t = await page.textContent('body');
  if (/repayment confirmed/i.test(t)) { console.log('REPAID at', i*2, 's'); break; }
  const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
  if (err.length) { console.log('REPAY ERROR:', JSON.stringify(err)); break; }
}
const loan = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [5n] });
console.log('loan #5 status on-chain (1=Repaid):', loan.status);
await shot('s07-5-after-repay');
await done();
