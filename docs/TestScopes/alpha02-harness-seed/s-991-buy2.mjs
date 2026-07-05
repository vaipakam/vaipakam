// Buyer-only retry: poll the deep link until the indexer ingests the
// sale offer, then drive the buy review to completion.
import { launch, SITE, clientsFor, addressOf } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const SALE_OFFER_ID = process.env.SALE_OFFER_ID ?? '22';
const { pub } = clientsFor(84532);
const { page, shot, done } = await launch({ role: 'lender' });
await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });

let selected = false;
for (let round = 0; round < 10 && !selected; round++) {
  await page.goto(`${SITE}/lend?offer=${SALE_OFFER_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  const t = await page.textContent('body');
  if (!t.includes("couldn’t find that offer") && !t.includes("couldn't find that offer")) { selected = true; break; }
  console.log(`round ${round + 1}: indexer still catching up — waiting 45s`);
  await page.waitForTimeout(45000);
}
if (!selected) { console.log('offer never appeared in the indexer'); await shot('991-r-timeout'); await done(); process.exit(2); }

await shot('991-5-buy-review');
let body = await page.textContent('body');
console.log('sale banner shown:', body.includes('position sale'));
console.log('names loan #11:', body.includes('#11'));
console.log('due-by date shown:', /due by/i.test(body));
console.log('remaining-interest wording:', body.includes('from now to the due date'));
console.log('OLD block text absent:', !body.includes("can't yet show you the real terms"));

const consent = page.locator('input[type="checkbox"]:visible').first();
await consent.check();
await page.waitForTimeout(1000);
const signBtn = page.getByRole('button', { name: /fund this borrower/i }).first();
console.log('sign label:', (await signBtn.textContent())?.trim(), '| enabled:', await signBtn.isEnabled());
if (!(await signBtn.isEnabled())) { await shot('991-6-blocked'); await done(); process.exit(2); }

let opened = false;
for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
  await signBtn.click();
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(3000);
    const t = await page.textContent('body');
    if (/what happens next|loan is open/i.test(t)) { opened = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); break; }
  }
}
await shot('991-7-after-buy');
console.log('BUY completed via UI:', opened);
await done();

for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const loan = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [11n] });
  if (loan.lender.toLowerCase() === addressOf('lender').toLowerCase()) {
    console.log('ON-CHAIN VERIFIED: loan 11 lender ->', loan.lender, '(UI buyer). status:', loan.status);
    process.exit(0);
  }
}
console.log('handoff not yet observed');
