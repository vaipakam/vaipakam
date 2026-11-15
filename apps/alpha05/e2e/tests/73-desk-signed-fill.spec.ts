/**
 * Filling a signed order from the rate desk (matrix OFF-60, second slice:
 * the fill). Another wallet signs a gasless lender order on the WETH against
 * tLIQ 30-day market, with its vault holding the amount free, and posts it
 * to the offer book. The viewer opens the order's fill review from the
 * desk's signed-order list: the review is read from the protocol's preview
 * of the signed fill, names the maker, the order's hash, what the fill takes
 * from the maker's vault against what it holds free and that a fill takes
 * the whole order; the protocol's own preview of the fill's risk-access
 * check is read with it, so the review does not leave that check to the dry
 * run. The
 * viewer signs the terms keyed to the order's hash, approves exactly the
 * collateral and sends the fill; the finish card reads the loan from the
 * fill's own log, and the chain agrees: the order is used, the maker's vault
 * gave the amount, the viewer's vault holds it less the fee and the
 * collateral. A second order larger than the maker's vault holds free is
 * refused in the review by the protocol's own preview, and nothing is
 * signed or sent. With the risk-access gate on, the preview names whose
 * access blocks the fill: the maker's is stated and offers no step, and the
 * taker's opens the step that clears it in the review, before anything is
 * signed. Runs on the desktop and the phone project; the chain is reverted
 * after each test.
 */
import { erc20Abi, parseEther, type Hex } from 'viem';
import { WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
import type { Page } from '@playwright/test';
import { orderHashOf, SIGNED_OFFER_TYPES, typedMessage, type SignedOrderWire } from '../../src/shared/desk/signedOrder';
import { scenario } from '../lib/chain';
import { postSignedOrder } from '../lib/stub';
import { accountFor, type Role } from '../lib/wallets';
import { connectWallet, expect, test } from '../lib/wallet';

const CHAIN_ID = 84532;
const ZERO = '0x0000000000000000000000000000000000000000';
const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }] as const;

