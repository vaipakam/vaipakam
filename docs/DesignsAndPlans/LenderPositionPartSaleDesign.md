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
- The lender's cut to the treasury is resolved in one host: settlement facets call `VPFIDiscountFacet.resolveLenderYieldFeeFor(loanId, lender, interest, treasuryShare)`, which returns what the lender gets back and what the treasury keeps, and for a lender on the full tariff takes the fee in VPFI from that lender's vault. Callers first run an inlined eligibility test, `LibVPFIDiscount.lenderYieldFeeEligible(loan, lender)`, and skip the host when it fails. Both are written for one lender. Every interest payment to the lender side passes `LibInterestLedger`, which allows at most 4 open seller claims per loan (`MAX_SELLER_CLAIMS`).
- Both sale routes move the whole position through `LibLoan.migrateLenderPosition`, which takes no token: it retires `loan.lenderTokenId` and replaces the stored lender. The direct sale requires the buy offer's amount to equal the loan's principal exactly (`SaleAmountNotExactPrincipal`).
- A lender-side reward entry already has a ceiling shared by every entry of the same loan and side.
- A loan's collateral may be an ERC-721 or ERC-1155 token. On a default it reaches the lender in kind, as one claim for the whole token.

So the money for a lender side already gathers in one custody place behind two ledgers, the lender's fee has one host, and interest has one ledger. The split is placed at those points, and the settlement facets are not rewritten.

## 3. The rule

1. **One loan, one lender side, several holders.** The loan record, its collateral, its rate, its due date and everything the borrower sees or does are unchanged. The lender side is divided into **shares** of a fixed whole. Each share is held by one lender position token.
2. **A share is created only by a platform sale.** A seller sells a stated part of their token; the buyer receives a new lender token for that part and the seller's token keeps the rest. A plain transfer moves a whole token and never splits one.
3. **A buyer who already holds a share of the loan gets the purchase added to that token.** A holder with two tokens of one loan may merge them. Neither creates a new holder.
4. **Limits.** At most 8 share tokens per loan. A sale must leave both parts at or above the minimum share: the larger of the offer-book value floor and 5 percent of the lender side. A sale that would break either is refused by name.
5. **Only where everything the side can receive is divisible.** A part sale is refused, by name, unless the loan's lending asset and its collateral are both ERC-20 tokens. A loan backed by an ERC-721 or ERC-1155 token can pay its lender in kind with a token that cannot be divided, so its lender side stays whole; so does an NFT rental's.
6. **Lender side only.** The borrower side is never divided: that would divide the collateral and the duty to repay.
7. **Custody does not move.** The lender side's money stays where #3629 puts it, in the stored lender's vault under reservation. The stored lender is the holder of the loan's first token (`loan.lenderTokenId`, the "lead" token) as today. Being lead gives no right over the others' money: the reservation keeps it out of the lead's spending, and each holder claims only their own part, through the outflow policy, into their own vault. When the lead token moves, custody follows it exactly as it does today.

## 4. Dividing what the lender side receives

### 4.1 One ledger for the side, one checkpoint per token

The side keeps, per asset it can receive, a running total of what has been credited to it **per whole** (everything credited, divided by the fixed whole). Each token keeps the value of that total at its last checkpoint and an **owed** balance per asset.

A checkpoint of a token adds `share × (the side's total now − the token's value at its last checkpoint)` to the token's owed balance and moves the token's value to now. A claim checkpoints the token and pays its owed balance. Nothing is ever computed from how much a token has taken in the past, so a claim followed by a split cannot double-pay.

- **A part sale** checkpoints the seller's token first. The new token starts at the side's total now, with an owed balance equal to what the sale rule gives it (section 5) and nothing else. The seller's token keeps the rest of its owed balance and continues at its smaller share.
- **A merge** checkpoints both tokens, then adds their shares and their owed balances.
- **A whole-token sale or a plain transfer** moves the token's row unchanged.

Everything the side receives is credited to the running total by the amount that arrived: principal, interest net of the treasury's base cut, sale proceeds on a liquidation or default, collateral received in kind (always an ERC-20 here, by rule 5), a late fee's lender part. The settlement facets do not change for this: they credit the side as today, and the side's two existing ledgers feed the running total.

