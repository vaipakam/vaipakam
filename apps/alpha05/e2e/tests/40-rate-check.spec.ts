/**
 * The rate warning before posting (#3357, RB-RATE-CHECK): the offer's rate
 * beside the middle rate of recent loans on the same pair and term, read
 * from the index. Two loans are opened at 8% on an unusual term (45 days,
 * so no other spec's loans share it), then the lender's form shows a near
 * rate as a note, a far one either side as a warning that says which way it
 * cuts, a term with no loans as "nothing to compare", and an index that is
 * down as "not compared". The borrower's form gets its own side's warning.
 * Nothing is posted; the loans last until the suite reverts the chain after
 * the test.
 */
import type { Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { openLoan } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { setIndexPosture, setUnplacedLoans } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function openForm(page: Page, side: 'lend' | 'borrow', collateral: Hex): Promise<void> {
  await page.goto(`/${side}`);
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId(side === 'lend' ? 'lend-offer-open' : 'request-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
}

async function term(page: Page, days: number): Promise<void> {
  await page.getByTestId('request-duration').getByRole('radio', { name: 'Other' }).check();
  await page.getByTestId('request-term-days').fill(String(days));
}

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.afterEach(async () => {
  await setIndexPosture('live');
  await setUnplacedLoans(0, false);
});

test('the rate warning compares an offer with recent loans on its pair and term, and never blocks', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 800, days: 45 });
  await openLoan(sc, { lender: 'lender', borrower: 'borrower', principalWeth: '0.1', collateralTliq: '500', rateBps: 800, days: 45 });

  const { page } = await launchWallet('lender');
  await openForm(page, 'lend', tliq);
  await term(page, 45);
  const check = page.getByTestId('rate-check');

  // Before a rate is typed, the recent middle rate is shown as a note.
  await expect(check).toContainText('a middle rate of 8% a year, 2 loans, 30 days', { timeout: 30_000 });

  // Within five points: a note, no warning.
  await page.getByTestId('request-rate').fill('8.5');
  await expect(check).toContainText('a middle rate of 8% a year');
  await expect(check).not.toHaveAttribute('data-verdict', 'far');

  // Far above, from a lender: the offer may sit untaken.
  await page.getByTestId('request-rate').fill('14');
  await expect(check).toHaveAttribute('data-verdict', 'far');
  await expect(check).toContainText('At 14% your rate is more than five points above the middle rate');
  await expect(check).toContainText('borrowers may pass it by');

  // Far below, from a lender: the offer is the one taken first.
  await page.getByTestId('request-rate').fill('2');
  await expect(check).toContainText('A lender’s offer this far under the market is the one taken first');
  await fitsWidth(page);

  // It warns; the review still opens.
  await expect(page.getByTestId('request-review')).toBeEnabled();

  // An offer that never lapses is told it keeps its rate as the market moves.
  await page.getByTestId('request-expiry').selectOption('never');
  await expect(page.getByTestId('request-expiry-never')).toContainText('keeps its rate as the market moves');
  await page.getByTestId('request-expiry').selectOption('7d');
  await expect(page.getByTestId('request-expiry-never')).toHaveCount(0);

  // Another term with no loans: nothing to compare, said so.
  await term(page, 46);
  await expect(check).toContainText('No confirmed loans on this pair and term in the last 30 days', { timeout: 30_000 });

  // Loans on the pair whose terms the index has not confirmed are stated,
  // so "no confirmed loans" never hides loans whose term is unknown.
  await setUnplacedLoans(3, false);
  await term(page, 48);
  await expect(check).toContainText('3 loans on this pair have terms the index has not confirmed; they are not compared.', { timeout: 30_000 });
  await setUnplacedLoans(0, false);

  // The index down: not compared, and the reason given.
  await setIndexPosture('down');
  await term(page, 47);
  await expect(check).toContainText('Recent rates could not be read', { timeout: 30_000 });
  await expect(check).toContainText('so this rate is not compared');
  await setIndexPosture('live');

  // The borrower's side: a request far over the market is taken quickly.
  const borrower = await launchWallet('borrower');
  await openForm(borrower.page, 'borrow', tliq);
  await term(borrower.page, 45);
  await borrower.page.getByTestId('request-rate').fill('14');
  const bcheck = borrower.page.getByTestId('rate-check');
  await expect(bcheck).toHaveAttribute('data-verdict', 'far', { timeout: 30_000 });
  await expect(bcheck).toContainText('A request this far over the market is taken quickly');
  await fitsWidth(borrower.page);
});
