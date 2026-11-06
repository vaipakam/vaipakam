/**
 * Borrow: the request's Advanced options (matrix OFF-10 / OFF-11 / OFF-16):
 * an amount range with a floor collateral, the fill mode, and the risk at
 * both ends of the range (what a lender taking it directly lends, and the
 * largest loan a match can make), with the matching switch and the live
 * start-of-loan health factor stated. Basic keeps every risk warning and
 * says when Advanced options set earlier still apply. Runs on the desktop
 * and the phone project.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { anvilRpc } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, onPhone, openMenu, test } from '../lib/wallet';

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function openForm(page: Page, collateral: Hex): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('request-open').click();
  await expect(page.getByRole('heading', { level: 2, name: 'Your borrow request' })).toBeVisible();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
}

interface StoredOffer {
  creator: Hex;
  amount: bigint;
  amountMax: bigint;
  interestRateBps: bigint;
  interestRateBpsMax: bigint;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  fillMode: number;
  expiresAt: bigint;
}

test('a ranged request posts both ends, the floor and the fill mode, with the risk stated at each end', async ({ launchWallet }) => {
  const sc = scenario();
  const snapshot = await anvilRpc<Hex>('evm_snapshot');
  try {
    const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
    const borrower = accountFor('borrower').address;
    await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('2000')]);
    await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);
    const matching = await sc.read<boolean>('getPartialFillEnabled', []);

    const { page, flags } = await launchWallet('borrower', { advanced: true });
    await openForm(page, tliq);
    const advanced = page.getByTestId('request-advanced');
    await expect(advanced.getByRole('heading', { name: 'Advanced options' })).toBeVisible();

    await page.getByTestId('request-amount').fill('0.25');
    await page.getByTestId('request-collateral').fill('2000');
    await page.getByTestId('request-rate').fill('6');
    // All or none takes one amount: a range turns it off and greys it out.
    await page
      .getByTestId('request-fill')
      .getByRole('radio', { name: /All or none/ })
      .check();
    await page.getByTestId('request-range').check();
    await expect(page.getByTestId('request-fill').getByRole('radio', { name: /All or none/ })).toBeDisabled();
    await expect(page.getByTestId('request-fill').getByRole('radio', { name: /Partial/ })).toBeChecked();
    await expect(page.getByText('Smallest amount (WETH)')).toBeVisible();
    // A malformed range is named in place.
    await page.getByTestId('request-amount-max').fill('0.1');
    await page.getByTestId('request-amount-max').blur();
    await expect(page.getByText('The largest amount must be at least the smallest.')).toBeVisible();
    await page.getByTestId('request-amount-max').fill('0.5');
    await page.getByTestId('request-floor').fill('2500');
    await page.getByTestId('request-floor').blur();
    await expect(page.getByText('The collateral for the smallest amount cannot be more than you lock.')).toBeVisible();
    await page.getByTestId('request-floor').fill('1000');
    // Immediate or cancel needs an expiry.
    await page.getByTestId('request-expiry').selectOption('never');
    await expect(page.getByTestId('request-fill').getByRole('radio', { name: /Immediate or cancel/ })).toBeDisabled();
    await page.getByTestId('request-expiry').selectOption('7d');
    await page
      .getByTestId('request-fill')
      .getByRole('radio', { name: /Immediate or cancel/ })
      .check();
    await expect(page.getByTestId('request-summary')).toContainText('Largest match: 0.5 WETH');
    await fitsWidth(page);
    await page.getByTestId('request-review').click();

    const receipt = page.locator('.post-request .receipt');
    await expect(receipt).toContainText('Smallest amount a lender may lend', { timeout: 60_000 });
    await expect(receipt).toContainText('Largest amount a match may lend');
    await expect(receipt).toContainText('Locked for the smallest loan');
    await expect(receipt).toContainText('Back to your wallet if a lender takes it directly');
    await expect(receipt).toContainText('Immediate or cancel: matches until it lapses, then the rest lapses');
    await expect(receipt).toContainText(matching ? 'On now: the range can fill across several matches' : 'Off now: matchers refuse');
    await expect(receipt).toContainText(/Loan-to-value if a lender takes it directly, at today's prices\s*[\d.]+%/);
    // A match locks what its lender asks for, at least the floor: the
    // largest match is stated from all the collateral to only the floor.
    await expect(receipt).toContainText(
      /Loan-to-value of the largest loan a match can make, at today's prices\s*[\d.]+% with all your collateral locked, up to [\d.]+% with only the floor/,
    );
    await expect(receipt).toContainText('A match locks only the collateral its lender asks for, at least 1,000 tLIQ');
    await expect(receipt).toContainText('You owe at the due date on the largest loan a match can make');
    // Advanced detail: the health factor a loan must start at, read live.
    await expect(receipt).toContainText(/At least \d+\.\d\d, read now/);
    // Only the fill mode is fixed: the protocol lets an open request's
    // amounts, rate and collateral change, which this app does not offer yet.
    await expect(receipt).toContainText('The fill mode cannot be changed after posting');
    await expect(receipt).toContainText('but this app does not offer that yet');
    // While matching is on, the collateral a match leaves stays with the request.
    const keepsRest = 'comes back to your wallet only when the request closes or you cancel it';
    if (matching) await expect(receipt).toContainText(keepsRest);
    else await expect(receipt).not.toContainText(keepsRest);
    await expect(receipt).not.toContainText('a lender cannot take this directly');
    // The approval covers everything posted, not the floor.
    await expect(receipt).toContainText('Exactly 2,000');
    await fitsWidth(page);

    const flow = page.locator('.post-request');
    await flow.getByTestId('request-consent').check();
    const sent = flags.sentTransactions;
    await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
    const finish = flow.locator('[data-phase="measured"]');
    await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
    expect(flags.sentTransactions).toBe(sent + 2);

    // The chain holds the range as typed: both ends, one rate, the floor, all
    // of the collateral, and the fill mode.
    const id = BigInt((await finish.textContent())!.match(/Request #(\d+)/)![1]!);
    const offer = await sc.read<StoredOffer>('getOffer', [id]);
    expect([offer.amount, offer.amountMax]).toEqual([parseEther('0.25'), parseEther('0.5')]);
    expect([offer.interestRateBps, offer.interestRateBpsMax]).toEqual([600n, 600n]);
    expect([offer.collateralAmount, offer.collateralAmountMax]).toEqual([parseEther('1000'), parseEther('2000')]);
    expect(offer.fillMode).toBe(2);
    expect(offer.expiresAt > 0n).toBe(true);
    const vault = await sc.read<Hex>('getUserVaultAddress', [borrower]);
    expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'balanceOf', args: [vault] })).toBeGreaterThanOrEqual(parseEther('2000'));
  } finally {
    await anvilRpc('evm_revert', [snapshot]);
  }
});

test('a range the collateral cannot carry is refused with its ceiling, the direct point is warned in Basic, and Basic says the options still apply', async ({
  launchWallet,
}, testInfo) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const { page, flags } = await launchWallet('borrower', { advanced: true });
  await openForm(page, tliq);

  await page.getByTestId('request-amount').fill('0.25');
  await page.getByTestId('request-collateral').fill('1');
  await page.getByTestId('request-rate').fill('6');
  await page.getByTestId('request-range').check();
  await page.getByTestId('request-amount-max').fill('100000');
  await page.getByTestId('request-floor').fill('0.0001');
  await page.getByTestId('request-review').click();

  const flow = page.locator('.post-request');
  // The protocol's own ceiling for the largest amount, as a blocker that the
  // wallet's shortfall (it holds no tLIQ) never hides; and the direct point,
  // which the create check does not cover, warned.
  await expect(flow).toContainText(/The largest amount asks for more than your collateral supports at today's prices: at most (≈ )?[\d.,]+ WETH/, { timeout: 60_000 });
  await expect(flow).toContainText('1 tLIQ short of the 1 tLIQ this request locks');
  await expect(flow.locator('.receipt')).toContainText(/At today's prices a lender cannot take this directly: 0\.0001 tLIQ supports at most (≈ )?[\d.,]+ WETH/);
  await expect(flow.getByTestId('request-consent')).toHaveCount(0);
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);

  // Back to the form, then to Basic: the options still apply and say so.
  await flow.getByTestId('request-edit').click();
  await openMenu(page);
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Basic' }).click();
  if (onPhone(testInfo.project.name)) await page.keyboard.press('Escape');
  await expect(page.getByTestId('request-advanced')).toHaveCount(0);
  await expect(page.getByTestId('request-advanced-set')).toContainText('an amount range');
  await expect(page.getByText('Smallest amount (WETH)')).toBeVisible();
  await page.getByTestId('request-advanced-clear').click();
  await expect(page.getByTestId('request-advanced-set')).toHaveCount(0);
  await expect(page.getByText('Amount to borrow (WETH)')).toBeVisible();
  await fitsWidth(page);
  expect(flags.sentTransactions).toBe(0);
});