**Precision.** The side's running total and each token's owed balance are kept at a fixed extra precision (scaled well below one base unit). A checkpoint adds the exact scaled amount and discards nothing. A claim pays the whole base units of the token's owed balance and leaves the fraction on the token, where later credits add to it. So how often a token is checkpointed, and by whom, changes nothing: a token checkpointed after every credit and one checkpointed once end with the same total. What remains for the whole side at the end, less than one base unit per token and asset, is paid with the last token's claim, so the side's ledger ends at zero and the reservation is fully released.

### 4.2 The treasury's cut, per holder

Each share pays the treasury's cut on its interest by **its own holder's** standing: the holder's fee discount (the lower of the standing recorded for that token and the holder's standing at the payment), the holder's own consent, and, for a holder on the full tariff, the fee in VPFI from **that holder's own vault**. A holder never gains or loses because of who else holds the loan, and no holder's vault pays another's fee.

This lives in the one host that resolves the lender's fee today:

- For a divided loan the host resolves each token in turn on that token's part of the interest and of the treasury's cut: eligibility, discount, and the VPFI payment or its fallback, exactly the single-lender rule applied to that holder. It returns the totals the caller already expects (what the lender side gets back, what the treasury keeps), so the settlement facets call the same function with the same result shape.
- What each token gets back is added to **that token's** owed balance in the same step. It is not credited to the side's running total, since it belongs to one holder.
- The inlined eligibility test, which today can skip the host on the stored lender's answer alone, answers "ask the host" for any divided loan. It is one library function; its callers recompile and do not otherwise change.
- A token whose holder is not eligible simply gets nothing back. A VPFI payment that cannot be taken from one holder's vault falls back for that token only, by today's fallback rule.

Cost: up to 8 resolutions on an interest payment to a divided loan, and nothing on an undivided one. The builder measures it and reports the figure; if it is too heavy the holder limit is lowered, the rule is not weakened.

### 4.3 Seller claims, per token

A sale leaves the seller a claim for interest earned and not yet paid (the existing rule). On a divided loan:

