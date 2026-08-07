/** #1588 — refinance, driven from the borrower's form through a
 *  lender's acceptance to the on-chain swap of one loan for another.
 *
 *  The pre-existing coverage (`21-grace-preclose`) asserts only that
 *  the refinance CARD RENDERS in the grace window. A rendering
 *  assertion passes just as happily against a flow whose submit
 *  reverts, and refinance settles two loans in one transaction — the
 *  old one is paid off from the borrower's wallet while the new one
 *  opens against the SAME collateral, which never unlocks in between.
 *
 *  What makes this worth a spec rather than a form-fill check is the
 *  carry-over: the contract's predicate compares the offer creator to
 *  the borrower stored at loan INIT, and when it does not match, the
 *  same offer silently becomes a fresh collateral pledge PULLED FROM
 *  THE POSTER'S WALLET.
 *
 *  That failure mode is why the collateral assertions here are not
 *  just `asset` + `amount` equality. A fresh pledge produces a new
 *  loan holding the same asset in the same amount — those two
 *  comparisons pass straight through the bug. What separates the two
 *  is WHERE the collateral came from, so the discriminating assertion
 *  is that the borrower's collateral balance does not move across the
 *  acceptance: carry-over re-tags an existing lien and pulls nothing.
 *  (Established by mutation, not by reasoning: posting a request whose
 *  collateral amount disagrees with the loan is rejected before a loan
 *  can exist, so a mismatched AMOUNT is not the reachable defect —
 *  a matching amount from the wrong SOURCE is.)
 */
import { test, expect } from '../lib/wallet-fixture';
import { seedDeskOffer, acceptOfferDirect, getOffer } from '../lib/desk';
import { accountFor } from '../lib/wallets';
import { newestOfferIdFor } from '../lib/flows';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, ERC20_MIN_ABI } from '../lib/chain';

interface LoanShape {
  borrower: `0x${string}`;
  lender: `0x${string}`;
  principal: bigint;
  collateralAsset: `0x${string}`;
  collateralAmount: bigint;
  status: number;
}

async function loanOf(loanId: bigint): Promise<LoanShape> {
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as Omit<LoanShape, 'status'> & { status: number | bigint };
  return { ...loan, status: Number(loan.status) };
}

test('refinance request completes: old loan closes, new loan carries the collateral', async ({
  launchWallet,
}) => {
  const offerId = await seedDeskOffer({
    role: 'lender',
    side: 'lend',
    rateBps: 900,
    amountWeth: '0.02',
    collateralTliq: '150',
    days: 30,
  });
  const oldLoanId = await acceptOfferDirect('borrower', offerId);
  const before = await loanOf(oldLoanId);
  expect(before.status, 'loan should open Active').toBe(0);

  // The borrower posts the refinance request through the real form
  // (advanced-mode surface).
  const adv = await launchWallet('borrower', { advanced: true });
  const { page } = adv;
  await page.goto(`/positions/${oldLoanId}`, { waitUntil: 'domcontentloaded' });

  const card = page
    .locator('section.card')
    .filter({ hasText: 'Refinance this loan' });
  await expect(card).toBeVisible({ timeout: 60_000 });

  // A ceiling ABOVE the current 9% so the request is acceptable at the
  // rate a lender would take it at.
  await card.getByLabel(/highest yearly rate/i).fill('12');
  await card.getByLabel(/new loan length/i).fill('30');

  const review = card.getByRole('button', { name: /review refinance request/i });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  await card.locator('input[type="checkbox"]').check();

  const confirm = card.getByRole('button', {
    name: /confirm — post refinance request/i,
  });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();

  // The form's own "posted" line is transient: the page-owned
  // RefinancePendingCard takes the story over the moment the request
  // is live (RefinanceFlow is FORM ONLY by design). Asserting the
  // standing surface — not the flash — is what proves the request
  // survived its own submit.
  const pending = page.getByText(/refinance request #\d+ is live/i);
  await expect(pending).toBeVisible({ timeout: 120_000 });

  // Pin the request to THIS loan rather than trusting "newest offer by
  // the borrower": the fork inherits Base Sepolia's whole book and the
  // role wallets are reused across specs, so an unrelated offer could
  // otherwise be accepted and the spec would still go green.
  const requestId = await newestOfferIdFor(
    accountFor('borrower').address,
  );
  const request = await getOffer(requestId);
  expect(
    request.refinanceTargetLoanId as bigint,
    'newest borrower offer must be the refinance request for this loan',
  ).toBe(oldLoanId);
  // ...and the id the page is standing behind is that same request, so
  // a chain-side read of some other offer cannot stand in for the one
  // this drive actually posted.
  await expect(
    page.getByText(new RegExp(`refinance request #${requestId} is live`, 'i')),
  ).toBeVisible({ timeout: 30_000 });
  await adv.ctx.close();

  // The borrower's collateral holding immediately before acceptance —
  // the baseline for the carry-over check below. Read here rather than
  // at the top of the test so the posting drive itself is inside the
  // window: nothing in a refinance should ever pull collateral.
  const collateralHeld = async (): Promise<bigint> =>
    (await pub.readContract({
      address: before.collateralAsset,
      abi: ERC20_MIN_ABI,
      functionName: 'balanceOf',
      args: [before.borrower],
    })) as bigint;
  const heldBefore = await collateralHeld();

  // A different lender accepts it — one transaction that opens the new
  // loan, pays off the old lender and closes the old loan.
  const newLoanId = await acceptOfferDirect('newLender', requestId);
  expect(newLoanId, 'refinance must open a DIFFERENT loan').not.toBe(oldLoanId);

  const oldAfter = await loanOf(oldLoanId);
  expect(oldAfter.status, 'the refinanced loan closes as Repaid').toBe(1);

  const fresh = await loanOf(newLoanId);
  expect(fresh.status, 'the replacement loan is Active').toBe(0);
  expect(fresh.borrower.toLowerCase(), 'same borrower continues').toBe(
    before.borrower.toLowerCase(),
  );
  expect(fresh.lender.toLowerCase(), 'the accepting lender funds it').toBe(
    accountFor('newLender').address.toLowerCase(),
  );

  // The carry-over — the assertion this spec exists for. The identity
  // and amount say the new loan is secured by the same stake...
  expect(fresh.collateralAsset.toLowerCase()).toBe(
    before.collateralAsset.toLowerCase(),
  );
  expect(fresh.collateralAmount).toBe(before.collateralAmount);
  // ...and this says it is the SAME stake rather than a second one.
  // A fresh pledge satisfies both lines above while quietly taking
  // another `collateralAmount` out of the borrower's wallet; the lien
  // re-tag takes nothing.
  expect(
    await collateralHeld(),
    'refinance must re-tag the existing lien, never pull fresh collateral',
  ).toBe(heldBefore);
  expect(fresh.principal, 'the new loan refinances the old principal').toBe(
    before.principal,
  );
});
