/**
 * Lend: the lender's own offer (matrix OFF-06, with OFF-07/12/13/16/17/18/19
 * from the lender's side): type the offer with exact parsing, review the
 * protocol's own verdict on it with every figure it binds, approve exactly
 * the amount lent, post it, and read the MEASURED outcome (the offer recorded
 * as a lender's, the amount locked in the vault). Runs on the desktop and the
 * phone project; every offer is posted inside a snapshot the test reverts, so
 * later specs and the other project start without it.
 */
import { erc20Abi, formatEther, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

async function openForm(page: Page, collateral: Hex): Promise<void> {
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your lending offer' })).toBeVisible();
  // The terms offered are the protocol's own, read before a review opens.
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
}

interface StoredOffer {
  creator: Hex;
  offerType: number;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  durationDays: bigint;
  expiresAt: bigint;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
}

test('a lender posts their own offer: exact figures, an exact approval of the amount, and a measured offer', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    const lender = accountFor('lender').address;
    await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.2'));
    // Whatever allowance an earlier spec left, this one starts from none, so
    // the approval step is observable.
    await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);
    const vault = await sc.read<Hex>('getUserVaultAddress', [lender]);
    const vaultBefore =
      vault === '0x0000000000000000000000000000000000000000' ? 0n : await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [vault] });

    const { page, flags } = await launchWallet('lender');
    await openForm(page, tliq);

    // The amount is what posting locks, so the form shows the wallet's balance of it.
    await expect(page.getByText('Your wallet holds')).toBeVisible();
    await expect(page.getByTestId('request-amount-all')).toBeVisible();
    await expect(page.getByText('The exact amount a borrower locks in their vault to take your offer.')).toBeVisible();
    // Exact parsing: more decimals than the token has are refused, not rounded.
    await page.getByTestId('request-amount').fill('0.1234567890123456789');
    await page.getByTestId('request-amount').blur();
    await expect(page.getByText('has 18 decimals; enter at most that many.')).toBeVisible();
    await page.getByTestId('request-amount').fill('0.2');
    await page.getByTestId('request-collateral').fill('1500');
    await page.getByTestId('request-rate').fill('6.5');
    await page.getByTestId('request-duration').getByRole('radio', { name: '14 days' }).check();
    await page.getByTestId('request-expiry').selectOption('1d');
    await page.getByTestId('request-partial').check();
    await expect(page.getByTestId('request-summary')).toContainText('you lend 0.2');
    await fitsWidth(page);

    // On a phone the primary action rests above the bottom bar, full width.
    if (testInfo.project.name === 'phone') {
      expect(await page.locator('.thumb-action').evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
      const button = await page.getByTestId('request-review').boundingBox();
      expect(button!.width).toBeGreaterThan(300);
    }
    await page.getByRole('button', { name: 'Review offer' }).click();

    // The review: what locks now, what a borrower must lock and would
    // receive, the interest and the protocol's share of it, every term it
    // binds, and the prompts (approve, post).
    const receipt = page.locator('.post-request .receipt');
    await expect(receipt).toContainText('Post your lending offer', { timeout: 60_000 });
    await expect(receipt).toContainText('You lock in your vault now');
    await expect(receipt).toContainText('Amount a borrower takes');
    await expect(receipt).toContainText('All of it by one borrower, or not at all');
    // The matching switch is stated whatever its state, since it can change while the offer is open.
    await expect(receipt).toContainText("Matching with borrowers' requests on this network");
    await expect(receipt).toContainText('Collateral a borrower must lock in their vault');
    await expect(receipt).toContainText('1500');
    await expect(receipt).toContainText('6.5% a year');
    await expect(receipt).toContainText('14 days after a borrower takes it');
    await expect(receipt).toContainText("The borrower receives, at today's fee rate");
    await expect(receipt).toContainText("The protocol's share of that interest");
    await expect(receipt).toContainText('fixed when the loan opens');
    await expect(receipt).toContainText('Full term, with partial repayments allowed');
    await expect(receipt).toContainText('Offer open until');
    await expect(receipt).toContainText('Exactly 0.2');
    await expect(receipt).toContainText('A borrower who takes the offer opens the loan at once');
    await expect(receipt).toContainText('When the offer lapses it can no longer be taken');
    await expect(receipt).toContainText('This app cannot follow or cancel an offer yet.');
    await expect(receipt).toContainText('Your side of the loan is a position token in your wallet');
    await expect(receipt).toContainText('Wallet prompts: 2.');
    await expect(page.getByTestId('request-manage-link')).toHaveAttribute('href', 'https://app.vaipakam.com/offers');
    await fitsWidth(page);

    const flow = page.locator('.post-request');
    const confirm = flow.getByRole('button', { name: 'Confirm in wallet' });
    await expect(confirm).toBeDisabled();
    await flow.getByTestId('request-consent').check();
    await expect(confirm).toBeEnabled();

    const sent = flags.sentTransactions;
    await confirm.click();
    const finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    await expect(finish).toContainText('posted and open for borrowers');
    await expect(finish).toContainText('0.2 WETH locked in your vault');
    expect(flags.sentTransactions).toBe(sent + 2);

    // The chain agrees: a lender's offer stored as typed, with one collateral
    // figure at both ends, the approval used up, and the amount in the vault.
    const id = BigInt((await finish.textContent())!.match(/Offer #(\d+)/)![1]!);
    const offer = await sc.read<StoredOffer>('getOffer', [id]);
    expect(offer.creator.toLowerCase()).toBe(lender.toLowerCase());
    expect(offer.offerType).toBe(0);
    expect([offer.amount, offer.amountMax]).toEqual([parseEther('0.2'), parseEther('0.2')]);
    expect([offer.interestRateBps, offer.interestRateBpsMax]).toEqual([650n, 650n]);
    expect([offer.collateralAmount, offer.collateralAmountMax]).toEqual([parseEther('1500'), parseEther('1500')]);
    expect(offer.durationDays).toBe(14n);
    expect(offer.expiresAt > 0n).toBe(true);
    expect(offer.useFullTermInterest).toBe(true);
    expect(offer.allowsPartialRepay).toBe(true);
    expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] })).toBe(0n);
    const vaultNow = await sc.read<Hex>('getUserVaultAddress', [lender]);
    expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [vaultNow] })).toBe(vaultBefore + parseEther('0.2'));
    await expect(finish.getByRole('link', { name: "Follow it on the current app's Offers page" })).toHaveAttribute('href', 'https://app.vaipakam.com/offers');

    // Closing returns to the requests, and the next offer starts from a clean form.
    await finish.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('lend-offer-open')).toBeVisible();
    await page.getByTestId('lend-offer-open').click();
    await expect(page.getByTestId('request-amount')).toHaveValue('');
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});

