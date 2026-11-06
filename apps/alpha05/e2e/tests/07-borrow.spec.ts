/**
 * Borrow (matrix OFF-02/03/05/17/19/28/29/34/35/36/40/41/44/50/78, RW-07,
 * RW-17): pick the pair, see the lender offers open for it read from the
 * protocol, take one whole through the shared signing flow, and read the
 * MEASURED outcome (the loan the acceptance opened, what arrived in the
 * wallet, what was locked in the vault). Runs on the desktop and the phone
 * project; each test posts its own offer, so the second project never
 * depends on the first.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function pickPair(page: Page, lending: Hex, collateral: Hex): Promise<void> {
  await page.getByTestId('pick-lending').locator('select').selectOption(lending);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
}

test('a borrower takes a lender offer whole: signed terms, an exact approval, and a measured loan', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.4', collateralTliq: '2000', rateBps: 450, days: 30 });
  const borrower = accountFor('borrower').address;
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('2000')]);
  // Whatever allowance an earlier spec left, this one starts from none, so
  // the approval step is observable.
  await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('borrower');
  await page.goto('/borrow');
  await expect(page.getByRole('heading', { level: 1, name: 'Borrow' })).toBeVisible();
  await connectWallet(page);
  await pickPair(page, WETH, tliq);
  await expect(page.getByTestId('pick-lending')).toContainText('priced and liquid');

  const offers = page.getByRole('region', { name: 'Offers you can take' });
  const row = offers.locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-takeable', 'true', { timeout: 60_000 });
  await expect(row).toContainText(`Offer #${offerId}: borrow 0.4`);
  await expect(row).toContainText('4.5% a year for 30 days');
  await expect(row).toContainText('Collateral asked: 2000');
  await expect(row).toContainText('Pro-rata interest');
  await expect(row).toContainText('Partial repayment allowed.');
  await expect(row).toContainText('You would receive');
  await fitsWidth(page);
  await row.getByRole('button', { name: 'Take this offer' }).click();

  // The review: every figure, the consequences, and three prompts (sign,
  // approve exactly the collateral, send).
  const review = page.locator(`.accept-offer[data-offer-id="${offerId}"]`);
  const receipt = review.locator('.receipt');
  await expect(receipt).toContainText('You receive in your wallet', { timeout: 60_000 });
  await expect(receipt).toContainText('Loan initiation fee, taken from the amount');
  await expect(receipt).toContainText('You lock in your vault');
  // The protocol pays the sender a share of the fee; on a direct take that is the borrower.
  await expect(receipt).toContainText('Of that fee, paid back to you as the sender');
  await expect(receipt).toContainText('2000');
  await expect(receipt).toContainText('You owe on the due date, if the protocol never pauses');
  // Every lifecycle term the signature binds is stated, defaults included.
  await expect(receipt).toContainText('Partial repayment');
  await expect(receipt).toContainText('Selling the collateral during the loan');
  await expect(receipt).toContainText('Collateral listed for sale before the loan');
  await expect(receipt).toContainText('Refinances a loan');
  await expect(receipt).toContainText('Linked loan');
  await expect(receipt).toContainText('interest keeps accruing through it');
  // A first loan opens the vault in the same transaction; a later one (the
  // second project's run) names the vault it already has.
  const vault = await sc.read<Hex>('getUserVaultAddress', [borrower]).catch(() => null);
  const hasVault = vault !== null && !/^0x0{40}$/i.test(vault);
  await expect(receipt).toContainText(hasVault ? vault! : 'Opened for you in this same transaction');
  await expect(receipt).toContainText('Exactly 2000');
  await expect(receipt).toContainText('Signing records a binding agreement for the life of the loan.');
  await expect(receipt).toContainText('Wallet prompts: 3.');
  await expect(page.getByRole('region', { name: 'Offers you can take' })).toHaveCount(0);
  await fitsWidth(page);

  // Confirm waits for the consent, which links the disclosures and Terms.
  const confirm = review.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await expect(review).toContainText('Tick the box above to continue.');
  await expect(review.getByRole('link', { name: 'Risk Disclosures' })).toHaveAttribute('href', /borrow-risks/);
  await review.getByTestId('accept-consent').check();
  await expect(confirm).toBeEnabled();

  const sent = flags.sentTransactions;
  const signed = flags.typedDataRequests.AcceptTerms ?? 0;
  const balance = () => sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [borrower] });
  const before = await balance();
  await confirm.click();
  const finish = review.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('with you as the borrower');
  await expect(finish).toContainText('arrived in your wallet');
  await expect(finish).not.toContainText('previewed');
  await expect(finish).toContainText('locked in your vault');
  expect(flags.typedDataRequests.AcceptTerms ?? 0).toBe(signed + 1);
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: the offer is taken, the wallet received the amount
  // less the fee, and no approval is left standing.
  const offer = await sc.read<{ accepted: boolean }>('getOffer', [offerId]);
  expect(offer.accepted).toBe(true);
  const received = (await balance()) - before;
  expect(received > 0n && received < parseEther('0.4')).toBe(true);
  expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(0n);
  const next = finish.locator('a[href^="/positions/"]');
  await expect(next).toContainText(/Open loan #\d+/);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('region', { name: 'Offers you can take' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Offers you can take' }).locator(`[data-offer-id="${offerId}"]`)).toHaveCount(0);
});

test('a wallet without the collateral is told the shortfall and cannot confirm', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  // More collateral than the faucet wallet could hold from any earlier spec.
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.05', collateralTliq: '9000000', rateBps: 300, days: 7 });
  const { page, flags } = await launchWallet('visitor');
  await page.goto('/borrow');
  await connectWallet(page);
  await pickPair(page, WETH, tliq);
  const row = page.getByRole('region', { name: 'Offers you can take' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-takeable', 'true', { timeout: 60_000 });
  await row.getByRole('button', { name: 'Take this offer' }).click();
  const review = page.locator(`.accept-offer[data-offer-id="${offerId}"]`);
  await expect(review).toContainText('short of the', { timeout: 60_000 });
  await expect(review.getByTestId('accept-consent')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  expect(flags.typedDataRequests.AcceptTerms ?? 0).toBe(0);
  await fitsWidth(page);
});

test('without a wallet the offers are listed, and taking one asks for a wallet', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.06', collateralTliq: '300', rateBps: 520, days: 10 });
  const { page } = await launchWallet('visitor', { preAuthorized: false });
  await page.goto('/borrow');
  await expect(page.getByText('Connect a wallet to see what each offer would give you and to take one.')).toBeVisible();
  await pickPair(page, WETH, tliq);
  const row = page.getByRole('region', { name: 'Offers you can take' }).locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toContainText(`Offer #${offerId}: borrow 0.06`, { timeout: 60_000 });
  await expect(row).toContainText('Connect a wallet to take it.');
  await expect(row.getByRole('button', { name: 'Take this offer' })).toHaveCount(0);
  // The same token on both sides is refused before anything is read.
  await page.getByTestId('pick-collateral').locator('select').selectOption(WETH);
  await expect(page.getByText('What you borrow and what you lock must be different tokens.')).toBeVisible();
  await fitsWidth(page);
});
