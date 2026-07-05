// PR #991 UI drive: newLender lists loan #11 for sale, lender BUYS it
// through the new buy-a-running-loan review on the branch preview.
import { launch, SITE, clientsFor, addressOf } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';
import { parseAbi } from 'viem';

const { pub, wallet } = clientsFor(84532);
const WETH = '0x4200000000000000000000000000000000000006';

const loan0 = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [11n] });
console.log('loan 11 | status:', loan0.status, '| lender:', loan0.lender, '(newLender =', addressOf('newLender') + ')');

// ── Pre-fund the BUYER wallet: needs 0.005 WETH for the purchase ──
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function deposit() payable']);
const buyerBal = await pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [addressOf('lender')] });
if (buyerBal < 6000000000000000n) {
  const h = await wallet('lender').writeContract({ address: WETH, abi: erc20, functionName: 'deposit', value: 6000000000000000n });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log('buyer wrapped 0.006 ETH -> WETH');
}

// ── Step A: SELLER lists via UI ──
{
  const { page, shot, done } = await launch({ role: 'newLender' });
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('alpha02.mode', 'advanced'));
  await page.goto(SITE + '/positions/11', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  let body = await page.textContent('body');
  if (!body.includes('List this position for sale')) {
    console.log('NO SALE CARD for newLender — sample:', body.replace(/\s+/g, ' ').slice(0, 500));
    await done(); process.exit(2);
  }
  const card = page.locator('section,div', { hasText: 'List this position for sale' }).last();
  await card.locator('input:visible').first().fill('10');
  await page.waitForTimeout(500);
  await card.getByRole('button', { name: /review listing/i }).click();
  await page.waitForTimeout(3000);
  const consent = page.locator('input[type="checkbox"]:visible').last();
  if (await consent.isVisible().catch(() => false)) await consent.click({ force: true });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /confirm — list my position|confirm/i }).last().click();
  let listed = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    const t = await page.textContent('body');
    if (t.includes('Position listed')) { listed = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log('listing error banner:', JSON.stringify(err)); break; }
  }
  await shot('991-1-listed');
  console.log('LISTED via UI:', listed);
  await done();
  if (!listed) process.exit(2);
}

// resolve the new sale offer id on-chain (retry for RPC lag)
let saleOfferId = null;
for (let i = 0; i < 10 && saleOfferId === null; i++) {
  await new Promise(r => setTimeout(r, 4000));
  for (let id = 30n; id >= 20n; id--) {
    try {
      const linked = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOfferLinkedLoanId', args: [id] });
      if (linked === 11n) {
        const o = await pub.readContract({ address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOffer', args: [id] });
        if (!o.accepted && o.creator.toLowerCase() === addressOf('newLender').toLowerCase()) { saleOfferId = id; break; }
      }
    } catch {}
  }
}
console.log('sale offer id:', saleOfferId);
if (saleOfferId === null) process.exit(2);

// ── Step B: BUYER drives the new buy review via deep link ──
{
  const { page, shot, done } = await launch({ role: 'lender' });
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await page.goto(`${SITE}/lend?offer=${saleOfferId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  await shot('991-2-buy-review');
  let body = await page.textContent('body');
  console.log('sale banner shown:', body.includes('position sale'));
  console.log('names loan #11:', body.includes('#11'));
  console.log('receipt mentions due-by date:', /due by/i.test(body));
  console.log('OLD block text absent:', !body.includes("can't yet show you the real terms"));
  console.log('seller-not-covered absent:', !body.includes('standing settlement approval'));

  const consent = page.locator('input[type="checkbox"]:visible').first();
  await consent.check();
  await page.waitForTimeout(1000);
  const signBtn = page.locator('button.btn-primary:visible').last();
  console.log('sign button label:', await signBtn.textContent());
  console.log('sign enabled:', await signBtn.isEnabled());
  if (!(await signBtn.isEnabled())) { await shot('991-3-blocked'); await done(); process.exit(2); }

  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    await signBtn.click();
    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(3000);
      const t = await page.textContent('body');
      if (/loan is open|opened|you'?re the lender|done/i.test(t) && page.url().includes('lend')) {
        const doneBanner = await page.locator('h2:visible, .banner-info:visible').allTextContents().catch(() => []);
        if (t.includes('What happens next') || /loan is open/i.test(t)) { opened = true; break; }
      }
      const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
      if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); break; }
    }
  }
  await shot('991-4-after-buy');
  console.log('BUY completed via UI:', opened);
  await done();
}

// ── on-chain verdict ──
for (let i = 0; i < 8; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const loan = await pub.readContract({ address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [11n] });
  if (loan.lender.toLowerCase() === addressOf('lender').toLowerCase()) {
    console.log('ON-CHAIN VERIFIED: loan 11 lender is now', loan.lender, '(the UI buyer). status:', loan.status);
    process.exit(0);
  }
}
console.log('lender handoff not yet observed on-chain');
