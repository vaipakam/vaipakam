/**
 * Lend: a lender's Advanced options on their own offer (matrix OFF-10 / OFF-11
 * from the lender's side): parts, the smallest of which one match may lend,
 * and the fill mode. The amount typed stays the whole amount, which posting
 * locks and a borrower taking the offer directly borrows; the review states
 * the smallest part, the least collateral it asks, and what matching in parts
 * means; the protocol's collateral floor is named as the lender's blocker.
 * Runs on the desktop and the phone project; the suite reverts the chain
 * after every test, so later specs and the other project start without the
 * offer.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, onPhone, openMenu, test } from '../lib/wallet';

/** Nothing on the page is wider than the window (a phone never scrolls sideways). */
async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const WETH_ABI = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;

interface StoredOffer {
  offerType: number;
  amount: bigint;
  amountMax: bigint;
  collateralAmount: bigint;
  collateralAmountMax: bigint;
  fillMode: number;
}

test('a lender posts an offer in parts: the whole amount locked, the smallest part and its collateral stated, the floor named', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const lender = accountFor('lender').address;
  await sc.write('lender', WETH, WETH_ABI, 'deposit', [], parseEther('0.2'));
  await sc.write('lender', WETH, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('lender', { advanced: true });
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  await page.getByTestId('lend-offer-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });

  await page.getByTestId('request-amount').fill('0.2');
  await page.getByTestId('request-rate').fill('6');
  await page.getByTestId('request-range').check();
  await expect(page.getByText('For the whole amount; a match lending a part asks a matching share of it.')).toBeVisible();
  // The smallest part cannot be more than the whole amount.
  await page.getByTestId('lend-offer-part').fill('0.3');
  await page.getByTestId('lend-offer-part').blur();
  await expect(page.getByText('The smallest part cannot be more than the amount you lend.')).toBeVisible();
  // #3242 — a part worth less than the offer-book floor is named with the
  // protocol's own smallest amount, before any review or signature.
  await page.getByTestId('lend-offer-part').fill('0.000001');
  await expect(page.getByText(/The smallest offer the protocol accepts in this token is [0-9.]+ WETH\./)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('lend-offer-part').fill('0.05');
  // All or none takes no parts; immediate or cancel needs an expiry.
  const fill = page.getByTestId('request-fill');
  await expect(fill.getByRole('radio', { name: /All or none: one borrower/ })).toBeDisabled();
  await page.getByTestId('request-expiry').selectOption('7d');
  await fill.getByRole('radio', { name: /Immediate or cancel/ }).check();
  // A collateral the protocol finds too small is named as the lender's to raise.
  await page.getByTestId('request-collateral').fill('0.0001');
  await fitsWidth(page);
  await page.getByTestId('request-review').click();
  const flow = page.locator('.post-request');
  await expect(flow).toContainText('The protocol asks at least', { timeout: 60_000 });
  await expect(flow).toContainText('Ask for more collateral, or lend less.');
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  expect(flags.sentTransactions).toBe(0);
  await flow.getByTestId('request-edit').click();
  await expect(page.getByTestId('lend-offer-part')).toHaveValue('0.05');
  await page.getByTestId('request-collateral').fill('1500');
  await page.getByTestId('request-review').click();

  const receipt = page.locator('.post-request .receipt');
  await expect(receipt).toContainText('Post your lending offer', { timeout: 60_000 });
  await expect(receipt).toContainText('Amount a borrower takes');
  await expect(receipt).toContainText('Smallest part one match may lend');
  await expect(receipt).toContainText('Taken directly: all of it; by matches: parts of at least the smallest');
  await expect(receipt).toContainText('Immediate or cancel');
  await expect(receipt).toContainText('Collateral a borrower must lock for the whole amount');
  await expect(receipt).toContainText('Least collateral a match asks for the smallest part');
  await expect(receipt).toContainText('375');
  await expect(receipt).toContainText('A borrower taking all of it receives');
  await expect(receipt).toContainText("Matching with borrowers' requests on this network");
  await expect(receipt).toContainText('A borrower taking your offer directly borrows all of it.');
  await expect(receipt).toContainText('Once a match has lent a part, no borrower can take the rest directly');
  await expect(receipt).toContainText('rounded down');
  await expect(receipt).toContainText('The fill mode cannot be changed after posting');
  await expect(receipt).toContainText('Exactly 0.2');
  await fitsWidth(page);

  await flow.getByTestId('request-consent').check();
  const sent = flags.sentTransactions;
  await flow.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = flow.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('0.2 WETH locked in your vault');
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: the smallest part is the minimum, the whole amount the
  // maximum, one collateral figure at both ends, immediate or cancel.
  const id = BigInt((await finish.textContent())!.match(/Offer #(\d+)/)![1]!);
  const offer = await sc.read<StoredOffer>('getOffer', [id]);
  expect(offer.offerType).toBe(0);
  expect([offer.amount, offer.amountMax]).toEqual([parseEther('0.05'), parseEther('0.2')]);
  expect([offer.collateralAmount, offer.collateralAmountMax]).toEqual([parseEther('1500'), parseEther('1500')]);
  expect(offer.fillMode).toBe(2);
  expect(await sc.pub.readContract({ address: WETH, abi: erc20Abi, functionName: 'allowance', args: [lender, sc.diamond] })).toBe(0n);
});

test('parts set in Advanced still apply in Basic, which says so and clears them', async ({ launchWallet }, testInfo) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const { page } = await launchWallet('visitor', { advanced: true });
  await page.goto('/lend');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);
  await page.getByTestId('lend-offer-open').click();
  await page.getByTestId('request-range').check();
  await page.getByTestId('lend-offer-part').fill('0.01');
  await openMenu(page);
  await page.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Basic' }).click();
  if (onPhone(testInfo.project.name)) await page.keyboard.press('Escape');
  await expect(page.getByTestId('request-advanced-set')).toContainText('Advanced options set for this offer still apply: lending in parts.');
  await fitsWidth(page);
  await page.getByTestId('request-advanced-clear').click();
  await expect(page.getByTestId('request-advanced-set')).toHaveCount(0);
});
