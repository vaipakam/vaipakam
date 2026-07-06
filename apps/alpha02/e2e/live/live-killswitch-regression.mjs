// #1056 post-merge live review — kill-switch ZERO-REGRESSION check.
// Production sets no VITE_DISABLED_FLOWS, so the observable contract
// is: every page renders normally and the kill-switch banner copy
// appears NOWHERE. (Flipping the switch on production is an operator
// action we don't do for a review — exception stated in the PR body.)
import { launch } from './driver.mjs';

const KILL_COPY = 'switched off right now';
const PAGES = ['/', '/borrow', '/lend', '/rent', '/vpfi', '/positions', '/settings'];

const { page, done } = await launch({ role: 'lender' });
let failures = 0;
for (const path of PAGES) {
  await page.goto(`https://alpha02.vaipakam.com${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const body = await page.locator('body').innerText();
  const hasKillCopy = body.toLowerCase().includes(KILL_COPY);
  const rendered = body.trim().length > 100;
  const ok = rendered && !hasKillCopy;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${path} rendered=${rendered} killCopy=${hasKillCopy} len=${body.trim().length}`);
}
await done();
process.exit(failures === 0 ? 0 : 1);
