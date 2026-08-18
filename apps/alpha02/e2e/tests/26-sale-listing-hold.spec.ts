/** Borrower-side listing-hold surface (#1503 PR-A follow-up) — while
 *  a lender-sale listing stands, the borrower's page explains the
 *  hold (close-early + collateral withdrawal held, repay stays open)
 *  and the chooser's close-early row says why it's held; once the
 *  listing expires, the same card grows the permissionless "Free held
 *  options" cleanup and clicking it releases the hold on-chain.
 *
 *  SELF-ARMING: the anvil fork tracks LIVE Base Sepolia, which routes
 *  the bounded 4-arg `createLoanSaleOffer` only after the operator
 *  runs `RefreshAllFacetsInPlace` (PR #1505's migration). Until that
 *  cut lands the whole lifecycle under test does not exist on the
 *  fork, so the spec skips itself on a loupe probe instead of failing
 *  red — and activates automatically, with no code change, the run
 *  after the refresh reaches the testnet.
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
import { pub, walletFor, DIAMOND, DIAMOND_ABI_VIEM, forkChain } from '../lib/chain';

// #1503 item 4 added two seller-bound arguments to the listing entry, which
// changes its selector. Both shapes are accepted for the same reason the app's
// own gate accepts both: either one is evidence the Diamond carries the
// bounded-listing lifecycle this spec exercises. Pinning only the four-argument
// form would SKIP this spec silently against a post-item-4 deploy — and a
// skipped spec reads exactly like a passing one in the summary.
const BOUNDED_LISTING_SELECTORS = [
  toFunctionSelector(
    'function createLoanSaleOffer(uint256,uint256,bool,uint64,uint128,uint128)',
  ),
  toFunctionSelector('function createLoanSaleOffer(uint256,uint256,bool,uint64)'),
] as const;

async function boundedListingCutLive(): Promise<boolean> {
  const routed = await Promise.all(
    BOUNDED_LISTING_SELECTORS.map(
      (selector) =>
        pub.readContract({
          address: DIAMOND,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'facetAddress',
          args: [selector],
        }) as Promise<`0x${string}`>,
    ),
  );
  return routed.some(
    (facet) => facet !== '0x0000000000000000000000000000000000000000',
  );
}

test('listing holds the borrower options; expiry + cleanup frees them', async ({
  launchWallet,
}) => {
  test.skip(
    !(await boundedListingCutLive()),
    'live Base Sepolia Diamond pre-refresh (routes no createLoanSaleOffer in either shape) — spec arms itself once RefreshAllFacetsInPlace runs',
  );

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
    // #1503 item 4 — the permissive bound (accept any net, allow any held
    // transfer). This spec is about what the BORROWER sees while a listing
    // holds their options; the seller-bound refusals have their own coverage.
    args: [loanId, 800n, true, 3600n, 0n, (1n << 128n) - 1n],
    account: accountFor('lender'),
    chain: forkChain,
  });
  await pub.waitForTransactionReceipt({ hash: listHash });
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
