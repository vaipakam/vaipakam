# Instant market — design

**Status:** owner approved the direction, 2026-11-15 ("yes, do it"; the name is "instant market"). Card #3656. Design first, no code yet. Builds on #3337 (floating loans), #3635 part B (Auto-lend that fills floating), #3325 (borrow across several lenders in one transaction), #3331 (a new lender replaces the current one) and the in-place extension. Reaches a chain by fresh deploy.
**Related:** `MarketLinkedRateLimitsDesign.md`, `FloatingRateCapFloorLevelsDesign.md`, `AutoLendLendUntilDesign.md`, `FeeLevelsDesign.md`, `ShortfallReserveDesign.md`.

## 1. Why

A borrower who wants an amount now, with no fixed end date, and a lender who wants to deposit once, earn the going rate and leave when they choose, are served today only by lenders that hold everyone's funds together. This platform keeps every user's funds in their own vault and every loan between one lender and one borrower, and that stays. The instant market gives those two users the same experience **without holding funds together**: it is a way of using Auto-lend, standing offers, floating and fixed loans and the position rules as one product, plus four additions.

It is never called a pool, in the app, the site, the docs or the contracts (section 10).

## 2. What it is

For a lending asset and a collateral asset that are both in the top liquidity tier:

| The user wants | What happens | Built from |
| --- | --- | --- |
| Lender: deposit once, earn the market rate | An Auto-lend slot with the instant-market setting; funds wait in the lender's own vault | #3635 B, plus section 3 |
| Borrower: any amount, now, floating or fixed | One transaction fills from several lenders' slots and standing offers; each fill is its own loan | Section 4 (#3325 extended) |
| Borrower: no end date | Short loans that renew in place until either side stops | Section 6 |
| Lender: leave when I choose | Another lender's idle slot takes the loan over at face value | Section 7 |
| Everyone: see supply and demand | Running totals per asset: declared, lent | Section 8 |

What does **not** change: no funds are held together; each loan has one lender and one borrower; a loss on a loan falls on that loan's lender (softened only by the shortfall reserve's rules); the rate is the reference plus a margin the two parties signed, and the protocol sets neither.

A master switch, off by default, governs the whole feature. It is limited to top-tier pairs by rule; widening it to the next tier is a separate owner decision.

## 3. The lender's setting

An Auto-lend slot gains one setting, `instantMarket`, which requires `acceptsProRata` (interest by time) and states three standing consents, each shown and signed when the slot is set:

1. **Fills from a borrower's direct request** (section 4), at the slot's own minimum: its minimum margin for a floating loan, its minimum rate for a fixed one.
2. **Renewal:** a loan it made may be extended in place, one base term at a time, at the loan's unchanged formula, never past the slot's lend-until time. Turning this off is the lender's notice to leave: its loans stop renewing and fall due on their current due dates.
3. **Takes over** another lender's instant-market loan at face value when that loan fits this slot's limits (section 7). This one may be switched off on its own.