test('an offer the wallet cannot fund is blocked in place, changing it keeps what was typed, and Advanced offers the schedule and tariff', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const visitor = accountFor('visitor').address;
  const held = await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [visitor] });
  const asked = formatEther(held + parseEther('0.02'));

  const { page, flags } = await launchWallet('visitor', { advanced: true });
  await openForm(page, tliq);
  // In Advanced a lender's form offers the interest schedule and the tariff.
  await expect(page.getByTestId('request-cadence')).toContainText('Interest schedule');
  await expect(page.getByTestId('request-tariff')).toContainText('Full fee tariff');
  // Errors wait until a review is asked; then every field names its own.
  await page.getByTestId('request-review').click();
  await expect(page.getByText('Enter an amount.').first()).toBeVisible();
  await page.getByTestId('request-rate').fill('101');
  await expect(page.getByText('The highest rate an offer may carry is 100% a year.')).toBeVisible();
  await page.getByTestId('request-expiry').selectOption('custom');
  await page.getByTestId('request-expiry-days').fill('400');
  await page.getByTestId('request-expiry-days').blur();
  await expect(page.getByText('An offer can stay open for at most 365 days.')).toBeVisible();
  await page.getByTestId('request-expiry-days').fill('10');

  await page.getByTestId('request-amount').fill(asked);
  await page.getByTestId('request-collateral').fill('900000');
  await page.getByTestId('request-rate').fill('4');
  await page.getByTestId('request-review').click();
  const flow = page.locator('.post-request');
  await expect(flow).toContainText('this offer locks', { timeout: 60_000 });
  await expect(flow.getByTestId('request-consent')).toHaveCount(0);
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);

  await flow.getByTestId('request-edit').click();
  await expect(page.getByTestId('request-amount')).toHaveValue(asked);
  await expect(page.getByTestId('request-rate')).toHaveValue('4');
  expect(flags.sentTransactions).toBe(0);
});
