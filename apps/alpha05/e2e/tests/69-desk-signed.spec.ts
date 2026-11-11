/**
 * Your signed orders on the rate desk, and the on-chain cancel (matrix
 * OFF-61). The lender signs three gasless orders on the WETH against tLIQ
 * 30-day market with its test key, two of them under one nonce, and posts
 * them to the offer book (the stand-in checks each signature as the indexer
 * does); another wallet's order on the same market is posted too. On the
 * desk the lender sees only its own three, each open on the chain, the
 * pair that shares a nonce grouped, and the statement that the on-chain
 * cancel is the only way to stop one. With the book held behind the chain,
 * the lender cancels one order: the review says it moves nothing and names
 * the race, the chain marks the order used, and the row the book still
 * lists reads as already cancelled with no cancel offered. With the book
 * following the chain again, the lender cancels the shared nonce: the
 * chain burns it, the book drops every order, and the finish card stays on
 * screen. Runs on the desktop and the phone project; the chain is reverted
 * after each test.
 */
import type { Hex } from 'viem';
import { postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import type { Page } from '@playwright/test';
import { orderHashOf, SIGNED_OFFER_TYPES, typedMessage, type SignedOrderWire } from '../../src/shared/desk/signedOrder';
import { scenario } from '../lib/chain';
import { postSignedOrder, setSignedBookLag } from '../lib/stub';
import { accountFor, type Role } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const CHAIN_ID = 84532;
const ZERO = '0x0000000000000000000000000000000000000000';

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('your signed orders are listed with the chain’s standing, and each is cancelled on the chain, alone or by its nonce', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await postLenderOffer(sc, { lender: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const lender = accountFor('lender').address.toLowerCase();
  const head = await sc.pub.getBlock({ blockTag: 'latest' });
  // Open a week on both clocks: the chain's (the cancel's) and the wall's
  // (the book's).
  const until = String(Math.max(Number(head.timestamp), Math.floor(Date.now() / 1000)) + 7 * 86_400);

  const order = (role: Role, patch: Partial<SignedOrderWire>): SignedOrderWire => ({
    offerType: '0',
    lendingAsset: WETH.toLowerCase(),
    amount: '50000000000000000',
    amountMax: '50000000000000000',
    interestRateBps: '600',
    interestRateBpsMax: '600',
    collateralAsset: tliq.toLowerCase(),
    collateralAmount: '250000000000000000000',
    collateralAmountMax: '250000000000000000000',
    durationDays: '30',
    assetType: '0',
    collateralAssetType: '0',
    tokenId: '0',
    quantity: '0',
    collateralTokenId: '0',
    collateralQuantity: '0',
    prepayAsset: ZERO,
    allowsPartialRepay: false,
    allowsPrepayListing: false,
    allowsParallelSale: false,
    expiresAt: until,
    fillMode: '1',
    periodicInterestCadence: '0',
    refinanceTargetLoanId: '0',
    useFullTermInterest: true,
    creatorFull: false,
    creatorMaxCStar: '0',
    creatorAllowFullDowngrade: false,
    signer: accountFor(role).address.toLowerCase(),
    nonce: '1001',
    deadline: until,
    ...patch,
  });
  const post = async (role: Role, o: SignedOrderWire) => {
    const signature = await accountFor(role).signTypedData({
      domain: { name: 'Vaipakam SignedOffer', version: '1', chainId: CHAIN_ID, verifyingContract: sc.diamond },
      types: SIGNED_OFFER_TYPES,
      primaryType: 'SignedOffer',
      message: typedMessage(o),
    });
    return postSignedOrder({ chainId: CHAIN_ID, order: o as unknown as Record<string, unknown>, signature });
  };

  const alone = order('lender', {});
  const pairA = order('lender', { nonce: '1002', interestRateBps: '650', interestRateBpsMax: '650' });
  const pairB = order('lender', { nonce: '1002', interestRateBps: '700', interestRateBpsMax: '700' });
  for (const o of [alone, pairA, pairB]) expect((await post('lender', o)).status).toBe(201);
  // A re-post is the same order; another wallet's order is not the lender's.
  expect((await post('lender', alone)).status).toBe(200);
  expect((await post('borrower', order('borrower', { nonce: '1003' }))).status).toBe(201);
  const hashes = [alone, pairA, pairB].map(orderHashOf);

  const { page, flags } = await launchWallet('lender', { advanced: true });
  await page.goto(`/desk?market=${WETH.toLowerCase()}-${tliq.toLowerCase()}-30`);
  await connectWallet(page);
  const panel = page.getByTestId('desk-signed');
  await expect(panel).toContainText('Your signed orders');
  await expect(panel.getByTestId('desk-signed-only-way')).toContainText('The only way to stop one before it lapses is a cancel on the chain');
  const rows = panel.getByTestId('desk-signed-order');
  await expect(rows).toHaveCount(3, { timeout: 60_000 });
  for (const h of hashes) await expect(panel.locator(`[data-order-hash="${h}"]`)).toHaveAttribute('data-standing', 'open', { timeout: 60_000 });
  const first = panel.locator(`[data-order-hash="${hashes[0]}"]`);
  await expect(first).toContainText('at 6% a year for 30 days');
  await expect(first).toContainText('Fillable until');
  await expect(first).toContainText('Open: nothing on the chain stops a fill.');
  const group = panel.getByTestId('desk-signed-nonce');
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-nonce', '1002');
  await expect(group).toContainText('2 of these open orders share one nonce');
  await fitsWidth(page);

  // One order, with the book held behind the chain.
  await setSignedBookLag(true);
  await first.getByTestId('desk-signed-cancel').click();
  const cancelOne = first.getByTestId('desk-signed-cancel-panel');
  const receipt = cancelOne.locator('.receipt');
  await expect(receipt).toContainText('Cancel this signed order', { timeout: 60_000 });
  await expect(receipt).toContainText('Marks this order used on the chain, so no fill can bind it.');
  await expect(receipt).toContainText('Nothing: a signed order sets nothing aside, so a cancel returns nothing. You pay gas.');
  await expect(receipt).toContainText('whichever the chain includes first wins');
  await expect(receipt).toContainText('A fill would have drawn');
  // Only one cancel is open at a time.
  await expect(panel.getByTestId('desk-signed-cancel')).toHaveCount(0);
  await expect(panel.getByTestId('desk-signed-cancel-nonce')).toHaveCount(0);
  const sent = flags.sentTransactions;
  await cancelOne.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finishOne = cancelOne.locator('[data-phase="measured"]');
  await expect(finishOne).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finishOne).toContainText('Signed order cancelled on the chain');
  expect(flags.sentTransactions).toBe(sent + 1);
  expect(await sc.read<bigint>('signedOfferFilledAmount', [hashes[0]])).toBeGreaterThan(0n);
  await finishOne.getByRole('button', { name: 'Close' }).click();
  // The book still lists it; the chain says it is done, and no cancel is offered.
  await expect(first).toHaveAttribute('data-standing', 'used', { timeout: 60_000 });
  await expect(first).toContainText('Already filled or cancelled on the chain; the offer book has not caught up.');
  await expect(first.getByTestId('desk-signed-cancel')).toHaveCount(0);

  // The shared nonce, with the book following the chain again.
  await setSignedBookLag(false);
  await group.getByTestId('desk-signed-cancel-nonce').click();
  const cancelNonce = panel.getByTestId('desk-signed-cancel-panel');
  const nonceReceipt = cancelNonce.locator('.receipt');
  await expect(nonceReceipt).toContainText('Cancel every order signed with this nonce', { timeout: 60_000 });
  await expect(nonceReceipt).toContainText('1002');
  await expect(nonceReceipt).toContainText('2 open orders on this market');
  await expect(nonceReceipt).toContainText('Cancels every order this wallet signed with this nonce, on every market.');
  await expect(nonceReceipt).toContainText('that this page does not list');
  await cancelNonce.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finishNonce = cancelNonce.locator('[data-phase="measured"]');
  await expect(finishNonce).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finishNonce).toContainText('Every order with this nonce cancelled on the chain');
  expect(await sc.read<boolean>('isSignedOfferNonceUsed', [lender, 1002n])).toBe(true);
  // The book drops every order; the finish card stays until it is closed.
  await expect(panel.getByTestId('desk-signed-none')).toBeVisible({ timeout: 60_000 });
  await expect(finishNonce).toBeVisible();
  await fitsWidth(page);
  await finishNonce.getByRole('button', { name: 'Close' }).click();
  await expect(panel.getByTestId('desk-signed-cancel-panel')).toHaveCount(0);
});
