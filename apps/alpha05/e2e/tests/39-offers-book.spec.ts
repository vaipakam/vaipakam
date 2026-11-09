/**
 * The offer book and an offer's own page (matrix OFF-39, OFF-40, OFF-41,
 * OFF-43, OFF-45, OFF-50). A lender posts an offer: a visitor with no
 * wallet finds it in the book (read from the index stand-in, which files
 * the chain's offers as the indexer does), filters by tab and side, and
 * opens its page, which reads it from the chain and asks for a wallet to
 * take it. A borrower then takes it whole from that page through the
 * shared acceptance flow, and the page reads it back as filled. A creator
 * cancels from the page and keeps the finish card after the terms clear. With the
 * index down, the book says it could not be read instead of showing an
 * empty list. Runs on the desktop and the phone project; the chain is
 * reverted after each test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { setIndexPosture } from '../lib/stub';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

// See 26-loan-claims: a revert leaves the head at the snapshot's timestamp,
// so a block is mined at once.
let snapshot: Hex;
test.beforeEach(async () => {
  snapshot = await anvilRpc<Hex>('evm_snapshot');
});
test.afterEach(async () => {
  await setIndexPosture('live');
  await anvilRpc('evm_revert', [snapshot]);
  await anvilRpc('evm_mine');
});

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('without a wallet neither the book nor an offer is read; once one connects the book lists the offer and its page reads it from the chain', async ({ launchWallet }) => {
  test.setTimeout(150_000);
  const sc = scenario();
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.07', collateralTliq: '350', rateBps: 610, days: 21 });
  const id = offerId.toString();
  const lender = accountFor('lender').address;

  const { page, flags } = await launchWallet('visitor', { preAuthorized: false });
  const bookReads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/offers/active')) bookReads.push(r.url());
  });
  await page.goto('/offers');
  await expect(page.getByText('Connect a wallet to see the offer book and the offers you made.')).toBeVisible();
  await expect(page.getByTestId('offer-book')).toHaveCount(0);
  // An offer's own page asks for a wallet too, and reads nothing.
  await page.goto(`/offers/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: `Offer #${id}` })).toBeVisible();
  await expect(page.getByTestId('offer-connect')).toHaveText('Connect a wallet to see this offer.');
  await expect(page.getByTestId('offer-facts')).toHaveCount(0);
  expect(bookReads).toEqual([]);
  await fitsWidth(page);

  await page.goto('/offers');
  // The wallet control settles after the page; connect once it offers to.
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  const book = page.getByTestId('offer-book');
  const row = book.getByTestId(`book-row-${id}`);
  await expect(row).toContainText(`Offer #${id}: lend 0.07 WETH at 6.1% a year, on a 21-day term.`, { timeout: 60_000 });
  await expect(row).toContainText('Asks for 350');
  await expect(row).toContainText(`Posted by ${lender.slice(0, 6)}`);
  await expect(page.getByTestId('offer-book-count')).toContainText('open offers');
  await fitsWidth(page);

  // A lender's offer is not a borrower's request, nor a rental.
  await page.getByTestId('offer-book-side-borrower').click();
  await expect(row).toHaveCount(0);
  await page.getByTestId('offer-book-side-lender').click();
  await expect(row).toBeVisible();
  await page.getByTestId('offer-book-tab-rentals').click();
  await expect(row).toHaveCount(0);
  await page.getByTestId('offer-book-tab-loans').click();
  await expect(row).toBeVisible();

  await row.getByTestId(`book-link-${id}`).click();
  await expect(page).toHaveURL(new RegExp(`/offers/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: `Offer #${id}` })).toBeVisible();
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });
  const facts = page.getByTestId('offer-facts');
  await expect(facts).toContainText('A lender’s offer');
  await expect(facts).toContainText('0.07 WETH');
  await expect(facts).toContainText('350');
  await expect(facts).toContainText('21 days');
  await expect(facts).toContainText('Until it is filled or cancelled');
  await expect(page.getByTestId('offer-connect')).toHaveCount(0);
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);
});

test('a borrower takes an offer whole from its page, and the page reads it back as filled', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.08', collateralTliq: '400', rateBps: 480, days: 14 });
  const id = offerId.toString();
  const borrower = accountFor('borrower').address;
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('400')]);

  const { page, flags } = await launchWallet('borrower');
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });
  await page.getByTestId('offer-page-take').click();

  const review = page.locator(`.accept-offer[data-offer-id="${id}"]`);
  const receipt = review.locator('.receipt');
  await expect(receipt).toContainText('Paid into your vault, yours to withdraw', { timeout: 60_000 });
  await expect(receipt).toContainText('You lock in your vault');
  await expect(receipt).toContainText('400');
  await fitsWidth(page);
  await review.getByTestId('accept-consent').check();
  const sent = flags.sentTransactions;
  await review.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = review.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('with you as the borrower');
  expect(flags.sentTransactions).toBeGreaterThan(sent);
  expect((await sc.read<{ accepted: boolean }>('getOffer', [offerId])).accepted).toBe(true);
  expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(0n);

  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('offer-state')).toHaveText('Filled', { timeout: 60_000 });
  await expect(page.getByText('This offer was taken and became a loan.')).toBeVisible();
  await expect(page.getByTestId('offer-page-take')).toHaveCount(0);
  await fitsWidth(page);
});

test('the creator cancels an offer from its page, and the finish card stays after the cancel clears its terms', async ({ launchWallet }) => {
  test.setTimeout(180_000);
  const sc = scenario({ lender: 'freshLender' });
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.04', collateralTliq: '200', rateBps: 520, days: 10 });
  const id = offerId.toString();
  await anvilRpc('evm_increaseTime', [301]);
  await anvilRpc('evm_mine');

  const { page } = await launchWallet('freshLender');
  await page.goto(`/offers/${id}`);
  await connectWallet(page);
  await expect(page.getByTestId('offer-state')).toHaveText('Open', { timeout: 60_000 });
  await expect(page.getByTestId('offer-page-take')).toHaveCount(0);
  await page.getByTestId('offer-page-cancel').click();
  const flow = page.getByTestId(`offer-cancel-panel-${id}`);
  await expect(flow.locator('.receipt')).toContainText('Cancel this offer', { timeout: 60_000 });
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 120_000 });
  // The re-read after the receipt finds no terms; the finish card stays.
  await expect(page.getByTestId('offer-no-terms')).toBeVisible({ timeout: 60_000 });
  await expect(finish).toContainText(`Offer #${id} cancelled`);
  await fitsWidth(page);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(flow).toHaveCount(0);
  await expect(page.getByTestId('offer-no-terms')).toBeVisible();
});

test('with the index down, the book says it could not be read instead of showing no offers', async ({ launchWallet }) => {
  await setIndexPosture('down');
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/offers');
  // The wallet control settles after the page; connect once it offers to.
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  await expect(page.getByTestId('offer-book-failed')).toContainText('The offer book could not be read, so nothing here means no offers', { timeout: 60_000 });
  await expect(page.getByTestId('offer-book-rows')).toHaveCount(0);
  await expect(page.getByTestId('offer-book-count')).toHaveCount(0);
  await fitsWidth(page);
});
