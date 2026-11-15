# Instant market — design

**Status:** owner approved the direction, 2026-11-15 ("yes, do it"; the name is "instant market"). Card #3656. Design first, no code yet. Builds on #3337 (floating loans), #3635 part B (Auto-lend that fills floating), #3325 (borrow across several lenders in one transaction), #3331 (a new lender replaces the current one) and the in-place extension. Reaches a chain by fresh deploy.
**Related:** `MarketLinkedRateLimitsDesign.md`, `FloatingRateCapFloorLevelsDesign.md`, `AutoLendLendUntilDesign.md`, `FeeLevelsDesign.md`, `ShortfallReserveDesign.md`.

## 1. Why

A borrower who wants an amount now, with no fixed end date, and a lender who wants to deposit once, earn the going rate and leave when they choose, are served today only by lenders that hold everyone's funds together. This platform keeps every user's funds in their own vault and every loan between one lender and one borrower, and that stays. The instant market gives those two users the same experience **without holding funds together**: it is a way of using Auto-lend, floating loans and the position rules as one product, plus four additions.

It is never called a pool, in the app, the site, the docs or the contracts (section 10).

## 2. What it is

For a lending asset and a collateral asset that are both in the top liquidity tier:

| The user wants | What happens | Built from |
| --- | --- | --- |
| Lender: deposit once, earn the market rate | An Auto-lend slot with the instant-market setting; funds wait in the lender's own vault | #3635 B, plus section 3 |
| Borrower: any amount, now | One transaction fills from several lenders' slots; each fill is its own loan | Section 4 (#3325 extended) |
| Borrower: no end date | Short floating loans that renew in place until either side stops | Section 6 |
| Lender: leave when I choose | Another lender's idle slot takes the loan over at face value | Section 7 |
| Everyone: see supply and demand | Running totals per asset: declared, lent | Section 8 |

What does **not** change: no funds are held together; each loan has one lender and one borrower; a loss on a loan falls on that loan's lender (softened only by the shortfall reserve's rules); the rate is the reference plus a margin the two parties signed, and the protocol sets neither.

A master switch, off by default, governs the whole feature. It is limited to top-tier pairs by rule; widening it to the next tier is a separate owner decision.

## 3. The lender's setting

An Auto-lend slot gains one setting, `instantMarket`, which requires `acceptsFloating` and `acceptsProRata` and states three standing consents, each shown and signed when the slot is set:

1. **Fills from a borrower's direct request** (section 4), at the slot's own minimum margin.
2. **Renewal:** a loan it made may be extended in place, one base term at a time, at the loan's unchanged formula, never past the slot's lend-until time. Turning this off is the lender's notice to leave: its loans end at their current due dates.
3. **Takes over** another lender's instant-market loan at face value when that loan fits this slot's limits (section 7). This one may be switched off on its own.

The slot's existing limits (largest exposure, minimum margin, largest initial loan-to-value, longest term, smallest fill, cap and floor acceptance, lend-until) bound every one of these.

## 4. Instant borrow

A borrower-initiated entry, `borrowInstant`:

- **Inputs:** the pair, the amount wanted, the collateral offered, the base term, the highest margin accepted, an optional cap level, a list of lender slots chosen off-chain (lowest margin first), the least total that must be received, and the transaction deadline.
- **Each fill is its own loan**, opened through the one shared origination step, so every existing check runs for it: health factor, loan-to-value against that slot's limit, risk access, sanctions, self-trade, the level rules, the price guards. Principal moves from that lender's vault to the borrower's wallet, less the fee. Collateral is taken once, split across the loans in proportion to principal (rounding stated: the last loan takes the remainder), and stays in the borrower's own vault under each loan's own lien. Unused collateral is not taken.
- **Price:** the borrower is the taker, so each loan carries that slot's minimum margin, as a direct accept carries the offer's rate. A slot above the borrower's highest margin is skipped. (The midpoint rule stays for two standing parties paired by a third.)
- **A stale or unfit slot is skipped and reported**, never reverted on. The transaction reverts only if the total received is below the stated least.
- **Bounded:** at most 8 fills in one transaction (governance-bounded 2 to 16); each fill at least the slot's smallest fill.
- **The borrower's signed confirmation covers** the list, the highest margin, the cap level and the base term, under the acceptance-term binding.
- A fixed-rate variant (highest rate instead of margin, a fixed term, no renewal) uses the same entry; it is #3325 with slots as the source.

The loans opened by one call share a **group id**, stored on each loan and stated in one summary event (the loans, the amounts, the margins, the collateral locked per loan, the slots skipped and why).

## 5. One position for the borrower: the group

A group is a label, not a shared obligation. Each loan keeps its own collateral, its own health factor and its own liquidation; nothing cross-defaults.

