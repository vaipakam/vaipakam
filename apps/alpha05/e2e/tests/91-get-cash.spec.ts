/**
 * #3763 / #3760 — "Get cash from this loan", the lender position's one door
 * for getting lent funds back before the due date, against loans opened
 * through the protocol's public entry points on the fixture chain. Sell now
 * finds a standing buy offer and states what the lender receives (the
 * sale's own figure), and the sale goes through one reviewed transaction;
 * Sell at my price quotes the least the lender receives as the rate is
 * typed, lists the loan, and afterwards the door says listing is not open,
 * in the protocol's words, with when it can open again. Runs on the desktop
 * and the phone project; the chain is reverted after each test.
 */
import type { Page } from '@playwright/test';
import { openLoan, postLenderOffer, waitOutTermsAge } from '@vaipakam/anvil-harness/lending';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const terms = { principalWeth: '0.5', collateralTliq: '15000', rateBps: 800, days: 30 };

async function openDoor(page: Page, loanId: bigint): Promise<void> {
  await page.goto(`/positions/${loanId}`);
  await connectWallet(page);
  await expect(page.getByTestId('position-status')).toHaveText('Active: the loan is running.', { timeout: 60_000 });
  await page.getByTestId('get-cash-open').click();
  await expect(page.getByTestId('get-cash-leave')).toBeVisible();
}

test('sell now: a standing buy offer is found, its figure stated, and the sale goes through one review', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', ...terms });
  await anvilRpc('evm_increaseTime', [5 * 86_400]);
  await anvilRpc('evm_mine');
  const buyOfferId = await postLenderOffer(sc, { lender: 'other', ...terms });
  const { termsSetAt } = await sc.read<{ termsSetAt: bigint }>('getOffer', [buyOfferId]);
  await waitOutTermsAge(sc, termsSetAt);

  const { page } = await launchWallet('lender');
  await openDoor(page, loanId);
  const sale = page.getByTestId('get-cash-sale');
  await expect(sale).toHaveAttribute('data-offer', buyOfferId.toString(), { timeout: 90_000 });
  // Same rate as the loan: no interest difference, so the lender nets the principal.
  await expect(sale).toHaveAttribute('data-net', '500000000000000000');
  await expect(sale).toContainText('You receive 0.5 WETH into your vault now.');
  await expect(sale).toContainText('Interest earned and not yet paid stays yours.');
  await fitsWidth(page);

  await sale.getByTestId('get-cash-sale-go').click();
  const flow = page.getByTestId('get-cash-sale-panel');
  await expect(flow).toContainText('Sell this loan into a standing offer', { timeout: 60_000 });
  await expect(flow).toContainText(`#${buyOfferId}, at 8% a year`);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(flow.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(flow).toContainText('Sold: the loan has a new lender');
});

test('sell at my price: the quote follows the typed rate, the listing goes through, and the door then says listing is not open', async ({ launchWallet }) => {
  test.setTimeout(240_000);
  const sc = scenario();
  const { loanId } = await openLoan(sc, { lender: 'lender', borrower: 'borrower', ...terms });

  const { page } = await launchWallet('lender');
  await openDoor(page, loanId);
  await expect(page.getByTestId('get-cash-now-none')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('get-cash-list-go').click();
  const form = page.getByTestId('get-cash-list-form');
  await form.getByTestId('get-cash-rate').fill('9');
  await form.getByTestId('get-cash-days').fill('7');
  await expect(form.getByTestId('get-cash-quote')).toContainText('If it fills, you receive at least', { timeout: 60_000 });
  await fitsWidth(page);
  await form.getByTestId('get-cash-list-review').click();

  const flow = page.getByTestId('get-cash-list-panel');
  await expect(flow).toContainText('List this loan for sale', { timeout: 60_000 });
  await expect(flow).toContainText('7 days, or to the due date if sooner');
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(flow.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  await expect(flow).toContainText('Listed for sale');

  await flow.getByRole('button', { name: 'Close' }).first().click();
  const closed = page.getByTestId('get-cash-list-closed');
  await expect(closed).toBeVisible({ timeout: 90_000 });
  await expect(closed.locator('li').first()).toHaveAttribute('data-code', 'SaleOfferAlreadyExists');
});
