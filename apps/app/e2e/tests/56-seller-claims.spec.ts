/** A lender who sold their position withdraws the interest they earned
 *  while they held it (#1209).
 *
 *  A sale turns the seller's earned and unpaid interest into a claim on the
 *  loan. When the borrower repays, the claim is paid from the lender side's
 *  proceeds before the buyer takes the rest, and the seller withdraws it
 *  from the Claims page.
 *
 *  The drive: a loan runs ten days, the lender lists it and a third wallet
 *  buys it (spec 44's drive), the borrower repays in full, and the seller
 *  opens Claims. Asserted, and from where:
 *  - the seed, from the chain: the sale recorded a claim for this seller
 *    with something owed (#2183);
 *  - the card, from the states it publishes (`data-state`, the row's
 *    `data-withdraw`, the card's withdrawal outcome), never from its
 *    wording: the list answered, this loan's row offers the withdrawal, and
 *    after the click the card states the withdrawal for this loan (the
 *    row itself goes once nothing is owed);
 *  - the result, from the chain: one `SellerInterestWithdrawn` for this
 *    loan and seller with a positive amount, that exact amount reached the
 *    seller's wallet, and nothing is left waiting for them.
 *
 *  The Claims page finds the loan through the indexer's seller-claim
 *  activity; the e2e stub serves those kinds from this chain's own logs,
 *  filed by the indexer's actor rule (`lib/indexer-stub.mjs`).
 */
import { erc20Abi, parseAbiItem, type Address } from 'viem';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import {
  consentAndWaitEnabled,
  newestOfferIdFor,
  openOfferToAccept,
  signAcceptReview,
} from '../lib/flows';
import { acceptOfferDirect, repayLoanInFull, seedDeskOffer } from '../lib/desk';
import { increaseTime } from '../lib/anvil';
import { topUpWeth } from '../lib/seed';
import { DIAMOND, DIAMOND_ABI_VIEM, pub } from '../lib/chain';

const DAY = 24 * 60 * 60;

const read = <T,>(functionName: string, args: readonly unknown[]) =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName,
    args: args as unknown[],
  }) as Promise<T>;

type Loan = { status: number | bigint; lender: Address; principalAsset: Address };
type Ledger = readonly [bigint, bigint, number, readonly { seller: Address; grossOwed: bigint }[]];

const WITHDRAWN = parseAbiItem(
  'event SellerInterestWithdrawn(uint256 indexed loanId, address indexed seller, address asset, uint256 amount)',
);

test('the seller of a lender position withdraws the interest it earned before the sale', async ({
  launchWallet,
}) => {
  // The lender funds 0.5 WETH and the buyer pays about as much; the serial
  // suite has already spent from both wallets, so neither relies on it.
  await topUpWeth('lender', '1');
  await topUpWeth('newLender', '1');
  await topUpWeth('borrower', '1'); // repays principal plus interest
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 900,
    amountWeth: '0.5',
    minAmountWeth: '0.5',
    collateralTliq: '10',
    days: 60,
  });
  const loanId = await acceptOfferDirect('borrower', offerId);
  // Ten days of interest earned by the lender who will sell.
  await increaseTime(10 * DAY);

  // The seller lists the position from its own form (spec 40's drive).
  const seller = await launchWallet('lender', { advanced: true });
  const sellerAddr = seller.account.address;
  await seller.page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const saleCard = seller.page.locator('#loan-sale-card');
  await expect(saleCard).toBeVisible({ timeout: 60_000 });
  await saleCard.getByLabel('Listing window').selectOption('1');
  const review = saleCard.getByRole('button', { name: /review listing/i });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  const confirmListing = saleCard.getByRole('button', { name: /confirm — list my position/i });
  await consentAndWaitEnabled(seller.page, confirmListing);
  await confirmListing.click();
  await expect(seller.page.getByText(/position listed/i)).toBeVisible({ timeout: 120_000 });
  await seller.ctx.close();
  const saleOfferId = await newestOfferIdFor(sellerAddr);
  expect(await read<bigint>('getOfferLinkedLoanId', [saleOfferId])).toBe(loanId);

  // A third wallet buys it (spec 44's drive).
  const buyer = await launchWallet('newLender');
  await openOfferToAccept(buyer.page, 'lend', saleOfferId);
  await connectWallet(buyer.page);
  await expect(
    buyer.page.getByText(new RegExp(`buying the lender side of already-running loan #${loanId}\\b`, 'i')),
  ).toBeVisible({ timeout: 60_000 });
  await signAcceptReview(buyer.page, /fund this borrower/i, /position bought/i);
  await buyer.ctx.close();

  // CONFIRM THE SEED FROM CHAIN STATE: the buyer holds the position, and
  // the sale recorded a claim for the seller with something owed.
  const loan = await read<Loan>('getLoanDetails', [loanId]);
  expect(loan.lender.toLowerCase(), 'the buyer is now the lender').toBe(
    buyer.account.address.toLowerCase(),
  );
  const [, , , claims] = await read<Ledger>('getInterestLedger', [loanId]);
  const claim = claims.find((c) => c.seller.toLowerCase() === sellerAddr.toLowerCase());
  expect(claim, 'the sale recorded a claim for the seller').toBeDefined();
  expect(claim!.grossOwed > 0n, 'the claim is owed something').toBe(true);

  // The borrower repays in full; the lender side's proceeds now carry the
  // seller's share.
  await repayLoanInFull('borrower', loanId);
  expect(Number((await read<Loan>('getLoanDetails', [loanId])).status)).toBe(1); // Repaid

  const asset = loan.principalAsset;
  const walletBefore = await pub.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [sellerAddr],
  });
  const fromBlock = await pub.getBlockNumber();

  const again = await launchWallet('lender');
  const { page } = again;
  await page.goto('/claims', { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  const state = page.getByTestId('seller-claims-state');
  await expect(state).toHaveAttribute('data-state', 'listed', { timeout: 90_000 });
  const row = page.locator(`[data-testid="seller-claims"] li[data-loan="${loanId}"]`);
  await expect(row).toHaveAttribute('data-withdraw', 'ready', { timeout: 60_000 });
  await row.getByTestId('seller-claim-withdraw').click();
  // The card states the withdrawal itself: the row goes once nothing is owed.
  await expect(
    page.locator(`[data-testid="seller-claim-withdrawn"][data-loan="${loanId}"]`),
  ).toBeVisible({ timeout: 120_000 });

  // The chain's account of it.
  const logs = await pub.getLogs({
    address: DIAMOND,
    event: WITHDRAWN,
    args: { loanId, seller: sellerAddr },
    fromBlock,
    toBlock: 'latest',
  });
  expect(logs.length, 'one withdrawal for this loan and seller').toBe(1);
  const amount = logs[0].args.amount!;
  expect(amount > 0n, 'the withdrawal paid something').toBe(true);
  expect(logs[0].args.asset!.toLowerCase()).toBe(asset.toLowerCase());
  const walletAfter = await pub.readContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [sellerAddr],
  });
  expect(walletAfter - walletBefore, 'that amount reached the seller’s wallet').toBe(amount);
  expect(
    await read<bigint>('getSellerInterestHeld', [loanId, sellerAddr, asset]),
    'nothing is left waiting for the seller',
  ).toBe(0n);
});
