/** Taking a borrower's OFFSET offer (#2523) — the counterparty half of
 *  preclose Option 3 that spec 25 left as a follow-up.
 *
 *  The borrower posts the offset from the app (spec 25's drive). A
 *  THIRD wallet then opens the offset offer from the offer link: the
 *  review states that taking it also closes the poster's earlier loan
 *  (it used to refuse every offset with the #951 block), the taker signs,
 *  and the chain shows the whole Option 3 outcome in one transaction —
 *  the earlier loan closed, the poster's position unlocked, and a new
 *  loan with the taker as borrower.
 */
import { test, expect } from "../lib/wallet-fixture";
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
  signAcceptReview,
} from "../lib/flows";
import { connectWallet } from "../lib/wallet-fixture";
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from "../lib/chain";

async function loanOf(loanId: bigint): Promise<{
  status: number;
  borrowerTokenId: bigint;
  lender: `0x${string}`;
  borrower: `0x${string}`;
}> {
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: "getLoanDetails",
    args: [loanId],
  })) as {
    status: number | bigint;
    borrowerTokenId: bigint;
    lender: `0x${string}`;
    borrower: `0x${string}`;
  };
  return { ...loan, status: Number(loan.status) };
}

async function positionLockOf(tokenId: bigint): Promise<number> {
  return Number(
    await pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: "positionLock",
      args: [tokenId],
    }),
  );
}

test("a third wallet takes an offset offer; the earlier loan closes in the same transaction", async ({
  launchWallet,
}) => {
  // Earlier loan: lender → borrower.
  const lender = await launchWallet("lender");
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet("borrower");
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, "borrower");
  await borrower.ctx.close();
  const earlier = await loanOf(loanId);

  // The borrower posts the offset from the app.
  const poster = await launchWallet("borrower", { advanced: true });
  await poster.page.goto(`/positions/${loanId}`, {
    waitUntil: "domcontentloaded",
  });
  const offsetCard = poster.page
    .locator("section.card")
    .filter({ hasText: "Exit by becoming a lender (offset)" });
  await expect(offsetCard).toBeVisible({ timeout: 60_000 });
  const review = offsetCard.getByRole("button", {
    name: /review offset offer/i,
  });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  await offsetCard.locator('input[type="checkbox"]').check();
  const confirm = offsetCard.getByRole("button", {
    name: /confirm — fund and post offer/i,
  });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  await expect(
    poster.page.getByText(/offset in progress/i).first(),
  ).toBeVisible({
    timeout: 120_000,
  });
  const offsetOfferId = await newestOfferIdFor(poster.account.address);
  await poster.ctx.close();

  // CONFIRM THE SETUP FROM CHAIN STATE (#2183): the offer is linked to the
  // earlier loan and the poster's position carries the offset lock.
  const linked = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: "getOfferLinkedLoanId",
    args: [offsetOfferId],
  })) as bigint;
  expect(
    linked,
    "the borrower’s newest offer should be the offset vehicle",
  ).toBe(loanId);
  expect(await positionLockOf(earlier.borrowerTokenId)).toBe(1); // PrecloseOffset

  // The taker's review discloses the close-out, then signs.
  const taker = await launchWallet("newBorrower");
  const { page } = taker;
  await page.goto(`/borrow?offer=${offsetOfferId}`, {
    waitUntil: "domcontentloaded",
  });
  await connectWallet(page);
  await expect(page.getByTestId("offset-offer-banner")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("offset-offer-banner")).toContainText(
    `closing loan #${loanId} early`,
  );
  await expect(page.getByTestId("offset-offer-blocked")).toHaveCount(0);
  await signAcceptReview(page);

  // One transaction, the whole Option 3 outcome.
  const after = await loanOf(loanId);
  expect(after.status, "the earlier loan should no longer be Active").not.toBe(
    0,
  );
  expect(await positionLockOf(earlier.borrowerTokenId)).toBe(0);
  const newLoanId = await newestLoanIdFor(taker.account.address, "borrower");
  const fresh = await loanOf(newLoanId);
  expect(fresh.status).toBe(0);
  expect(fresh.lender.toLowerCase()).toBe(poster.account.address.toLowerCase());
  await taker.ctx.close();
});
