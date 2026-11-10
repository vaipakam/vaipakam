/**
 * Position, repay in full (matrix LN-21, LN-16, LN-30 for full repayment),
 * against loans opened through the protocol's public entry points on the
 * fixture chain. The review states the protocol's payoff now and at most by a
 * moment a short while ahead, the wallet approves exactly the later figure,
 * and the finish card reports the MEASURED outcome: the loan repaid, what
 * left the wallet, and the unused approval put back. A larger standing
 * approval (an unlimited one here) is lowered to exactly that figure for the
 * repayment, since `repayLoan` takes no maximum, and put back afterwards. A
 * wallet other than the
 * borrower is told that paying gives no right to the collateral; the lender
 * is not offered the action; a loan past its grace period says the protocol
 * no longer accepts a repayment. Runs on the desktop and the phone project;
 * each run opens its own loans, and the suite reverts the chain (and the
 * clock a test moves) after every test.
 */
import { createWalletClient, erc20Abi, formatEther, http, maxUint256, parseEther } from 'viem';
import { openLoan, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { ANVIL_URL, increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

/** Sets the borrower's WETH allowance to the protocol directly, outside the app. */
async function setAllowance(diamond: `0x${string}`, amount: bigint): Promise<void> {
  const w = createWalletClient({ account: accountFor('borrower'), transport: http(ANVIL_URL) });
  await w.writeContract({ address: WETH, abi: erc20Abi, functionName: 'approve', args: [diamond, amount], chain: null });
  await mine();
}

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the borrower repays in full: the payoff now and at most, an exact approval, then the loan repaid, the amount paid and the approval put back', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 600, days: 30 });
  // The principal less the fee went to the borrower's vault, not the wallet,
  // so the wallet is funded for the whole payoff here: every test starts
  // from the same chain, with nothing an earlier spec left in the wallet.
  await sc.write('borrower', WETH, WETH_ABI, 'deposit', [], parseEther('0.35'));
  const borrower = sc.address('borrower');
  // Below the payoff, so the flow raises it; whatever it was is what the
  // flow puts back. A larger one is the next test's case.
  await setAllowance(sc.diamond, 0n);
  const prior = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] });
  const priorText = `${formatEther(prior)} WETH`;

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const actions = page.getByRole('region', { name: 'Actions' });
  await actions.getByTestId('repay-open').click({ timeout: 60_000 });

  const flow = page.getByTestId('repay-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Repay loan #${loanId} in full`, { timeout: 60_000 });
  await expect(receipt).toContainText('You pay, if it confirms now');
  await expect(receipt).toContainText(/At most, if it confirms by .* UTC/);
  await expect(receipt).toContainText('Principal still owed');
  await expect(receipt).toContainText('0.3 WETH');
  await expect(receipt).toContainText('Pro rata: for the time the loan has run');
  await expect(receipt).toContainText(/1,500 tLIQ, collected on Claims by the holder of borrower position #\d+/);
  await expect(receipt).toContainText(/Approve exactly 0\.3\d* WETH, the most it can take by then/);
  await expect(receipt).toContainText('The amount grows by the second until it confirms');
  await expect(receipt).toContainText(/The approval caps the amount, not the time: confirming after .* UTC, it goes through only while/);
  await expect(receipt).toContainText(`Whatever the repayment does not use of the approval is put back to ${priorText} afterwards.`);
  await expect(receipt).not.toContainText('This figure did not grow over that window');
  await expect(receipt).not.toContainText('Paying gives you no right to the collateral');
  await expect(receipt).toContainText('Wallet prompts: 2, then up to 1 more to put back the unused approval.');
  // Base Sepolia keeps no public queue, so the public-queue notice (RB-PUBLIC-QUEUE) is not shown.
  await expect(page.getByTestId('flow-public-queue')).toHaveCount(0);
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(`Loan #${loanId} repaid`);
  await expect(finish).toContainText(/Paid (≈ )?0\.3\d* WETH/);
  await expect(finish).toContainText(`Unused approval put back to ${priorText}`);
  // Approve, repay, and the put-back of what the repayment did not use.
  expect(flags.sentTransactions).toBe(sent + 3);

  // The chain agrees: repaid, and the approval back where it was.
  const after = await sc.read<{ status: number }>('getLoanDetails', [loanId]);
  expect(Number(after.status)).toBe(1);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(prior);

  // Closing the finish card leaves the loan's own page, now repaid.
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('position-status')).toHaveText('Repaid.', { timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'Actions' })).toHaveCount(0);
});

