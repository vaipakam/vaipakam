/**
 * Settings › Keepers (#3180; ACC-34, RB-KEEPERS), against the suite's chain.
 * Everything starts off and Basic points to Advanced; in Advanced the master
 * switch is turned on, a keeper is approved with two actions, one action is
 * taken away, the keeper is removed and access turned off, each in one
 * signed step with its receipt and a measured outcome. With Terms in force,
 * giving a keeper a permission asks for them first and taking one away never
 * does. While the protocol is paused, the approved keepers stay listed and
 * no change is offered. The suite reverts the chain after every test. Runs
 * on the desktop and the phone.
 */
import { keccak256, toHex } from 'viem';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Check a change's receipt, sign it, and wait for the measured outcome. */
async function sign(page: Page, receiptText: string[], outcomeText: string): Promise<void> {
  const flow = page.getByTestId('settings-keepers-flow');
  const receipt = flow.locator('.receipt');
  for (const t of receiptText) await expect(receipt).toContainText(t, { timeout: 60_000 });
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(outcomeText);
  await finish.getByTestId('settings-keepers-done').click();
  await expect(flow).toHaveCount(0);
}

test('all off at first; in Advanced: access on, approve, change actions, remove, access off', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const keeper = accountFor('visitor').address;
  const { page, flags } = await launchWallet('freshBorrower');
  await page.goto('/settings');
  await connectWallet(page);
  const section = page.getByTestId('settings-keepers');
  const state = section.getByTestId('settings-keepers-state');
  await expect(state).toHaveAttribute('data-access', 'off', { timeout: 60_000 });
  await expect(state).toHaveAttribute('data-count', '0');
  await expect(state).toContainText('no keeper can act for this wallet');
  await expect(state).toContainText('never receives your funds');
  await expect(section).toContainText('is in Advanced mode');
  await expect(section.getByTestId('settings-keepers-access')).toHaveCount(0);

  await page.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
  const sent = flags.sentTransactions;
  await section.getByTestId('settings-keepers-access').click();
  await sign(page, ['Turn keeper access on', 'None: this only changes a permission', 'only while access is on'], 'Keeper access turned on');
  await expect(state).toHaveAttribute('data-access', 'on', { timeout: 30_000 });

  const add = section.getByTestId('settings-keepers-add');
  await add.locator('#keepers-add-input').fill(keeper);
  // #3415: a first-time address is shown in full and needs an explicit check.
  const entry = add.getByTestId('settings-keepers-add-entry');
  await expect(entry).toHaveAttribute('data-candidate', 'new');
  await expect(entry.getByTestId('settings-keepers-add-entry-full')).toHaveText(keeper);
  await entry.getByTestId('settings-keepers-add-entry-checked').check();
  const picker = add.getByTestId('settings-keepers-add-actions');
  await picker.locator('input[data-bit="1"]').check();
  await picker.locator('input[data-bit="32"]').check();
  await fitsWidth(page);
  await picker.getByRole('button', { name: 'Approve this keeper' }).click();
  await sign(page, ['Approve a keeper', 'Finish a sale of your lender position', 'Extend a loan within the limits'], 'approved');
  const row = section.getByTestId('settings-keeper-row');
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await expect(row).toHaveAttribute('data-keeper', keeper.toLowerCase());
  await expect(row).toHaveAttribute('data-actions', '33');

  const edit = row.getByTestId('settings-keeper-actions');
  await edit.locator('input[data-bit="32"]').uncheck();
  await edit.getByRole('button', { name: 'Save these actions' }).click();
  await sign(page, ["Change a keeper's actions", 'Actions now', 'Actions after this'], 'changed');
  await expect(row).toHaveAttribute('data-actions', '1', { timeout: 30_000 });

  await row.getByTestId('settings-keeper-revoke').click();
  await sign(page, ['Remove a keeper', 'can no longer act for this wallet'], 'removed');
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  await section.getByTestId('settings-keepers-access').click();
  await sign(page, ['Turn keeper access off', 'stay saved'], 'Keeper access turned off');
  await expect(state).toHaveAttribute('data-access', 'off', { timeout: 30_000 });
  expect(flags.sentTransactions).toBe(sent + 5);
  await fitsWidth(page);
});

test('with Terms in force, giving a keeper a permission asks for them first; removing one never does', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const keeper = accountFor('visitor').address;
  await sc.diamondWrite('borrower', 'setKeeperAccess', [true]);
  await sc.diamondWrite('borrower', 'approveKeeper', [keeper, 1]);
  await sc.diamondWrite('admin', 'setCurrentTos', [1, keccak256(toHex('alpha05 e2e Terms v1'))]);
  const { page } = await launchWallet('freshBorrower');
  await page.goto('/settings');
  await connectWallet(page);
  await page.getByTestId('settings-mode').getByRole('button', { name: 'Advanced' }).click();
  const section = page.getByTestId('settings-keepers');
  const row = section.getByTestId('settings-keeper-row');
  await expect(row).toHaveCount(1, { timeout: 60_000 });

  // Removing opens its review at once: no Terms asked.
  await row.getByTestId('settings-keeper-revoke').click();
  const flow = section.getByTestId('settings-keepers-flow');
  await expect(flow.locator('.receipt')).toContainText('Remove a keeper', { timeout: 60_000 });
  await expect(page.getByRole('dialog', { name: 'Terms of Service' })).toHaveCount(0);
  await flow
    .getByRole('button', { name: /^(Close|Cancel)$/ })
    .first()
    .click();
  await expect(flow).toHaveCount(0);

  // Giving an action asks for the Terms first, then opens the review.
  const edit = row.getByTestId('settings-keeper-actions');
  await edit.locator('input[data-bit="32"]').check();
  await edit.getByRole('button', { name: 'Save these actions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Terms of Service' });
  await expect(dialog).toContainText('Giving a keeper a permission needs the Terms of Service', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(dialog.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Continue: Giving a keeper a permission' }).click();
  await expect(flow.locator('.receipt')).toContainText("Change a keeper's actions", { timeout: 60_000 });
  await fitsWidth(page);
});

test('while the protocol is paused, the approved keepers stay listed and no change is offered', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const keeper = accountFor('visitor').address;
  const sc = scenario({ borrower: 'freshBorrower' });
  await sc.diamondWrite('borrower', 'setKeeperAccess', [true]);
  await sc.diamondWrite('borrower', 'approveKeeper', [keeper, 0x20]);
  await sc.diamondWrite('admin', 'pause');
  const { page } = await launchWallet('freshBorrower');
  await page.goto('/settings');
  await connectWallet(page);
  const section = page.getByTestId('settings-keepers');
  await expect(section.getByTestId('settings-keepers-state')).toHaveAttribute('data-count', '1', { timeout: 60_000 });
  await expect(section).toContainText('The protocol is paused', { timeout: 60_000 });
  const row = section.getByTestId('settings-keeper-row');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-keeper', keeper.toLowerCase());
  await expect(row).toContainText('Extend a loan within the limits both sides agreed');
  await expect(section.getByTestId('settings-keeper-revoke')).toHaveCount(0);
  await expect(section.getByTestId('settings-keepers-access')).toHaveCount(0);
  await fitsWidth(page);
});
