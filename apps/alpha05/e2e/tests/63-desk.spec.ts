/**
 * The rate desk, slice 1 (matrix OFF-73, ACC-07). Lenders post offers at
 * two rates and a borrower posts a request in one market (WETH against
 * tLIQ, 14 days), and the lender posts once in a second market (30 days).
 * Without a wallet the desk reads nothing; once one connects it lists both
 * markets from the index stand-in (which groups the chain's offers as the
 * indexer does), opens the deepest market's ladder, steps each side by
 * rate with the offers' open amounts added up, states the derived middle
 * rate, and opens another market's ladder by its own address. A Basic
 * reader sees the orientation card on top, which switches to Advanced or
 * hides for good. With the index down the desk says it could not read the
 * markets instead of showing none. Runs on the desktop and the phone
 * project; the chain is reverted after each test.
 */
import { postBorrowRequest, postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { setIndexPosture } from '../lib/stub';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

function marketOf(tliq: string, days: number): string {
  return `${WETH.toLowerCase()}-${tliq.toLowerCase()}-${days}`;
}

test('the desk lists the markets from the index, ladders a market by rate with its depth and derived middle, and opens another by its address', async ({
  launchWallet,
}) => {
  test.setTimeout(180_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, string>).liquidToken!;
  const a = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 14 });
  const b = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.03', collateralTliq: '150', rateBps: 500, days: 14 });
  const c = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.04', collateralTliq: '200', rateBps: 650, days: 14 });
  const d = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.02', collateralTliq: '100', rateBps: 450, days: 14 });
  const e = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.06', collateralTliq: '300', rateBps: 700, days: 30 });
  const short = marketOf(tliq, 14);
  const long = marketOf(tliq, 30);

  const { page } = await launchWallet('borrower', { preAuthorized: false, advanced: true });
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/offers/markets') || r.url().includes('/offers/active')) reads.push(r.url());
  });
  await page.goto('/desk');
  await expect(page.getByRole('heading', { level: 1, name: 'Rate desk' })).toBeVisible();
  await expect(page.getByText('Connect a wallet to read the token markets and their rate ladders.')).toBeVisible();
  await expect(page.getByTestId('desk-markets')).toHaveCount(0);
  expect(reads).toEqual([]);
  await fitsWidth(page);

  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  await expect(page.getByTestId('desk-completeness')).toContainText('this page does not list them yet');
  // Advanced mode: no orientation card.
  await expect(page.getByTestId('orientation-card')).toHaveCount(0);

  const shortRow = page.locator(`[data-testid="desk-market"][data-market="${short}"]`);
  await expect(shortRow).toContainText('WETH against', { timeout: 60_000 });
  await expect(shortRow).toContainText('14-day term');
  await expect(shortRow).toContainText('Lenders’ offers: 3. Borrowers’ requests: 1.');
  await expect(shortRow).toContainText('Lowest lender rate 5% a year · Highest borrower rate 4.5% a year');
  const longRow = page.locator(`[data-testid="desk-market"][data-market="${long}"]`);
  await expect(longRow).toContainText('Lenders’ offers: 1. Borrowers’ requests: 0.');
  await expect(longRow).toContainText('No borrower’s request');

  // Without a market in the address, the deepest market's ladder opens.
  const first = await page.getByTestId('desk-market').first().getAttribute('data-market');
  const ladder = page.getByTestId('desk-ladder');
  await expect(ladder).toHaveAttribute('data-market', first!);

  await page.goto(`/desk?market=${short}`);
  await expect(ladder).toHaveAttribute('data-market', short);
  await expect(page.getByTestId('desk-ladder-market')).toContainText('14-day term');
  await expect(shortRow).toContainText('Ladder shown below');
  const asks = page.getByTestId('desk-asks').getByTestId('desk-ask-step');
  await expect(asks).toHaveCount(2, { timeout: 60_000 });
  // Lowest rate first; the two 5% offers stand on one step, their open
  // amounts added up.
  await expect(asks.nth(0)).toHaveAttribute('data-rate', '500');
  await expect(asks.nth(0)).toHaveAttribute('data-count', '2');
  await expect(asks.nth(0)).toContainText('5% a year');
  await expect(asks.nth(0)).toContainText('Offers at this rate: 2');
  await expect(asks.nth(0)).toContainText('Open amounts added up: 0.08 WETH');
  await expect(asks.nth(0).getByTestId(`desk-offer-${a}`)).toHaveText(`Offer #${a}: 0.05 WETH open`);
  await expect(asks.nth(0)).not.toContainText('Yours');
  await expect(asks.nth(0).getByTestId(`desk-offer-${b}`)).toHaveText(`Offer #${b}: 0.03 WETH open`);
  await expect(asks.nth(1)).toHaveAttribute('data-rate', '650');
  await expect(asks.nth(1).getByTestId(`desk-offer-${c}`)).toBeVisible();
  const bids = page.getByTestId('desk-bids').getByTestId('desk-bid-step');
  await expect(bids).toHaveCount(1);
  await expect(bids.nth(0)).toHaveAttribute('data-rate', '450');
  await expect(bids.nth(0)).toContainText('Open amounts added up: 0.02 WETH');
  await expect(bids.nth(0).getByTestId(`desk-offer-${d}`)).toBeVisible();
  // The borrower's own request is marked as theirs.
  await expect(bids.nth(0)).toContainText('Yours');
  await expect(page.getByTestId('desk-middle')).toHaveAttribute('data-middle', '4750');
  await expect(page.getByTestId('desk-middle')).toContainText('Middle rate 4.75%');
  await expect(page.getByTestId('desk-crossed')).toHaveCount(0);
  await expect(page.getByTestId('desk-counted')).toHaveCount(0);
  await expect(page.getByText('A rate’s total is depth, not one amount')).toBeVisible();
  await fitsWidth(page);

  // Another market's ladder opens by its own address.
  await longRow.getByTestId('desk-market-open').click();
  await expect(page).toHaveURL(new RegExp(`market=${long}`));
  await expect(ladder).toHaveAttribute('data-market', long);
  await expect(page.getByTestId('desk-asks').getByTestId('desk-ask-step')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId(`desk-offer-${e}`)).toBeVisible();
  await expect(page.getByTestId('desk-bids')).toContainText('No borrower’s request is listed in this market.');
  await expect(page.getByTestId('desk-middle')).toContainText('No middle rate');

  // An offer on the ladder opens its own page, which reads it from the chain.
  await page.getByTestId(`desk-offer-${e}`).click();
  await expect(page).toHaveURL(new RegExp(`/offers/${e}$`));
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });

  // An address that names no market says so.
  await page.goto('/desk?market=junk');
  await expect(page.getByTestId('desk-bad-market')).toBeVisible();
  await fitsWidth(page);
});

