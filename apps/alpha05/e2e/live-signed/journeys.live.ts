/**
 * Signed live journeys against the deployed site (#3180). Each journey drives
 * the real pages with the dev test wallets and reads the measured outcome the
 * page reports; nothing is stubbed. Test tokens are minted to the wallets
 * first (the testnet mocks mint to anyone). Every amount is small.
 */
import type { Page } from '@playwright/test';
import { MUSDC, TLIQ, clearGates, connectWallet, expect, fund, settled, test } from './fixture';

test.describe.configure({ mode: 'serial' });

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function pickPair(page: Page, path: '/lend' | '/borrow'): Promise<void> {
  await page.goto(path);
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(MUSDC);
  await page.getByTestId('pick-collateral').locator('select').selectOption(TLIQ);
}

/** Fill the shared post form and open its review, passing any first-time steps. */
async function fillAndReview(page: Page, amount: string, collateral: string, rate: string): Promise<void> {
  await expect(page.getByTestId('request-duration')).toBeVisible();
  await page.getByTestId('request-amount').fill(amount);
  await page.getByTestId('request-collateral').fill(collateral);
  await page.getByTestId('request-rate').fill(rate);
  const expiry = page.getByTestId('request-expiry');
  if (await expiry.isVisible()) await expiry.selectOption('1d');
  const partial = page.getByTestId('request-partial');
  if (await partial.isVisible()) await partial.check();
  await fitsWidth(page);
  await page.getByTestId('request-review').click();
  await clearGates(page);
  const takeNow = page.getByTestId('take-now');
  if (await takeNow.isVisible()) await takeNow.getByTestId('take-now-post').click();
}

