import { launch, SITE } from './driver.mjs';
const { page, done } = await launch({ role: 'borrower' });
await page.goto(SITE + '/positions/8', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const c = page.getByRole('button', { name: /connect/i }).first();
if (await c.isVisible().catch(()=>false)) { await c.click(); await page.waitForTimeout(1500);
  for (const n of [/vaipakam test wallet/i,/metamask/i,/browser wallet/i]) { const o=page.getByRole('button',{name:n}).first(); if(await o.isVisible().catch(()=>false)){await o.click();break;} }
  await page.waitForTimeout(4000);
}
await page.goto(SITE + '/positions/8', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const b = (await page.textContent('body')).toLowerCase();
console.log('[pos8t] shows defaulted/liquidated/closed:', /default|liquidat|closed|ended/.test(b));
console.log('[pos8t] still shows Active/Healthy (should be false):', /\bhealthy\b/.test(b) && /\bactive\b/.test(b));
console.log('[pos8t] shows repay action (should be gone/terminal):', /repay this loan|make a repayment/.test(b));
const i=b.indexOf('status'); if(i>=0) console.log('[pos8t] status ctx:', b.slice(i,i+60).replace(/\s+/g,' '));
await done();
