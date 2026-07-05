// Lender posts a WETH lending offer (tCOL collateral) end-to-end,
// then verifies the offer on-chain from the OfferCreated log.
import fs from 'node:fs';
import { parseAbiItem } from 'viem';
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';

const mocks = JSON.parse(fs.readFileSync('mocks-84532.json', 'utf8'));
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const { page, shot, done, consoleErrors } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);
const startBlock = await pub.getBlockNumber();

await page.goto(SITE + '/lend', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// details
await page.locator('select').first().selectOption({ index: 1 }); // WETH
await page.locator('input[placeholder="0.0"]').fill('0.005');
await page.getByRole('button', { name: /see matching offers/i }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /post my own lending offer/i }).click();
await page.waitForTimeout(1200);

// terms: rate input (placeholder 5), collateral select → paste tCOL, collateral amount
await page.locator('input[placeholder="5"]').fill(process.env.RATE ?? '10');
const colSelect = page.locator('select:visible').first();
await colSelect.selectOption({ index: 3 }); // Paste a token address…
await page.waitForTimeout(600);
// the paste-address input appears with placeholder "0x…"
await page.locator('input[placeholder="0x…"]').fill(mocks.tCOL);
await page.waitForTimeout(1500);
// collateral amount keeps the 0.0 placeholder
await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
await page.waitForTimeout(800);
await shot('s02-4-terms-filled');
await page.getByRole('button', { name: /continue to review/i }).click();
await page.waitForTimeout(3500);
await shot('s02-5-review');
const body = await page.textContent('body');
console.log('review shows illiquid warning:', /isn.t priced by the protocol/i.test(body));
console.log('review shows grace:', /grace period/i.test(body));

// consent + sign
const consent = page.locator('input[type="checkbox"]:visible').first();
await consent.check();
await page.waitForTimeout(400);
const post = page.getByRole('button', { name: /post lending offer/i });
console.log('post enabled:', await post.isEnabled());
await post.click();
// approval tx + createOffer tx fire through the shim; wait for done screen
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(2000);
  const t = await page.textContent('body');
  if (/lending offer posted/i.test(t)) { console.log('DONE SCREEN at', i * 2, 's'); break; }
  if (i === 39) console.log('no done screen; body tail:', t.slice(-400));
}
await shot('s02-6-done');

// on-chain verification
const logs = await pub.getLogs({
  address: DIAMOND,
  event: parseAbiItem('event OfferCreated(uint256 indexed offerId, address indexed creator, uint8 offerType, address lendingAsset, uint256 amount, uint256 interestRateBps, uint256 durationDays)'),
  fromBlock: startBlock,
}).catch((e) => { console.log('log query failed with 7-arg shape:', e.shortMessage ?? e.message); return []; });
if (logs.length) {
  for (const l of logs) console.log('OfferCreated:', l.args.offerId, 'creator', l.args.creator);
  fs.writeFileSync('state-offer.json', JSON.stringify({ offerId: String(logs.at(-1).args.offerId) }));
} else {
  // fallback: unknown event shape — scan raw logs from diamond
  const raw = await pub.getLogs({ address: DIAMOND, fromBlock: startBlock });
  console.log('raw diamond logs since start:', raw.length, raw.map((r) => r.topics[0].slice(0, 10)).join(','));
  fs.writeFileSync('state-raw-logs.json', JSON.stringify(raw.map(r => ({ topics: r.topics, block: String(r.blockNumber), tx: r.transactionHash })), null, 1));
}
console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 6)));
await done();
