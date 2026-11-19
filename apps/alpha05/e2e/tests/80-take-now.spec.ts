/**
 * Take it now at posting (#3622 B1, RB-TAKE-NOW). When an open offer on the
 * other side already fits what the reader is about to post, the page shows
 * it before the post review: taking it opens the ordinary accept review on
 * that offer's own terms, and "post anyway" opens the post review the reader
 * asked for. An offer outside any of the reader's limits is never offered.
 * Runs on the desktop and the phone project; each test posts what it reads,
 * and the chain is reverted after each test.
 */
import type { Hex } from 'viem';
import { WETH, postBorrowRequest, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** Fill the shared post form: pro-rata with partial repayment, as the
 *  fixture's offers are posted, so the two sides' options agree. */
async function fill(page: Page, amount: string, collateral: string, rate: string): Promise<void> {
  await page.getByTestId('request-amount').fill(amount);
  await page.getByTestId('request-collateral').fill(collateral);
  await page.getByTestId('request-rate').fill(rate);
  await page.getByTestId('request-prorata').check();
  await page.getByTestId('request-partial').check();
}

test('a borrower is offered a lender’s offer that fits, and chooses between taking it and posting', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const fitting = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.2', collateralTliq: '1000', rateBps: 400, days: 30 });
  // Dearer than the borrower will pay: never offered.
  const dear = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.2', collateralTliq: '1000', rateBps: 900, days: 30 });

  const { page, flags } = await launchWallet('borrower');
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  await expect(page.locator(`[data-offer-id="${fitting}"]`)).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('request-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
  await fill(page, '0.2', '1000', '5');
  await page.getByTestId('request-review').click();

  const choice = page.getByTestId('take-now');
  await expect(choice).toContainText('A lender’s offer already fits your request', { timeout: 60_000 });
  await expect(choice).toContainText('on that offer’s own terms shown below');
  await expect(choice.locator(`[data-offer-id="${fitting}"]`)).toContainText('4% a year for 30 days');
  await expect(choice.locator(`[data-offer-id="${dear}"]`)).toHaveCount(0);
  await fitsWidth(page);
  expect(flags.sentTransactions).toBe(0);

  // Post anyway: the post review the reader asked for.
  await choice.getByTestId('take-now-post').click();
  await expect(page.locator('.post-request .receipt')).toContainText('You lock in your vault now', { timeout: 60_000 });
  // Back to the form, and the choice is offered again on the next review.
  await page.locator('.post-request').getByTestId('request-edit').click();
  await page.getByTestId('request-review').click();
  await expect(page.getByTestId('take-now')).toBeVisible({ timeout: 60_000 });
  // Back to the form from the choice keeps what was typed.
  await page.getByTestId('take-now-back').click();
  await expect(page.getByTestId('request-amount')).toHaveValue('0.2');
  await page.getByTestId('request-review').click();

  // Take it now: the ordinary accept review, on the offer's own terms.
  await page.getByTestId('take-now').locator(`[data-offer-id="${fitting}"]`).getByRole('button', { name: 'Take this offer' }).click();
  const receipt = page.locator(`.accept-offer[data-offer-id="${fitting}"] .receipt`);
  await expect(receipt).toContainText('Paid into your vault, yours to withdraw', { timeout: 60_000 });
  await expect(page.getByTestId('take-now')).toHaveCount(0);
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);
});

test('a lender is offered a borrow request that fits; a request outside its limits goes straight to the post review', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const fitting = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.2', collateralTliq: '1000', rateBps: 600, days: 30 });

  const { page } = await launchWallet('lender');
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  await expect(page.locator(`[data-offer-id="${fitting}"]`)).toBeVisible({ timeout: 60_000 });
  // #3761: the Lend form opens on Auto-lend; this flow posts a one-time offer.
  await page.getByTestId('lend-choice-once').check();
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });

  // Asking more collateral than the request locks: no choice.
  await fill(page, '0.2', '1200', '5');
  await page.getByTestId('request-review').click();
  await expect(page.locator('.post-request')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('take-now')).toHaveCount(0);
  await page.locator('.post-request').getByTestId('request-edit').click();

  // Inside its limits: the request is offered first.
  await page.getByTestId('request-collateral').fill('1000');
  await page.getByTestId('request-review').click();
  const choice = page.getByTestId('take-now');
  await expect(choice).toContainText('A borrower’s request already fits your offer', { timeout: 60_000 });
  await expect(choice.locator(`[data-offer-id="${fitting}"]`)).toContainText('6% a year');
  await fitsWidth(page);
  await choice.locator(`[data-offer-id="${fitting}"]`).getByRole('button', { name: 'Fund this request' }).click();
  await expect(page.locator(`.accept-offer[data-offer-id="${fitting}"] .receipt`)).toContainText(`Fund request #${fitting}`, { timeout: 60_000 });
});
