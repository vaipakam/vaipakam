// Lender posts a LIQUID lending offer: lend WETH, require tLIQ collateral
// (tLIQ now classifies Liquid via the oracle mocks). Verifies the review
// screen no longer shows the illiquid warning, and records the offerId.
import fs from 'node:fs';
import { parseAbiItem } from 'viem';
import { launch, SITE, clientsFor } from './driver.mjs';

const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const tLIQ = '0x9d2a1acF65Ed12716Ca67Beb7D108890ccDa49f8';
const { page, shot, done, consoleErrors } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);
const startBlock = await pub.getBlockNumber();
const log = (...a) => console.log('[liq-offer]', ...a);

await page.goto(SITE + '/lend', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await shot('liq-offer-1-lend');

// Connect
const cbtn = page.getByRole('button', { name: /connect/i }).first();
if (await cbtn.isVisible().catch(() => false)) {
  await cbtn.click();
  await page.waitForTimeout(1500);
  for (const name of [/vaipakam test wallet/i, /metamask/i, /browser wallet/i, /injected/i]) {
    const opt = page.getByRole('button', { name }).first();
    if (await opt.isVisible().catch(() => false)) { await opt.click(); break; }
  }
  await page.waitForTimeout(3000);
}
await shot('liq-offer-2-connected');

// details: pick WETH principal, amount 0.005
await page.locator('select').first().selectOption({ index: 1 }).catch(() => log('principal select failed'));
await page.locator('input[placeholder="0.0"]').first().fill('0.005').catch(() => log('amount fill failed'));
const seeBtn = page.getByRole('button', { name: /see matching offers/i });
if (await seeBtn.isVisible().catch(() => false)) { await seeBtn.click(); await page.waitForTimeout(2500); }
const postOwn = page.getByRole('button', { name: /post my own lending offer/i });
if (await postOwn.isVisible().catch(() => false)) { await postOwn.click(); await page.waitForTimeout(1200); }
await shot('liq-offer-3-terms');

// terms: rate, collateral = paste tLIQ, collateral amount 1
await page.locator('input[placeholder="5"]').fill('10').catch(() => log('rate fill failed'));
const colSelect = page.locator('select:visible').first();
// find the "paste address" option index by label
const opts = await colSelect.locator('option').allTextContents().catch(() => []);
log('collateral options:', JSON.stringify(opts));
const pasteIdx = opts.findIndex((o) => /paste/i.test(o));
await colSelect.selectOption({ index: pasteIdx >= 0 ? pasteIdx : opts.length - 1 }).catch(() => log('col select failed'));
await page.waitForTimeout(700);
await page.locator('input[placeholder="0x…"]').fill(tLIQ).catch(() => log('paste addr failed'));
await page.waitForTimeout(1800);
await page.locator('input[placeholder="0.0"]:visible').last().fill('1').catch(() => log('col amount failed'));
await page.waitForTimeout(1000);
await shot('liq-offer-4-filled');
const contBtn = page.getByRole('button', { name: /continue to review/i });
await contBtn.click().catch(() => log('continue failed'));
await page.waitForTimeout(4000);
await shot('liq-offer-5-review');
const rbody = await page.textContent('body');
log('FINDING review shows illiquid warning (expect FALSE for tLIQ):', /isn.t priced by the protocol|illiquid/i.test(rbody));
log('review mentions health factor:', /health factor|HF/i.test(rbody));

// consent + post
const consent = page.locator('input[type="checkbox"]:visible').first();
await consent.check().catch(() => log('consent failed'));
await page.waitForTimeout(400);
const post = page.getByRole('button', { name: /post lending offer/i });
log('post enabled:', await post.isEnabled().catch(() => false));
await post.click().catch(() => log('post click failed'));
let doneOk = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2000);
  const t = await page.textContent('body');
  if (/lending offer posted|offer posted/i.test(t)) { doneOk = true; log('DONE at', i * 2, 's'); break; }
}
await shot('liq-offer-6-done');

const logs = await pub.getLogs({
  address: DIAMOND,
  event: parseAbiItem('event OfferCreated(uint256 indexed offerId, address indexed creator, uint8 offerType, address lendingAsset, uint256 amount, uint256 interestRateBps, uint256 durationDays)'),
  fromBlock: startBlock,
}).catch(() => []);
if (logs.length) {
  const oid = String(logs.at(-1).args.offerId);
  log('OfferCreated id', oid);
  fs.writeFileSync('state-liq-offer.json', JSON.stringify({ offerId: oid }));
} else log('no OfferCreated log found; doneOk=', doneOk);
log('console errors:', JSON.stringify(consoleErrors.slice(0, 6)));
await done();
