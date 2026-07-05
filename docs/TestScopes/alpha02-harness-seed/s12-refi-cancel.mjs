// Borrower cancels the live refinance request (offer #11 via marker)
// from the pending card; verify offer deleted + approval revoked.
// The cancel cooldown is chain-time gated (~5 min), so wait it out.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'borrower' });
const { pub } = clientsFor(84532);
const erc20 = [{name:'allowance',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'}],outputs:[{type:'uint256'}]}];
const WETH = '0x4200000000000000000000000000000000000006';

await page.goto(SITE + '/positions/7', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await shot('s12-1-pending');
const b = await page.textContent('body');
console.log('pending card present:', /refinance request/i.test(b));
console.log('cancel button present:', await page.getByRole('button', { name: /cancel refinance request/i }).isVisible().catch(() => false));
console.log('cooldown note present:', /cancellation opens/i.test(b));

const cancel = page.getByRole('button', { name: /cancel refinance request/i });
// wait for cooldown if disabled
for (let i = 0; i < 24; i++) {
  if (await cancel.isEnabled().catch(() => false)) break;
  console.log('cancel disabled (cooldown) — wait', i);
  await page.waitForTimeout(20000);
  await page.reload();
  await page.waitForTimeout(5000);
}
console.log('cancel enabled now:', await cancel.isEnabled().catch(() => false));
let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  await cancel.click();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/request cancelled|cancelled and the payoff/i.test(t)) { console.log(`CANCELLED (attempt ${attempt})`); ok = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s12-2-after-cancel');
const o11 = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOffer', args: [11n] });
console.log('offer 11 creator after cancel (zero = deleted):', o11.creator);
console.log('WETH allowance after cancel (0 = revoked):', await pub.readContract({ address: WETH, abi: erc20, functionName: 'allowance', args: [addressOf('borrower'), DIAMOND] }));
await done();