- A seller claim is recorded against **the token that holds the part sold**: on a part sale that is the buyer's new token, on a whole-token sale the token that replaces the one sold. It has first call on that token's later interest only. It never draws on the part the seller kept, nor on another holder's part.
- The limit of open seller claims is **per token** (4, today's figure), so sales by other holders cannot use up a holder's room to sell. The sale-exit verdict reads the count the sold part would carry.
- **Claims follow the part they are owed from.** When a token that carries open seller claims is itself sold in part, each open claim is divided between the two tokens in the ratio of the split, so the interest that funds a claim and the claim stay together and the total owed is unchanged. The new token then carries those portions plus the new seller's claim; a sale that would put more than the limit on it is refused by name. A merge adds the two tokens' claims (two portions of one original claim rejoin as one) and is refused if the result would pass the limit.
- A token's seller claims are settled when that token is checkpointed: its newly credited interest pays its seller claims, oldest first, before its owed balance. A seller may checkpoint the token to collect; the payment goes to the seller's vault as today. No per-payment loop over every token's claims is added to the payer's transaction.

### 4.4 Claims

Both lender claims (`claimHeldForLender` on an open loan and the terminal `claimAsLender`) take the token, checkpoint it, pay its owed balance into its holder's vault, and mark that token only. The terminal claim closes the loan's lender row when the last token has claimed.

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
- **Interest earned before the sale** on the part sold stays the seller's, by the seller-claim rule (4.3). The unclaimed held principal belonging to the part goes with the part, as it does today for a whole sale: it becomes the new token's starting owed balance (4.1).
- **A whole token sold by any holder** moves through a share-aware migration that replaces only that token and its row. Shared custody moves only when the token sold is the lead. Today's migration, which always retires the loan's first token and replaces the stored lender, is used only through that step.
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

- **No extra reward or interest is created, and nothing is paid twice.** Shares sum to the whole; the reward ceiling is shared; a token's entitlement comes from checkpoints, never from past claims (4.1).
- **No fee discount is borrowed and no fee is paid for another.** Each share's cut is resolved on its own holder's standing, consent and vault (4.2).
- **No dust and no crowding.** The minimum share and the holder limit bound both. A holder cannot fill the limit to stop another holder from selling: a whole token always sells or transfers without a new slot, a purchase by an existing holder merges, and seller-claim room is per token (4.3).
- **The lead cannot spend the side's money.** It is reserved, and leaves only by each token's claim.
- **The borrower cannot be burdened.** One loan, one repayment, whatever the number of holders, except the bounded cost in section 4 on an interest payment.
- **A buyer is not sold a weakening loan.** The loan-level tests are the same as for a whole sale.

## 8. Contract changes

| Where | Change |
| --- | --- |
| Loan record | A share table per loan: token id, share, per asset the checkpoint value and the owed balance, open seller claims. The side's running total per asset. `loan.lender` and `loan.lenderTokenId` keep their meaning (custody and the lead token). Fresh deploy; no storage compatibility is owed. |
| A new share host facet | Create a share at a sale, merge, the per-token entitlement read, the limits. One library holds the division rule; nothing else divides. |
| `LibLoan.migrateLenderPosition` | Reached only through the share host's token-aware migration: the selected token and its row are replaced; the stored lender and custody change only when it is the lead. |
| The lender-fee host (`resolveLenderYieldFeeFor`) and `LibVPFIDiscount.lenderYieldFeeEligible` | Per-token resolution for a divided loan (4.2); same result shape for callers. |
| `LibInterestLedger`, `SellerClaimFacet`, `SaleExitVerdictFacet` | Seller claims and their limit per token, settled at the token's checkpoint (4.3). |
| `ClaimFacet`, the mid-loan claim of #3629 | Take a token; checkpoint it; pay its owed balance; close the row with the last token. |
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
3. Interest with different standing: two holders at different tiers each receive their own net; the treasury receives exactly the sum of both cuts; one holder unstaking lowers only their own. Mixed cases: the lead has no consent and another holder does; one holder is on the full tariff and pays in VPFI from their own vault; that holder's vault is short and only their token falls back.
3b. Two equal tokens and many small credits: one token is checkpointed after every credit (by its holder and by a seller), the other once; both end with the same total, to the base unit.
3a. A holder claims, then sells part: the seller's token and the new token together can claim exactly what is credited afterwards plus what the sale rule moved, and the reservation invariant holds. A merge after claims conserves both owed balances.
4. Principal, liquidation proceeds, in-kind collateral and a late fee divide by share; claims in any order pay each token once; the last claim leaves the ledger and the reservation at zero.
5. Mid-loan claim by one holder, then a further payment, then claims by all: nothing is paid twice.
6. Sale of a part, then of the rest of the same token; sale of the lead token whole (custody follows); plain transfer of a share token.
7. Seller claim for interest earned before a part sale is recorded on the buyer's token and paid first from later interest on that part only; the part the seller kept pays none of it. A token with open claims is sold in part again: each claim divides in the split's ratio and the total owed is unchanged; a merge rejoins them. Four sales from other tokens do not stop an untouched holder from selling; a fifth open claim on one token is refused for that token only.
7a. A non-lead holder sells their whole token: only that token is replaced, the lead token and custody are untouched. The lead sold whole: custody follows.
7b. A loan with ERC-721 or ERC-1155 collateral, and an NFT rental, refuse a part sale by name.
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
7. **Each token's entitlement from what it has taken so far.** Simple to state. Rejected: a claim followed by a split would leave the seller's token negative and let the new token claim money already paid. Checkpoints (4.1) remove the question.
8. **A joint custody or forced sale for an indivisible collateral token.** Would let NFT-backed loans be divided. Rejected for now: it needs its own disposal rule and agreement among holders; such loans stay whole.
9. **One running total for the side, a checkpoint per token, and the treasury's cut resolved per holder in the fee host (chosen).**

## 12. Recommendation and order of work

Build as one contract change after #3629 and after the sale to Auto-lend, on the build branch under the batch rule. Scout the code, the designs named above and the spec before starting, and run an adversarial self-review: this is a fund-moving change. The spec (`ProjectDetailsREADME.md`, the lender-exit and claim sections, and `TokenomicsTechSpec.md` for rewards and the fee discount) is updated in the same change.

## 13. Open items for the builder to raise, not decide silently

- Any interest payment to the lender side that does not pass the interest ledger, and any lender-side caller check not covered by the one helper.
- The measured cost of an interest payment to a loan with 8 holders, and whether the limit should be lower.
- How the backstop claim route treats one token of a divided loan.
- Whether the per-token seller-claim rule (4.3) should become the one rule for every loan, divided or not, so that there is one mechanism.
- Any other step written for one lender that the scout finds (a fee, a consent, a notice), listed with the rule proposed for it.