Group helpers act on every open loan of a group in one transaction, each through the existing single-loan entry: repay (all, or an amount spread in proportion), add collateral (in proportion to principal outstanding), withdraw surplus collateral, set the borrower's renewal limits, fund the renewal reserve. A helper that cannot complete one loan reports it and completes the rest, except repay-all, which states exactly what remains.

The app shows a group as one position: total borrowed, the blended rate now, the lowest health factor among its loans, and one set of actions. The loans are listed beneath, each with its lender-side status.

## 6. No end date: renewal

An instant-market loan has a **base term** (30 days by default; 7 or 30 offered) and renews by the existing in-place extension:

- It needs both standing consents: the lender slot's renewal consent (section 3) and the borrower's renewal limits, which `borrowInstant` sets in the same transaction when the borrower chooses "no end date".
- At each renewal the interest earned in the ending term is settled as the extension already does, from the borrower's renewal reserve or vault balance, and the initiation fee's difference for the added time is charged (`FeeLevelsDesign.md`). The loan's formula (reference plus margin, cap and floor) does not change.
- **Either side stops it.** The borrower repays at any time, with interest to that moment. The lender turns renewal off, or asks for a takeover (section 7). A lender's lend-until time ends renewal by itself.
- **When a lender stops and nobody takes the loan over,** the loan ends at its current due date and the borrower must repay it or replace it, as with any loan; the keeper's advance alert says so, and a replacement from other slots is offered in the app. This is the one place the experience differs from an open-ended loan elsewhere, and the review states it: "a lender may end this loan at a renewal date; you then have until the due date and the grace period".
- A renewal the borrower's reserve cannot fund does not happen, and the loan keeps its due date.

## 7. A lender leaves: takeover at face value

A floating loan earns the market rate at every moment, so what is owed on it is what it is worth. That makes a transfer at face value fair to both lenders with no pricing step.

