/** Lender-sale listing form and standing card (#1810, #1848).
 *
 *  The listing FORM is the lender's surface; spec 26 lists directly
 *  on-chain to test the borrower's side and left the form uncovered. This
 *  drives it end to end. The form states the seller's guaranteed minimum
 *  (read from `quoteSellerBounds`) before anything is offered; the listing
 *  goes out through the bound entry point; the standing card says until
 *  when buyers can take it. Once the window has run out, the card says the
 *  listing ended without a buyer, from the listing's own record rather
 *  than from the lock (which still stands).
 *
 *  Both new selectors are ASSERTED routed, as spec 26 does for its own:
 *  the e2e chain carries this tree's contracts (#2334), so a missing route
 *  is a regression here, not something to skip around.
 */
import { toFunctionSelector } from "viem";
import { test, expect } from "../lib/wallet-fixture";
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
  consentAndWaitEnabled,
} from "../lib/flows";
import { increaseTime } from "../lib/anvil";
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from "../lib/chain";

const ZERO = "0x0000000000000000000000000000000000000000";

async function routed(signature: string): Promise<boolean> {
  const facet = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: "facetAddress",
    args: [toFunctionSelector(signature)],
  })) as `0x${string}`;
  return facet !== ZERO;
}

test("listing form states the minimum, lists bound to it, and the card reports expiry", async ({
  launchWallet,
}) => {
  for (const sig of [
    "function quoteSellerBounds(uint256,uint256,uint256)",
    "function createLoanSaleOfferBound(uint256,uint256,bool,uint64,uint256,uint256)",
  ]) {
    expect(await routed(sig), `the current Diamond must route ${sig}`).toBe(
      true,
    );
  }

  // Active loan between the fixture wallets.
  const lenderPost = await launchWallet("lender");
  await postLenderOffer(lenderPost.page);
  const offerId = await newestOfferIdFor(lenderPost.account.address);
  await lenderPost.ctx.close();

  const borrower = await launchWallet("borrower");
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, "borrower");
  await borrower.ctx.close();

  const lender = await launchWallet("lender", { advanced: true });
  const { page } = lender;
  await page.goto(`/positions/${loanId}`, { waitUntil: "domcontentloaded" });
  const saleCard = page.locator("#loan-sale-card");
  await expect(saleCard).toBeVisible({ timeout: 60_000 });

  // The shortest window, so the expiry half of the test needs one day of
  // chain time rather than the default seven.
  await saleCard.getByLabel("Listing window").selectOption("1");
  // The minimum is stated BEFORE any review is offered.
  await expect(saleCard.getByText(/you come out with at least/i)).toBeVisible({
    timeout: 60_000,
  });

  const review = saleCard.getByRole("button", { name: /review listing/i });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  // The receipt repeats the reviewed minimum it binds the listing to.
  await expect(
    saleCard.getByText(/the listing records this minimum/i),
  ).toBeVisible();
  const confirm = saleCard.getByRole("button", {
    name: /confirm — list my position/i,
  });
  await consentAndWaitEnabled(page, confirm);
  await confirm.click();
  await expect(page.getByText(/position listed/i)).toBeVisible({
    timeout: 120_000,
  });

  // CONFIRM THE SETUP FROM CHAIN STATE (#2183): the lender position is
  // locked for EarlyWithdrawalSale (LockReason 2).
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: "getLoanDetails",
    args: [loanId],
  })) as { lenderTokenId: bigint };
  const lock = await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: "positionLock",
    args: [loan.lenderTokenId],
  });
  expect(Number(lock), "the listing should lock the lender position").toBe(2);

  // Standing card: open to buyers, plus the note on what can make a live
  // listing unbuyable and what the app cannot check.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(/open to buyers until/i)).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByText(/can.t read the figures recorded for this listing/i),
  ).toBeVisible();

  // Past the one-day window: the lock still stands, but the record says
  // no one can buy it, and the card says so instead of "is live".
  await increaseTime(86_400 + 120);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText(/without a buyer, so no one can buy it now/i),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/open to buyers until/i)).toHaveCount(0);
  await lender.ctx.close();
});
