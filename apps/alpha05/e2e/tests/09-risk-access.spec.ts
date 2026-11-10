/**
 * Risk access in the borrow flows (matrix ACC-RISK, OFF-50, OFF-05): with the
 * protocol's risk-access gate switched on, a pair the wallet's risk level
 * does not cover is stated in place with the one step that clears it, the
 * step runs through the shared signing flow with its own receipt and
 * measured outcome, a step the protocol makes wait states when it takes
 * effect (read from the chain, never assumed immediate), and an illiquid pair
 * asks for the wallet's agreement to that exact pair after the level. Every
 * test switches the gate on itself, and the suite reverts the chain after
 * each test, so no other spec and neither project sees it on.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH, postLenderOffer } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { increaseTime, mine } from '../lib/anvil';
import { scenario } from '../lib/chain';
import { accountFor } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function openRequest(page: Page, collateral: Hex, amount: string, lock: string): Promise<void> {
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(collateral);
  await page.getByTestId('request-open').click();
  await expect(page.getByTestId('request-duration')).toContainText('30 days', { timeout: 60_000 });
  await page.getByTestId('request-amount').fill(amount);
  await page.getByTestId('request-collateral').fill(lock);
  await page.getByTestId('request-rate').fill('6');
  await page.getByTestId('request-review').click();
}

test('taking an offer the risk level does not cover: the review raises it in place, then the offer can be taken', async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const borrower = accountFor('borrower').address;
  // The lender's offer is posted before the gate, and the lender raises its
  // own level, so the only block is the borrower's.
  const offerId = await postLenderOffer(sc, { lender: 'lender', principalWeth: '0.3', collateralTliq: '1500', rateBps: 500, days: 30 });
  await sc.diamondWrite('lender', 'setVaultRiskTier', [1]);
  await sc.diamondWrite('admin', 'setRiskAccessGateEnabled', [true]);
  expect(
    Number(
      await sc.read('pairRequiredRiskLevel', [
        { lendAsset: WETH, lendType: 0, lendTokenId: 0n, collAsset: tliq, collType: 0, collTokenId: 0n, prepayAsset: '0x0000000000000000000000000000000000000000' },
      ]),
    ),
  ).toBe(1);
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('1500')]);

  const { page, flags } = await launchWallet('borrower');
  await page.goto('/borrow');
  await connectWallet(page);
  await page.getByTestId('pick-lending').locator('select').selectOption(WETH);
  await page.getByTestId('pick-collateral').locator('select').selectOption(tliq);

  // The row says a step is needed and keeps the review one tap away.
  const row = page.locator(`[data-offer-id="${offerId}"]`);
  await expect(row).toHaveAttribute('data-risk-step', 'true', { timeout: 60_000 });
  await expect(row).toContainText('needs one risk-access step');
  await fitsWidth(page);
  await row.getByRole('button', { name: 'Review this offer' }).click();

  const review = page.locator(`.accept-offer[data-offer-id="${offerId}"]`);
  const gate = review.getByTestId('risk-gate');
  await expect(gate).toHaveAttribute('data-risk-plan', 'raise', { timeout: 60_000 });
  await expect(gate).toContainText("This pair needs the risk level “Liquid assets”. Your account's level is “Blue-chip assets only”.");
  await expect(gate).toContainText('It takes effect as soon as the transaction is confirmed.');
  await expect(review.getByTestId('accept-consent')).toHaveCount(0);
  await fitsWidth(page);
  await gate.getByTestId('risk-open').click();

  // The step's own receipt: what changes, how far it reaches, that no funds move.
  const step = review.getByTestId('risk-step');
  const receipt = step.locator('.receipt');
  await expect(receipt).toContainText('Raise your risk level', { timeout: 60_000 });
  await expect(receipt).toContainText('From “Blue-chip assets only” to “Liquid assets”');
  await expect(receipt).toContainText('Every pair up to this level, for this wallet on Base Sepolia');
  await expect(receipt).toContainText('None: this only records a setting');
  await expect(receipt).toContainText('Any time, taking effect at once');
  await expect(receipt).toContainText('not only this one');
  await fitsWidth(page);
  const sent = flags.sentTransactions;
  await step.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = step.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Risk level set to “Liquid assets”');
  await expect(finish).toContainText('In effect now');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(Number(await sc.read('getEffectiveRiskTier', [borrower]))).toBe(1);

  // Back in the review: the block is gone and the acceptance can be confirmed.
  await finish.getByTestId('risk-back').click();
  await expect(review.getByTestId('risk-gate')).toHaveCount(0, { timeout: 60_000 });
  await review.getByTestId('accept-consent').check();
  await expect(review.getByRole('button', { name: 'Confirm in wallet' })).toBeEnabled();
});

test("posting a request while a raise waits out the protocol's waiting period: the time is stated, nothing is offered twice", async ({ launchWallet }) => {
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const borrower = accountFor('borrower').address;
  await sc.diamondWrite('admin', 'setRiskAccessGateEnabled', [true]);
  await sc.diamondWrite('admin', 'setRiskAccessUnlockCooldown', [3600n]);
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('1000')]);
  await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('borrower');
  await openRequest(page, tliq, '0.1', '1000');
  const flow = page.locator('.post-request');
  const gate = flow.getByTestId('risk-gate');
  await expect(gate).toHaveAttribute('data-risk-plan', 'raise', { timeout: 60_000 });
  await expect(flow).toContainText('risk level does not cover this pair yet');
  await expect(gate).toContainText('It takes effect about 1 h after it is recorded');
  await gate.getByTestId('risk-open').click();

  const step = flow.getByTestId('risk-step');
  await expect(step.locator('.receipt')).toContainText('About 1 h after it is recorded', { timeout: 60_000 });
  const sent = flags.sentTransactions;
  await step.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = step.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Takes effect at');
  expect(flags.sentTransactions).toBe(sent + 1);
  await finish.getByTestId('risk-back').click();

  // Waiting: the time is stated and no second raise is offered (it would
  // start the wait over); the request stays blocked.
  await expect(gate).toHaveAttribute('data-risk-plan', 'wait-tier', { timeout: 60_000 });
  await expect(gate).toContainText('Your risk level “Liquid assets” is recorded and takes effect at');
  await expect(gate.getByTestId('risk-open')).toHaveCount(0);
  await expect(flow.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await fitsWidth(page);

  // Once the period has passed on chain, the review clears by itself.
  await increaseTime(3601);
  await mine(2);
  await expect(flow.getByTestId('risk-gate')).toHaveCount(0, { timeout: 60_000 });
  await expect(flow.getByTestId('request-consent')).toBeVisible();
});

test('an illiquid pair: the level first, then the agreement to that exact pair', async ({ launchWallet }) => {
  const sc = scenario();
  const illiquid = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).illiquidToken;
  const borrower = accountFor('borrower').address;
  await sc.diamondWrite('admin', 'setRiskAccessGateEnabled', [true]);
  await sc.write('borrower', illiquid, MINT_ABI, 'mint', [borrower, parseEther('100')]);

  const { page } = await launchWallet('borrower');
  await openRequest(page, illiquid, '0.01', '100');
  const flow = page.locator('.post-request');
  const gate = flow.getByTestId('risk-gate');
  await expect(gate).toContainText('“Any asset, including illiquid ones”', { timeout: 60_000 });
  await gate.getByTestId('risk-open').click();
  let step = flow.getByTestId('risk-step');
  await step.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(step.locator('[data-phase="measured"]')).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await step.getByTestId('risk-back').click();

  // The protocol's next answer asks for the agreement to the pair.
  await expect(gate).toHaveAttribute('data-risk-need', 'pair-consent', { timeout: 60_000 });
  await expect(flow).toContainText('This illiquid pair needs your agreement');
  await gate.getByTestId('risk-open').click();
  step = flow.getByTestId('risk-step');
  const receipt = step.locator('.receipt');
  await expect(receipt).toContainText('Agree to an illiquid pair', { timeout: 60_000 });
  await expect(receipt).toContainText('This exact pair only, for this wallet on Base Sepolia');
  await expect(receipt).toContainText('no price-based liquidation');
  await fitsWidth(page);
  await step.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = step.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('Agreement to this pair recorded');
  await finish.getByTestId('risk-back').click();
  await expect(flow.getByTestId('risk-gate')).toHaveCount(0, { timeout: 60_000 });
});
