/**
 * The rate desk, slice 2 (matrix OFF-75): below a market's ladder, the
 * viewer's own offers with how much of each was taken, the market's recent
 * loans (the fills tape) and the rates loans were agreed at over time (the
 * executed-rate chart). Two loans open in one market (WETH against tLIQ,
 * 14 days) two days apart, at 4.8% and then 5.2%; the lender leaves an
 * offer at 5.5% open and the borrower a request at 4.5%. The tape lists the
 * loans newest first at the rates agreed when they opened, with the last
 * rate on top; the chart draws two steps that are not joined (no loan was
 * agreed between them), the ladder's middle rate as a labelled reference,
 * and the same figures in a table; the period choice is kept in the page
 * address. A market with no loan says so, the count of loans on the pair
 * whose term the index has not confirmed is stated, and with the index down
 * the tape and the chart say they could not be read instead of showing
 * nothing. Runs on the desktop and the phone; the chain is reverted after
 * each test.
 */
import type { Page } from '@playwright/test';
import { openLoan, postBorrowRequest, postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { setIndexPosture, setUnplacedLoans } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

function marketOf(tliq: string, days: number): string {
  return `${WETH.toLowerCase()}-${tliq.toLowerCase()}-${days}`;
}

test('a market’s own offers, recent loans and agreed-rate chart read the terms set at opening, and gaps are not drawn over', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, string>).liquidToken!;
  const first = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.02', collateralTliq: '100', rateBps: 480, days: 14 });
  await increaseTime(2 * 86_400);
  await mine();
  const second = await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.03', collateralTliq: '150', rateBps: 520, days: 14 });
  const open = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 550, days: 14 });
  await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.02', collateralTliq: '100', rateBps: 450, days: 14 });
  const market = marketOf(tliq, 14);

  const { page } = await launchWallet('lender', { advanced: true });
  await page.goto(`/desk?market=${market}`);
  await connectWallet(page);

  // The lender's own offer on the ladder, with nothing taken yet.
  const order = page.getByTestId('desk-order');
  await expect(order).toHaveCount(1, { timeout: 60_000 });
  await expect(order).toHaveAttribute('data-offer-id', open.toString());
  await expect(order).toContainText(`Offer #${open}: you lend at 5.5% a year`);
  await expect(order).toContainText('Nothing taken yet; 0.05 WETH open');

  // The tape: newest loan first, at the rate and amount agreed at opening.
  const tape = page.getByTestId('desk-tape');
  const fills = tape.getByTestId('desk-fill');
  await expect(fills).toHaveCount(2, { timeout: 60_000 });
  await expect(fills.nth(0)).toHaveAttribute('data-loan-id', second.loanId.toString());
  await expect(fills.nth(0)).toContainText(`Loan #${second.loanId}: 5.2% a year, 0.03 WETH lent`);
  await expect(fills.nth(1)).toHaveAttribute('data-loan-id', first.loanId.toString());
  await expect(fills.nth(1)).toContainText('4.8% a year, 0.02 WETH lent');
  await expect(tape.getByTestId('desk-tape-last')).toContainText(/Last loan agreed at 5\.2% a year, .+ ago\./);
  await expect(tape.getByTestId('desk-unplaced')).toHaveCount(0);

  // The chart: two periods with a loan, two days apart, drawn as two steps
  // that are not joined, and the ladder's middle as a labelled reference.
  const chart = page.getByTestId('desk-chart');
  await expect(chart).toHaveAttribute('data-period', '30d');
  await expect(chart.getByTestId('desk-chart-period')).toHaveCount(2, { timeout: 60_000 });
  await expect(chart.getByTestId('desk-chart-run')).toHaveCount(2);
  await expect(chart.getByTestId('desk-chart-middle')).toContainText('Middle now 5%');
  await expect(chart).not.toContainText(/[+-]\d+(\.\d+)?%\s*(change|today)/i);
  await chart.getByTestId('desk-chart-period').nth(1).hover();
  const tip = chart.getByTestId('desk-chart-tip');
  await expect(tip).toContainText('First 5.2%, high 5.2%, low 5.2%, last 5.2%');
  await expect(tip).toContainText('Loans agreed: 1');
  await expect(tip).toContainText('Amounts lent added up: 0.03 WETH');
  await chart.getByTestId('desk-chart-table').locator('summary').click();
  const rows = chart.getByTestId('desk-candle-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-close', '520');
  await expect(rows.nth(1)).toHaveAttribute('data-close', '480');
  await fitsWidth(page);

  // The period is kept in the page address beside the market.
  await chart.getByTestId('desk-period-7d').click();
  await expect(page).toHaveURL(/period=7d/);
  await expect(page).toHaveURL(new RegExp(`market=${market}`));
  await expect(chart).toHaveAttribute('data-period', '7d');
  await expect(chart.getByTestId('desk-chart-run')).toHaveCount(2);
  await expect(page.getByTestId('desk-period-7d')).toHaveAttribute('aria-pressed', 'true');

  // Loans on the pair whose term the index has not confirmed are counted.
  await setUnplacedLoans(3, false);
  await page.reload();
  await expect(tape.getByTestId('desk-unplaced')).toContainText('3 loans on this token pair have terms the index has not confirmed', { timeout: 60_000 });
  await fitsWidth(page);
});

test('a market with no loan says so, and with the index down the tape and the chart say they could not be read', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, string>).liquidToken!;
  await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.04', collateralTliq: '200', rateBps: 600, days: 30 });
  const market = marketOf(tliq, 30);

  const { page } = await launchWallet('borrower', { advanced: true });
  await page.goto(`/desk?market=${market}`);
  await connectWallet(page);
  await expect(page.getByTestId('desk-tape-none')).toHaveText('The index holds no loan agreed in this market.', { timeout: 60_000 });
  await expect(page.getByTestId('desk-chart-none')).toHaveText('No loan was agreed in this market in this period.');
  await expect(page.getByTestId('desk-rate-chart')).toHaveCount(0);
  // The borrower has no offer on this ladder.
  await expect(page.getByTestId('desk-orders-none')).toBeVisible();
  await fitsWidth(page);

  await setIndexPosture('down');
  await page.reload();
  await expect(page.getByTestId('desk-tape-failed')).toContainText('nothing here means no loans', { timeout: 60_000 });
  await expect(page.getByTestId('desk-chart-failed')).toContainText('an empty chart here means nothing');
  await expect(page.getByTestId('desk-tape-none')).toHaveCount(0);
  await expect(page.getByTestId('desk-chart-none')).toHaveCount(0);
  await fitsWidth(page);
});
