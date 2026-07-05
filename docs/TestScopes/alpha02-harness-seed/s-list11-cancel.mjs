// Verify the loan-11 sale listing's NFT lock on-chain, then cancel
// the listing from the pending card and verify the unlock.
import { launch, SITE, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const { pub } = clientsFor(84532);
const loan = await pub.readContract({
  address: DIAMOND, abi: abiOf('LoanFacet'), functionName: 'getLoanDetails', args: [11n],
});
const lockAbi = [...abiOf('VaipakamNFTFacet'), ...abiOf('EncumbranceMutateFacet'), ...abiOf('MetricsFacet')];
const readLock = async () => {
  try {
    return await pub.readContract({
      address: DIAMOND, abi: lockAbi, functionName: 'positionLock', args: [loan.lenderTokenId],
    });
  } catch (e) { return `read failed: ${e.shortMessage ?? e.message}`; }
};
console.log('lock BEFORE cancel:', JSON.stringify(await readLock(), (k, v) => typeof v === 'bigint' ? v.toString() : v));

const { page, shot, done } = await launch({ role: 'lender' });
await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('alpha02.mode', 'advanced'));
await page.goto(SITE + '/positions/11', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

let cancelled = false;
for (let attempt = 1; attempt <= 8 && !cancelled; attempt++) {
  const btn = page.getByRole('button', { name: /cancel listing/i }).first();
  if (!(await btn.isVisible().catch(() => false))) {
    console.log(`attempt ${attempt}: no cancel button visible`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    continue;
  }
  // The card disables Cancel until the 300s chain-time cooldown from
  // offer.createdAt elapses — wait for enabled instead of hard-click.
  if (!(await btn.isEnabled().catch(() => false))) {
    console.log(`attempt ${attempt}: cancel disabled (cooldown) — waiting 45s`);
    await page.waitForTimeout(45_000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    continue;
  }
  await btn.click();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(3000);
    const t = await page.textContent('body');
    if (/listing cancelled/i.test(t)) { cancelled = true; break; }
    if (/cancellation opens a few minutes/i.test(t)) {
      console.log(`attempt ${attempt}: cancel window not open yet — waiting 45s`);
      await page.waitForTimeout(45_000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      break;
    }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(20_000); break; }
  }
}
await shot('list11-5-cancelled');
console.log('CANCELLED:', cancelled);
console.log('lock AFTER cancel:', JSON.stringify(await readLock(), (k, v) => typeof v === 'bigint' ? v.toString() : v));
const o = await pub.readContract({
  address: DIAMOND, abi: abiOf('OfferCancelFacet'), functionName: 'getOffer', args: [19n],
});
console.log('offer 19 after cancel — creator:', o.creator, 'status-ish fields:',
  JSON.stringify({ isActive: o.isActive, active: o.active, cancelled: o.cancelled }, (k, v) => typeof v === 'bigint' ? v.toString() : v));
await done();
