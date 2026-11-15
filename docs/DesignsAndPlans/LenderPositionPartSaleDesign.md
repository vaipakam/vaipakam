# Selling part of a lender position — design

**Status:** owner approved, 2026-11-15. Card #3674. Build after `LenderPayoutsThroughClaimDesign.md` (#3629) and Part B of `SecondaryDebtMarketDesign.md` (#3667), which it extends.
**Related:** `SecondaryDebtMarketDesign.md` (price language, holder epoch, `positionWorth`), `InstantMarketDesign.md` (takeover at face value), `LenderPayoutsThroughClaimDesign.md` (every lender payout is held for the position and claimed), #3670 (a sale forfeits no reward).
**Scouted 2026-11-15** (code, designs, spec) before writing; what was found is in section 2.

## 1. Why

A lender can leave a loan only by selling all of it. Two things follow.

- A large position needs one buyer with room for the whole loan. An Auto-lend slot limits what it puts into one loan, and a standing buy offer has its own amount, so a large position often has no single buyer even when several buyers together would take it. Instant borrowing already fills one request across several slots; selling should be able to do the same.
- A lender who needs part of the money back has to give up the whole loan.

This design lets the lender side of one loan be held by a few position tokens, each with a stated share. It is not a platform-issued share token: each part is a whole position token, the same kind as today's, and shares are never interchangeable units.

## 2. What exists today (scouted)

- A loan stores one lender (`loan.lender`, the "stored lender", whose vault holds the lender side's money under reservation) and one lender token (`loan.lenderTokenId`). About 44 source files read `loan.lender`.
- The terminal lender due is one row per loan, `lenderClaims[loanId]`, written by about fourteen settlement facets and released by `claimAsLender`.
- Under #3629 (approved, not yet built) every payment on an open loan is also held for the position (`heldForLender[loanId]`) in the stored lender's vault and claimed by the holder.
- The lender's fee discount is read in one place (`LibVPFIDiscount.lenderHoldTierDiscountBps`, a read of the accumulator facet's `lenderHoldDiscountBps`), and every interest payment to the lender side passes `LibInterestLedger`.
- Both sale routes move the whole position through `LibLoan.migrateLenderPosition`. The direct sale requires the buy offer's amount to equal the loan's principal exactly (`SaleAmountNotExactPrincipal`).
- A lender-side reward entry already has a ceiling shared by every entry of the same loan and side.

So the money for a lender side already gathers in one custody place behind two ledgers, the fee discount has one reader, and interest has one ledger. The split is placed at those points, and the settlement facets are not rewritten.

## 3. The rule

1. **One loan, one lender side, several holders.** The loan record, its collateral, its rate, its due date and everything the borrower sees or does are unchanged. The lender side is divided into **shares** of a fixed whole. Each share is held by one lender position token.
2. **A share is created only by a platform sale.** A seller sells a stated part of their token; the buyer receives a new lender token for that part and the seller's token keeps the rest. A plain transfer moves a whole token and never splits one.
3. **A buyer who already holds a share of the loan gets the purchase added to that token.** A holder with two tokens of one loan may merge them. Neither creates a new holder.
4. **Limits.** At most 8 share tokens per loan. A sale must leave both parts at or above the minimum share: the larger of the offer-book value floor and 5 percent of the lender side. A sale that would break either is refused by name.
5. **Lender side only.** The borrower side is never divided: that would divide the collateral and the duty to repay.
6. **Custody does not move.** The lender side's money stays where #3629 puts it, in the stored lender's vault under reservation. The stored lender is the holder of the loan's first token (`loan.lenderTokenId`, the "lead" token) as today. Being lead gives no right over the others' money: the reservation keeps it out of the lead's spending, and each holder claims only their own part, through the outflow policy, into their own vault. When the lead token moves, custody follows it exactly as it does today.

## 4. Dividing what the lender side receives

Every amount credited to the lender side is one of two kinds.

