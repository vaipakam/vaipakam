import { launch, SITE, addressOf } from './driver.mjs';

const role = process.env.ROLE ?? 'lender';
const { page, shot, done, consoleErrors } = await launch({ role });

await page.goto(SITE, { waitUntil: 'networkidle' }).catch(async (e) => {
  console.log('goto error:', e.message);
});
await page.waitForTimeout(2000);
console.log('title:', await page.title());
console.log('url:', page.url());
await shot(`s01-${role}-home`);

// Find and click the connect button (ConnectKit).
const connectBtn = page.getByRole('button', { name: /connect/i }).first();
if (await connectBtn.isVisible().catch(() => false)) {
  await connectBtn.click();
  await page.waitForTimeout(1500);
  await shot(`s01-${role}-modal`);
  // ConnectKit modal: click our announced wallet by name, else 'browser wallet' style entries.
  for (const name of [/vaipakam test wallet/i, /metamask/i, /browser wallet/i, /injected/i]) {
    const opt = page.getByRole('button', { name }).first();
    if (await opt.isVisible().catch(() => false)) {
      console.log('clicking wallet option:', name);
      await opt.click();
      break;
    }
  }
  await page.waitForTimeout(3000);
  await shot(`s01-${role}-connected`);
}
// Is the address visible anywhere?
const addr = addressOf(role);
const short = addr.slice(0, 6);
const body = await page.textContent('body');
console.log('address fragment on page:', body.includes(short));
console.log('console errors:', JSON.stringify(consoleErrors.slice(0, 8), null, 1));
await done();
