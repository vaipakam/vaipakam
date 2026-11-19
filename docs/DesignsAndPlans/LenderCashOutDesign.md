# Cash from a loan you made: one door, and an advance the loan repays (design)

**Status:** owner asked for this design on 2026-11-19 ("there are so many options for lender to exit loan early together with borrowing against a loan you made, we need to make it simple for user"). Card #3760. Design first, no code yet. Built before the pre-audit refactor and audited in phases. Reaches a chain by fresh deploy.
**Related:** `SecondaryDebtMarketDesign.md` (#3667: the sale to Auto-lend, the price language, `positionWorth`, and section 8, which this design replaces), `LenderPositionPartSaleDesign.md` (#3674), `InstantMarketDesign.md` (#3656: takeover at face value), `LenderPayoutsThroughClaimDesign.md` (#3629), `LenderSaleSellerInterestClaimDesign.md`, `PositionSaleStateGuardDesign.md` (#3710), `PayoutDestinationRuleDesign.md`, the functional spec's lender early-withdrawal section.
**Base:** the code named below was read on the batch branch of #3743 (`claude/project-thread-ijafuu` at `a067c7bae`): the sale-exit verdict (`SaleExitVerdictFacet`), the two sale entries, the takeover (`InstantTakeoverFacet`), the interest ledger and seller claims (`LibInterestLedger`, `SellerClaimFacet`), and the amounts held for a lender position (#3629). The sale to Auto-lend, the part sale and `positionWorth` are approved designs that are not built yet.

## 1. Why

A lender who wants money back before a loan ends has, built or approved, six ways:

| Way | What it is | State |
| --- | --- | --- |
| Direct sale | Sell into a standing buy offer in one transaction | Built |
| Listing | Post the loan for sale with an expiry and wait | Built |
| Takeover | Hand the loan to an Auto-lend slot at face value | Built on the batch branch |
| Sale to Auto-lend | Sell to a slot at a price at or below face value | Approved (#3667) |
| Part sale | Any of the above for a part of the loan | Approved (#3674) |
| Outside transfer | Sell or give the token anywhere | Built |

Each has its own name, screen, price figure and refusals. Borrowing against the loan would be a seventh. A lender should not have to learn seven names to answer one question: **how do I get cash from this loan, and what does it cost me?**

Two changes answer it. The routes stay, as sources behind one action. And borrowing against a loan is given a shape with nothing for the lender to watch.

## 2. What the lender sees

On every loan they hold, one action: **Get cash from this loan**. It asks one thing, the amount wanted (or "all of it"), and answers with at most three choices. "Leave it" is stated first, as the spec requires: the loan keeps paying, and nothing is given up.

| Choice | In plain words | You get now | You give up | You still hold |
| --- | --- | --- | --- | --- |
| **Sell now** | The best price available this minute | The price, less any stated cost | That part of the loan, for good | The rest of the loan, if you sold a part |
| **Sell at my price** | Name a price and wait for a buyer | Nothing until a buyer takes it | That part of the loan, when it sells | The whole loan until then |
| **Borrow against it** | Keep the loan, receive part of its value now | The advance, less the fee | Interest on the advance until the loan repays it | The whole loan |

- Every choice shows the same three figures, from one read (section 3), and its own short list of what else changes.
- A choice that is not open says why and when it can open, as the exit surface already must.
- The names "direct sale", "takeover", "sale to Auto-lend" and "part sale" are never choices. They are the sources "Sell now" draws on.
- An outside transfer is not part of this flow. It stays on the token's own page with the check page of #3667.

## 3. One read for all three

Today's verdict answers for two routes whether a lender may sell now. It grows into the one answer the door needs.

- **`cashOptions(loanId, caller, amount)`** returns, for each of the three choices: whether it is open; every refusal as the error the entry itself would raise, with the earliest time it can lift (the verdict's existing shape); and the limits that do not depend on a counterparty (the largest part that may be sold, the largest advance the rules allow).
- **Figures that depend on a counterparty** come from two previews that take the sources the app found: `previewSellNow` (section 4) and `previewAdvance` (section 6). Each returns the exact amounts the entry would move, from the same computation, and the same first refusal.
- The entries keep calling the verdict for their opening checks, so the door cannot show a choice the contract would refuse.
- **One open route per position.** A listing, an offset, a takeover in progress and an advance exclude one another. The read names the one that stands and what ends it.

## 4. Sell now

One entry, **`sellNow`**, does for a seller what the instant borrow does for a borrower.

- **Inputs:** the loan, the part to sell (all, or an amount of outstanding principal once #3674 exists), a list of sources chosen off chain, best first, the least the seller will receive in all, the most held balance that may go with the position, and a deadline. These are the reviewed figures every sale is already bound to.
- **Sources:** an Auto-lend slot that takes over at face value, an Auto-lend slot that buys at a price, and a standing buy offer. The backstop is a source only where its own rules already let it buy.
- **Each fill runs through the one sale host**, with that route's existing checks, price rule and seller-claim rule. Nothing about any route changes. A source that refuses is skipped and reported with its reason.
- **The call reverts only when the total received would be below the seller's stated least.** At most 8 fills.
- **Before the part sale is built** a position is sold whole: the sources are tried in order until one takes all of it.
- **Best first** is the app's ordering by what the seller receives, from `previewSellNow`. The contract enforces only the seller's least, as the instant borrow enforces only the borrower's.
- A keeper under the holder's mandate may call it at or above the holder's floor, as #3667 already allows for a sale to a slot.

"Sell at my price" is the listing as it is. It is reached from the same door and described by the same three figures.

## 5. Borrowing against a loan: the shape

Section 8 of `SecondaryDebtMarketDesign.md` sketched a pledge: the position as the collateral of a second loan, with a value, a health rule, a freeze on everything the position receives, and a default that hands the token to the new lender. A lender could lose a whole position by missing a date. This design replaces it with an **advance that the loan itself repays**.

1. An Auto-lend slot pays the holder an advance: a part of the loan's outstanding principal, at the slot's own rate.
2. From then on, everything the loan pays to its lender side goes **first** to the advance and its interest. What is left is the holder's.
3. The holder may repay the advance from their own vault at any time.
4. When the advance is repaid, by the loan or by the holder, the position is free again.

That is the whole of it for the holder: no date to meet, no health factor, no liquidation of the holder, and the token never leaves them. The cost is the interest on the advance, which runs until it is repaid.

For the slot's owner it is a loan paid first out of a loan that an Auto-lend slot could have made itself: the borrower's collateral stands behind the whole principal, and the advance is only part of it.

The advance is owed **by the position, not by the person**. There is no claim on the holder beyond what the position receives, as there is none on a borrower beyond their collateral. The position token is still never collateral and never a deposit: the refusal of #3667 Part A stays as it is.

## 6. The advance in detail

### 6.1 Who gives one

An Auto-lend slot whose owner has switched on a new consent, **advances on loans**, with one limit of their own: the largest share of a loan's outstanding principal they advance (default 70%, never above 85%). The slot's other settings apply as they do to a loan: its lowest rate, smallest fill, exposure, and lend-until time. Fixed-rate slots first. Standing offers by hand are a later step.

### 6.2 Which loans

An advance is refused, by name, unless all of these hold:

- the loan is active, not past due and not in a fallback; both its assets are ERC-20 and top tier (the instant market's test); its interest is owed by time;
- the loan passes, at that moment, the health test a new loan must pass;
- its lender side is whole (not divided under #3674) and the caller holds its token;
- nothing is held unclaimed for the position, the token is outside its transfer wait, and no other route is open on it;
- renewal and extension are off for the loan, so its due date is firm;
- the loan's due date and grace period end inside the slot's lend-until time;
- the slot's owner is not the loan's borrower or its holder;
- neither party is flagged, locked or without the Terms, and the feature's switch is on.

### 6.3 How much, and at what cost

- **Amount:** what the holder asks, at least the slot's smallest fill. The advance plus its interest up to the end of the loan's grace period may not exceed the slot's share of the outstanding principal. So the repayment of principal alone covers it.
- **Rate:** the slot's own lowest rate, fixed, by time, on what is still owed. The holder is the taker, as in an instant borrow.
- **Fees:** the ordinary ones. The initiation fee of a loan of that amount for the time to the loan's due date, taken from the advance; the treasury's cut of the advance's interest. An advance with no fee would be a way around the fees on borrowing.
- **One advance per position.** A second needs the first repaid.
- The holder's call states the slot, the amount, the highest rate accepted, the least they must receive and a deadline.

The advance moves from the slot's capital, in its owner's vault, to the holder's vault as free balance.

### 6.4 Repayment from the loan

Everything a lender side receives is already held for the position and claimed by its holder (#3629). The advance is paid at that one place.

- While an advance is open, the held balance pays, in order: the seller claims of earlier sales, as today; the advance's interest; the advance itself; then the holder.
- This applies to everything that arrives: interest, a part repayment, the final repayment, a refinance payoff, an early close, and the proceeds of a liquidation or a default.
- Paying the advance from a held balance is a step anyone may call, and it runs inside the holder's own claim. A keeper pass backs it. Interest on the advance stops on each amount the moment it is paid.
- What goes to the advance lands in the slot owner's vault and returns to the slot as any repayment does.

### 6.5 While the advance is open

The position is locked, by the record itself, where the token stands:

- no transfer, sale, listing, takeover or part sale; the read of section 3 says why and what lifts it;
- renewal and extension stay off;
- the holder claims only what is left after the advance;
- a move that follows the person (a recovery clawback, an account replacement) carries the token with its advance attached.

The borrower of the loan sees no change and none of their routes is touched: repay, repay in part, close early, refinance, hand over. Each of those pays the lender side, and the advance is paid from it.

### 6.6 How it ends

| Case | What happens |
| --- | --- |
| The loan's payments cover it | The advance closes when the last of it is paid. The lock lifts. |
| The holder repays it | Any amount, at any time, from their vault. Paid in full, the lock lifts. |
| The loan ends and its lender side has received less than is owed | The advance receives all of it and closes with a shortfall, which is stated. Nothing more is owed by the holder. |
| The loan ends in a fallback and the lender side receives collateral in kind | The holder has 7 days to repay the advance and keep the collateral. After that the advance takes collateral worth what it is owed at the rate the fallback itself used, and the holder keeps the rest. Where the fallback had no price, the advance takes all of it. |

An advance is outside the shortfall reserve, earns no usage reward on either side, and counts for no fee discount.

### 6.7 The advance lender's side

- The advance is a record on the loan, naming the slot. It is not a position token and cannot be transferred or sold in this version.
- It ends no later than the loan's own close-out, which is why the loan's due date and grace must sit inside the slot's lend-until time.
- It counts toward the slot's exposure until repaid.
- A flagged advance lender's payments are held for them as any flagged lender's are. A flagged holder does not stop the advance being paid from the position.

## 7. What cannot be gamed, and what is stated

- **Emptying the position before borrowing:** nothing may be held unclaimed, and the token must be outside its transfer wait.
- **Borrowing against a weak loan:** the health test of a new loan, top-tier assets only, and an advance that principal alone covers.
- **Lending to yourself through two wallets and borrowing against it:** it draws on the advance lender less than the collateral that stands behind the loan, at a worse ratio than borrowing directly, and pays every fee. No reward is earned on an advance.
- **Moving the due date after the advance:** renewal and extension stay off.
- **Selling the position out from under the advance:** locked.
- **A caller choosing when to pay the advance:** paying sooner only stops interest sooner. The order of payment is fixed.
- **Sell now steering to a poor source:** the seller's least binds the call, and the preview and the fill use one computation.
- **Stated to the holder:** interest on the advance runs until the loan repays it, so a loan that pays late costs more. If the loan ends short, the advance is paid before them. They cannot sell or move the position until the advance is repaid.
- **Stated to the slot's owner:** the funds return when the loan pays, not on a date of their choosing, and no later than the loan's close-out. If the loan ends short of the advance, the loss is theirs.

## 8. Wording rules

The door is **Get cash from this loan**. The choices are **Sell now**, **Sell at my price** and **Borrow against it**. The thing borrowed is an **advance**, and it costs **interest**. The app never says leverage, margin or pledge, never calls the advance risk-free, and never shows the loan's due date as the date the slot owner's funds return.

## 9. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Sale-exit verdict | Becomes the one read for the three choices (`cashOptions`), with the limits that need no counterparty. A new facet if the present one has no room. |
| New entry `sellNow` and `previewSellNow` | Fills across sources through the existing sale host; reverts under the seller's least. A new facet. |
| New facet for the advance | Take, repay, pay from the held balance, the fallback case, the views and `previewAdvance`. |
| Lender intent | The "advances on loans" consent and its share limit; advances count toward exposure. |
| Held-for-lender payout | One added step in the order of payment while an advance is open, at the place seller claims are already paid first. |
| Position record | The advance lock, read by every transfer and every route's opening check; carried by a move that follows the person. |
| `positionWorth` and metadata | State an open advance and what is owed on it, ahead of the holder. |
| Events | Advance taken, paid from the position, repaid by the holder, closed (with any shortfall), the fallback case; sell-now's summary with each fill and each skipped source. |
| Keeper | A pass that pays advances from held balances, shipped disarmed; the existing sale pass may call `sellNow`. |
| Permissionless-steps ledger, indexer, app | Rows for the open steps; advances indexed; the one door of section 2 in place of the separate exit screens; wording per section 8. |

Append storage at the tail and run the storage-layout guard's `write`. Check facet sizes with the deploy-sanity suite.

## 10. Tests

1. `cashOptions` reports each choice open or refused exactly as its entry does, for every refusal the verdict classifies, and names the one open route.
2. `sellNow`: fills in list order through each route's own rules; a refusing source is skipped and reported; reverts only under the seller's least; the fill limit; equals the same single-route calls made one by one; before the part sale, sells whole to the first source that takes all.
3. `previewSellNow` and the fill agree to the unit.
4. Advance taken: every refusal of 6.2; the amount rule of 6.3 at its edge; the fee equals a loan's of the same amount and time; funds land in the holder's vault; the slot's exposure rises.
5. Order of payment: seller claims, advance interest, advance, holder, for each kind of arrival (interest, part repayment, final repayment, refinance, early close, liquidation, default).
6. Interest on the advance is by time on what is owed and stops on each amount when paid.
7. The holder repays in part and in full; the lock lifts only when nothing is owed.
8. While open: transfer, sale, listing, takeover, part sale, renewal and extension are refused; the borrower's routes all work; a clawback and a replacement carry the advance.
9. The loan ends short: the advance receives everything, closes with the stated shortfall, and the holder owes nothing.
10. The fallback case: the 7 days, the split at the fallback's own rate, and the no-price case.
11. Paying from the held balance by any caller gives the same result as the holder's claim.
12. A flagged holder does not stop the advance being paid; a flagged advance lender's payments are held.
13. After any sequence of advance, arrivals, repayments and close, the position's held balance, the advance owed and each vault's balance add up, and nothing rests in the Diamond.
14. With the advance switch off, taking one refuses and an open one still runs to its end.

## 11. Alternatives considered

1. **Keep each route as its own choice and improve the chooser.** The lender still has to understand six routes. Rejected.
2. **Remove routes.** Each serves a real case. Behind one action they cost the user nothing. Rejected.
3. **The position as collateral of a second loan** (the earlier section 8 of the sale design). Rejected: see section 5.
4. **A sale with a right to buy back.** Two moves of the position, the buyer holds the token meanwhile, and the outcome is the same as an advance. Rejected.
5. **Let the advance's lender take the token when the loan runs late.** It adds a default to manage and nothing the order of payment does not already give. Rejected.
6. **Advances from standing offers by hand.** Useful, later. Slots are instant and priced by rule.
7. **Several advances on one position.** Needs a rank among them. Later, if wanted.
8. **A transferable advance.** It would need its own token and its own exit rules. Left out of this version.
9. **Leave borrowing out and rely on selling a part.** Covers the need for cash, but the lender gives up the interest on the part sold. The owner asked for it now.

## 12. Recommendation and order of work

1. The one read and the door in the app, over the two routes that exist today.
2. `sellNow`, taking in the takeover and, as they are built, the sale to Auto-lend and the part sale.
3. The advance from Auto-lend slots, top-tier pairs, behind its own switch.
4. Later: advances from standing offers, and a floating rate.

## 13. Open items for the builder to raise, not decide silently

1. Whether the advance's place in the order of payment is best kept in the seller-claim host or beside it.
2. How the 7 days and the in-kind split fit the fallback's existing claim steps, including the one retry of a failed collateral sale.
3. What an advance record does when the slot owner's account is replaced or clawed back.
4. Whether `cashOptions` fits on the verdict's facet.