/** Post from the open review and return the new offer's id. */
async function post(page: Page): Promise<bigint> {
  const flow = page.locator('.post-request');
  await expect(flow.locator('.receipt')).toBeVisible();
  await fitsWidth(page);
  await flow.getByTestId('request-consent').check();
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = await settled(flow);
  const id = (await finish.textContent())!.match(/(?:Offer|Request) #(\d+)/)?.[1];
  expect(id, 'the measured outcome names the offer').toBeTruthy();
  return BigInt(id!);
}

let loanId: bigint;

test('a lender posts an offer and a borrower takes it: a live loan opens', async ({ launchWallet }) => {
  await fund(['lender', 'borrower']);
  const l = await launchWallet('lender');
  await pickPair(l.page, '/lend');
  await l.page.getByTestId('lend-offer-open').click();
  await fillAndReview(l.page, '100', '0.2', '6');
  const offerId = await post(l.page);

  const b = await launchWallet('borrower');
  await pickPair(b.page, '/borrow');
  const row = b.page.getByRole('region', { name: 'Offers you can take' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toBeVisible({ timeout: 180_000 });
  await row.getByRole('button', { name: /Take this offer|Review this offer/ }).click();
  const review = b.page.locator(`.accept-offer[data-offer-id="${offerId}"]`);
  await clearGates(b.page);
  await expect(review.locator('.receipt')).toContainText('Paid into your vault');
  await fitsWidth(b.page);
  await review.getByTestId('accept-consent').check();
  await review.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = await settled(review);
  const href = await finish.locator('a[href^="/positions/"]').first().getAttribute('href');
  loanId = BigInt(href!.split('/').pop()!);

  await b.page.goto('/positions');
  await expect(b.page.getByRole('region', { name: 'Your loans' }).locator(`[data-loan-id="${loanId}"]`)).toBeVisible({ timeout: 180_000 });
  await b.page.goto(`/positions/${loanId}`);
  await expect(b.page.getByTestId('position-status')).toBeVisible();
  await fitsWidth(b.page);
});

test('the borrower repays in full and both sides collect their payouts', async ({ launchWallet }) => {
  test.skip(loanId === undefined, 'needs the loan the previous journey opened');
  const b = await launchWallet('borrower');
  await b.page.goto(`/positions/${loanId}`);
  await connectWallet(b.page);
  await b.page.getByRole('region', { name: 'Actions' }).getByTestId('repay-open').click({ timeout: 120_000 });
  const repay = b.page.getByTestId('repay-panel');
  await expect(repay.locator('.receipt')).toBeVisible();
  const consent = repay.locator('input[type="checkbox"]');
  if ((await consent.count()) > 0) await consent.first().check();
  await repay.getByRole('button', { name: 'Confirm in wallet' }).click();
  const repaid = await settled(repay);
  await repaid.getByRole('button', { name: 'Close' }).first().click();
  await expect(b.page.getByTestId('position-status')).toHaveText('Repaid.', { timeout: 180_000 });

  const l = await launchWallet('lender');
  await l.page.goto(`/positions/${loanId}`);
  await connectWallet(l.page);
  const payout = l.page.getByRole('region', { name: 'Your payout' });
  await payout.getByTestId('loan-claim-open-lender').click({ timeout: 180_000 });
  const claim = l.page.getByTestId('loan-claim-panel-lender');
  await claim.getByRole('button', { name: 'Confirm in wallet' }).click();
  await settled(claim);

  await b.page.goto('/claims');
  const card = b.page.locator(`[data-claim="borrower:${loanId}"]`);
  await expect(card).toBeVisible({ timeout: 180_000 });
  await card.getByTestId(`claims-keep-borrower-${loanId}`).click();
  const bClaim = card.getByTestId('loan-claim-panel-borrower');
  await bClaim.getByRole('button', { name: 'Confirm in wallet' }).click();
  await settled(bClaim);
  await fitsWidth(b.page);
});

test('a lender posts an offer and cancels it on Offers', async ({ launchWallet }) => {
  await fund(['newLender']);
  const l = await launchWallet('newLender');
  await pickPair(l.page, '/lend');
  await l.page.getByTestId('lend-offer-open').click();
  await fillAndReview(l.page, '50', '0.1', '7');
  const id = await post(l.page);
  await l.page.goto('/offers');
  await expect(l.page.getByTestId(`offer-state-${id}`)).toHaveText('Open', { timeout: 180_000 });
  await l.page.getByTestId(`offer-cancel-${id}`).click();
  const flow = l.page.getByTestId(`offer-cancel-panel-${id}`);
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  await settled(flow);
  await fitsWidth(l.page);
});

test('a borrower posts a request and a lender funds it', async ({ launchWallet }) => {
  await fund(['newBorrower', 'newLender']);
  const b = await launchWallet('newBorrower');
  await pickPair(b.page, '/borrow');
  await b.page.getByTestId('request-open').click();
  await fillAndReview(b.page, '60', '0.15', '8');
  const id = await post(b.page);

  const l = await launchWallet('newLender');
  await pickPair(l.page, '/lend');
  const row = l.page.locator(`[data-offer-id="${id}"]`).first();
  await expect(row).toBeVisible({ timeout: 180_000 });
  await row.getByRole('button', { name: /Fund this request|Review this request|Review this offer/ }).click();
  const review = l.page.locator(`.accept-offer[data-offer-id="${id}"]`);
  await clearGates(l.page);
  await expect(review.locator('.receipt')).toBeVisible();
  await review.getByTestId('accept-consent').check();
  await review.getByRole('button', { name: 'Confirm in wallet' }).click();
  await settled(review);
  await fitsWidth(l.page);
});

test('a lender sets up Auto-lend and sees it on Positions', async ({ launchWallet }) => {
  await fund(['lender']);
  const l = await launchWallet('lender');
  await pickPair(l.page, '/lend');
  const choice = l.page.getByTestId('lend-choice');
  await expect(choice).toHaveAttribute('data-autolend', 'open', { timeout: 120_000 });
  await l.page.getByTestId('lend-choice-keep').check();
  await l.page.getByTestId('lend-offer-open').click();
  await l.page.getByTestId('autolend-amount').fill('200');
  await l.page.getByTestId('autolend-rate').fill('5');
  await l.page.getByTestId('autolend-ltv').fill('50');
  await l.page.getByTestId('autolend-days').fill('30');
  await l.page.getByTestId('autolend-prorata').check();
  await l.page.getByTestId('autolend-review').click();
  await clearGates(l.page);
  const setup = l.page.getByTestId('autolend-setup');
  await expect(setup.locator('.receipt')).toContainText('nothing promises a fill');
  await fitsWidth(l.page);
  await setup.getByTestId('autolend-consent').check();
  await setup.getByRole('button', { name: 'Confirm in wallet' }).click();
  await settled(setup);
  await l.page.goto('/positions');
  const card = l.page.locator('[data-testid^="autolend-card"]').first();
  await expect(card).toBeVisible({ timeout: 180_000 });
  await fitsWidth(l.page);
  // Stop it again, taking back what is still set aside, so the next run (the
  // phone after the desktop, or a rerun) finds the pair open to set up.
  await card.getByTestId('autolend-stop').click();
  await expect(card.getByTestId('autolend-stop-takeback')).toBeChecked();
  await card.getByTestId('autolend-manage-review').click();
  const stop = card.getByTestId('autolend-manage-stop');
  await expect(stop.locator('.receipt')).toContainText('No new loans from this Auto-lend', { timeout: 120_000 });
  await stop.getByRole('button', { name: 'Confirm in wallet' }).click();
  await settled(stop);
});
