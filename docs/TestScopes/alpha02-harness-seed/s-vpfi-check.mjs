import { launch, SITE } from './driver.mjs';
const { page, done } = await launch({ role: 'borrower' });
await page.goto(SITE + '/vpfi', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const c=page.getByRole('button',{name:/connect/i}).first();
if(await c.isVisible().catch(()=>false)){await c.click();await page.waitForTimeout(1500);for(const n of[/vaipakam test wallet/i,/metamask/i,/browser wallet/i]){const o=page.getByRole('button',{name:n}).first();if(await o.isVisible().catch(()=>false)){await o.click();break;}}await page.waitForTimeout(4000);}
await page.goto(SITE + '/vpfi', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const b=await page.textContent('body');
console.log('[chk] shows vault holds 25,000 VPFI:', /25,000|25000/.test(b));
console.log('[chk] shows Tier 4 / current tier:', /tier 4|tier\s*4/i.test(b));
console.log('[chk] shows 24%:', /24%/.test(b));
// what does it say near the user's current standing
const idx=b.toLowerCase().search(/your (tier|discount|standing|current)/);
if(idx>=0) console.log('[chk] standing ctx:', b.slice(idx,idx+120).replace(/\s+/g,' '));
const idx2=b.toLowerCase().indexOf('withdraw');
if(idx2>=0) console.log('[chk] has withdraw control:', true);
await done();
