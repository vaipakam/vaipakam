/**
 * Position, take back collateral (matrix LN-32), against loans opened through
 * the protocol's public entry points on the fixture chain. The borrower
 * chooses an amount, checked as it is typed against the protocol's own limit
 * (`calculateMaxWithdrawable`, which moves with prices and as interest
 * accrues); the review states the collateral before and after, that it goes
 * to the wallet, the limit, the loan's health factor and loan-to-value now,
 * and every consequence; no approval is asked. The finish card reports the
 * MEASURED outcome from the transaction's own logs: the collateral it left,
 * the protocol's health factor and loan-to-value after, and what arrived in
 * the wallet. The lender is not offered the action. Runs on the desktop and
 * the phone project; each run opens its own loans, and every test is rolled
 * back after it, so the collateral it returns never reaches a later spec's
 * wallet.
 */
import { erc20Abi, parseEther } from 'viem';
import { openLoan } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

// The chain as each test found it: a later spec counts on the borrower's
// wallet holding none of the collateral token. A revert leaves the head at
// the snapshot's timestamp, as old as the test took, while the next block
// mines at the wall clock; a later write would then be estimated in that
// stale environment and mine short of gas on a call whose cost grows with
// elapsed time (interest accrues per second). So a block is mined at once,
// bringing the head to the present.
let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the borrower takes back collateral: the amount checked against the protocol limit, one prompt, then the collateral and health measured from the log', async ({
  launchWallet,
}) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });
  const borrower = sc.address('borrower');
  const { collateralAsset } = await sc.read<{ collateralAsset: Hex }>('getLoanDetails', [loanId]);
  const max = await sc.read<bigint>('calculateMaxWithdrawable', [loanId]);
  // The fixture's loan carries room above its limits, well over what this
  // run takes back.
  expect(max).toBeGreaterThan(parseEther('200'));
  const before = await sc.pub.readContract({ address: collateralAsset, abi: erc20Abi, functionName: 'balanceOf', args: [borrower] });

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const actions = page.getByRole('region', { name: 'Actions' });
  await actions.getByTestId('take-back-open').click({ timeout: 60_000 });

  const form = page.getByTestId('take-back-form');
  await expect(form).toContainText('How much collateral to take back');
  await expect(form).toContainText(/At most (≈ )?[\d,.]+ tLIQ now\. This limit moves with prices and as interest accrues\./, { timeout: 30_000 });
  const amount = form.getByTestId('take-back-amount');
  await amount.fill('1500');
  await expect(form).toContainText(/The protocol lets you take back at most (≈ )?[\d,.]+ tLIQ now\./);
  await amount.fill('200');
  await expect(form.locator('.field-error')).toHaveCount(0);
  await fitsWidth(page);
  await form.getByTestId('take-back-review').click();

  const flow = page.getByTestId('take-back-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Take back collateral from loan #${loanId}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Collateral you take back');
  await expect(receipt).toContainText('200 tLIQ');
  await expect(receipt).toContainText('1,500 tLIQ');
  await expect(receipt).toContainText('1,300 tLIQ');
  await expect(receipt).toContainText('Your wallet, from your vault');
  await expect(receipt).toContainText('Most you can take back now');
  await expect(receipt).toContainText('Health factor now');
  await expect(receipt).toContainText('so it moves closer to liquidation');
  await expect(receipt).toContainText('If prices move first and the amount no longer fits, it is refused and nothing moves.');
  await expect(receipt).toContainText('If the protocol pauses before this confirms, it is refused and nothing moves.');
  await expect(receipt).toContainText('Wallet prompts: 1');
  await fitsWidth(page);

  // Changing the amount goes back to the form with the amount kept.
  await flow.getByTestId('take-back-change').click();
  await expect(page.getByTestId('take-back-amount')).toHaveValue('200');
  await page.getByTestId('take-back-review').click();
  await expect(flow.locator('.receipt')).toContainText(`Take back collateral from loan #${loanId}`, { timeout: 60_000 });

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Collateral now 1,300 tLIQ');
  await expect(finish).toContainText(/Health factor after \d/);
  await expect(finish).toContainText('200 tLIQ arrived in your wallet');
  expect(flags.sentTransactions).toBe(sent + 1);

  // The chain agrees: still running, with the collateral lowered and the
  // wallet holding what left the vault.
  const after = await sc.read<{ status: number; collateralAmount: bigint }>('getLoanDetails', [loanId]);
  expect(Number(after.status)).toBe(0);
  expect(after.collateralAmount).toBe(parseEther('1300'));
  expect(await sc.pub.readContract({ address: collateralAsset, abi: erc20Abi, functionName: 'balanceOf', args: [borrower] })).toBe(before + parseEther('200'));

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('take-back-open')).toBeVisible({ timeout: 60_000 });
});

test('the lender is not offered taking back collateral, nor told why', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });

  const { page } = await launchWallet('lender');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const actions = page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByTestId('position-actions-later')).toBeVisible({ timeout: 60_000 });
  await expect(actions.getByTestId('take-back-open')).toHaveCount(0);
  await expect(actions.getByTestId('take-back-refusal')).toHaveCount(0);
  await fitsWidth(page);
});
