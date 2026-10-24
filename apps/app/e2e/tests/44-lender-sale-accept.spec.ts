/** A listed lender position is bought, and the position migrates (#1850).
 *
 *  Spec 40 drives the seller's listing form and stops at the standing
 *  card. This drives the rest of the path, which moves funds: a third
 *  wallet opens the listing from its link, the review says it is buying
 *  the lender side of a RUNNING loan, it signs, and the chain shows the
 *  whole migration in that one transaction:
 *
 *  - the seller's lender NFT is burned and a fresh one is minted to the
 *    buyer, who is now the loan's lender;
 *  - the borrower's side is untouched: same borrower and borrower NFT,
 *    same principal, rate, start and length (so the same due date), same
 *    collateral;
 *  - the behavioural terms the buyer signed (on the sale offer) are the
 *    ones the position carries, and the sale did not change them. A sale
 *    vehicle once carried only `useFullTermInterest` and left the other
 *    terms at their defaults (#1503 item 23), which a buyer would have
 *    signed without seeing;
 *  - the buyer's payment is accounted for exactly: what left the buyer
 *    (wallet and vault) is what reached the seller and the treasury,
 *    with any rate shortfall credited back to the buyer's vault. No
 *    token is left behind in custody.
 *
 *  Not covered here, and tracked on #2787: a held-for-lender
 *  balance moving to the buyer, a Full fee entitlement travelling with
 *  the position, and the seller's pending reward entry being forfeited.
 *  Each needs its own setup (a partial repayment before listing, the Full
 *  tariff, a reward programme on the e2e chain).
 */
import { erc20Abi, type Address } from "viem";
import { test, expect } from "../lib/wallet-fixture";
import { connectWallet } from "../lib/wallet-fixture";
import {
  postLenderOffer,
  acceptAsBorrower,
  newestOfferIdFor,
  newestLoanIdFor,
  consentAndWaitEnabled,
  signAcceptReview,
} from "../lib/flows";
import { pub, DIAMOND, DIAMOND_ABI_VIEM } from "../lib/chain";

const ZERO = "0x0000000000000000000000000000000000000000";

type Loan = {
  status: number | bigint;
  lender: Address;
  borrower: Address;
  lenderTokenId: bigint;
  borrowerTokenId: bigint;
  principal: bigint;
  principalAsset: Address;
  interestRateBps: bigint;
  startTime: bigint;
  durationDays: bigint;
  collateralAsset: Address;
  collateralAmount: bigint;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  periodicInterestCadence: number;
};

type Offer = {
  accepted: boolean;
  amount: bigint;
  lendingAsset: Address;
  useFullTermInterest: boolean;
  allowsPartialRepay: boolean;
  allowsPrepayListing: boolean;
  periodicInterestCadence: number;
};

const read = <T>(functionName: string, args: readonly unknown[]) =>
  pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName,
    args: args as unknown[],
  }) as Promise<T>;

const loanOf = (loanId: bigint) => read<Loan>("getLoanDetails", [loanId]);

