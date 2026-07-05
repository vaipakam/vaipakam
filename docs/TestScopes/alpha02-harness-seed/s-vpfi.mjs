import { launch, SITE } from './driver.mjs';
const { page, done, consoleErrors } = await launch({ role: 'borrower' });
const log=(...a)=>console.log('[vpfi]',...a);
async function connect(){const c=page.getByRole('button',{name:/connect/i}).first();if(await c.isVisible().catch(()=>false)){await c.click();await page.waitForTimeout(1500);for(const n of [/vaipakam test wallet/i,/metamask/i,/browser wallet/i]){const o=page.getByRole('button',{name:n}).first();if(await o.isVisible().catch(()=>false)){await o.click();break;}}await page.waitForTimeout(4000);}}
// /vpfi requires advanced mode? it's advancedOnly in nav but route reachable
await page.goto(SITE + '/vpfi', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000); await connect();
await page.goto(SITE + '/vpfi', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const b=(await page.textContent('body'));
log('vpfi page rendered:', /vpfi|discount|tier/i.test(b));
log('shows not-available/registered/coming state:', /not available|isn.t available|no vpfi|not registered|coming|unavailable/i.test(b));
log('shows a tier table:', /tier/i.test(b));
log('shows an ERROR/crash (should be false):', /something went wrong|error boundary/i.test(b));
// claims rewards card
await page.goto(SITE + '/claims', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const c=(await page.textContent('body'));
log('rewards card present:', /reward/i.test(c));
log('rewards shows empty/none (0 pending):', /no .*reward|nothing|not earned|come back|empty/i.test(c) || !/ready to claim/i.test(c));
log('non-429 console errors:', JSON.stringify(consoleErrors.filter(e=>!/429/.test(e)).slice(0,5)));
await done();