async function fitsWidth(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

/** A lender order by `role` on the market, signed and posted to the book. */
async function signedLenderOrder(role: Role, tliq: Hex, diamond: Hex, until: string, patch: Partial<SignedOrderWire>): Promise<SignedOrderWire> {
  const o: SignedOrderWire = {
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
    nonce: '3001',
    deadline: until,
    ...patch,
  };
  const signature = await accountFor(role).signTypedData({
    domain: { name: 'Vaipakam SignedOffer', version: '1', chainId: CHAIN_ID, verifyingContract: diamond },
    types: SIGNED_OFFER_TYPES,
    primaryType: 'SignedOffer',
    message: typedMessage(o),
  });
  expect((await postSignedOrder({ chainId: CHAIN_ID, order: o as unknown as Record<string, unknown>, signature })).status).toBe(201);
  return o;
}

test('a signed order is filled whole from the desk: the protocol’s preview, terms keyed to the order, a measured loan', async ({ launchWallet }) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const head = await sc.pub.getBlock({ blockTag: 'latest' });
  const until = String(Math.max(Number(head.timestamp), Math.floor(Date.now() / 1000)) + 7 * 86_400);

  // The maker's vault holds the order's 0.05 WETH free.
  const free = parseEther('0.05');
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], free);
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, free]);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, free]);
  const makerVault = await sc.read<Hex>('getUserVaultAddress', [accountFor('lender').address]);
  const maker = accountFor('lender').address.toLowerCase();

  const order = await signedLenderOrder('lender', tliq, sc.diamond, until, {});
  const short = await signedLenderOrder('lender', tliq, sc.diamond, until, {
    nonce: '3002',
    amount: '200000000000000000',
    amountMax: '200000000000000000',
    interestRateBps: '550',
    interestRateBpsMax: '550',
  });
  const [hash, hShort] = [order, short].map(orderHashOf);

  // The taker holds the collateral and starts with no allowance, so the
  // approval step is observable.
  const borrower = accountFor('borrower').address;
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('250')]);
  await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('borrower', { advanced: true });
  await page.goto(`/desk?market=${WETH.toLowerCase()}-${tliq.toLowerCase()}-30`);
  await connectWallet(page);
  const section = page.getByTestId('desk-signed-book');
  const row = section.locator(`li[data-order-hash="${hash}"]`);
  await expect(row).toHaveAttribute('data-standing', 'open', { timeout: 60_000 });
  await expect(row).toHaveAttribute('data-cover', 'covers');

  // A short order: the protocol's own preview refuses it in the review.
  await section.locator(`li[data-order-hash="${hShort}"]`).getByTestId('desk-signed-book-fill').click();
  const shortReview = section.locator(`.accept-offer[data-order-hash="${hShort}"]`);
  await expect(shortReview).toContainText('The maker’s vault does not hold free what this fill would draw from it, so a fill now would fail.', {
    timeout: 60_000,
  });
  await expect(shortReview.getByTestId('accept-consent')).toHaveCount(0);
  await expect(shortReview.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await fitsWidth(page);
  await shortReview.getByRole('button', { name: 'Cancel' }).click();
  await expect(shortReview).toHaveCount(0);

  // The order the maker's vault covers.
  await row.getByTestId('desk-signed-book-fill').click();
  const review = section.locator(`.accept-offer[data-order-hash="${hash}"]`);
  const receipt = review.locator('.receipt');
  await expect(receipt).toContainText(`Take a signed offer from ${maker.slice(0, 6)}`, { timeout: 60_000 });
  await expect(receipt).toContainText('Paid into your vault, yours to withdraw');
  await expect(receipt).toContainText('You lock in your vault');
  await expect(receipt).toContainText('The signed order');
  await expect(receipt).toContainText(hash);
  await expect(receipt).toContainText('Taken from the lender’s vault by this fill');
  await expect(receipt).toContainText('Free in the maker’s vault now');
  await expect(receipt).toContainText('A fill takes the whole order in one transaction');
  await expect(receipt).not.toContainText('so the dry run after you sign makes it');
  await expect(receipt).toContainText('Exactly 250');
  await expect(receipt).toContainText('Wallet prompts: 3.');
  await fitsWidth(page);

  const confirm = review.getByRole('button', { name: 'Confirm in wallet' });
  await expect(confirm).toBeDisabled();
  await review.getByTestId('accept-consent').check();
  await expect(confirm).toBeEnabled();

  const sent = flags.sentTransactions;
  const signed = flags.typedDataRequests.AcceptTerms ?? 0;
  const balance = (token: Hex, who: Hex) => sc.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  const makerBefore = await balance(WETH, makerVault);
  await confirm.click();
  const finish = review.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  await expect(finish).toContainText('with you as the borrower');
  await expect(finish).toContainText('credited to your vault, free to withdraw');
  await expect(finish).toContainText('locked in your vault');
  await expect(finish.locator('a[href^="/positions/"]')).toContainText(/Open loan #\d+/);
  expect(flags.typedDataRequests.AcceptTerms ?? 0).toBe(signed + 1);
  expect(flags.sentTransactions).toBe(sent + 2);

  // The chain agrees: the order is used whole, the maker's vault gave the
  // amount, the taker's vault holds it less the fee, and no approval stands.
  expect(await sc.read<bigint>('signedOfferFilledAmount', [hash])).toBe(parseEther('0.05'));
  expect(makerBefore - (await balance(WETH, makerVault))).toBe(parseEther('0.05'));
  const takerVault = await sc.read<Hex>('getUserVaultAddress', [borrower]);
  expect(await balance(tliq, takerVault)).toBeGreaterThanOrEqual(parseEther('250'));
  expect(await sc.pub.readContract({ address: tliq, abi: erc20Abi, functionName: 'allowance', args: [borrower, sc.diamond] })).toBe(0n);
  await finish.getByRole('button', { name: 'Close' }).click();
  await expect(row).toHaveAttribute('data-standing', 'used', { timeout: 60_000 });
  await expect(row.getByTestId('desk-signed-book-fill')).toHaveCount(0);
  await fitsWidth(page);
});

