// #1055 follow-up live review — the alerts Telegram link flow end to
// end on production alpha02, now that the agent ships with alpha02 in
// FRONTEND_ORIGIN (the original 403) AND the link request requires a
// wallet signature (#1056). Expects: click Link Telegram → wallet
// signs the ownership proof → a 6-digit code renders.
import { launch } from './driver.mjs';

const { page, done } = await launch({ role: 'lender' });
await page.goto('https://alpha02.vaipakam.com/settings', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

const linkBtn = page.getByRole('button', { name: 'Link Telegram' });
const visible = await linkBtn.isVisible().catch(() => false);
console.log('link button visible:', visible);
if (!visible) {
  console.log('BODY:', (await page.locator('body').innerText()).slice(0, 1500));
  await done();
  process.exit(1);
}
await linkBtn.click();
// The driver wallet auto-approves signature requests; give the round
// trip a moment.
await page.waitForTimeout(6000);
const body = await page.locator('body').innerText();
const codeMatch = body.match(/\b(\d{6})\b/);
const hasIssueCopy = body.includes('Open our bot');
const errorBanner = await page.locator('.banner-danger').innerText().catch(() => '');
console.log('code shown:', codeMatch?.[1] ?? 'NONE');
console.log('issue copy shown:', hasIssueCopy);
if (errorBanner) console.log('error banner:', errorBanner.slice(0, 300));
await done();
process.exit(codeMatch && hasIssueCopy ? 0 : 1);
