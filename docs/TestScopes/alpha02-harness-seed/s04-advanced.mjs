// Lender: flip Advanced mode, exercise the NFT verifier (live + gone
// verdicts) and the keeper permissions card end-to-end.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf } from './verify.mjs';

const { page, shot, done, consoleErrors } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);

// 1. Settings → Advanced mode
await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await shot('s04-1-settings');
const advToggle = page.locator('input[type="checkbox"]:visible').first();
const body0 = await page.textContent('body');
console.log('settings mentions advanced:', /advanced/i.test(body0));
// find the advanced-mode control (checkbox or button)
const advBtn = page.getByRole('button', { name: /advanced/i }).first();
if (await advBtn.isVisible().catch(() => false)) {
  await advBtn.click();
} else if (await advToggle.isVisible().catch(() => false)) {
  await advToggle.check();
}
await page.waitForTimeout(2000);
await shot('s04-2-settings-advanced');
const body1 = await page.textContent('body');
console.log('keeper card visible:', /keeper permissions/i.test(body1));
console.log('approvals card visible:', /standing approvals|spending permission/i.test(body1));

// 2. NFT verifier — live token (offer-stage mint #11)
await page.goto(SITE + '/nft/11', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await shot('s04-3-verifier-live');
const v = await page.textContent('body');
console.log('live verdict:', /is live on this network/i.test(v));
console.log('shows holder 0x1DAe:', v.includes('0x1DAe'));
console.log('offer-stage row:', /minted for an offer/i.test(v));
console.log('compliance row flagged?:', /compliance-flagged/i.test(v), 'unknown?:', /couldn.t check the holder/i.test(v));

// 3. gone token
await page.goto(SITE + '/nft/999999', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await shot('s04-4-verifier-gone');
const g = await page.textContent('body');
console.log('gone verdict:', /does not currently exist/i.test(g));
console.log('states both possibilities:', /never minted/i.test(g));
console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 5)));
await done();
