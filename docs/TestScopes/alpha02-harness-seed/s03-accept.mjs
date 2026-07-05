// Borrower finds and accepts the lender's offer #7.
import fs from 'node:fs';
import { launch, SITE, clientsFor, addressOf } from './driver.mjs';

const mocks = JSON.parse(fs.readFileSync('mocks-84532.json', 'utf8'));
const { page, shot, done, consoleErrors } = await launch({ role: 'borrower' });

await page.goto(SITE + '/borrow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
// connect if needed (fresh profile)
const connectBtn = page.getByRole('button', { name: /^connect wallet$/i }).first();
if (await connectBtn.isVisible().catch(() => false)) {
  await connectBtn.click();
  await page.waitForTimeout(1500);
  for (const name of [/vaipakam test wallet/i, /metamask/i, /browser/i, /injected/i]) {
    const opt = page.getByRole('button', { name }).first();
    if (await opt.isVisible().catch(() => false)) { await opt.click(); break; }
  }
  await page.waitForTimeout(2500);
}
await shot('s03-1-borrow');

// details: want WETH 0.005
await page.locator('select').first().selectOption({ index: 1 }); // WETH
await page.locator('input[placeholder="0.0"]').fill('0.005');
await page.waitForTimeout(800);
await page.getByRole('button', { name: /see matching offers/i }).click();
await page.waitForTimeout(4000);
await shot('s03-2-matches');
const body = await page.textContent('body');
console.log('match list mentions 10%:', body.includes('10%'));
console.log('mentions offer #7:', body.includes('#7'));

// choose the offer
const choose = page.getByRole('button', { name: /^choose$/i }).first();
if (!(await choose.isVisible().catch(() => false))) {
  console.log('NO MATCH ROW VISIBLE — body sample:', body.replace(/\s+/g, ' ').slice(0, 600));
  await done();
  process.exit(2);
}
await choose.click();
await page.waitForTimeout(4000);
await shot('s03-3-review');
const rbody = await page.textContent('body');
console.log('review shows illiquid warning:', /isn.t priced by the protocol/i.test(rbody));
console.log('review shows collateral 100:', rbody.includes('100'));
console.log('review shows grace period:', /grace period/i.test(rbody));

// consent + accept
await page.locator('input[type="checkbox"]:visible').first().check();
await page.waitForTimeout(500);
const accept = page.getByRole('button', { name: /borrow this now/i });
console.log('accept enabled:', await accept.isEnabled());
// A real user retries a transient failure — allow up to 3 attempts
// (stale-replica estimates and free-tier RPC 429s both self-heal).
let opened = false;
for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
  await accept.click();
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const t = await page.textContent('body');
    if (/loan opened/i.test(t)) { console.log(`LOAN OPENED (attempt ${attempt}) at`, i * 2, 's'); opened = true; break; }
    const err = await page.locator('.banner-danger:visible').allTextContents().catch(() => []);
    if (err.length) { console.log(`attempt ${attempt} error:`, JSON.stringify(err)); await page.waitForTimeout(8000); break; }
  }
}
await shot('s03-4-done');
console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 6)));
await done();
