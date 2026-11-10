/**
 * Repay, the grace clock (#3412, RB-GRACE-CLOCK), against loans opened
 * through the protocol's public entry points on the fixture chain. Before
 * the due date a repayment shows no clock. In grace it counts down to the
 * end of grace by the chain's clock and says to send early, since a default
 * filed after grace ends and a late repayment race, and whichever is mined
 * first wins; with an hour or less left it says to send now. The part
 * payment shows the same clock. Runs on the desktop and the phone project;
 * the suite reverts the chain and the clock after every test.
 */
import { openLoan } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Moves the chain clock to `at` (unix seconds), never backwards. */
async function chainTo(sc: ReturnType<typeof scenario>, at: bigint): Promise<void> {
  const block = await sc.pub.getBlock();
  const gap = Number(at - block.timestamp);
  if (gap > 0) await increaseTime(gap);
  await mine();
}

async function openRepay(page: Page, loanId: bigint) {
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await page.getByRole('region', { name: 'Actions' }).getByTestId('repay-open').click({ timeout: 60_000 });
  const panel = page.getByTestId('repay-panel');
  await expect(panel.locator('.receipt')).toContainText(`Repay loan #${loanId} in full`, { timeout: 60_000 });
  return panel;
}

test('no clock before the due date; in grace it counts down to the end and says to send early', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const [, , maturity, graceEnd] = await sc.read<readonly [bigint, bigint, bigint, bigint]>('getLoanDeadlines', [loanId]);

  const { page } = await launchWallet('borrower');
  const before = await openRepay(page, loanId);
  await expect(before.getByTestId('grace-clock')).toHaveCount(0);
  await before.getByRole('button', { name: 'Cancel' }).click();

  await chainTo(sc, maturity + 3600n);
  const panel = await openRepay(page, loanId);
  const clock = panel.getByTestId('grace-clock');
  await expect(clock).toHaveAttribute('data-kind', 'running', { timeout: 60_000 });
  await expect(clock).toContainText(/This loan is in its grace period, which ends at .* UTC, .+ from now\./);
  await expect(clock).toContainText('anyone can file a default; whichever transaction is mined first wins, so send the repayment well before then.');
  expect(graceEnd).toBeGreaterThan(maturity);
  await fitsWidth(page);
});

test('with an hour or less of grace left, the clock says to send now', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const [, , , graceEnd] = await sc.read<readonly [bigint, bigint, bigint, bigint]>('getLoanDeadlines', [loanId]);
  await chainTo(sc, graceEnd - 1800n);

  const { page } = await launchWallet('borrower');
  const clock = (await openRepay(page, loanId)).getByTestId('grace-clock');
  await expect(clock).toHaveAttribute('data-kind', 'urgent', { timeout: 60_000 });
  await expect(clock).toContainText(/Less than an hour of the grace period is left: it ends at .* UTC, \d+ min from now\./);
  await expect(clock).toContainText('A repayment still waiting to be mined then is refused with nothing moved, and the loan can be defaulted, so send it now.');
  await fitsWidth(page);
});

test('a part payment in grace shows the same clock', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 600, days: 30 });
  const [, , maturity] = await sc.read<readonly [bigint, bigint, bigint, bigint]>('getLoanDeadlines', [loanId]);
  await chainTo(sc, maturity + 86_400n);

  const { page } = await launchWallet('borrower');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await page.getByTestId('partial-open').click({ timeout: 60_000 });
  await page.getByTestId('partial-amount').fill('0.01');
  await page.getByTestId('partial-review').click();
  const clock = page.getByTestId('partial-panel').getByTestId('grace-clock');
  await expect(clock).toHaveAttribute('data-kind', 'running', { timeout: 60_000 });
  await expect(clock).toContainText(/This loan is in its grace period, which ends at .* UTC/);
  await fitsWidth(page);
});
