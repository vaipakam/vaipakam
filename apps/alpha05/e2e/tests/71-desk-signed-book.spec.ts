/**
 * A market's signed orders on the rate desk (matrix OFF-60, first slice:
 * the list, before the fill). Another wallet signs three gasless lender
 * orders on the WETH against tLIQ 30-day market and posts them to the offer
 * book: one its vault covers, one larger than its vault holds free, and one
 * it then cancels on the chain while the book is held behind the chain. The
 * viewer signs a borrower order of its own on the same market. On the desk
 * the viewer sees every maker's orders, lenders' lowest rate first and
 * borrowers' highest first, each with its maker, its lapse and where the
 * chain stands on it, and for each fillable order what the maker's vault
 * holds free against what a fill would draw: enough, short (a fill now
 * would fail), and for the cancelled one nothing weighed. A fill is offered
 * on each open order another wallet signed, never on the viewer's own or a
 * used one; filling is spec 73. Runs on the
 * desktop and the phone project; the chain is reverted after each test.
 */
import { parseEther, type Hex } from 'viem';
import { postLenderOffer, WETH } from '@vaipakam/anvil-harness/lending';
import { TOKEN_ABI } from '@vaipakam/anvil-harness/scenarioChain';
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

test('a market’s signed orders are listed with the chain’s standing and each maker’s vault against a fill, and a fill offered on open ones', async ({
  launchWallet,
}) => {
  test.setTimeout(300_000);
  const sc = scenario();
  const tliq = (sc.fixture.artifact.testnetMocks as Record<string, Hex>).liquidToken;
  await postLenderOffer(sc, { lender: 'borrower', principalWeth: '0.05', collateralTliq: '250', rateBps: 500, days: 30 });
  const maker = accountFor('borrower').address.toLowerCase();
  const head = await sc.pub.getBlock({ blockTag: 'latest' });
  const until = String(Math.max(Number(head.timestamp), Math.floor(Date.now() / 1000)) + 7 * 86_400);

  // The maker's vault holds 0.05 WETH free.
  const free = parseEther('0.05');
  await sc.write('borrower', WETH, TOKEN_ABI, 'deposit', [], free);
  await sc.write('borrower', WETH, TOKEN_ABI, 'approve', [sc.diamond, free]);
  await sc.diamondWrite('borrower', 'depositToVault', [0, WETH, 0n, free]);

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
    nonce: '2001',
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
    expect((await postSignedOrder({ chainId: CHAIN_ID, order: o as unknown as Record<string, unknown>, signature })).status).toBe(201);
  };

  const covered = order('borrower', {});
  const large = order('borrower', {
    nonce: '2002',
    amount: '200000000000000000',
    amountMax: '200000000000000000',
    interestRateBps: '550',
    interestRateBpsMax: '550',
  });
  const cancelled = order('borrower', { nonce: '2003', interestRateBps: '700', interestRateBpsMax: '700' });
  const mine = order('lender', { offerType: '1', nonce: '2004', interestRateBps: '400', interestRateBpsMax: '450' });
  for (const [role, o] of [
    ['borrower', covered],
    ['borrower', large],
    ['borrower', cancelled],
    ['lender', mine],
  ] as const)
    await post(role, o);
  // The book keeps listing the cancelled order: it is held behind the chain.
  await setSignedBookLag(true);
  await sc.diamondWrite('borrower', 'cancelSignedOffer', [typedMessage(cancelled)]);
  const [hCovered, hLarge, hCancelled, hMine] = [covered, large, cancelled, mine].map(orderHashOf);

  const { page, flags } = await launchWallet('lender', { advanced: true });
  await page.goto(`/desk?market=${WETH.toLowerCase()}-${tliq.toLowerCase()}-30`);
  await connectWallet(page);
  const section = page.getByTestId('desk-signed-book');
  await expect(section).toContainText('Signed orders on this market');
  await expect(page.getByTestId('desk-completeness')).toContainText('signed orders are listed below it');

  // Lenders' orders, lowest rate first; the borrower order on its own side.
  const asks = section.getByTestId('desk-signed-book-asks').getByTestId('desk-signed-book-order');
  await expect(asks).toHaveCount(3, { timeout: 60_000 });
  await expect(asks.nth(0)).toHaveAttribute('data-order-hash', hLarge);
  await expect(asks.nth(1)).toHaveAttribute('data-order-hash', hCovered);
  await expect(asks.nth(2)).toHaveAttribute('data-order-hash', hCancelled);
  const bids = section.getByTestId('desk-signed-book-bids').getByTestId('desk-signed-book-order');
  await expect(bids).toHaveCount(1);
  await expect(bids.nth(0)).toHaveAttribute('data-order-hash', hMine);

  // Covered: open, its maker named, the vault holds enough.
  const rowCovered = section.locator(`[data-order-hash="${hCovered}"]`);
  await expect(rowCovered).toHaveAttribute('data-standing', 'open', { timeout: 60_000 });
  await expect(rowCovered).toHaveAttribute('data-cover', 'covers');
  await expect(rowCovered).toHaveAttribute('data-maker', maker);
  await expect(rowCovered).toContainText('Lend 0.05 WETH at 6% a year for 30 days');
  await expect(rowCovered).toContainText('Signed by 0x');
  await expect(rowCovered).toContainText('Open: nothing on the chain stops a fill.');
  await expect(rowCovered).toContainText('The maker’s vault holds 0.05 WETH free now, enough for the 0.05 WETH a fill would draw.');

  // Larger than the vault holds free: said, with the consequence.
  const rowLarge = section.locator(`[data-order-hash="${hLarge}"]`);
  await expect(rowLarge).toHaveAttribute('data-cover', 'short');
  await expect(rowLarge.getByTestId('desk-signed-book-short')).toContainText('short of the 0.2 WETH a fill would draw, so a fill now would fail');

  // Cancelled on the chain while the book still lists it.
  const rowCancelled = section.locator(`[data-order-hash="${hCancelled}"]`);
  await expect(rowCancelled).toHaveAttribute('data-standing', 'used');
  await expect(rowCancelled).toHaveAttribute('data-cover', 'none');
  await expect(rowCancelled).toContainText('Filled or cancelled on the chain; the offer book has not caught up. No one can fill it.');

  // The viewer's own order is marked as theirs.
  const rowMine = section.locator(`[data-order-hash="${hMine}"]`);
  await expect(rowMine).toContainText('Borrow 0.05 WETH at 4 to 4.5% a year');
  await expect(rowMine).toContainText('Signed by you');

  // A fill is offered on the open orders another wallet signed, never on a
  // used one or the viewer's own; listing them sends nothing.
  await expect(rowCovered.getByTestId('desk-signed-book-fill')).toHaveText('Review a fill');
  await expect(rowLarge.getByTestId('desk-signed-book-fill')).toBeVisible();
  await expect(rowCancelled.getByTestId('desk-signed-book-fill')).toHaveCount(0);
  await expect(rowMine.getByTestId('desk-signed-book-fill')).toHaveCount(0);
  await expect(section.locator('.why-link')).toHaveCount(1);
  expect(flags.sentTransactions).toBe(0);
  await fitsWidth(page);
  await setSignedBookLag(false);
});