test('an unlimited standing approval is lowered to exactly the most the repayment can take, then put back', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  await sc.write('borrower', WETH, WETH_ABI, 'deposit', [], parseEther('0.06'));
  const borrower = sc.address('borrower');
  await setAllowance(sc.diamond, maxUint256);

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await page.getByRole('region', { name: 'Actions' }).getByTestId('repay-open').click({ timeout: 60_000 });
  const flow = page.getByTestId('repay-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(/Lower your approval from unlimited to exactly 0\.05\d* WETH, the most it can take by then/, { timeout: 60_000 });
  await expect(receipt).toContainText(/The approval caps the amount, not the time: confirming after .* UTC, it goes through only while/);
  await expect(receipt).toContainText('Whatever the repayment does not use of the approval is put back to unlimited afterwards.');
  await expect(receipt).toContainText('Wallet prompts: 2, then up to 1 more to put back the unused approval.');
  await fitsWidth(page);

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText(`Loan #${loanId} repaid`);
  await expect(finish).toContainText('Unused approval put back to unlimited');
  // Lower, repay, and the put-back.
  expect(flags.sentTransactions).toBe(sent + 3);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(maxUint256);
});

test('full-term interest: the payoff does not grow, so the review says a later confirmation can still go through', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30, fullTermInterest: true });
  await sc.write('borrower', WETH, WETH_ABI, 'deposit', [], parseEther('0.06'));

  const { page } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await page.getByRole('region', { name: 'Actions' }).getByTestId('repay-open').click({ timeout: 60_000 });
  const flow = page.getByTestId('repay-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText('This figure did not grow over that window, so a repayment confirming after it can still go through', { timeout: 60_000 });
  await expect(receipt).toContainText(/The approval caps the amount, not the time/);
  await fitsWidth(page);
  await flow.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('repay-open')).toBeVisible();
});

test('another wallet may repay but is told it gains no right to the collateral; the lender is not offered the action', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const { borrowerTokenId } = await sc.read<{ borrowerTokenId: bigint }>('getLoanDetails', [loanId]);
  const visitor = createWalletClient({ account: accountFor('visitor'), transport: http(ANVIL_URL) });
  await visitor.writeContract({ address: WETH, abi: WETH_ABI, functionName: 'deposit', value: parseEther('0.1'), chain: null });

  const v = await launchWallet('visitor');
  await v.page.goto(`/positions/${loanId}`);
  await connectWallet(v.page);
  await v.page.getByTestId('repay-open').click({ timeout: 60_000 });
  const receipt = v.page.getByTestId('repay-panel').locator('.receipt');
  await expect(receipt).toContainText(`Paying gives you no right to the collateral: only the holder of borrower position #${borrowerTokenId} can collect it.`, {
    timeout: 60_000,
  });
  await v.page.getByTestId('repay-panel').getByRole('button', { name: 'Cancel' }).click();
  await expect(v.page.getByTestId('repay-open')).toBeVisible();
  await v.ctx.close();

  const l = await launchWallet('lender');
  await l.page.goto(`/positions/${loanId}`);
  await connectWallet(l.page);
  const actions = l.page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByTestId('position-actions-later')).toBeVisible({ timeout: 60_000 });
  await expect(actions.getByTestId('repay-open')).toHaveCount(0);
  await expect(actions.getByTestId('repay-refusal')).toHaveCount(0);
  await l.ctx.close();
});

test('past the grace period the protocol no longer accepts a repayment, and the page says so', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  // Thirty days and a grace period that is at most thirty more.
  await increaseTime(61 * 24 * 60 * 60);
  await mine();
  const { page } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const refusal = page.getByTestId('repay-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'RepaymentPastGracePeriod', { timeout: 60_000 });
  await expect(refusal).toContainText(/The grace period ended at .* UTC, so the protocol no longer accepts a repayment; the loan goes to default\./);
  await expect(page.getByTestId('repay-open')).toHaveCount(0);
});
