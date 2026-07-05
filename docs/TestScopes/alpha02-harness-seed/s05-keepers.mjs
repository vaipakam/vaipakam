// Lender: enable Advanced, then keeper permissions end-to-end:
// master switch ON, approve newBorrower as keeper with 2 action bits,
// edit bits, revoke. Verify each write on-chain.
import { launch, SITE, addressOf, clientsFor } from './driver.mjs';
import { DIAMOND, abiOf, fmt } from './verify.mjs';

const { page, shot, done, consoleErrors } = await launch({ role: 'lender' });
const { pub } = clientsFor(84532);
const profileAbi = abiOf('ProfileFacet');
const lender = addressOf('lender');
const keeperAddr = addressOf('newBorrower');

const chainState = async () => {
  const [enabled, keepers] = await Promise.all([
    pub.readContract({ address: DIAMOND, abi: profileAbi, functionName: 'getKeeperAccess', args: [lender] }),
    pub.readContract({ address: DIAMOND, abi: profileAbi, functionName: 'getApprovedKeepers', args: [lender] }),
  ]);
  const actions = [];
  for (const k of keepers) actions.push([k, await pub.readContract({ address: DIAMOND, abi: profileAbi, functionName: 'getKeeperActions', args: [lender, k] })]);
  return { enabled, keepers, actions: actions.map(([k, a]) => k.slice(0,8) + ':' + a) };
};
console.log('chain before:', fmt(await chainState()));

await page.goto(SITE + '/settings', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Experience level', { timeout: 30000 });
await page.waitForTimeout(1000);
// segmented control: click the "Advanced" segment
await page.locator('button:has-text("Advanced")').first().click();
await page.waitForTimeout(2500);
const b = await page.textContent('body');
console.log('advanced active, keeper card:', /keeper permissions/i.test(b), 'approvals card:', /standing approvals|spending permissions/i.test(b));
await shot('s05-1-advanced');
if (!/keeper permissions/i.test(b)) { console.log('KEEPER CARD MISSING'); await done(); process.exit(2); }

// master switch on
const master = () => page.locator('label', { hasText: /master switch/i }).locator('input[type="checkbox"]');
console.log('master checked before:', await master().isChecked());
if (!(await master().isChecked())) {
  // Controlled checkbox: state flips only after the tx mines + the
  // awaited refetch — click and poll, never .check().
  await master().click({ force: true });
  for (let i = 0; i < 20 && !(await master().isChecked()); i++) await page.waitForTimeout(1500);
}
console.log('master UI checked:', await master().isChecked(), '| on-chain:', (await chainState()).enabled);
await shot('s05-2-master');

// add keeper: address + tick 2 actions (close early=0x08? first two checkboxes in add form) then Approve
await page.locator('input[placeholder="0x… keeper address"]').fill(keeperAddr);
// The add-form checklist is the LAST ActionChecklist on the page.
const addCard = page.locator('.card', { hasText: /add a keeper|approve/i }).last();
const boxes = addCard.locator('input[type="checkbox"]');
console.log('add-form checkboxes:', await boxes.count());
await boxes.nth(0).click({ force: true });
await boxes.nth(1).click({ force: true });
await page.waitForTimeout(500);
await shot('s05-3-add-filled');
const addBtn = page.getByRole('button', { name: /^(add|approve)/i }).last();
console.log('add btn label:', await addBtn.textContent());
await addBtn.click();
await page.waitForTimeout(8000);
console.log('after add:', fmt(await chainState()));
await shot('s05-4-added');

// revoke
const revoke = page.getByRole('button', { name: /revoke/i }).first();
await revoke.click();
await page.waitForTimeout(8000);
console.log('after revoke:', fmt(await chainState()));
// master back off (leave clean state)
if (await master().isChecked()) {
  await master().click({ force: true });
  for (let i = 0; i < 20 && (await master().isChecked()); i++) await page.waitForTimeout(1500);
}
console.log('final:', fmt(await chainState()));
await shot('s05-5-final');
console.log('console errors:', JSON.stringify(consoleErrors.filter(e => !/Analytics/.test(e)).slice(0, 5)));
await done();