Which kinds of loan the slot makes stays its own existing choice (#3621): floating needs `acceptsFloating`, fixed needs a minimum fixed rate, and a slot may accept either. The same holds for the lifecycle settings it accepts, such as partial repayment. The instant-market setting adds no new kind of loan.

The slot's existing limits (largest exposure, minimum margin, largest initial loan-to-value, longest term, smallest fill, cap and floor acceptance, lend-until) bound every one of these.

## 4. Instant borrow

A borrower-initiated entry, `borrowInstant`:

- **Inputs:** the pair, the amount wanted, the collateral offered, the kind of loan (floating or fixed), the base term, the highest margin accepted (floating) or the highest rate accepted (fixed), an optional cap level (floating), the lifecycle settings wanted (such as partial repayment), a list of sources chosen off-chain, cheapest first, the least total that must be received, and the transaction deadline.
- **Each fill is its own loan**, opened through the one shared origination step, so every existing check runs for it: health factor, loan-to-value against that slot's limit, risk access, sanctions, self-trade, the level rules, the price guards. Principal moves from that lender's vault to the borrower's own vault as free balance, less the fee, as every new loan's principal does (`VaultOutflowPolicyDesign.md`); taking it to a wallet is the separate withdrawal, under the account's own policy and any delay it carries. The review says where the funds arrive. Collateral is taken once, split across the loans in proportion to principal (rounding stated: the last loan takes the remainder), and stays in the borrower's own vault under each loan's own lien. Unused collateral is not taken.
- **Sources:** an Auto-lend slot with the instant-market setting, or a standing lender offer the borrower could accept directly. Every loan opened here carries interest by time (pro-rata): an offer whose interest is owed for the full term is not a source, so the promise in section 6 that a borrower repays with interest to that moment holds for every loan. A source is used only if it makes the kind of loan asked for and accepts the lifecycle settings asked for; otherwise it is skipped and reported. One call opens loans of one kind. A loan filled from an offer carries no slot consents: it renews only under renewal limits its lender sets on the loan as any lender may, and its lender may still ask for a takeover into a slot.
- **Price:** the borrower is the taker, so each loan carries that source's own price: a slot's minimum margin or minimum rate, an offer's rate, as a direct accept does today. A source above the borrower's highest margin or rate is skipped. (The midpoint rule stays for two standing parties paired by a third.)
- **A stale or unfit slot is skipped and reported**, never reverted on. The transaction reverts only if the total received is below the stated least.
- **Bounded:** at most 8 fills in one transaction (governance-bounded 2 to 16); each fill at least the slot's smallest fill.
- **The borrower's signed confirmation covers** the list, the kind, the highest margin or rate, the cap level, the lifecycle settings and the base term, under the acceptance-term binding.
- The fixed-rate form is #3325 with slots added as a source. It needs no reference rate, so it can ship before floating loans exist.

Settled with the builder on 2026-11-15:

- **One rule for a fill.** The checks a matcher's fill of a slot runs are in one library, and the borrower's direct fill runs the same ones. Each fill opens a borrower slice for that part and passes through the shared match step. The slice opens and closes in the same transaction, emits the events any offer does, and never counts toward the open-offer cap; the indexer never lists it as an open offer.
- **No matcher, no service charge.** The call names no matcher, so the borrower is never paid a share of their own fee. The fee is split as for a direct accept: the treasury floor, then the integrator share if the borrower names a registered integrator (`IntegratorFeeShareDesign.md`), then the rest as the fee design says. The matcher capacity a third party's fill is charged against is not charged here; the fill limit bounds the work.
- **Where the collateral comes from.** Free balance in the borrower's vault first, then one deposit from the wallet for the rest. The preview and the summary event state how much came from each.
- **A standing offer as a source** is filled on the match path at the offer's own rate. It is filled in part only where the offer itself allows partial fills; otherwise whole, or skipped and reported. Every condition of the offer still holds: its allowed taker, its expiry, its maker's price-move guard, the timing rule, and its collateral requirement, in proportion, as a floor.

The loans opened by one call share a **group id**, stored on each loan and stated in one summary event (the loans, the amounts, the margins, the collateral locked per loan, the slots skipped and why).

## 5. One position for the borrower: the group

A group is a label, not a shared obligation. Each loan keeps its own collateral, its own health factor and its own liquidation; nothing cross-defaults.

Group helpers act on every open loan of a group in one transaction, each through the existing single-loan entry: repay (all, or an amount spread in proportion), add collateral (in proportion to principal outstanding), withdraw surplus collateral, set the borrower's renewal limits, fund the renewal reserve. A helper that cannot complete one loan reports it and completes the rest, except repay-all, which states exactly what remains.

The app shows a group as one position: total borrowed, the blended rate now, the lowest health factor among its loans, and one set of actions. The loans are listed beneath, each with its lender-side status.

## 6. No end date: renewal

An instant-market loan has a **base term** (30 days by default; 7 or 30 offered) and renews by the existing in-place extension, floating or fixed:

- It needs both standing consents: the lender slot's renewal consent (section 3) and the borrower's renewal limits, which `borrowInstant` sets in the same transaction when the borrower chooses "no end date".
- At each renewal the interest earned in the ending term is settled as the extension already does, from the borrower's renewal reserve or vault balance, and the initiation fee's difference for the added time is charged (`FeeLevelsDesign.md`). The loan's price does not change: a floating loan keeps its formula (reference plus margin, cap and floor) and so follows the market; a fixed loan keeps its rate, and each side's standing limits decide whether that rate is still acceptable for another term (the lender's minimum rate, the borrower's highest rate). A renewal either side's limits refuse does not happen.
- **Either side stops it.** The borrower repays at any time, with interest to that moment. The lender turns renewal off, or asks for a takeover (section 7). A lender's lend-until time ends renewal by itself.
- **When a lender stops and nobody takes the loan over,** the loan ends at its current due date and the borrower must repay it or replace it, as with any loan; the keeper's advance alert says so, and a replacement from other slots is offered in the app. This is the one place the experience differs from an open-ended loan elsewhere, and the review states it: "a lender may end this loan at a renewal date; you then have until the due date and the grace period".
- A renewal the borrower's reserve cannot fund does not happen, and the loan keeps its due date.

Settled with the builder on 2026-11-15:

- **Renewal has its own entry** for instant-market loans made from a slot, open to anyone since both consents stand: the same rate, one base term. The slot's consent is read at that moment (a paused, cancelled or re-owned slot gives none), and for a fixed loan both sides' rate limits are read at that moment too. It shares the in-place extension's interest booking; there is no second copy. Interest comes from the borrower's one per-loan reserve (`StandingInstructionsDesign.md`), and renewal is the loan's single plan for maturity there. A loan made from a standing offer is refused by this entry and renews only through the existing extension under limits its lender sets. The entry has its row in the permissionless-steps ledger and a keeper pass that ships disarmed.
- **The fee for the added time** goes through one seam that charges nothing until the fee levels are built (`FeeLevelsDesign.md`); the event says so.
- **Renewal is built after the per-loan reserve.** Until then the slot's renewal consent is stored and nothing acts on it, `borrowInstant` does not take the "no end date" choice, and the app says that every loan ends at its due date.

## 7. A lender leaves: takeover at face value

A takeover moves a loan from one lender to another for exactly the principal outstanding, with no pricing step. Two things make that fair. The outgoing lender chooses it, and a lender who wants more than face value for a loan uses the ordinary sale routes. The incoming lender takes only a loan their slot would open today on the same terms (the as-new test below). For a floating loan the two views meet by themselves, since the loan earns the market rate at every moment. For a fixed loan the as-new test carries the weight: the loan's rate must be at or above the incoming slot's minimum rate.

- **Who starts it:** the current holder of the lender position, or a keeper holding that holder's mandate for this action.
- **Which loans:** an active loan opened through the instant market, floating or fixed, with interest by time, not past due, not in a fallback, with no other sale route open.
- **Who takes it:** one lender slot with the takeover consent on, chosen off-chain, whose limits the loan fits **as if it were opened now**: the slot makes that kind of loan; the loan's margin (floating) or rate (fixed) at or above the slot's minimum; its cap and floor inside the slot's acceptance; its lifecycle settings among those the slot accepts; its current loan-to-value at or below the slot's largest initial loan-to-value, its health factor at or above the minimum for a new loan, its due date inside the slot's longest term and lend-until, and room in the slot's exposure. A loan that would not be admitted as new cannot be handed over, so a lender cannot pass on a weakening loan.
- **Nothing may be held for the position.** A takeover is refused while any amount is held for the lender position (a partial repayment's principal, interest paid and not yet claimed, under `LenderPayoutsThroughClaimDesign.md`) and while the position is inside the transfer cooldown that a claim starts. The outgoing holder claims first, the cooldown passes, and then the takeover may run; the preview names either reason. So nothing the outgoing lender has earned travels with the position, and the rule that a position cannot be sold in the same moment value leaves it is kept whole.
- **What moves:** the incoming lender's vault pays the outstanding principal into the outgoing lender's vault, measured on arrival. The lender position moves to the incoming lender on the same loan record, through the existing lender-position migration. Interest the outgoing lender earned up to that moment follows the existing seller-claim rule: it is paid to them first out of the borrower's next interest payment.
- **The borrower** signs nothing, pays nothing, and none of their terms change. No initiation fee is charged: no loan is opened.
- The incoming lender is checked as a standing participant (risk access, sanctions) and may not be the borrower. The outgoing slot's exposure is released and the incoming slot's is taken.
- One event states the loan, both lenders, the principal paid, the interest left as a seller claim, and the slot.
- Settled with the builder on 2026-11-15: a keeper acts under the holder's existing mandate for a direct sale, checked through the one sale-exit rule; the incoming principal comes from the slot's reserved capital, as a fill's does; and the loan's record of which slot it came from is rewritten for the incoming slot, so the lend-until limit follows the new lender. Interest earned stays a seller claim.

A loan whose interest is owed for the full term whatever the repayment date is not eligible: what is owed on it is not what has been earned, so face value is not its worth. Selling any loan at a price other than face value is the secondary-market question the owner has set aside, and nothing here opens it.

The review of a fixed-rate takeover tells the outgoing lender that the loan is handed over at face value and that a sale at a price is a separate route, and the incoming slot's owner was told when setting the slot that its minimum rate is the rate it may be given a loan at.

## 8. The common ledger

Running totals per lending asset (and per pair for the instant market), written by the steps that already change them:

- **Declared:** the sum of the largest exposure of every Auto-lend slot that is active and whose fill window is still open. Declared is the limit lenders have set, not depth: depth is the **available** total of `TermAverageAndLinkGuardsDesign.md` section 7 (#3714), counted exactly from the capital each owner has reserved for the intent, and "how full" is principal lent out of slots divided by that principal plus available. A slot with an end date leaves the total when its window closes without anyone acting: its exposure is also recorded against the UTC day its window closes, every write first removes the days that have fully passed, and the view applies the same subtraction. The figure is therefore stated "as of the start of today (UTC)": a slot whose window closes today still counts until the day ends.
- **Lent:** three figures, per asset and per pair. All open principal from every route, which the shortfall reserve's activation check reads. Open principal lent out of Auto-lend slots. Open principal opened through the instant market. Whether a loan was opened through the instant market is fixed when it opens. Whether it counts as lent out of a slot follows the slot it is held from now: it leaves the figure when that slot's exposure is released, and a loan taken over into a slot joins it. Otherwise "how full" would understate the exposure in use.

They are exact and cost one counter update per change. Amended 2026-11-17 (#3714): a slot lends only from capital its owner has reserved under the intent's own lien, which changes only through the intent's steps, so what slots can lend now is also an exact ledger figure, **available**. Standing offers that serve as sources are not in it; the app adds those from the indexer and labels that part an estimate at the time of reading. The app's "how full" figure is the principal lent out of Auto-lend slots divided by that principal plus available; all-route principal is never divided by it.

The totals set no rate. They also give the shortfall reserve the open-principal figure its activation checks read.

## 9. What cannot be gamed, and what is stated

- **Passing on a bad loan:** refused by the as-new test in section 7.
- **Trading with yourself:** the self-trade rule runs on every fill and every takeover, and it refuses the same address on both sides. It cannot see that two addresses belong to one person, here or anywhere else on the platform. Such a pair gains nothing from this feature: both sides pay the usual fees, the as-new test still applies to a takeover, and the shortfall reserve's own rules make a staged loss cost more than it returns.
- **Splitting into dust:** the smallest fill and the fill limit.
- **Favouring a lender:** the borrower chooses the list, as a direct accept chooses an offer; a slot is never made to take a margin below its minimum, and the app's list is lowest margin first, least recently filled first among equals.
- **A lender leaving just before a loss:** the incoming lender accepted the loan under their own limits at that moment; the loss rules follow the holder at close-out.
- **Stated to the lender:** leaving is immediate only while another slot can take the loan. Otherwise turning renewal off stops the loan renewing past its due date, and that is all it does: when the funds return still depends on the borrower repaying, the grace period, and a close-out if the loan defaults, under the ordinary loan rules. The due date is never shown as the date funds come back.
- **Stated to the borrower:** several loans, one per lender; each can be ended by its lender at a renewal date; liquidation is per loan.

## 10. Wording rules

- Name: "instant market". Never pool, pooled, shared fund, deposit rate or yield.
- Always say that funds stay in the user's own vault and that each loan is with one lender.
- "Available" and "how full" for slots are exact ledger figures; the part of depth that comes from standing offers is a labelled estimate with its time of reading. Declared is always called the limit lenders have set.
- No promised return and no comparison to named third parties, as everywhere.

## 11. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Lender intent | `instantMarket` and the takeover consent; validation that they require pro-rata; the kind of loan stays the slot's existing choice. |
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

1. `borrowInstant`: fills in list order at each source's own price (slot minimum margin, slot minimum rate, offer rate), floating and fixed; a source of the other kind, an offer with full-term interest, or one that refuses the lifecycle settings asked for is skipped and reported; skips a stale, unfit or too-dear slot and reports it; reverts only under the stated least; the fill limit; collateral split and rounding; unused collateral not taken.
2. Every origination refusal applies per fill (health factor, loan-to-value, risk access, sanctions, self-trade, level rules).
3. Group helpers equal the same single-loan calls made one by one; a loan that cannot complete is reported and the rest complete.
4. Renewal: needs both consents; a fixed loan renews at its unchanged rate only while both sides' rate limits allow; stops at lend-until; a lender turning it off leaves the due date unchanged; an unfunded renewal changes nothing; the fee difference is charged once per added period.
5. Takeover: the as-new test each way; refused while anything is held for the position and inside the claim's transfer cooldown, accepted after the holder has claimed and the cooldown has passed, and the incoming lender pays only the principal still outstanding; principal measured on arrival; the seller claim is paid first from the next interest; exposure released and taken; the borrower's terms are byte-for-byte unchanged; refused past due, in a fallback, with another sale route open, into the borrower's own slot, for a loan with full-term interest, and for a fixed loan whose rate is below the incoming slot's minimum rate or whose lifecycle settings the slot does not accept; a fixed loan that passes moves with its rate and settings unchanged.
6. Ledger totals equal the sum over slots and loans after any sequence of set, fill, repay, takeover, cancel and close-out.
7. With the master switch off, every new entry refuses and existing loans keep their rules.
8. Liquidation of one loan in a group leaves the others untouched.

## 13. Alternatives considered

1. **Hold lenders' funds together.** Rejected: it ends the per-user vault, shares every loss, and is the regulated shape the platform avoids.
2. **One loan shared by several lenders.** Tidier for the borrower, but those lenders would share that loan's loss. Rejected as the same thing in small.
3. **A rate set by how full the market is.** Rejected: the protocol would be setting the rate. The reference comes from the #3337 quorum and the margin from the parties.
4. **Only keeper matching of posted requests.** Already exists; it is not instant.
5. **Leave exits to the general secondary market.** That needs pricing rules the owner has set aside. A handover at face value, chosen by the outgoing lender and admitted only as a new loan would be, needs none.
6. **Shared collateral across a group.** Rejected: one lender's liquidation would reach another lender's security.

## 14. Recommendation and order of work

Build it as designed, top-tier pairs only, behind the master switch:

1. The ledger (small; the shortfall reserve needs it too).
2. Instant borrow and groups, fixed-rate first (works before floating loans exist), with the instant-market setting, renewal and takeover for fixed loans.
3. After #3337 part 2 and #3635 part B: the same for floating loans.
4. The app's instant-market page.

## 15. Open items for the builder to raise, not decide silently

Settled on 2026-11-15: earned interest stays a seller claim at takeover; renewal uses the one per-loan reserve, not one per group.

- The timing rule (#3443): a borrower-initiated fill takes standing slot terms, as a direct accept takes an offer; confirm no slot-side ageing rule is bypassed.
- How a group helper reports partial completion without hiding a failed loan.
