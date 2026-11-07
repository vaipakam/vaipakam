/**
 * Position, one loan read-only (matrix LN-04, LN-07, LN-08, LN-09, LN-10,
 * LN-11, LN-12), against loans opened and repaid through the protocol's
 * public entry points on the fixture chain. Runs on the desktop and the phone
 * project; each run opens its own loans.
 */
import type { Locator } from '@playwright/test';
import { openLoan, repayInFull } from '@vaipakam/anvil-harness/lending';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

/** The value beside a fact's label (exact label match). */
const fact = (section: Locator, label: string) =>
  section
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
    .locator('xpath=following-sibling::dd[1]');

test('an address that names no loan says so', async ({ launchWallet }) => {
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/positions/abc');
  await expect(page.getByText('This address does not name a loan.')).toBeVisible();
});

test('a live loan states its status, the reader’s role, its dates, terms, health and collateral; a loan that does not exist says so', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.6', collateralTliq: '3000', rateBps: 525, days: 30 });

  for (const [role, expected] of [
    ['borrower', 'borrower'],
    ['lender', 'lender'],
    ['visitor', 'none'],
  ] as const) {
    const { page, ctx } = await launchWallet(role);
    await page.goto(`/positions/${loanId}`);
    await connectWallet(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Loan #${loanId}`);
    const status = page.getByTestId('position-status');
    await expect(status).toHaveText('Active: the loan is running.', { timeout: 60_000 });
    await expect(page.getByTestId('position-role')).toHaveAttribute('data-role', expected);

    const dates = page.getByRole('region', { name: 'Dates' });
    await expect(fact(dates, 'Due date of this term, before pause credit')).toHaveText(/UTC/);
    await expect(fact(dates, 'Pause credit')).toHaveText('None');
    await expect(fact(dates, 'Grace period ends')).toHaveText(/UTC/);

    const terms = page.getByRole('region', { name: 'Terms' });
    await expect(fact(terms, 'Principal still owed')).toHaveText('0.6 WETH');
    await expect(fact(terms, 'Interest rate')).toHaveText('5.25% a year');
    await expect(fact(terms, 'Term')).toHaveText('30 days');
    await expect(fact(terms, 'Interest')).toHaveText(/^(Full term|Pro rata)/);
    await expect(fact(terms, 'Interest schedule')).toHaveText('All at repayment');
    await expect(fact(terms, "Protocol's share of interest")).toHaveText(/%, fixed when the loan opened$/);
    await expect(fact(terms, 'Collateral')).toHaveText('3,000 tLIQ');

    const health = page.getByRole('region', { name: 'Health' });
    await expect(fact(health, 'Health factor')).toHaveText(/^\d/);
    await expect(fact(health, 'Liquidation threshold')).toHaveText(/% loan-to-value, fixed when the loan opened$/);
    // The internal-match band is stated from the protocol: a band, or that matching is off or holds none.
    await expect(fact(health, 'Held for an internal match')).toHaveText(/^(From \d.*% loan-to-value; an outside sale opens at .*%|No: .*)$/);

    const held = page.getByRole('region', { name: 'Collateral held' });
    await expect(fact(held, 'Amount')).toHaveText('3,000 tLIQ');
    await expect(fact(held, 'Where it is')).toHaveText(/^Held for this loan in the vault of 0x/);
    await expect(page.getByTestId('position-actions-later')).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    if (role === 'visitor') {
      await page.goto('/positions/999999999');
      await expect(page.getByText(/^No loan #999999999 exists on /)).toBeVisible({ timeout: 60_000 });
    }
    await ctx.close();
  }
});

test('a repaid loan states it, with no dates to meet and its collateral held until its claim is collected', async ({ launchWallet }) => {
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.15', collateralTliq: '750', rateBps: 400, days: 30 });
  await repayInFull(sc, 'borrower', loanId);
  const { page } = await launchWallet('lender');
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await expect(page.getByTestId('position-status')).toHaveText('Repaid.', { timeout: 60_000 });
  await expect(page.getByTestId('position-status')).toHaveAttribute('data-status', 'repaid');
  await expect(page.getByRole('region', { name: 'Dates' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Health' })).toHaveCount(0);
  await expect(fact(page.getByRole('region', { name: 'Terms' }), 'Principal on the loan when it ended')).toHaveText('0.15 WETH');
  await expect(fact(page.getByRole('region', { name: 'Collateral held' }), 'Where it is')).toHaveText(/^Held in the vault of 0x.* until its claim is collected on Claims$/);
});