**Interest.** Each share pays the treasury's cut at **its own holder's fee discount**, by the existing rule (the lower of the standing recorded for that token and the holder's standing at the payment). A holder never gains or loses discount because of who else holds the loan.

- The one discount read returns, for a loan with several shares, the share-weighted figure, so the treasury's cut taken by the settlement step is exactly the sum of what each share owes. The settlement facets call the same function as today.
- The interest ledger, which every interest payment already passes, credits each token its own net interest in the same step, from the same per-share figures. The amounts credited to the tokens sum exactly to what arrived for the side; any rounding remainder goes to the largest share.
- This costs up to 8 reads and 8 writes on an interest payment to a divided loan, and nothing on an undivided one. The builder measures it and reports the figure; if it is too heavy the holder limit is lowered, the rule is not weakened.

**Everything else** (principal, sale proceeds on a liquidation or default, collateral received in kind in a fallback, a late fee's lender part): divided by share when claimed. A token's claim is its share of the side's total credited, less what that token has already taken. No settlement step changes for this; the division is in the claim.

**Rounding** always rounds a token's part down. What remains, at most a few base units per asset, is paid with the last token's claim, so the side's ledger ends at zero and the reservation is fully released.

**Claims.** Both lender claims (`claimHeldForLender` on an open loan and the terminal `claimAsLender`) take the token, pay that token's part into its holder's vault, and mark that token only. The terminal claim closes the loan's lender row when the last token has claimed.

## 5. The sale of a part

The four ways a lender position is sold each accept a part:

| Route | How the part is set |
| --- | --- |
| Listing | The seller lists a stated part of their token. |
| Direct sale into a standing buy offer | The exact-principal rule is replaced: the buy offer's amount may be less than the token's outstanding principal, and it buys that part. It may not exceed it. |
| Sale to Auto-lend (Part B of the sale design) | The slot buys what its room allows, at or above the seller's lowest price. One call may sell across several slots, as instant borrowing fills across several. |
| Takeover at face value (instant market) | A slot takes over a part at face value. |

Everything else about a sale is the existing rule applied to the part sold:

- **Price** in basis points of the outstanding principal of the part. A slot never pays above par.
- **Tests on the loan** (the as-new test, the solvency check, the sale-exit verdict) judge the whole loan. **Room and exposure** count the part bought.
- **Seller's reviewed figures** (least net, most held, deadline) bind the sale as today.
- **Interest earned before the sale** on the part sold stays the seller's, by the existing seller-claim rule. The unclaimed held principal belonging to the part goes with the part, as it does today for a whole sale.
- **Rewards:** the seller's reward entry continues at the smaller share from the sale day and the buyer's starts at its share (#3670). The loan side's shared ceiling is unchanged.
- **Fee-discount standing** is recorded for the new token as for any new holder.
- **The holder epoch** of the lender side advances, so every standing permission on the side lapses.
- **Sanctions, protected accounts, the cooldown:** each rule that guards a sale today guards a part sale, per token.

## 6. Lender choices on a divided loan

| Choice | Rule |
| --- | --- |
| Claim, sell, list, cancel a listing | Each holder, for their own token only. |
| Anything that needs the lender's fresh consent (an in-place extension or renewal) | Not available while the loan has more than one holder. The loan runs to its due date. The borrower's own routes (repay, close early, refinance, hand over) are unaffected, since each pays the lender side in full. |
| A step that changes only the form of what the side is owed and already has a floor (the one retry of a failed collateral sale) | Any holder may start it, once, as today; the result is shared by share. |
| Auto-lend roll and re-commit | Act on the intent owner's own token only, with that token's proceeds. The part sold leaves the intent, and its exposure is released at the sale. |

A flagged holder freezes their own token's claim and nothing else. The frozen-claimant marker is kept per token.

## 7. What cannot be gamed

- **No extra reward or interest is created.** Shares sum to the whole; the reward ceiling is shared; interest is divided exactly.
- **No fee discount is borrowed.** Each share pays at its own holder's discount, with the lower-of rule per token.
- **No dust and no crowding.** The minimum share and the holder limit bound both. A holder cannot fill the limit to stop another holder from selling: a whole token always sells or transfers without a new slot, and a purchase by an existing holder merges.
- **The lead cannot spend the side's money.** It is reserved, and leaves only by each token's claim.
- **The borrower cannot be burdened.** One loan, one repayment, whatever the number of holders, except the bounded cost in section 4 on an interest payment.
- **A buyer is not sold a weakening loan.** The loan-level tests are the same as for a whole sale.

## 8. Contract changes

| Where | Change |
| --- | --- |
| Loan record | A share table per loan: token id, share, amount taken per asset, interest credited. `loan.lender` and `loan.lenderTokenId` keep their meaning (custody and the lead token). Fresh deploy; no storage compatibility is owed. |
| A new share host facet | Create a share at a sale, merge, the per-token entitlement read, the limits. One library holds the division rule; nothing else divides. |
| `LibLoan.migrateLenderPosition` | Whole-token sale as today; a part sale calls the share host instead. |
| The discount read (`lenderHoldDiscountBps`) | Returns the share-weighted figure and the per-share figures for a divided loan. |
| `LibInterestLedger` | Credits each token's net interest at payment. |
| `ClaimFacet`, the mid-loan claim of #3629 | Take a token; pay its part; close the row with the last token. |
| The four sale routes | Accept a part (section 5); the direct sale's exact-principal rule becomes "not more than". |
| Lender-side caller checks | "Holds the lender token" becomes "holds a lender token of this loan" for own-token actions, and "the only holder" for section 6's consent steps. One helper. |
| Position token and metadata | Each share token states its loan and share. |
| `positionWorth(tokenId)` | Figures for the token's share, the number of holders, and whether the token is the lead. |
| Reward host | Entries carry a share. |
| Views and events | Every sale, merge, credit and claim states the token, its share and the measured amount. |

Facet room is checked with the deploy-sanity suite; where a facet has none, split along a seam.

## 9. App and off-chain

- Sell screens offer "sell part" with the amount, and show both resulting parts and the price in the one price language.
- A lender position shows its share of the loan and that others hold the rest; the "check before you buy" page shows the same for any token.
- The indexer handles the new events; the keeper's sale-related passes read shares. No new keeper pass is owed by this design alone.

## 10. Tests

1. A part sale on each of the four routes: the buyer's token and the seller's token hold the stated shares, summing to the whole; the price paid is measured; the borrower's record is unchanged.
2. Limits: a ninth holder, a part below the minimum, a remainder below the minimum, a buy amount above the token's principal are each refused by name; a purchase by an existing holder merges.
3. Interest with different discounts: two holders at different tiers each receive their own net; the treasury receives exactly the sum of both cuts; one holder unstaking lowers only their own.
4. Principal, liquidation proceeds, in-kind collateral and a late fee divide by share; claims in any order pay each token once; the last claim leaves the ledger and the reservation at zero.
5. Mid-loan claim by one holder, then a further payment, then claims by all: nothing is paid twice.
6. Sale of a part, then of the rest of the same token; sale of the lead token whole (custody follows); plain transfer of a share token.
7. Seller claim for interest earned before a part sale is paid first from later interest on that part only.
8. Rewards: entries by share from the sale day, the shared ceiling holds across several sales.
9. A flagged holder cannot claim; the others can; the flagged holder's part waits.
10. A divided loan refuses an in-place extension; repayment, early close, refinance, hand-over, liquidation and default all settle and divide correctly.
11. Auto-lend: sale of a part releases that part's exposure; the roll re-commits the owner's token only.
12. Invariant: for every loan, shares sum to the whole, and the sum of every token's remaining entitlement per asset equals the side's unreleased reservation.

## 11. Alternatives considered

1. **Leave it out.** Whole sales only. Rejected by the owner's direction: large positions then depend on one buyer.
2. **Divide the loan into two loans.** Each lender then has an ordinary loan. Rejected: it divides the collateral, doubles the borrower's repayments and liquidation points without their consent, and changes the borrower's terms.
3. **Platform-issued interchangeable share tokens.** Rejected at any time: interchangeable shares in a loan issued by the platform read as an investment product, and they would need their own transfer, pricing and claim rules.
4. **Pay each holder's vault at every payment.** No custody place to share. Rejected: every payer would make up to 8 deposits, and it would create vaults for whoever holds a token without their act, which #3629 already rejected.
5. **One fee discount for the whole side** (the lowest among holders, or a share-weighted figure divided evenly). Cheaper. Rejected: a buyer with no standing would lower the other holders' discount, or share in one they did not earn.
6. **Take the treasury's cut at claim instead of at payment.** Exact per holder with no reads at payment. Rejected: it changes when the treasury is paid on every settlement path and lets a holder choose the moment their standing is read.
7. **Shares at the claim for principal, per token at payment for interest (chosen).**

## 12. Recommendation and order of work

Build as one contract change after #3629 and after the sale to Auto-lend, on the build branch under the batch rule. Scout the code, the designs named above and the spec before starting, and run an adversarial self-review: this is a fund-moving change. The spec (`ProjectDetailsREADME.md`, the lender-exit and claim sections, and `TokenomicsTechSpec.md` for rewards and the fee discount) is updated in the same change.

## 13. Open items for the builder to raise, not decide silently

- Any interest payment to the lender side that does not pass the interest ledger, and any lender-side caller check not covered by the one helper.
- The measured cost of an interest payment to a loan with 8 holders, and whether the limit should be lower.
- How the backstop claim route treats one token of a divided loan.
- Whether an NFT rental's lender side may be divided (this design says no: rentals are excluded until asked for).
