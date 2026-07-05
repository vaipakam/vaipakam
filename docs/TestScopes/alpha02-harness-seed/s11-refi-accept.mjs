// New Lender funds the refinance request (offer #11) from the Lend
// page. Completes the atomic refinance; verify old loan 7 closes and
// a new loan opens with newLender as lender.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'newLender' });
const { pub } = clientsFor(84532);

// connect fresh profile
await page.goto(SITE + '/lend', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const connectBtn = page.getByRole('button', { name: /^connect wallet$/i }).first();
if (await connectBtn.isVisible().catch(() => false)) {
  await connectBtn.click();
  await page.waitForTimeout(1500);
  for (const name of [/vaipakam test wallet/i, /metamask/i, /browser/i, /injected/i]) {
    const opt = page.getByRole('button', { name }).first();
    if (await opt.isVisible().catch(() => false)) { await opt.click(); break; }
  }
  await page.waitForTimeout(3000);
}
// details: WETH 0.005
await page.locator('select').first().selectOption({ index: 1 });
await page.locator('input[placeholder="0.0"]').fill('0.005');
await page.getByRole('button', { name: /see matching offers/i }).click();
await page.waitForTimeout(4000);
await shot('s11-1-matches');
const b = await page.textContent('body');
console.log('match list mentions #11:', b.includes('#12'), '| mentions 9%:', b.includes('9%'));
const row12 = page.locator('.item-row', { hasText: '#12' }).first();
const choose = (await row12.isVisible().catch(() => false))
  ? row12.locator('button', { hasText: /choose/i }).first()
  : page.getByRole('button', { name: /^choose$/i }).first();
if (!(await choose.isVisible().catch(() => false))) {
  console.log('NO MATCH — sample:', b.replace(/\s+/g, ' ').slice(0, 400));
  await done(); process.exit(2);
}
await choose.click();
await page.waitForTimeout(4000);
await shot('s11-2-review');
const r = await page.textContent('body');
// this is a refinance vehicle — the app treats it as a normal fund; should NOT be blocked (linkedLoanId is 0)
console.log('review blocked banner present:', /already-running loan/i.test(r));
console.log('sign enabled path — consent checkbox:', await page.locator('input[type="checkbox"]:visible').first().isVisible().catch(() => false));
await page.locator('input[type="checkbox"]:visible').first().check();
await page.waitForTimeout(400);
const fund = page.getByRole('button', { name: /fund this borrower/i });
console.log('fund enabled:', await fund.isEnabled().catch(() => false));
let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  await fund.click();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/loan opened/i.test(t)) { console.log(`FUNDED (attempt ${attempt})`); ok = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s11-3-done');

// chain: old loan 7 should be closed (Repaid), new loan opened w/ newLender
const loan7 = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [7n] });
console.log('loan 7 status (should be 1/Repaid after refinance):', loan7.status);
const acc = abiOf('OfferAcceptFacet').find((e) => e.type === 'event' && e.name === 'OfferAccepted');
import('./verify.mjs').then(async ({ scanLogs }) => {
  const alogs = await scanLogs(84532, { event: acc, blocks: 800n });
  for (const l of alogs) console.log('OfferAccepted offer', l.args.offerId, 'loan', l.args.loanId, 'acceptor', l.args.acceptor);
  const newLoanId = alogs.find((l) => l.args.offerId === 12n)?.args.loanId;
  if (newLoanId) {
    const nl = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [newLoanId] });
    console.log('NEW loan', newLoanId, fmt({ status: nl.status, lender: nl.lender, borrower: nl.borrower, principal: nl.principal, rate: nl.interestRateBps, collateralAsset: nl.collateralAsset, collateralAmount: nl.collateralAmount }));
  }
  await done();
});
