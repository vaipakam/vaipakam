// #1056 post-merge live review — kill-switch ZERO-REGRESSION check.
// Production sets no VITE_DISABLED_FLOWS, so the observable contract
// is: every page renders normally and the kill-switch banner copy
// appears NOWHERE. (Flipping the switch on production is an operator
// action we don't do for a review — exception stated in the PR body.)
import { ensureConnected, launch, SITE } from './driver.mjs';

const KILL_COPY = 'switched off right now';
// EVERY public route in App.tsx — the claim is "the banner appears
// nowhere", so the sweep must cover the whole route table.
const PAGES = [
  '/', '/borrow', '/lend', '/rent', '/positions', '/claims', '/offers',
  '/vault', '/activity', '/vpfi', '/nft', '/settings', '/faucet', '/help',
];

const { page, done } = await launch({ role: 'lender' });
// Connect BEFORE the sweep: several killable surfaces render only in
// the connected branch (Vpfi.tsx shows the connect-first card to an
// unauthenticated visit, hiding the deposit banner spot), so an
// unauthenticated sweep couldn't honestly claim the vpfi-deposit id
// (round 4). The session persists across gotos in this context.
await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
await ensureConnected(page);
let failures = 0;
for (const path of PAGES) {
  await page.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  const hasKillCopy = body.toLowerCase().includes(KILL_COPY);
  const rendered = body.trim().length > 100;
  const ok = rendered && !hasKillCopy;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${path} rendered=${rendered} killCopy=${hasKillCopy} len=${body.trim().length}`);
}
// Review-state banners (round 3): the offer/rent banners render only
// inside the review card, so root visits alone can't prove those flow
// ids are enabled. Drive the deepest killable surface — the lend
// post-offer review — and require BOTH no banner AND the sign button
// actually enabling (which also proves the normal gates are clear).
// Per-id coverage: post-offer = this review drive; vpfi-deposit = the
// CONNECTED /vpfi visit in the sweep above (deposit is the default
// tab and the wallet is connected before the sweep, so its banner
// spot renders); accept-offer / nft-list / nft-rent share the same
// flowDisabled() config read and banner component but their review
// states need live book/NFT fixtures — root visits only, stated here
// honestly rather than claimed.
console.log('driving lend post-offer review…');
await page.goto(`${SITE}/lend`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
await ensureConnected(page);
await page.locator('#lending-asset').selectOption('__custom__');
await page.locator('#lending-asset ~ input[placeholder="0x…"]')
  .fill('0x2affacdea8119e38d9754b2c2c15ec79af360807');
await page.waitForTimeout(1500);
await page.locator('input[placeholder="0.0"]').fill('25');
await page.getByRole('button', { name: /see matching offers/i }).click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: /post my own lending offer/i }).click();
await page.waitForTimeout(800);
await page.locator('input[placeholder="5"]').fill('9');
await page.locator('#collateral-asset').selectOption('__custom__').catch(() => {});
await page.locator('#collateral-asset ~ input[placeholder="0x…"]')
  .fill('0x2A6c7149199991243aCbc04e1d59Aa052A6f00c3');
await page.waitForTimeout(1500);
await page.locator('input[placeholder="0.0"]:visible').last().fill('100');
await page.getByRole('button', { name: /continue to review/i }).click();
await page.waitForTimeout(3000);
const post = page.getByRole('button', { name: /post lending offer/i });
let reviewOk = false;
const reviewDeadline = Date.now() + 90_000;
for (;;) {
  for (const box of await page.locator('input[type="checkbox"]:visible').all()) {
    if (!(await box.isChecked().catch(() => true))) await box.check().catch(() => {});
  }
  await page.waitForTimeout(2000);
  const reviewBody = await page.locator('body').innerText();
  if (reviewBody.toLowerCase().includes(KILL_COPY)) {
    console.log('FAIL — kill banner visible in the post-offer review');
    break;
  }
  if (await post.isEnabled().catch(() => false)) { reviewOk = true; break; }
  if (Date.now() > reviewDeadline) {
    console.log('FAIL — sign button never enabled (a closed gate or the kill switch)');
    break;
  }
}
console.log(`${reviewOk ? 'PASS' : 'FAIL'} post-offer review: no banner, sign button enabled`);
if (!reviewOk) failures++;

await done();
process.exit(failures === 0 ? 0 : 1);
