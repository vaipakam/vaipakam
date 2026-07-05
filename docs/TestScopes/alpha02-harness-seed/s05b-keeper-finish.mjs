import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);
const profileAbi = abiOf('ProfileFacet');
const lender = addressOf('lender');
const chainState = async () => {
  const [enabled, keepers] = await Promise.all([
    pub.readContract({ address: DIAMOND, abi: profileAbi, functionName: 'getKeeperAccess', args: [lender] }),
    pub.readContract({ address: DIAMOND, abi: profileAbi, functionName: 'getApprovedKeepers', args: [lender] }),
  ]);
  return { enabled, keepers };
};

await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Keeper permissions', { timeout: 30000 });
await page.waitForTimeout(4000);
await shot('s05b-1-fresh');
const b = await page.textContent('body');
console.log('fresh load shows keeper entry (0xCeF8):', b.includes('0xCeF8'));
console.log('revoke visible:', await page.getByRole('button', { name: /revoke/i }).first().isVisible().catch(() => false));

// Edit bits: uncheck one granted action → Save → verify mask change on-chain.
const entryCard = page.locator('.card', { hasText: '0xCeF8' }).last(); // innermost
const entryBoxes = entryCard.locator('input[type="checkbox"]');
console.log('entry checkboxes:', await entryBoxes.count());
await entryBoxes.nth(0).click({ force: true }); // drop the first granted bit (0x08)
await page.waitForTimeout(500);
const save = entryCard.getByRole('button', { name: /save/i });
console.log('save visible after edit:', await save.isVisible());
await save.click();
await page.waitForTimeout(9000);
const actions = await pub.readContract({ address: DIAMOND, abi: profileAbi, functionName: 'getKeeperActions', args: [lender, addressOf('newBorrower')] });
console.log('actions after save (expect 16 = 0x10):', actions);
await shot('s05b-2-saved');

// Revoke
await page.getByRole('button', { name: /revoke/i }).first().click();
await page.waitForTimeout(9000);
console.log('after revoke:', fmt(await chainState()));

// master off for clean state
const master = page.locator('label', { hasText: /master switch/i }).locator('input[type="checkbox"]');
if (await master.isChecked()) {
  await master.click({ force: true });
  await page.waitForTimeout(9000);
}
console.log('final:', fmt(await chainState()));
await shot('s05b-3-final');
await done();
