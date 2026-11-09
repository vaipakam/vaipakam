/**
 * Lend (matrix OFF-44, OFF-50 lender side, OFF-35): pick what to lend and
 * what collateral to accept, see the borrow requests open for the pair read
 * from the protocol, fund one whole through the shared signing flow, and
 * read the MEASURED outcome (the loan opened with this wallet as lender,
 * what left the wallet, the fee share that came back). Runs on the desktop
 * and the phone project; each test posts its own request, so the second
 * project never depends on the first.
 */
import { erc20Abi, formatEther, parseEther, type Hex } from 'viem';
import { WETH, postBorrowRequest } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const WETH_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

async function pickPair(page: Page, lending: Hex, collateral: Hex): Promise<void> {
  await page.getByTestId('pick-lending').locator('select').selectOption(lending);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
}

const wethOf = (sc: ReturnType<typeof scenario>, who: Hex) => sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

test('a lender funds a borrow request whole: signed terms, an exact approval, and a measured loan', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.3', collateralTliq: '1500', rateBps: 500, days: 30 });
  const lender = accountFor('lender').address;
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.3'));
  // Whatever allowance an earlier spec left, this one starts from none, so
  // the approval step is observable.
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('lender');
  await page.goto('/lend');
  await expect(page.getByRole('heading', { level: 1, name: 'Lend' })).toBeVisible();
  await connectWallet(page);
  await pickPair(page, WETH, tliq);
  await expect(page.getByTestId('pick-lending')).toContainText('priced and liquid');

  const requests = page.getByRole('region', { name: 'Requests you can fund' });
  const row = requests.locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-takeable', 'true', { timeout: 60_000 });
  await expect(row).toContainText(`Request #${offerId}: lend 0.3`);
  await expect(row).toContainText('5% a year for 30 days');
  await expect(row).toContainText('Collateral locked by the borrower: 1,500');
  await expect(row).toContainText('Pro-rata interest: an early repayment earns you less.');
  await expect(row).toContainText('You would lend 0.3');
  await fitsWidth(page);
  await row.getByRole('button', { name: 'Fund this request' }).click();

  // The review: what leaves the wallet, what the borrower gets, the
  // interest and the protocol's share, every consequence, three prompts.
  const review = page.locator(`.accept-offer[data-offer-id="${offerId}"]`);
  const receipt = review.locator('.receipt');
  await expect(receipt).toContainText(`Fund request #${offerId}`, { timeout: 60_000 });
  await expect(receipt).toContainText('You lend from your wallet');
  await expect(receipt).toContainText('The borrower receives');
  await expect(receipt).toContainText("The borrower's loan initiation fee, taken from the amount");
  await expect(receipt).toContainText('Of that fee, paid to you as the sender');
  await expect(receipt).toContainText("Collateral held for you in the borrower's vault");
  await expect(receipt).toContainText('Interest the borrower owes you on the due date, if the protocol never pauses');
  await expect(receipt).toContainText("The protocol's share of that interest");
  await expect(receipt).toContainText('fixed when the loan opens');
  await expect(receipt).toContainText('Back to you if repaid on the due date');
  await expect(receipt).toContainText('Pays off another loan');
  await expect(receipt).toContainText('Exactly 0.3');
  await expect(receipt).toContainText('A sale can bring in less than you are owed.');
  await expect(receipt).toContainText('whoever holds it is the one repaid');
  await expect(receipt).toContainText('The protocol keeps its share of each interest payment before it reaches you.');
  await expect(receipt).toContainText('Wallet prompts: 3.');
  await expect(receipt).not.toContainText('You lock in your vault');
  await expect(page.getByRole('region', { name: 'Requests you can fund' })).toHaveCount(0);
  await fitsWidth(page);

  const confirm = review.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await expect(review.getByRole('link', { name: 'Risk Disclosures' })).toHaveAttribute('href', /lend-risks/);
  await review.getByTestId('accept-consent').check();
  await expect(confirm).toBeEnabled();

  const sent = flags.sentTransactions;
  const signed = flags.typedDataRequests.AcceptTerms ?? 0;
  const before = await wethOf(sc, lender);
  await confirm.click();
  const finish = review.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('with you as the lender');
  await expect(finish).toContainText('left your wallet for the loan');
  await expect(finish).toContainText("of the borrower's fee arrived in your wallet");
  expect(flags.typedDataRequests.AcceptTerms ?? 0).toBe(signed + 1);
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: the request is taken, the wallet paid the amount less
  // the fee share it got back, and no approval is left standing.
  const offer = await sc.read<{ accepted: boolean }>('getOffer', [offerId]);
  expect(offer.accepted).toBe(true);
  const spent = before - (await wethOf(sc, lender));
  expect(spent > 0n && spent < parseEther('0.3')).toBe(true);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] })).toBe(0n);
  await expect(finish.locator('a[href^="/positions/"]')).toContainText(/Open loan #\d+/);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('region', { name: 'Requests you can fund' }).locator(`[data-offer-id="${offerId}"]`)).toHaveCount(0);
});

test('a wallet without the amount is told the shortfall and cannot confirm, until it is funded', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const visitor = accountFor('visitor').address;
  // Ask for 0.02 WETH more than the wallet holds, whatever earlier specs left it.
  const short = parseEther('0.02');
  const asked = (await wethOf(sc, visitor)) + short;
  const offerId = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: formatEther(asked), collateralTliq: '100', rateBps: 300, days: 7 });
  const { page, flags } = await launchWallet('visitor');
  await page.goto('/lend');
  await connectWallet(page);
  await pickPair(page, WETH, tliq);
  const row = page.getByRole('region', { name: 'Requests you can fund' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-takeable', 'true', { timeout: 60_000 });
  await row.getByRole('button', { name: 'Fund this request' }).click();
  const review = page.locator(`.accept-offer[data-offer-id="${offerId}"]`);
  await expect(review).toContainText('this request asks you to lend', { timeout: 60_000 });
  await expect(review.getByTestId('accept-consent')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);

  // RB-RAILS: the review is read again each block, so funding the wallet
  // lifts the blocker without reopening the panel.
  await sc.write('other', WETH, WETH_ABI, 'deposit', [], short);
  await sc.write('other', WETH, WETH_ABI, 'transfer', [visitor, short]);
  await expect(review).not.toContainText('this request asks you to lend', { timeout: 60_000 });
  await expect(review.getByTestId('accept-consent')).toBeVisible();
  expect(flags.sentTransactions).toBe(0);
});

test('without a wallet no request is read and Lend asks for one; once it connects the requests are listed', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postBorrowRequest(sc, { borrower: 'borrower', principalWeth: '0.04', collateralTliq: '200', rateBps: 610, days: 10 });
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/lend');
  await expect(page.getByText('Connect a wallet to see the requests open for a pair and to fund one.')).toBeVisible();
  // Nothing about the book is read or offered before a wallet connects,
  // and posting an offer needs a wallet too.
  await expect(page.getByTestId('pick-lending')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Requests you can fund' })).toHaveCount(0);
  await expect(page.getByTestId('lend-offer-open')).toHaveCount(0);
  await fitsWidth(page);

  // The wallet control settles after the page; connect once it offers to.
  await expect(page.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await connectWallet(page);
  await pickPair(page, WETH, tliq);
  const row = page.getByRole('region', { name: 'Requests you can fund' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toContainText(`Request #${offerId}: lend 0.04`, { timeout: 60_000 });
  await page.getByTestId('pick-collateral').locator('select').selectOption(WETH);
  await expect(page.getByText('What you lend and the collateral you accept must be different tokens.')).toBeVisible();
  await fitsWidth(page);
});
