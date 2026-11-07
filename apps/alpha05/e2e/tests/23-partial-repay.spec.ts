/**
 * Position, pay part of a loan (matrix LN-22, LN-64), against loans opened
 * through the protocol's public entry points on the fixture chain. The
 * borrower chooses a principal part, checked against the protocol's own
 * bounds as it is typed (at least the minimum part, less than the whole
 * principal); the review states the part, the interest it adds (exact on a
 * pro-rata loan before its due date, "at most" past it) and the principal
 * left; the wallet approves exactly the most it can take; and the finish
 * card reports the MEASURED outcome: the principal at the receipt's block,
 * what left the wallet, and the unused approval put back. The lender is not
 * offered the action, and a loan whose terms do not allow it says so. Runs
 * on the desktop and the phone project; each run opens its own loans, and
 * the clock is moved only inside a snapshot the test reverts.
 */
import { erc20Abi, formatEther, parseEther } from 'viem';
import { openLoan, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc, increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the borrower pays part: the amount checked against the protocol bounds, exact interest, then the principal lowered and the approval put back', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 600, days: 30 });
  await sc.write('borrower', WETH, WETH_ABI, 'deposit', [], parseEther('0.2'));
  const borrower = sc.address('borrower');
  // Below the reviewed maximum, so the flow raises it (another spec can
  // leave a larger one, which the flow would lower instead).
  await sc.write('borrower', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);
  const prior = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] });
  const priorText = `${formatEther(prior)} WETH`;

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  const actions = page.getByRole('region', { name: 'Actions' });
  await actions.getByTestId('partial-open').click({ timeout: 60_000 });

  // The form: the whole principal is a full repayment, and a part needs an
  // amount.
  const form = page.getByTestId('partial-form');
  await expect(form).toContainText('How much of the principal to pay');
  await expect(form).toContainText(/less than the 0\.3 WETH still owed\./);
  await expect(form).toContainText('The interest accrued so far is added on top.');
  const amount = form.getByTestId('partial-amount');
  await amount.fill('0.3');
  await expect(form).toContainText('That is the whole 0.3 WETH still owed: use Repay in full instead.');
  await amount.fill('0.1');
  await expect(form.locator('.field-error')).toHaveCount(0);
  await fitsWidth(page);
  await form.getByTestId('partial-review').click();

  const flow = page.getByTestId('partial-panel');
  const receipt = flow.locator('.receipt');
  await expect(receipt).toContainText(`Pay part of loan #${loanId}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Principal you pay');
  await expect(receipt).toContainText('Interest, if it confirms now');
  await expect(receipt).toContainText(/Interest, if it confirms by .* UTC/);
  await expect(receipt).toContainText('Principal still owed after');
  await expect(receipt).toContainText('0.2 WETH');
  await expect(receipt).toContainText(/, unchanged/);
  await expect(receipt).toContainText('The holder of the lender position, straight away');
  await expect(receipt).toContainText(/Approve exactly 0\.1\d* WETH, the most it can take by then/);
  await expect(receipt).toContainText('The interest is what has accrued since it was last paid');
  await expect(receipt).toContainText(/Paying part never moves the due date: the rest is still owed by .* UTC\./);
  await expect(receipt).not.toContainText(/At most (≈ )?\d/);
  await expect(receipt).toContainText('Wallet prompts: 2, then up to 1 more to put back the unused approval.');
  await fitsWidth(page);

  // Changing the amount goes back to the form with the amount kept.
  await flow.getByTestId('partial-change').click();
  await expect(page.getByTestId('partial-amount')).toHaveValue('0.1');
  await page.getByTestId('partial-review').click();
  await expect(flow.locator('.receipt')).toContainText(`Pay part of loan #${loanId}`, { timeout: 60_000 });

  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Principal now 0.2 WETH');
  await expect(finish).toContainText(/Paid (≈ )?0\.1\d* WETH/);
  await expect(finish).toContainText(`Unused approval put back to ${priorText}`);
  expect(flags.sentTransactions).toBe(sent + 3);

  // The chain agrees: still active, with the principal lowered by the part.
  const after = await sc.read<{ status: number; principal: bigint }>('getLoanDetails', [loanId]);
  expect(Number(after.status)).toBe(0);
  expect(after.principal).toBe(parseEther('0.2'));
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(prior);

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('partial-open')).toBeVisible({ timeout: 60_000 });
});

test('past the due date the interest reads at most, and the review says why', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  await sc.write('borrower', WETH, WETH_ABI, 'deposit', [], parseEther('0.05'));
  const snapshot = await anvilRpc<string>('evm_snapshot');
  try {
    // A day past the due date, inside the grace period.
    await increaseTime(31 * 24 * 60 * 60);
    await mine();
    const { page } = await launchWallet('borrower');
    await page.goto(`/positions/${loanId}`);
    await connectWallet(page);
    await page.getByTestId('partial-open').click({ timeout: 60_000 });
    await page.getByTestId('partial-amount').fill('0.01');
    await page.getByTestId('partial-review').click();
    const receipt = page.getByTestId('partial-panel').locator('.receipt');
    await expect(receipt).toContainText(/At most (≈ )?0\.\d+ WETH/, { timeout: 60_000 });
    await expect(receipt).toContainText('Past the due date that also counts a late fee, which a part payment does not charge, so it is an upper bound');
    await fitsWidth(page);
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});

test('the lender is not offered paying part, and a loan whose terms do not allow it says so to the borrower', async ({ launchWallet }) => {
  const sc = scenario();
  const open = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const l = await launchWallet('lender');
  await l.page.goto(`/positions/${open.loanId}`);
  await connectWallet(l.page);
  const actions = l.page.getByRole('region', { name: 'Actions' });
  await expect(actions.getByTestId('position-actions-later')).toBeVisible({ timeout: 60_000 });
  await expect(actions.getByTestId('partial-open')).toHaveCount(0);
  await expect(actions.getByTestId('partial-refusal')).toHaveCount(0);
  await l.ctx.close();

  const closed = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30, allowsPartialRepay: false });
  const b = await launchWallet('borrower');
  await b.page.goto(`/positions/${closed.loanId}`);
  await connectWallet(b.page);
  const refusal = b.page.getByTestId('partial-refusal');
  await expect(refusal).toHaveAttribute('data-code', 'PartialRepayNotAllowed', { timeout: 60_000 });
  await expect(refusal).toContainText('This loan’s terms do not allow paying part of it; that was fixed when it opened.');
  await expect(b.page.getByTestId('partial-open')).toHaveCount(0);
  await expect(b.page.getByTestId('repay-open')).toBeVisible();
  await b.ctx.close();
});
