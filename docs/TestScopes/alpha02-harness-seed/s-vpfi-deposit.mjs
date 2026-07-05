// VPFI deposit → tier climb review. Connects, deposits VPFI via /vpfi,
// verifies the effective discount tier on-chain + reflected in the UI.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
const { page, shot, done, consoleErrors } = await launch({ role: 'borrower' });
const { pub } = clientsFor(84532);
const me = addressOf('borrower');
const log = (...a) => console.log('[vpfi-dep]', ...a);
const fs = await import('node:fs');
const DIAMOND = '0xd89fd7F787e4415460b23891E97570a4881fb995';
const dabi = JSON.parse(fs.readFileSync('/home/user/vaipakam/packages/contracts/src/abis/VPFIDiscountFacet.json', 'utf8'));
const eff = () => pub.readContract({ address: DIAMOND, abi: dabi, functionName: 'getEffectiveDiscount', args: [me] }).catch(e => 'ERR');

log('effDiscount BEFORE deposit:', JSON.stringify(await eff(), (k, v) => typeof v === 'bigint' ? String(v) : v));

await page.goto(SITE + '/vpfi', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const c = page.getByRole('button', { name: /connect/i }).first();
if (await c.isVisible().catch(() => false)) { await c.click(); await page.waitForTimeout(1500);
  for (const n of [/vaipakam test wallet/i, /metamask/i, /browser wallet/i]) { const o = page.getByRole('button', { name: n }).first(); if (await o.isVisible().catch(() => false)) { await o.click(); break; } }
  await page.waitForTimeout(4000);
}
await page.goto(SITE + '/vpfi', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await shot('vpfi-dep-1-active');
const body = await page.textContent('body');
log('page now ACTIVE (not "aren’t available"):', !/aren.t available|not available/i.test(body));
log('shows tier table (10%/15%/20%/24%):', /24%/.test(body) && /10%/.test(body));
log('shows deposit control:', /deposit/i.test(body));

// consent checkbox if present
const consent = page.locator('input[type="checkbox"]:visible').first();
if (await consent.isVisible().catch(() => false) && !(await consent.isChecked().catch(() => true))) { await consent.check().catch(() => {}); log('checked consent'); await page.waitForTimeout(400); }

// deposit amount
const amt = page.locator('input[placeholder="0.0"]:visible, input[type="number"]:visible, input[inputmode="decimal"]:visible').first();
if (await amt.isVisible().catch(() => false)) { await amt.fill('25000'); log('filled 25000'); }
else { log('amount input not found'); }
await page.waitForTimeout(800);
await shot('vpfi-dep-2-filled');
// submit — approve (if needed) then deposit; poll ON-CHAIN for the tier
// to climb rather than trusting page wording.
const tierNow = async () => { const e = await eff(); return Array.isArray(e) ? Number(e[0]) : -1; };
for (let i = 0; i < 24; i++) {
  if ((await tierNow()) > 0) { log('tier climbed on-chain at ~', i * 4, 's'); break; }
  // click whatever actionable submit is present (Approve VPFI → Deposit VPFI)
  const btn = page.getByRole('button', { name: /approve|deposit|stake|confirm/i }).filter({ hasNotText: /withdraw|connect/i }).first();
  if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
    const label = (await btn.textContent().catch(() => '')) ?? '';
    await btn.click().catch(() => {});
    log('clicked:', label.trim().slice(0, 30));
  }
  await page.waitForTimeout(4000);
}
await shot('vpfi-dep-3-after');
await page.waitForTimeout(3000);
const after = await eff();
log('effDiscount AFTER deposit:', JSON.stringify(after, (k, v) => typeof v === 'bigint' ? String(v) : v), '(expect tier 4, 2400 bps)');
const b2 = await page.textContent('body');
log('UI shows a tier/discount now:', /tier|% off|discount/i.test(b2));
log('non-429 errors:', JSON.stringify(consoleErrors.filter(e => !/429/.test(e)).slice(0, 5)));
await done();
