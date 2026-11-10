/**
 * Position, add collateral (matrix LN-31), against loans opened through the
 * protocol's public entry points on the fixture chain. The borrower chooses
 * an amount, checked against the wallet's balance as it is typed; the review
 * states the collateral before and after, where it is held, the loan's
 * health factor and loan-to-value now, the approval, and that a top-up stays
 * open under the protocol pause; the finish card reports the MEASURED
 * outcome from the transaction's own logs: the collateral it left, the
 * protocol's health factor and loan-to-value after, and what left the
 * wallet. A standing approval that covers the amount is left as it is. The
 * lender is not offered the action. Runs on the desktop and the phone
 * project; each run opens its own loans, and every test is rolled back
 * after it, so the tokens it mints never reach a later spec's wallet.
 */
import { erc20Abi, parseEther } from 'viem';
import { openLoan } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

type Hex = `0x${string}`;

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the borrower adds collateral: the amount checked against the wallet, an exact approval, then the collateral and health measured from the log', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });
  const borrower = sc.address('borrower');
  const { collateralAsset } = await sc.read<{ collateralAsset: Hex }>('getLoanDetails', [loanId]);
  await sc.write('borrower', collateralAsset, MINT_ABI, 'mint', [borrower, parseEther('500')]);
  // No standing approval, so the flow approves exactly the amount.
  await sc.write('borrower', collateralAsset, erc20Abi, 'approve', [sc.diamond, 0n]);
  const balance = await sc.pub.readContract({ address: collateralAsset, abi: erc20Abi, functionName: 'balanceOf', args: [borrower] });

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const actions = page.getByRole('region', { name: 'Actions' });
  await actions.getByTestId('add-collateral-open').click({ timeout: 60_000 });

  const form = page.getByTestId('add-collateral-form');
  await expect(form).toContainText('How much collateral to add');
  await expect(form).toContainText(/Your wallet holds [\d,.]+ tLIQ\./, { timeout: 30_000 });
  await expect(form).toContainText('The same token as the loan’s collateral; the protocol takes no other.');
  const amount = form.getByTestId('add-collateral-amount');
  await amount.fill((balance / 10n ** 18n + 1n).toString());
  await expect(form).toContainText(/That is more than the [\d,.]+ tLIQ your wallet holds\./);
  await amount.fill('250');
  await expect(form.locator('.field-error')).toHaveCount(0);
  await fitsWidth(page);
  await form.getByTestId('add-collateral-review').click();

  const flow = page.getByTestId('add-collateral-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Add collateral to loan #${loanId}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Collateral you add');
  await expect(receipt).toContainText('250 tLIQ');
  await expect(receipt).toContainText('1,500 tLIQ');
  await expect(receipt).toContainText('1,750 tLIQ');
  await expect(receipt).toContainText('In your vault, locked to this loan until it ends');
  await expect(receipt).toContainText('Collateral you add can be lost with the rest: if the loan is liquidated or defaults');
  await expect(receipt).toContainText('Health factor now');
  await expect(receipt).toContainText(/Approve exactly the 250 tLIQ it takes/);
  await expect(receipt).toContainText('The finish card shows the protocol’s own figures after it.');
  await expect(receipt).toContainText('Adding collateral stays open even while the protocol is paused.');
  await expect(receipt).toContainText('Wallet prompts: 2');
  await fitsWidth(page);

  // Changing the amount goes back to the form with the amount kept.
  await flow.getByTestId('add-collateral-change').click();
  await expect(page.getByTestId('add-collateral-amount')).toHaveValue('250');
  await page.getByTestId('add-collateral-review').click();
  await expect(flow.locator('.receipt')).toContainText(`Add collateral to loan #${loanId}`, { timeout: 60_000 });

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Collateral now 1,750 tLIQ');
  await expect(finish).toContainText(/Health factor after \d/);
  await expect(finish).toContainText('250 tLIQ left your wallet');
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: still running, with the collateral raised and the
  // approval used up.
  const after = await sc.read<{ status: number; collateralAmount: bigint }>('getLoanDetails', [loanId]);
  expect(Number(after.status)).toBe(0);
  expect(after.collateralAmount).toBe(parseEther('1750'));
  expect(await sc.pub.readContract({ address: collateralAsset, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(0n);

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('add-collateral-open')).toBeVisible({ timeout: 60_000 });
});

test('a standing approval that covers the amount is left as it is, and the lender is not offered the action', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '1500', rateBps: 500, days: 30 });
  const borrower = sc.address('borrower');
  const { collateralAsset } = await sc.read<{ collateralAsset: Hex }>('getLoanDetails', [loanId]);
  await sc.write('borrower', collateralAsset, MINT_ABI, 'mint', [borrower, parseEther('100')]);
  await sc.write('borrower', collateralAsset, erc20Abi, 'approve', [sc.diamond, parseEther('1000')]);

  const l = await launchWallet('lender');
  await l.page.goto(`/positions/${loanId}`);
  await connectWallet(l.page);
  const lenderActions = l.page.getByRole('region', { name: 'Actions' });
  await expect(lenderActions.getByTestId('position-actions-later')).toBeVisible({ timeout: 60_000 });
  await expect(lenderActions.getByTestId('add-collateral-open')).toHaveCount(0);
  await expect(lenderActions.getByTestId('add-collateral-refusal')).toHaveCount(0);
  await l.ctx.close();

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await page.getByTestId('add-collateral-open').click({ timeout: 60_000 });
  await page.getByTestId('add-collateral-amount').fill('100');
  await page.getByTestId('add-collateral-review').click();
  const flow = page.getByTestId('add-collateral-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('Your approval already covers the 100 tLIQ it takes', { timeout: 60_000 });
  await expect(receipt).toContainText('Wallet prompts: 1');
  await expect(receipt).not.toContainText('put back as it was');

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Collateral now 1,600 tLIQ');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.pub.readContract({ address: collateralAsset, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(parseEther('900'));
  await fitsWidth(page);
});
