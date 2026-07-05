// Drive the newly-enabled LoanSaleFlow end-to-end on the branch
// preview: lender lists loan #11 at its own rate, verify the pending
// card + the on-chain sale offer + the lender-NFT lock.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);

const loan = await pub.readContract({
  address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [11n],
});
console.log('loan 11 status:', loan.status, 'rateBps:', loan.interestRateBps);

// Advanced mode is per-origin localStorage — the branch preview is a
// fresh origin, so set it before the app boots.
await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('alpha02.mode', 'advanced'));
await page.goto(SITE + '/positions/11', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
await shot('list11-1-page');
let body = await page.textContent('body');
console.log('sale card present:', body.includes('List this position for sale'));
console.log('gated-off note present (should be FALSE):',
  body.includes('isn’t available yet'));

if (!body.includes('List this position for sale')) {
  console.log('NO SALE CARD — sample:', body.replace(/\s+/g, ' ').slice(0, 600));
  await done(); process.exit(2);
}

// Rate input inside the sale card — type the loan's own rate in %.
const pct = (Number(loan.interestRateBps) / 100).toString();
const card = page.locator('section,div', { hasText: 'List this position for sale' }).last();
const rate = card.locator('input:visible').first();
await rate.fill(pct);
await page.waitForTimeout(500);
await card.getByRole('button', { name: /review listing/i }).click();
await page.waitForTimeout(3000);
await shot('list11-2-review');
body = await page.textContent('body');
console.log('lock disclosure shown:', body.includes('locks your lender position NFT'));
console.log('approval note shown:', /standing approval of up to/i.test(body));

// Consent checkbox gates the confirm button.
const consent = page.locator('input[type="checkbox"]:visible').last();
if (await consent.isVisible().catch(() => false)) await consent.click({ force: true });
await page.waitForTimeout(500);
const confirm = page.getByRole('button', { name: /confirm — list my position|confirm/i }).last();
await confirm.click();
let listed = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(3000);
  const t = await page.textContent('body');
  if (t.includes('Position listed')) { listed = true; break; }
  const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
  if (err.length) { console.log('error banner:', JSON.stringify(err)); break; }
}
await shot('list11-3-after');
console.log('LISTED:', listed);

// Reload → pending card with the offer id.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
await shot('list11-4-pending');
body = await page.textContent('body');
const m = body.match(/Sale listing #(\d+) is live/);
console.log('pending card:', m ? m[0] : '(not found)');

// On-chain: offer record + lender NFT lock.
if (m) {
  const offerId = BigInt(m[1]);
  const o = await pub.readContract({
    address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOffer', args: [offerId],
  });
  console.log('on-chain offer', m[1], '| creator:', o.creator,
    '| lender wallet:', addressOf('lender'),
    '| rateBps:', o.interestRateBps, '| active:', o.isActive ?? o.active ?? '(?)');
}
try {
  const lock = await pub.readContract({
    address: DIAMOND, abi: abiOf('VaipakamNFTFacet'), functionName: 'getTokenLock', args: [loan.lenderTokenId],
  });
  console.log('lender NFT lock:', JSON.stringify(lock, (k, v) => typeof v === 'bigint' ? v.toString() : v));
} catch (e) { console.log('lock read n/a:', e.shortMessage ?? e.message); }
await done();