async function balanceOf(token: Address, holder: Address): Promise<bigint> {
  if (holder === ZERO) return 0n;
  return pub.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

/** A wallet's holding of `token` across its wallet and its vault. */
async function heldBy(token: Address, who: Address): Promise<bigint> {
  const vault = await read<Address>("getUserVaultAddress", [who]);
  return (await balanceOf(token, who)) + (await balanceOf(token, vault));
}

/** Where `token` sits outside the parties' own holdings.
 *
 *  `treasury` is what the treasury holds: its own balance, or, when the
 *  Diamond is the treasury, the accrual the Diamond records for it.
 *  `custody` is the Diamond's balance that is NOT treasury accrual, so a
 *  fee booked to a Diamond treasury is never read as proceeds left
 *  behind. */
async function outsideParties(
  token: Address,
): Promise<{ treasury: bigint; custody: bigint }> {
  const treasury = await read<Address>("getTreasury", []);
  const diamondBalance = await balanceOf(token, DIAMOND);
  if (treasury.toLowerCase() === DIAMOND.toLowerCase()) {
    const accrued = await read<bigint>("getTreasuryBalance", [token]);
    return { treasury: accrued, custody: diamondBalance - accrued };
  }
  return {
    treasury: await balanceOf(token, treasury),
    custody: diamondBalance,
  };
}

test("a third wallet buys a listed lender position; the position migrates and the payment is accounted for", async ({
  launchWallet,
}) => {
  // A running loan between the fixture wallets.
  const lenderPost = await launchWallet("lender");
  await postLenderOffer(lenderPost.page);
  const offerId = await newestOfferIdFor(lenderPost.account.address);
  await lenderPost.ctx.close();

  const borrower = await launchWallet("borrower");
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, "borrower");
  await borrower.ctx.close();

  // The seller lists the position from its own form (spec 40's drive).
  const seller = await launchWallet("lender", { advanced: true });
  await seller.page.goto(`/positions/${loanId}`, {
    waitUntil: "domcontentloaded",
  });
  const saleCard = seller.page.locator("#loan-sale-card");
  await expect(saleCard).toBeVisible({ timeout: 60_000 });
  await saleCard.getByLabel("Listing window").selectOption("1");
  const review = saleCard.getByRole("button", { name: /review listing/i });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  const confirmListing = saleCard.getByRole("button", {
    name: /confirm — list my position/i,
  });
  await consentAndWaitEnabled(seller.page, confirmListing);
  await confirmListing.click();
  await expect(seller.page.getByText(/position listed/i)).toBeVisible({
    timeout: 120_000,
  });
  await seller.ctx.close();

  // CONFIRM THE SETUP FROM CHAIN STATE (#2183): the seller's newest offer
  // is the sale vehicle for this loan, and the position is locked for it.
  const saleOfferId = await newestOfferIdFor(seller.account.address);
  expect(
    await read<bigint>("getOfferLinkedLoanId", [saleOfferId]),
    "the seller's newest offer should be the sale vehicle for this loan",
  ).toBe(loanId);
  const before = await loanOf(loanId);
  expect(
    Number(await read<number>("positionLock", [before.lenderTokenId])),
    "the listing should lock the lender position",
  ).toBe(2); // EarlyWithdrawalSale
  const sale = await read<Offer>("getOfferDetails", [saleOfferId]);
  expect(sale.accepted).toBe(false);

  // The buyer's review names the running loan it is buying into.
  const buyer = await launchWallet("newLender");
  const token = before.principalAsset;
  const ledger = async () => ({
    buyer: await heldBy(token, buyer.account.address),
    seller: await heldBy(token, seller.account.address),
    ...(await outsideParties(token)),
  });
  const pre = await ledger();

  const { page } = buyer;
  await page.goto(`/lend?offer=${saleOfferId}`, {
    waitUntil: "domcontentloaded",
  });
  await connectWallet(page);
  await expect(
    page.getByText(
      new RegExp(
        `buying the lender side of already-running loan #${loanId}\\b`,
        "i",
      ),
    ),
  ).toBeVisible({ timeout: 60_000 });
  await signAcceptReview(page, /fund this borrower/i, /position bought/i);
  await buyer.ctx.close();

  // ── One transaction, the whole migration ──────────────────────────────
  const after = await loanOf(loanId);
  expect(Number(after.status), "the loan stays Active").toBe(0);
  expect(after.lender.toLowerCase(), "the buyer is now the lender").toBe(
    buyer.account.address.toLowerCase(),
  );
  expect(
    after.lenderTokenId,
    "the lender position is re-minted, not handed over",
  ).not.toBe(before.lenderTokenId);
  expect(
    (await read<Address>("ownerOf", [after.lenderTokenId])).toLowerCase(),
    "the buyer holds the new lender NFT",
  ).toBe(buyer.account.address.toLowerCase());
  await expect(
    read<Address>("ownerOf", [before.lenderTokenId]),
    "the seller's lender NFT is burned",
  ).rejects.toThrow();
  expect(
    Number(await read<number>("positionLock", [after.lenderTokenId])),
    "the buyer's position carries no sale lock",
  ).toBe(0);
  expect((await read<Offer>("getOfferDetails", [saleOfferId])).accepted).toBe(
    true,
  );

  // The borrower's side is untouched: same party, same position, same
  // debt, same rate and due date, same collateral.
  expect(after.borrower).toBe(before.borrower);
  expect(after.borrowerTokenId).toBe(before.borrowerTokenId);
  expect(
    (await read<Address>("ownerOf", [after.borrowerTokenId])).toLowerCase(),
  ).toBe(before.borrower.toLowerCase());
  expect(after.principal).toBe(before.principal);
  expect(after.interestRateBps, "the borrower's rate is unchanged").toBe(
    before.interestRateBps,
  );
  expect(after.startTime).toBe(before.startTime);
  expect(after.durationDays, "the due date is unchanged").toBe(
    before.durationDays,
  );
  expect(after.collateralAsset).toBe(before.collateralAsset);
  expect(after.collateralAmount).toBe(before.collateralAmount);

  // The behavioural terms the buyer signed are the ones it now holds, and
  // the sale did not change them.
  for (const term of [
    "useFullTermInterest",
    "allowsPartialRepay",
    "allowsPrepayListing",
    "periodicInterestCadence",
  ] as const) {
    expect(
      Number(sale[term]),
      `the sale offer must carry the position's ${term}`,
    ).toBe(Number(before[term]));
    expect(Number(after[term]), `the sale must not change ${term}`).toBe(
      Number(before[term]),
    );
  }

  // ── The buyer's payment, exactly ──────────────────────────────────────
  // The buyer paid the listed price, less any rate shortfall credited to
  // its vault; the seller and the treasury received the rest between
  // them; nothing stays in the Diamond's custody.
  const post = await ledger();
  const paid = pre.buyer - post.buyer;
  const toSeller = post.seller - pre.seller;
  const toTreasury = post.treasury - pre.treasury;
  expect(paid > 0n, "the buyer paid for the position").toBe(true);
  expect(paid <= sale.amount, "the buyer never pays above the listed price").toBe(
    true,
  );
  expect(toSeller > 0n, "the seller received the proceeds").toBe(true);
  expect(toTreasury >= 0n).toBe(true);
  expect(
    toSeller + toTreasury,
    "what left the buyer is what the seller and treasury received",
  ).toBe(paid);
  expect(post.custody, "no proceeds are left in custody").toBe(pre.custody);
});
