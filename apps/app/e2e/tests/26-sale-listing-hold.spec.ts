/** Borrower-side listing-hold surface (#1503 PR-A follow-up) — while
 *  a lender-sale listing stands, the borrower's page explains the
 *  hold (close-early + collateral withdrawal held, repay stays open)
 *  and the chooser's close-early row says why it's held; once the
 *  listing expires, the same card grows the permissionless "Free held
 *  options" cleanup and clicking it releases the hold on-chain.
 *
 *  The bounded 4-arg `createLoanSaleOffer` is ASSERTED routed, not
 *  probed. This spec used to skip itself while the forked live Diamond
 *  predated that route (PR #1505's migration). The e2e chain now carries
 *  the repository's current contracts (#2334), so a missing route here is
 *  a regression in this tree, and a skip would hide it.
 */
import { toFunctionSelector } from 'viem';
import { test, expect } from '../lib/wallet-fixture';
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
} from '../lib/flows';
import { increaseTime } from '../lib/anvil';
import { accountFor } from '../lib/wallets';
import { confirm, pub, walletFor, DIAMOND, DIAMOND_ABI_VIEM, forkChain } from '../lib/chain';

const BOUNDED_LISTING_SELECTOR = toFunctionSelector(
  'function createLoanSaleOffer(uint256,uint256,bool,uint64)',
);

async function boundedListingCutLive(): Promise<boolean> {
  const facet = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'facetAddress',
    args: [BOUNDED_LISTING_SELECTOR],
  })) as `0x${string}`;
  return facet !== '0x0000000000000000000000000000000000000000';
}

test('listing holds the borrower options; expiry + cleanup frees them', async ({
  launchWallet,
}) => {
  expect(
    await boundedListingCutLive(),
    'the current Diamond must route the bounded 4-arg createLoanSaleOffer',
  ).toBe(true);

  // Active loan between the fixture wallets.
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrowerCtx = await launchWallet('borrower');
  await acceptAsBorrower(borrowerCtx.page, offerId);
  const loanId = await newestLoanIdFor(
    borrowerCtx.account.address,
    'borrower',
  );
  await borrowerCtx.ctx.close();

  // The lender lists the position directly on-chain (the listing FORM
  // is the lender's surface, covered by its own follow-up spec — this
  // spec is about what the BORROWER sees). Minimum window: 1 hour.
  const lenderWallet = walletFor(accountFor('lender'));
  const listHash = await lenderWallet.writeContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'createLoanSaleOffer',
    args: [loanId, 800n, true, 3600n],
    account: accountFor('lender'),
    chain: forkChain,
  });
  await confirm(listHash, 'createLoanSaleOffer (lender lists the position)');

  // CONFIRM THE SETUP FROM CHAIN STATE, not from the surface under test
  // (#2183). The `confirm` above rules out a revert; this rules out the
  // rest — that the listing actually placed the hold the borrower page
  // is about to be asserted on.
  //
  // Both halves earn their place. Without them this spec's only evidence
  // that the listing exists is the hold card rendering, so ANY failure
  // upstream arrives 60s later as "element(s) not found" on line 86 —
  // three steps from the cause, in a message that describes the UI and
  // says nothing about the listing never having been placed. That is the
  // whole of #2183: a setup failure wearing a product failure's clothes.
  //
  // `EarlyWithdrawalSale` is `LockReason` 2 (`None`=0, `PrecloseOffset`=1,
  // `EarlyWithdrawalSale`=2, `PrepayCollateralListing`=3). Asserting the
  // exact reason rather than "not None" matters: a position locked for
  // the OFFSET route would also be non-zero and would render a different
  // card, so a loose check would pass on the wrong precondition.
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { lenderTokenId: bigint };
  const lock = await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'positionLock',
    args: [loan.lenderTokenId],
  });
  expect(
    Number(lock),
    `the lender position (token ${loan.lenderTokenId}) should be locked for ` +
      `EarlyWithdrawalSale after createLoanSaleOffer — if this fails the ` +
      `listing did not take effect and every borrower-page assertion below ` +
      `would be testing a state that was never reached`,
  ).toBe(2);

  const saleOfferId = await newestOfferIdFor(accountFor('lender').address);

  // Borrower page: the hold notice renders in its LIVE shape (no
  // cleanup button — teardown would revert), and the chooser's
  // close-early row is held with the why.
  const borrower = await launchWallet('borrower');
  const { page } = borrower;
  await page.goto(`/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const holdCard = page.getByTestId('sale-listing-hold-card');
  await expect(holdCard).toBeVisible({ timeout: 60_000 });
  await expect(
    holdCard.getByText(/two of your options are held/i),
  ).toBeVisible();
  await expect(page.getByTestId('free-held-options')).toHaveCount(0);
  const chooser = page
    .locator('section.card')
    .filter({ hasText: 'Ways to repay or exit early' });
  await expect(chooser).toBeVisible({ timeout: 30_000 });
  await expect(
    chooser.getByText(/held while the lender.s sale listing stands/i),
  ).toBeVisible();

  // Past the listing's 1-hour window the probe flips: the cleanup
  // button appears, and clicking it frees the hold in one tx — the
  // exact affordance the PR-A action window exists to hand the
  // borrower.
  await increaseTime(3_700);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const freeBtn = page.getByTestId('free-held-options');
  await expect(freeBtn).toBeVisible({ timeout: 60_000 });
  // App-standard write flow: the action opens the six-row review
  // receipt first; confirming sends the teardown.
  await freeBtn.click();
  await page
    .getByRole('button', { name: /confirm — free held options/i })
    .click();
  await expect(
    page.getByText(/held options freed/i),
  ).toBeVisible({ timeout: 120_000 });

  // On-chain: the loan↔listing link is severed — the vehicle no
  // longer reports a linked loan, so the borrower's preclose /
  // collateral-withdrawal guards no longer see a listing.
  const linked = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getOfferLinkedLoanId',
    args: [saleOfferId],
  })) as bigint;
  expect(linked).toBe(0n);
  await borrower.ctx.close();
});