- **Who starts it:** the current holder of the lender position, or a keeper holding that holder's mandate for this action.
- **Which loans:** an active instant-market loan (floating, interest by time), not past due, not in a fallback, with no other sale route open.
- **Who takes it:** one lender slot with the takeover consent on, chosen off-chain, whose limits the loan fits **as if it were opened now**: the loan's margin at or above the slot's minimum, its cap and floor inside the slot's acceptance, its current loan-to-value at or below the slot's largest initial loan-to-value, its health factor at or above the minimum for a new loan, its due date inside the slot's longest term and lend-until, and room in the slot's exposure. A loan that would not be admitted as new cannot be handed over, so a lender cannot pass on a weakening loan.
- **What moves:** first, everything already held for the lender position (a partial repayment's principal, interest paid and not yet claimed, under `LenderPayoutsThroughClaimDesign.md`) is released to the outgoing holder's vault by the position claim, in the same transaction, so nothing the outgoing lender has earned travels with the position. A takeover that cannot complete that claim is refused. Then the incoming lender's vault pays the outstanding principal into the outgoing lender's vault, measured on arrival. The lender position moves to the incoming lender on the same loan record, through the existing lender-position migration. Interest the outgoing lender earned up to that moment follows the existing seller-claim rule: it is paid to them first out of the borrower's next interest payment.
- **The borrower** signs nothing, pays nothing, and none of their terms change. No initiation fee is charged: no loan is opened.
- The incoming lender is checked as a standing participant (risk access, sanctions) and may not be the borrower. The outgoing slot's exposure is released and the incoming slot's is taken.
- One event states the loan, both lenders, the principal paid, the interest left as a seller claim, and the slot.

Fixed-rate loans are not eligible: their worth moves with the market, and pricing them is the secondary-market question the owner has set aside.

## 8. The common ledger

Running totals per lending asset (and per pair for the instant market), written by the steps that already change them:

- **Declared:** the sum of the largest exposure of every active Auto-lend slot.
- **Lent:** open principal, in total and through the instant market.

They are exact and cost one counter update per change. What the ledger does **not** know is how much of the declared amount is in the lenders' vaults at this moment, since a vault balance changes without touching a slot. That figure, "available now", is computed by a paged view and by the indexer, and is always labelled as an estimate at the time of reading. The app's "how full" figure is lent divided by declared.

The totals set no rate. They also give the shortfall reserve the open-principal figure its activation checks read.

## 9. What cannot be gamed, and what is stated

- **Passing on a bad loan:** refused by the as-new test in section 7.
- **Trading with yourself:** the self-trade rule runs on every fill and every takeover, and it refuses the same address on both sides. It cannot see that two addresses belong to one person, here or anywhere else on the platform. Such a pair gains nothing from this feature: both sides pay the usual fees, the as-new test still applies to a takeover, and the shortfall reserve's own rules make a staged loss cost more than it returns.
- **Splitting into dust:** the smallest fill and the fill limit.
- **Favouring a lender:** the borrower chooses the list, as a direct accept chooses an offer; a slot is never made to take a margin below its minimum, and the app's list is lowest margin first, least recently filled first among equals.
- **A lender leaving just before a loss:** the incoming lender accepted the loan under their own limits at that moment; the loss rules follow the holder at close-out.
- **Stated to the lender:** leaving is immediate only while another slot can take the loan; otherwise it happens at the loan's due date.
- **Stated to the borrower:** several loans, one per lender; each can be ended by its lender at a renewal date; liquidation is per loan.

## 10. Wording rules

- Name: "instant market". Never pool, pooled, shared fund, deposit rate or yield.
- Always say that funds stay in the user's own vault and that each loan is with one lender.
- "Available now" and "how full" are labelled estimates with their time of reading.
- No promised return and no comparison to named third parties, as everywhere.

## 11. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Lender intent | `instantMarket` and the takeover consent; validation that they require floating and pro-rata. |
| New facet for the borrower's entry and groups | `borrowInstant`, the group id, the group helpers, previews for each. A new facet, not added to a facet near its size limit. |
| Shared origination step | Accepts a slot as the source for a borrower-initiated fill; stamps the group id. |
| In-place extension | The slot's renewal consent stands as the lender's limits for its instant-market loans, bounded by lend-until. |
| Takeover | A sale at face value into a slot, through the existing sale checks, the lender-position migration and the interest ledger. |
| Ledger | Counters and views (section 8). |
| Views | A slot list for a pair sorted for the app's list builder; a group's summary; whether a takeover would be accepted and why not. |
| Keeper | Renewal already exists; a takeover pass under mandate; group-aware alerts. New passes ship disarmed. |
| Permissionless-steps ledger, indexer, app | Rows for new open steps; group and ledger indexing; the instant-market page, the one-position view, wording per section 10. |

Append storage at the tail and run the storage-layout guard's `write`. Check facet sizes with the deploy-sanity suite.

## 12. Tests

1. `borrowInstant`: fills in list order at each slot's minimum margin; skips a stale, unfit or too-dear slot and reports it; reverts only under the stated least; the fill limit; collateral split and rounding; unused collateral not taken.
2. Every origination refusal applies per fill (health factor, loan-to-value, risk access, sanctions, self-trade, level rules).
3. Group helpers equal the same single-loan calls made one by one; a loan that cannot complete is reported and the rest complete.
4. Renewal: needs both consents; stops at lend-until; a lender turning it off leaves the due date unchanged; an unfunded renewal changes nothing; the fee difference is charged once per added period.
5. Takeover: the as-new test each way; an unclaimed partial repayment and unclaimed interest are paid to the outgoing holder before the position moves, and the incoming lender pays only the principal still outstanding; principal measured on arrival; the seller claim is paid first from the next interest; exposure released and taken; the borrower's terms are byte-for-byte unchanged; refused past due, in a fallback, with another sale route open, into the borrower's own slot, for a fixed-rate loan.
6. Ledger totals equal the sum over slots and loans after any sequence of set, fill, repay, takeover, cancel and close-out.
7. With the master switch off, every new entry refuses and existing loans keep their rules.
8. Liquidation of one loan in a group leaves the others untouched.

## 13. Alternatives considered

1. **Hold lenders' funds together.** Rejected: it ends the per-user vault, shares every loss, and is the regulated shape the platform avoids.
2. **One loan shared by several lenders.** Tidier for the borrower, but those lenders would share that loan's loss. Rejected as the same thing in small.
3. **A rate set by how full the market is.** Rejected: the protocol would be setting the rate. The reference comes from the #3337 quorum and the margin from the parties.
4. **Only keeper matching of posted requests.** Already exists; it is not instant.
5. **Leave exits to the general secondary market.** That needs pricing rules the owner has set aside. Face value for floating loans needs none.
6. **Shared collateral across a group.** Rejected: one lender's liquidation would reach another lender's security.

## 14. Recommendation and order of work

Build it as designed, top-tier pairs only, behind the master switch:

1. The ledger (small; the shortfall reserve needs it too).
2. Instant borrow and groups, fixed-rate first (works before floating loans exist).
3. After #3337 part 2 and #3635 part B: the instant-market setting, renewal and takeover.
4. The app's instant-market page.

## 15. Open items for the builder to raise, not decide silently

- The timing rule (#3443): a borrower-initiated fill takes standing slot terms, as a direct accept takes an offer; confirm no slot-side ageing rule is bypassed.
- Whether the outgoing lender's earned interest is better paid by the incoming lender at takeover than left as a seller claim.
- How a group helper reports partial completion without hiding a failed loan.
- Whether the renewal reserve should be one per group.