test('a fill the risk level does not cover: the protocol’s preview names whose access blocks it, the step is offered in the review, then the fill lands', async ({
  launchWallet,
}) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  const head = await sc.pub.getBlock({ blockTag: 'latest' });
  const until = String(Math.max(Number(head.timestamp), Math.floor(Date.now() / 1000)) + 7 * 86_400);

  // Neither the maker's level nor the taker's covers the pair at first.
  const free = parseEther('0.05');
  await sc.write('lender', WETH, TOKEN_ABI, 'deposit', [], free);
  await sc.write('lender', WETH, TOKEN_ABI, 'approve', [sc.diamond, free]);
  await sc.diamondWrite('lender', 'depositToVault', [0, WETH, 0n, free]);
  await sc.diamondWrite('admin', 'setRiskAccessGateEnabled', [true]);
  const order = await signedLenderOrder('lender', tliq, sc.diamond, until, { nonce: '3101' });
  const hash = orderHashOf(order);
  const borrower = accountFor('borrower').address;
  await sc.write('borrower', tliq, MINT_ABI, 'mint', [borrower, parseEther('250')]);
  await sc.write('borrower', tliq, erc20Abi, 'approve', [sc.diamond, 0n]);

  const { page, flags } = await launchWallet('borrower', { advanced: true });
  await page.goto(`/desk?market=${WETH.toLowerCase()}-${tliq.toLowerCase()}-30`);
  await connectWallet(page);
  const section = page.getByTestId('desk-signed-book');
  const row = section.locator(`li[data-order-hash="${hash}"]`);
  await expect(row).toHaveAttribute('data-standing', 'open', { timeout: 60_000 });
  await row.getByTestId('desk-signed-book-fill').click();
  const review = section.locator(`.accept-offer[data-order-hash="${hash}"]`);

  // The maker's own level refuses first: the review states it before
  // anything is signed, and offers no step of the taker's, since none could
  // clear it.
  await expect(review).toContainText("The lender's own risk setting no longer covers this pair", { timeout: 60_000 });
  await expect(review.locator('.receipt')).not.toContainText('so the dry run after you sign makes it');
  await expect(review.getByTestId('risk-gate')).toHaveCount(0);
  await expect(review.getByTestId('accept-consent')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Confirm in wallet' })).toBeDisabled();
  await fitsWidth(page);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);

  // The maker raises its own level; the taker's is now the only block, and
  // the review offers the step that clears it, in place.
  await sc.diamondWrite('lender', 'setVaultRiskTier', [1]);
  await row.getByTestId('desk-signed-book-fill').click();
  const gate = review.getByTestId('risk-gate');
  await expect(gate).toHaveAttribute('data-risk-plan', 'raise', { timeout: 60_000 });
  await expect(review.getByTestId('accept-consent')).toHaveCount(0);
  await fitsWidth(page);
  const sent = flags.sentTransactions;
  await gate.getByTestId('risk-open').click();
  const step = review.getByTestId('risk-step');
  await step.getByRole('button', { name: 'Confirm in wallet' }).click();
  const stepDone = step.locator('[data-phase="measured"]');
  await expect(stepDone).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(Number(await sc.read('getEffectiveRiskTier', [borrower]))).toBe(1);
  await stepDone.getByTestId('risk-back').click();

  // Back on a fresh review of the same order: the block is gone and the
  // fill lands. The raise, the approval and the fill: nothing refused.
  await expect(review.getByTestId('risk-gate')).toHaveCount(0, { timeout: 60_000 });
  await review.getByTestId('accept-consent').check();
  await review.getByRole('button', { name: 'Confirm in wallet' }).click();
  const finish = review.locator('[data-phase="measured"]');
  await expect(finish).toHaveAttribute('data-verdict', 'done', { timeout: 90_000 });
  expect(flags.sentTransactions).toBe(sent + 3);
  expect(await sc.read<bigint>('signedOfferFilledAmount', [hash])).toBe(parseEther('0.05'));
});
