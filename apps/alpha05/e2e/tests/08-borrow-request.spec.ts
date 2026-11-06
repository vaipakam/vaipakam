/**
 * Borrow: the borrower's own request (matrix OFF-04/05/07/12/13/16/17/18/19):
 * type the request with exact parsing, review the protocol's own verdict on
 * it with every figure it binds, approve exactly the collateral, post it, and
 * read the MEASURED outcome (the request recorded, the collateral locked in
 * the vault). Runs on the desktop and the phone project, where the form's
 * primary action is pinned above the bottom bar.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function openForm(page: Page, collateral: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('request-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
  // The terms offered are the protocol's own, read before a review opens.
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
}

interface StoredOffer {
  creator: Hex;
  offerType: number;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  collateralAmount: bigint;
  durationDays: bigint;
  expiresAt: bigint;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
}

test('a borrower posts their own request: exact figures, an exact approval, and a measured request', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  // The request stays open on the shared chain, so it is posted inside a
  // snapshot the test reverts: later specs (Home lists a wallet's open
  // offers) and the other project start without it.
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    const borrower = accountFor('borrower').address;
    await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('2000')]);
    await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);

    const { page, flags } = await launchWallet('borrower');
    await openForm(page, tliq);

    // Exact parsing: more decimals than the token has are refused, not rounded.
    await page.getByTestId('request-amount').fill('0.1234567890123456789');
    await page.getByTestId('request-amount').blur();
    await expect(page.getByText('has 18 decimals; enter at most that many.')).toBeVisible();
    await page.getByTestId('request-amount').fill('0.25');
    await page.getByTestId('request-collateral').fill('2000');
    await page.getByTestId('request-rate').fill('7.25');
    await page.getByTestId('request-duration').getByRole('radio', { name: '14 days' }).check();
    await page.getByTestId('request-expiry').selectOption('1d');
    await page.getByTestId('request-partial').check();
    await expect(page.getByTestId('request-summary')).toContainText("at today's fee");
    await fitsWidth(page);

    // On a phone the primary action rests above the bottom bar, full width.
    const action = page.locator('.thumb-action');
    if (testInfo.project.name === 'phone') {
      expect(await action.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
      const button = await page.getByTestId('request-review').boundingBox();
      expect(button!.width).toBeGreaterThan(300);
    }
    await page.getByTestId('request-review').click();

    // The review: what is locked now, what a lender taking it gives and asks
    // back, every term it binds, and the prompts (approve, post).
    const receipt = page.locator('.post-request .receipt');
    await expect(receipt).toContainText('You lock in your vault now', { timeout: 60_000 });
    await expect(receipt).toContainText('2000');
    await expect(receipt).toContainText('Amount you ask to borrow');
    await expect(receipt).toContainText('All of it by one lender, or not at all');
    await expect(receipt).toContainText('7.25% a year');
    await expect(receipt).toContainText('14 days after a lender takes it');
    await expect(receipt).toContainText("You receive in your wallet if a lender takes it, at today's fee rate");
    await expect(receipt).toContainText('Full term, with partial repayments allowed');
    await expect(receipt).toContainText('Request open until');
    await expect(receipt).toContainText('Exactly 2000');
    await expect(receipt).toContainText('used up by posting');
    await expect(receipt).toContainText('A lender who takes the request opens the loan at once');
    await expect(receipt).toContainText('When the request lapses it can no longer be taken');
    await expect(receipt).toContainText('This app cannot follow or cancel a request yet.');
    await expect(page.getByTestId('request-manage-link')).toHaveAttribute('href', 'https://app.vaipakam.com/offers');
    await expect(receipt).toContainText('Wallet prompts: 2.');
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
    await expect(finish).toContainText('posted and open for lenders');
    await expect(finish).toContainText('locked in your vault');
    expect(flags.sentTransactions).toBe(sent + 2);

    // The chain agrees: the request is stored as typed, the approval was used
    // up, and the collateral is in the borrower's vault.
    const id = BigInt((await finish.textContent())!.match(/Request #(\d+)/)![1]!);
    const offer = await sc.read<StoredOffer>('getOffer', [id]);
    expect(offer.creator.toLowerCase()).toBe(borrower.toLowerCase());
    expect(offer.offerType).toBe(1);
    expect([offer.amount, offer.amountMax]).toEqual([parseEther('0.25'), parseEther('0.25')]);
    expect(offer.interestRateBps).toBe(725n);
    expect(offer.collateralAmount).toBe(parseEther('2000'));
    expect(offer.durationDays).toBe(14n);
    expect(offer.expiresAt > 0n).toBe(true);
    expect(offer.useFullTermInterest).toBe(true);
    expect(offer.allowsPartialRepay).toBe(true);
    expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(0n);
    const vault = await sc.read<Hex>('getUserVaultAddress', [borrower]);
    expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBeGreaterThanOrEqual(parseEther('2000'));
    // The Offers page is not built in this app yet: the review said so before
    // anything locked, and the finish card hands on to the current app's.
    await expect(finish.getByRole('link', { name: "Follow it on the current app's Offers page" })).toHaveAttribute('href', 'https://app.vaipakam.com/offers');

    // Closing returns to the offers, and the next request starts from a clean form.
    await finish.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('request-open')).toBeVisible();
    await page.getByTestId('request-open').click();
    await expect(page.getByTestId('request-amount')).toHaveValue('');
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});

test('a request the wallet cannot fund is blocked in place, and changing it keeps what was typed', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const visitor = accountFor('visitor').address;
  const held = (await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'balanceOf', args: [visitor] })) / 10n ** 18n;
  const needed = (held + 9_000_000n).toString();

  const { page, flags } = await launchWallet('visitor');
  await openForm(page, tliq);
  // Errors wait until a review is asked; then every field names its own.
  await page.getByTestId('request-review').click();
  await expect(page.getByText('Enter an amount.').first()).toBeVisible();
  await expect(page.getByText('Enter a rate.')).toBeVisible();
  await page.getByTestId('request-rate').fill('101');
  await expect(page.getByText('The highest rate a request may carry is 100% a year.')).toBeVisible();
  // A typed term and a typed expiry are checked against their bounds too.
  await page.getByTestId('request-duration').getByRole('radio', { name: 'Other' }).check();
  await page.getByTestId('request-term-days').fill('99999');
  await expect(page.getByText(/The longest term open on this network is \d+ days\./)).toBeVisible();
  await page.getByTestId('request-term-days').fill('45');
  await page.getByTestId('request-expiry').selectOption('custom');
  await page.getByTestId('request-expiry-days').fill('400');
  await page.getByTestId('request-expiry-days').blur();
  await expect(page.getByText('A request can stay open for at most 365 days.')).toBeVisible();
  await page.getByTestId('request-expiry-days').fill('10');

  await page.getByTestId('request-amount').fill('0.05');
  await page.getByTestId('request-collateral').fill(needed);
  await page.getByTestId('request-rate').fill('3');
  await page.getByTestId('request-review').click();
  const flow = page.locator('.post-request');
  await expect(flow).toContainText('short of the', { timeout: 60_000 });
  await expect(flow.locator('.receipt')).toContainText('45 days after a lender takes it');
  await expect(flow.getByTestId('request-consent')).toHaveCount(0);
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);

  await flow.getByTestId('request-edit').click();
  await expect(page.getByTestId('request-collateral')).toHaveValue(needed);
  await expect(page.getByTestId('request-rate')).toHaveValue('3');
  await expect(page.getByTestId('request-term-days')).toHaveValue('45');
  expect(flags.sentTransactions).toBe(0);
});
