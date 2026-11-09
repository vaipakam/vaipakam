/**
 * Settings › Approvals (#3180; ACC-32, RB-APPROVALS), against the suite's
 * chain. With no standing approval the page says none was found among the
 * assets it checked, and what it checked; standing approvals (an unlimited
 * ERC-20, a limited one, an operator approval over a collection) are listed
 * with what each lets the protocol move, and each is withdrawn in one signed
 * step with its receipt and a measured outcome. An address that is not a
 * contract is refused before it is added. Each test runs inside a snapshot
 * it reverts. Runs on the desktop and the phone.
 */
import { erc20Abi, maxUint256, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const OPERATOR_ABI = [
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'bool' }], outputs: [] },
] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function inSnapshot(body: () => Promise<void>): Promise<void> {
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    await body();
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
    await anvilRpc('evm_mine');
  }
}

test('no standing approval: the page says none was found among what it checked, and refuses an address that is not a contract', async ({ launchWallet }) => {
  const { page } = await launchWallet('freshBorrower');
  await page.goto('/settings');
  await connectWallet(page);
  const section = page.getByTestId('settings-approvals');
  await expect(section.getByTestId('settings-approvals-none')).toContainText('No standing approval to the protocol was found among the', { timeout: 60_000 });
  await expect(section.getByTestId('settings-approvals-scope')).toContainText('An approval for any other token is not found here');

  const add = section.getByTestId('settings-approvals-add');
  await add.locator('input').fill('not an address');
  await add.getByRole('button', { name: 'Check' }).click();
  await expect(add.getByTestId('settings-approvals-add-note')).toHaveText('That is not an address.');
  await add.locator('input').fill(accountFor('visitor').address);
  await add.getByRole('button', { name: 'Check' }).click();
  await expect(add.getByTestId('settings-approvals-add-note')).toContainText('No contract at that address');
  await fitsWidth(page);
});

test('standing approvals are listed with what each lets the protocol move, and each is withdrawn in one step', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario({ borrower: 'freshBorrower' });
  const mocks = sc.fixture.artifact.testnetMocks as Record<string, Hex>;
  await inSnapshot(async () => {
    await sc.write('borrower', WETH, erc20Abi, 'approve', [sc.diamond, maxUint256]);
    await sc.write('borrower', mocks.liquidToken!, erc20Abi, 'approve', [sc.diamond, parseEther('25')]);
    await sc.write('borrower', mocks.multiToken!, OPERATOR_ABI, 'setApprovalForAll', [sc.diamond, true]);

    const { page, flags } = await launchWallet('freshBorrower');
    await page.goto('/settings');
    await connectWallet(page);
    const section = page.getByTestId('settings-approvals');
    const rows = section.getByTestId('settings-approval-row');
    await expect(rows).toHaveCount(3, { timeout: 60_000 });
    const weth = rows.and(page.locator(`[data-asset="${WETH.toLowerCase()}"]`));
    const tliq = rows.and(page.locator(`[data-asset="${mocks.liquidToken!.toLowerCase()}"]`));
    const multi = rows.and(page.locator(`[data-asset="${mocks.multiToken!.toLowerCase()}"]`));
    await expect(weth).toContainText('Any amount, with no limit');
    await expect(tliq).toContainText('Up to 25');
    await expect(multi).toHaveAttribute('data-kind', 'collection');
    await expect(multi).toContainText('Every token you hold in this collection');
    await fitsWidth(page);

    // The unlimited one: its receipt, one signature, the outcome read back.
    const sent = flags.sentTransactions;
    await weth.getByTestId('settings-approval-revoke').click();
    const flow = section.getByTestId('settings-approvals-flow');
    const receipt = flow.locator('.receipt');
    await expect(receipt).toContainText('Withdraw an approval', { timeout: 60_000 });
    await expect(receipt).toContainText('Any amount, with no limit');
    await expect(receipt).toContainText('Nothing, until you approve again');
    await expect(receipt).toContainText('None: this only withdraws a permission');
    await expect(receipt).toContainText('refuses until you approve again');
    await fitsWidth(page);
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    let finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    await expect(finish).toContainText('withdrawn');
    expect(flags.sentTransactions).toBe(sent + 1);
    await finish.getByTestId('settings-approvals-done').click();
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(weth).toHaveCount(0);

    // The collection's operator approval.
    await multi.getByTestId('settings-approval-revoke').click();
    await expect(flow.locator('.receipt')).toContainText('Every token you hold in this collection', { timeout: 60_000 });
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    await finish.getByTestId('settings-approvals-done').click();
    await expect(rows).toHaveCount(1, { timeout: 60_000 });
    await expect(tliq).toHaveCount(1);
  });
});
