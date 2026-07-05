import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'borrower' });
const { pub } = clientsFor(84532);

await page.goto(SITE + '/positions/7', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
await page.locator('input[aria-label="Highest yearly rate you’d accept"]').fill('9');
await page.locator('input[aria-label="New loan length (days)"]').fill('30');
await page.waitForTimeout(500);
await page.getByRole('button', { name: /review refinance request/i }).click();
await page.waitForTimeout(2500);
await shot('s10-2-refi-review');
const r = await page.textContent('body');
console.log('review mentions payoff/full remaining interest:', /full remaining|payoff|full-term/i.test(r));
console.log('review mentions guardrails/expiry:', /guardrail|expir/i.test(r));
// consent + submit (multi-tx)
const consent = page.locator('input[type="checkbox"]:visible').last();
await consent.click({ force: true });
await page.waitForTimeout(400);
const postSel = () => page.getByRole('button', { name: /post refinance request|request refinancing|confirm — post/i }).last();
console.log('submit label:', (await postSel().textContent())?.trim(), 'enabled:', await postSel().isEnabled());
let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  if (!(await postSel().isVisible().catch(() => false))) { console.log('submit button gone (attempt', attempt, ')'); break; }
  await postSel().click();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/request .*is live|refinance request #\d+/i.test(t)) { console.log(`REQUEST LIVE (attempt ${attempt})`); ok = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s10-3-pending');
const t2 = await page.textContent('body');
console.log('pending card banner:', /refinance request #\d+ is live/i.test(t2) || /request #\d+/i.test(t2));
console.log('cancel affordance mentioned:', /cancel refinance request|cancellation opens/i.test(t2));

// on-chain verification
const caps = await pub.readContract({ address: DIAMOND, abi: abiOf('AutoLifecycleFacet'), functionName: 'getAutoRefinanceCaps', args: [7n] }).catch(() => null);
console.log('caps:', caps ? fmt(caps) : 'read failed');
const erc20 = [{name:'allowance',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'}],outputs:[{type:'uint256'}]}];
console.log('payoff allowance:', await pub.readContract({ address: '0x4200000000000000000000000000000000000006', abi: erc20, functionName: 'allowance', args: [addressOf('borrower'), DIAMOND] }));
await done();
