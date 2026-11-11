/**
 * The rate desk, slice 3 (matrix OFF-76): below a market's activity, the
 * viewer's own live loans in that market, read from its own chain read of
 * its positions, each with its health reading and a way into the loan; and
 * the viewer's desk history from the index, every token loan against token
 * collateral it has held a side of, newest participation first, with the
 * status on record. Two loans open between the lender and the borrower, in
 * two markets (14 and 30 days); the lender's live loans in the 14-day market
 * list only that market's loan, while its history lists both. A wallet with
 * no loan sees that it has none, and with the index down the history says it
 * could not be read instead of showing nothing. Runs on the desktop and the
 * phone; the chain is reverted after each test.
 */
import type { Page } from '@playwright/test';
import { openLoan, WETH } from '@vaipakam/anvil-harness/lending';
import { scenario } from '../lib/chain';
import { setIndexPosture } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

function marketOf(tliq: string, days: number): string {
  return `${WETH.toLowerCase()}-${tliq.toLowerCase()}-${days}`;
}

test('a market lists the viewer’s live loans in it, and the history lists every desk loan the viewer held a side of', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, string>).liquidToken!;
  const short = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.02', collateralTliq: '100', rateBps: 480, days: 14 });
  const long = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.03', collateralTliq: '150', rateBps: 520, days: 30 });

  const { page } = await launchWallet('lender', { advanced: true });
  await page.goto(`/desk?market=${marketOf(tliq, 14)}`);
  await connectWallet(page);

  // Live loans in the selected market only: the 14-day loan, on the lender's side.
  const loans = page.getByTestId('desk-loans');
  const loan = loans.getByTestId('desk-loan');
  await expect(loan).toHaveCount(1, { timeout: 60_000 });
  await expect(loan).toHaveAttribute('data-loan-id', short.loanId.toString());
  await expect(loan).toHaveAttribute('data-side', 'lender');
  await expect(loan).toContainText(`Loan #${short.loanId}: you lent 0.02 WETH at 4.8% a year.`);
  await expect(loan.getByTestId('desk-loan-health')).toContainText(/Health factor|No health reading/);
  // The live loans carry their own read's age and a refresh, apart from the index's freshness.
  await expect(loans.locator('.stamp')).toBeVisible();
  await expect(loans.locator('.stamp').getByRole('button')).toBeVisible();
  await expect(loan.getByRole('link', { name: `Manage loan #${short.loanId}` })).toHaveAttribute('href', `/positions/${short.loanId}`);

  // The history: both loans, newest participation first, with the status on record.
  const history = page.getByTestId('desk-history');
  const rows = history.getByTestId('desk-history-row');
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  await expect(rows.nth(0)).toHaveAttribute('data-loan-id', long.loanId.toString());
  await expect(rows.nth(1)).toHaveAttribute('data-loan-id', short.loanId.toString());
  for (const i of [0, 1]) {
    await expect(rows.nth(i)).toHaveAttribute('data-status', 'active');
    await expect(rows.nth(i)).toHaveAttribute('data-lent', 'true');
    await expect(rows.nth(i)).toHaveAttribute('data-borrowed', 'false');
    await expect(rows.nth(i)).toContainText('You lent. Status on record: active.');
  }
  await expect(rows.nth(0)).toContainText(`Loan #${long.loanId}, WETH against`);
  await expect(rows.nth(0)).toContainText('30-day term');
  await expect(rows.nth(0).getByRole('link')).toHaveAttribute('href', `/positions/${long.loanId}`);
  await expect(history.getByTestId('desk-history-end')).toBeVisible();
  await expect(history.getByTestId('desk-history-older')).toHaveCount(0);
  await fitsWidth(page);

  // Moving to the 30-day market lists that market's loan instead.
  await page.goto(`/desk?market=${marketOf(tliq, 30)}`);
  await expect(page.getByTestId('desk-loan')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('desk-loan')).toHaveAttribute('data-loan-id', long.loanId.toString());
});

test('a wallet with no desk loan sees that it has none, and with the index down the history says it could not be read', async ({ launchWallet }) => {
  test.setTimeout(360_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, string>).liquidToken!;
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.02', collateralTliq: '100', rateBps: 480, days: 14 });

  const { page } = await launchWallet('freshLender', { advanced: true });
  await page.goto(`/desk?market=${marketOf(tliq, 14)}`);
  await connectWallet(page);
  await expect(page.getByTestId('desk-loans-none')).toHaveText('You hold no side of a live loan in this market.', { timeout: 60_000 });
  await expect(page.getByTestId('desk-history-none')).toHaveText('The index holds no desk loan you have taken a side of.', { timeout: 60_000 });
  await expect(page.getByTestId('desk-history-row')).toHaveCount(0);
  await fitsWidth(page);

  await setIndexPosture('down');
  // The next poll fails over the cached empty list: the warning stands and the
  // list no longer claims the index holds nothing.
  await expect(page.getByTestId('desk-history-failed')).toContainText('could not be re-read', { timeout: 150_000 });
  await expect(page.getByTestId('desk-history-none')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('desk-history-failed')).toContainText('nothing here means no loans', { timeout: 60_000 });
  await expect(page.getByTestId('desk-history-none')).toHaveCount(0);
  await fitsWidth(page);
});