test('a Basic reader sees the orientation card, which switches to Advanced or hides for good; with the index down the desk says it could not read the markets', async ({
  launchWallet,
}) => {
  test.setTimeout(150_000);
  const { page } = await launchWallet('visitor');
  await page.goto('/desk');
  const card = page.getByTestId('orientation-card');
  await expect(card).toContainText('This is an Advanced page');
  await expect(card).toContainText('ladder of rates');
  await expect(card.getByTestId('orientation-guided-borrow')).toHaveAttribute('href', '/borrow');
  await expect(card.getByTestId('orientation-guided-lend')).toHaveAttribute('href', '/lend');
  await fitsWidth(page);

  await card.getByTestId('orientation-switch').click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Rate desk' })).toBeVisible();
  await expect(card).toHaveCount(0);

  // Back in Basic mode the card returns until it is hidden, then stays hidden.
  await page.evaluate(() => window.localStorage.setItem('app.mode', 'basic'));
  await page.reload();
  await expect(card).toBeVisible();
  await card.getByTestId('orientation-dismiss').click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Rate desk' })).toBeVisible();
  await expect(card).toHaveCount(0);

  await setIndexPosture('down');
  await page.reload();
  await expect(page.getByTestId('desk-markets-failed')).toContainText('nothing here means no markets', { timeout: 60_000 });
  await expect(page.getByTestId('desk-markets-none')).toHaveCount(0);
  await fitsWidth(page);
});
