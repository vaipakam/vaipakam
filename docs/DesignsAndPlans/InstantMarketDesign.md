# Instant market — design

**Status:** owner approved the direction, 2026-11-15 ("yes, do it"; the name is "instant market"). Card #3656. Design first, no code yet. Builds on #3337 (floating loans), #3635 part B (Auto-lend that fills floating), #3325 (borrow across several lenders in one transaction), #3331 (a new lender replaces the current one) and the in-place extension. Reaches a chain by fresh deploy.
**Related:** `MarketLinkedRateLimitsDesign.md`, `FloatingRateCapFloorLevelsDesign.md`, `AutoLendLendUntilDesign.md`, `FeeLevelsDesign.md`, `ShortfallReserveDesign.md`, `TermAverageAndLinkGuardsDesign.md`, `PositionSaleStateGuardDesign.md`, `ReferralFeeShareDesign.md`.
**Reviewed 2026-11-17** against the decisions made since: the available total (#3714), the acknowledgement for a fixed rate far from the term average (#3713), the per-token transfer wait (#3710), the referral amounts in the fee split (#3722) and readable signing (#3718). Sections 2, 4, 7, 8 and 12 were brought in line.

## 1. Why

A borrower who wants an amount now, with no fixed end date, and a lender who wants to deposit once, lend at the going rate and leave when they choose, are served today only by lenders that hold everyone's funds together. This platform keeps every user's funds in their own vault and every loan between one lender and one borrower, and that stays. The instant market gives those two users the same experience **without holding funds together**: it is a way of using Auto-lend, standing offers, floating and fixed loans and the position rules as one product, plus four additions.

It is never called a pool, in the app, the site, the docs or the contracts (section 10).

## 2. What it is

For a lending asset and a collateral asset that are both in the top liquidity tier:

| The user wants | What happens | Built from |
| --- | --- | --- |
| Lender: deposit once, lend at the market rate | An Auto-lend slot with the instant-market setting; funds wait in the lender's own vault | #3635 B, plus section 3 |
| Borrower: any amount, now, floating or fixed | One transaction fills from several lenders' slots and standing offers; each fill is its own loan | Section 4 (#3325 extended) |
| Borrower: no end date | Short loans that renew in place until either side stops | Section 6 |
| Lender: leave when I choose | Another lender's idle slot takes the loan over at face value | Section 7 |
| Everyone: see supply and demand | Running totals per asset: declared, available, lent | Section 8 |

What does **not** change: no funds are held together; each loan has one lender and one borrower; a loss on a loan falls on that loan's lender (softened only by the shortfall reserve's rules); the rate is the reference plus a margin the two parties signed, and the protocol sets neither.

A master switch, off by default, governs the whole feature. It is limited to top-tier pairs by rule; widening it to the next tier is a separate owner decision.

Amended 2026-11-19 (#3761, `DefaultPathsDesign.md`): the coded default stays off, and the launch configuration switches the feature on for top-tier pairs from the first deploy, so it is available from the first loan. The Lend form pre-selects the slot consents of section 3 on its review screen, and the Borrow form opens on the instant borrow. A consent is still stored only as its owner set it.

## 3. The lender's setting

An Auto-lend slot gains one setting, `instantMarket`, which requires `acceptsProRata` (interest by time) and states three standing consents, each shown and signed when the slot is set:

1. **Fills from a borrower's direct request** (section 4), at the slot's own minimum: its minimum margin for a floating loan, its minimum rate for a fixed one.
2. **Renewal:** a loan it made may be extended in place, one base term at a time, at the loan's unchanged formula, never past the slot's lend-until time. Turning this off is the lender's notice to leave: its loans stop renewing and fall due on their current due dates.
3. **Takes over** another lender's instant-market loan at face value when that loan fits this slot's limits (section 7). This one may be switched off on its own.

Amended 2026-11-19 (#3811 to #3813, `LendingBalanceDesign.md`): a slot holds no money. Every slot a lender has on one lending asset lends from that lender's one lending balance, and the first borrower to arrive is served. A slot that makes fixed-rate loans may add a fourth consent, make room: inside its own fill it hands over the lender's floating loans at face value, as far as the fill needs. A floating loan opened here carries a 3-day notice period. Turning renewal off still stops every loan of the slot at its due date; notice brings one floating loan's due date forward.

Which kinds of loan the slot makes stays its own existing choice (#3621): floating needs `acceptsFloating`, fixed needs a minimum fixed rate, and a slot may accept either. The same holds for the lifecycle settings it accepts, such as partial repayment. The instant-market setting adds no new kind of loan.

The slot's existing limits (largest exposure, minimum margin, largest initial loan-to-value, longest term, smallest fill, cap and floor acceptance, lend-until) bound every one of these.

## 4. Instant borrow

A borrower-initiated entry, `borrowInstant`:

- **Inputs:** the pair, the amount wanted, the collateral offered, the kind of loan (floating or fixed), the base term, the highest margin accepted (floating) or the highest rate accepted (fixed), an optional cap level (floating), the lifecycle settings wanted (such as partial repayment), a list of sources chosen off-chain, cheapest first, the least total that must be received, and the transaction deadline.
- **Each fill is its own loan**, opened through the one shared origination step, so every existing check runs for it: health factor, loan-to-value against that slot's limit, risk access, sanctions, self-trade, the level rules, the price guards. Principal moves from that lender's vault to the borrower's own vault as free balance, less the fee, as every new loan's principal does (`VaultOutflowPolicyDesign.md`); taking it to a wallet is the separate withdrawal, under the account's own policy and any delay it carries. The review says where the funds arrive. Collateral is taken once, split across the loans in proportion to principal (rounding stated: the last loan takes the remainder), and stays in the borrower's own vault under each loan's own lien. Unused collateral is not taken.
- **Sources:** an Auto-lend slot with the instant-market setting, or a standing lender offer the borrower could accept directly. Every loan opened here carries interest by time (pro-rata): an offer whose interest is owed for the full term is not a source, so the promise in section 6 that a borrower repays with interest to that moment holds for every loan. A source is used only if it makes the kind of loan asked for and accepts the lifecycle settings asked for; otherwise it is skipped and reported. One call opens loans of one kind. A loan filled from an offer carries no slot consents: it renews only under renewal limits its lender sets on the loan as any lender may, and its lender may still ask for a takeover into a slot.
- **Price:** the borrower is the taker, so each loan carries that source's own price: a slot's minimum margin or minimum rate, an offer's rate, as a direct accept does today. A source above the borrower's highest margin or rate is skipped. (The midpoint rule stays for two standing parties paired by a third.)
- **A stale or unfit slot is skipped and reported**, never reverted on. The transaction reverts only if the total received is below the stated least.
- **Bounded:** the most fills in one transaction is set per network, from measured cost. The whole call must fit inside 80% of that network's limit on one transaction's gas, counted before refunds, and governance cannot set the bound above that. As measured on 2026-11-20 (about 5.4 million gas for one fill and about 4.8 million for each further fill), that is 2 fills where the limit is 16,777,216 gas (Ethereum, Base, OP Mainnet) and 4 or 5 where it is 32,000,000 (Arbitrum One, Polygon PoS). The builder's gas test, run on the CI toolchain, cold and as the taker's first borrow, fixes which of the two, and holds the bound to the measurement from then on. A larger borrow takes more than one transaction, each sized by the app from the same figures, or goes to the rate auction. This replaces "at most 8 fills, governed 2 to 16" (amended 2026-11-20). Each fill is at least the slot's smallest fill.
- **The borrower's own call states** the list, the kind, the highest margin or rate, the cap level, the lifecycle settings and the base term, and two acknowledgements where they apply: the risk and terms consent, and, for a fixed rate outside the warning band, `rateFarFromAverageAcknowledged` (`TermAverageAndLinkGuardsDesign.md` 6.4). As built it is a direct call by the borrower, with nothing signed for another party to submit. Wallet display descriptions make the call readable in the wallet first; moving it to the typed, signed-terms shape an accept has belongs to the pre-audit refactor (#3718).
- The fixed-rate form is #3325 with slots added as a source. It needs no reference rate, so it can ship before floating loans exist.

Settled with the builder on 2026-11-15:

- **One rule for a fill.** The checks a matcher's fill of a slot runs are in one library, and the borrower's direct fill runs the same ones. Each fill opens a borrower slice for that part and passes through the shared match step. The slice opens and closes in the same transaction, emits the events any offer does, and never counts toward the open-offer cap; the indexer never lists it as an open offer.
- **No matcher, no service charge.** The call names no matcher, so the borrower is never paid a share of their own fee. The fee is split as for a direct accept: the treasury floor, then the integrator share if the borrower names a registered integrator (`IntegratorFeeShareDesign.md`), then, where the borrower is bound to an inviter, the inviter's share, with the new user's cut never collected (`ReferralFeeShareDesign.md`), then the rest as the fee design says. The one per-loan ceiling of that design bounds these together. The matcher capacity a third party's fill is charged against is not charged here; the fill limit bounds the work.
- **Where the collateral comes from.** Free balance in the borrower's vault first, then one deposit from the wallet for the rest. The preview and the summary event state how much came from each.
- **A standing offer as a source** is filled on the match path at the offer's own rate. It is filled in part only where the offer itself allows partial fills; otherwise whole, or skipped and reported. Every condition of the offer still holds: its allowed taker, its expiry, its maker's price-move guard, the timing rule, and its collateral requirement, in proportion, as a floor.

Settled with the builder on 2026-11-20:

- **Why a fill costs what it does, and what changes.** As first built, "one rule for a fill" writes two complete offers that are used up in the same call, the lender's slice and the borrower's, each with its record, its position token, its lien and its book entry, and then writes the loan with two new position tokens. The slices' tokens are retired in that same call. Every fill that opens and closes an offer in one call pays this: a signed offer's fill, a keeper's fill of a slot, an instant fill and a collection fill. Card #3851, first in the gas and refactor window, changes the creation rule and the match step to take the agreed terms as a value. An offer on the book is loaded into that same value, so there is still one rule and never a second, shorter creation path. A same-call fill then writes only the loan, its two tokens and its lien, with every origination check unchanged, and the loan's creation event names its source, because such a loan has no offer ids. Measured on 2026-11-20, one fill of a slot costs 5.41 million gas. The two slices are 2.01 million of it (the lender's 1.12 million, the borrower's 0.89 million), retiring them 0.14 million and releasing their liens 0.04 million. Creating the loan is 1.67 million, of which the loan record is 0.57 million and its two position tokens 0.53 million. The remaining 1.3 million or so is the slot's record and the ledger, the fee, the risk and price reads, and the calls between facets. The builder puts what #3851 removes at about 2.0 million a fill. That leaves about 3.4 million for the first fill and about 2.8 million for each further one, which is about 4 fills where the limit is 16,777,216 gas and about 8 where it is 32,000,000. These are estimates until the change is measured, and the per-network bound is set again from that measurement.

The loans opened by one call belong to one **borrowing** (section 5), named in one summary event (the loans, the amounts, the margins, the collateral locked per loan, the slots skipped and why). The call opens the borrowing, or adds to one the borrower names.

## 5. One borrowing for the borrower

Amended 2026-11-19 (#3808, `BorrowingDesign.md`): the group label is replaced by a **borrowing**, a record over the borrower's loans on the pair. That design is the source for everything below.

A borrowing is a record, not a shared obligation. Each loan keeps its own collateral, its own health factor and its own liquidation; nothing cross-defaults.

- The borrowing holds the borrower's **one payment reserve and one collateral reserve**, and **one set of settings** (the renewal limits, the plan for the due date, the standing instructions) for all of its loans.
- **Actions on a borrowing** act on the loans the holder names in one transaction, each through the single-loan step: repay (all, or an amount spread in proportion or in the order given), add collateral, withdraw surplus collateral. An action that cannot complete one loan reports it and completes the rest, except repay-all, which states exactly what remains.
- A later instant borrow may **add to the borrowing**.

The app shows a borrowing as one line: total borrowed, the blended rate now, the lowest health factor among its loans, and one set of actions. The loans are listed beneath, each with its lender-side status.

## 6. No end date: renewal

An instant-market loan has a **base term** (30 days by default; 7 or 30 offered) and renews by the existing in-place extension, floating or fixed:

- It needs both standing consents: the lender slot's renewal consent (section 3) and the borrower's renewal limits, which are the borrowing's (section 5) and which `borrowInstant` sets in the same transaction when the borrower chooses "no end date".
- At each renewal the interest earned in the ending term is settled as the extension already does, from the borrowing's payment reserve or the borrower's vault balance, and the initiation fee's difference for the added time is charged (`FeeLevelsDesign.md`). The loan's price does not change: a floating loan keeps its formula (reference plus margin, cap and floor) and so follows the market; a fixed loan keeps its rate, and each side's standing limits decide whether that rate is still acceptable for another term (the lender's minimum rate, the borrower's highest rate). A renewal either side's limits refuse does not happen.
- **Either side stops it.** The borrower repays at any time, with interest to that moment. The lender turns renewal off, or asks for a takeover (section 7). A lender's lend-until time ends renewal by itself.
- **When a lender stops and nobody takes the loan over,** the loan ends at its current due date and the borrower must repay it or replace it, as with any loan; the keeper's advance alert says so, and a replacement from other slots is offered in the app. This is the one place the experience differs from an open-ended loan elsewhere, and the review states it: "a lender may end this loan at a renewal date; you then have until the due date and the grace period". Amended 2026-11-19 (#3763): where the borrower chose it and another lender stands ready, the loan continues with that lender instead (6.1), and this rule is what remains when none does. Amended 2026-11-19 (#3813): on a floating loan the lender may also give 3 days' notice, which brings the due date forward and leaves the grace period as it is (`LendingBalanceDesign.md` section 6). The base term stays 7 or 30 days; a 1-day term was considered and is not offered (section 7 there).
- A renewal the borrower's reserve cannot fund does not happen, and the loan keeps its due date.

Settled with the builder on 2026-11-15:

- **Renewal has its own entry** for instant-market loans made from a slot, open to anyone since both consents stand: the same rate, one base term. The slot's consent is read at that moment (a paused, cancelled or re-owned slot gives none), and for a fixed loan both sides' rate limits are read at that moment too. It shares the in-place extension's interest booking; there is no second copy. Interest comes from the borrowing's payment reserve (`BorrowingDesign.md` section 5; one per loan as first settled, one per borrowing by the owner's decision of 2026-11-19), and renewal is the first step of the plan for the due date (`DueDatePlanDesign.md`). A loan made from a standing offer is refused by this entry and renews only through the existing extension under limits its lender sets. The entry has its row in the permissionless-steps ledger and a keeper pass. The pass was first to ship disarmed; by the owner's decision of 2026-11-19 it is armed at launch (6.1).
- **The fee for the added time** goes through one seam that charges nothing until the fee levels are built (`FeeLevelsDesign.md`); the event says so.
- **Renewal is built after the reserve.** Until then the slot's renewal consent is stored and nothing acts on it, `borrowInstant` does not take the "no end date" choice, and the app says that every loan ends at its due date.

### 6.1 The lender gives no renewal: the loan continues with another lender

Added 2026-11-19 (#3763). Built with renewal. `DueDatePlanDesign.md` (#3785) opens this step to every ERC-20 loan with interest by time on an instant-market pair, whichever way the loan was opened, and places it as the second step of the borrower's plan for the due date.

Section 6 ends a borrower's loan when its lender gives no renewal and no other lender has taken the loan over. This closes that case wherever another lender stands ready at a rate the borrower has already accepted. The lender's exit is unchanged: it is paid in full at the moment it would otherwise have waited for.

- **The borrower chooses it.** The borrower's renewal limits carry one more setting, "continue with another lender". `borrowInstant` sets it with the limits when the borrower chooses "no end date", and the borrower may change it at any time. It is the borrowing's setting and covers every loan of the borrowing. For a fixed loan the highest rate in those limits is the most the loan's rate may ever be. For a floating loan the limit is the highest margin, which bounds the margin only: the whole rate is the reference inside the loan's floor and cap, plus the margin, and where the loan carries no cap it has no upper limit.
- **When.** Inside the loan's renewal window, and only when the renewal of section 6 is refused for a reason on the lender's side: the slot's renewal consent is off; the slot is paused, cancelled, or no longer owned by the holder of the lender position; its lend-until time would be passed; or its minimum rate is above the loan's rate. The entry checks this itself in the same call, so the loan's own lender at the unchanged rate always has first place. A renewal refused for a reason on the borrower's side (the reserve is short, the borrower's limits refuse) is not a case for this step.
- **Who takes it.** One slot with the takeover consent on, chosen off-chain, that passes the as-new test of section 7 at the new rate. The loan's own lender's slot is a candidate like any other: where its minimum rate is above the loan's rate and inside the borrower's limit, the loan stays with it at that rate and no principal moves.
- **The rate.** The incoming slot's minimum rate, or minimum margin for a floating loan, as an instant borrow from that slot would carry, and never above the borrower's limit. The cap, the floor and the lifecycle settings do not change.
- **A rising ceiling** (amended 2026-11-19, `BorrowingDesign.md` section 10). Inside the window the rate may not exceed a ceiling that starts at the loan's own rate when the window opens, rises in a straight line, and reaches the borrower's limit one day before the due date. A lender at a lower rate can therefore be taken earlier than a dearer one. The contract enforces the ceiling only: among the lenders under it the caller still chooses, and choosing the cheapest is the keeper's policy.
- **What the outgoing lender receives.** What a repayment at that moment pays: the principal outstanding, from the incoming slot's reserved capital, measured on arrival, and the interest earned to that moment, from the borrower's reserve. Both go through the lender side's one order of payment (`LenderCashOutDesign.md` 6.4), so an open seller claim or an advance on the loan is paid in its place and nothing is left behind as a claim. A loan with interest by time may be repaid at any moment, so the outgoing lender is asked to consent to nothing.
- **What the borrower keeps.** The same loan record, collateral, lien, position token and borrowing. The loan is extended one base term from that moment by the existing in-place extension, which settles the interest and sets the new rate through the interest ledger. The fee is a renewal's: the difference for the added time. No loan is opened, so no new initiation fee is charged.
- **The lender position** moves to the incoming slot's owner by the existing migration. The step is refused, with the reason named in its preview, while the outgoing side cannot be settled whole in the same step, while the lender token is inside its transfer wait, and while a sale listing or another route is in flight on the loan. The loan then keeps its due date.
- **The incoming lender** is checked as a standing participant (risk access, sanctions, Terms) and may not be the borrower. The outgoing slot's exposure is released, the incoming slot's is taken, and the loan's record of its slot is rewritten, so the lend-until limit follows the new lender.
- **One step that anyone may run,** since every consent stands: the renewal entry takes an optional incoming slot. It has its row in the permissionless-steps ledger. The keeper's renewal pass tries the loan's own lender first, then the cheapest slot under the ceiling. It is armed at launch by the owner's decision of 2026-11-19, with no bounty, and an operator alert when a due renewal has not run. While that pass is not running on a network, nothing submits the step unless the borrower or someone else does, and the borrower's review and loan page say so (`DefaultPathsDesign.md` rule 7).
- **The caller chooses the slot,** inside the ceiling of that moment, so the borrower's limit is the worst case, and the borrower's review says so. For a fixed loan: "if your lender leaves, this loan may continue with another lender at up to X%". For a floating loan it names the margin as a margin, "at the reference plus up to M%", with the reference now and the loan's cap, or the absence of one, on their own lines. A margin is never shown as a limit on the whole rate. The warning-band check is the one made on that limit when the borrower set it (`TermAverageAndLinkGuardsDesign.md` 6.4); the step needs no new flag.
- **When no slot fits,** the last rule of section 6 stands: the loan ends at its due date, the keeper's advance alert says so, and the app offers a replacement.
- One event states the loan, both lenders, the principal and interest paid, the old and new rate, the new due date and the slot.

**A posted request may ask for no end date too.** A borrower's request may carry the same renewal limits. Where a slot with the renewal consent fills it, on a top-tier pair, with interest by time, for a term equal to a base term this market offers, and with the master switch on, the loan is marked at origination as an instant-market loan, in a borrowing of its own, and sections 6, 6.1 and 7 apply to it. A request filled any other way keeps its stated term. The request's review says so: it renews only if a lender who keeps lending fills it.

## 7. A lender leaves: takeover at face value

A takeover moves a loan from one lender to another for exactly the principal outstanding, with no pricing step. Two things make that fair. The outgoing lender chooses it, and a lender who wants more than face value for a loan uses the ordinary sale routes. The incoming lender takes only a loan their slot would open today on the same terms (the as-new test below). For a floating loan the two views meet by themselves, since the loan earns the market rate at every moment. For a fixed loan the as-new test carries the weight: the loan's rate must be at or above the incoming slot's minimum rate.

- **Who starts it:** the current holder of the lender position, or a keeper holding that holder's mandate for this action.
- **Which loans:** an active loan opened through the instant market, floating or fixed, with interest by time, not past due, not in a fallback, with no other sale route open.
- **Who takes it:** one lender slot with the takeover consent on, chosen off-chain, whose limits the loan fits **as if it were opened now**: the slot makes that kind of loan; the loan's margin (floating) or rate (fixed) at or above the slot's minimum; its cap and floor inside the slot's acceptance; its lifecycle settings among those the slot accepts; its current loan-to-value at or below the slot's largest initial loan-to-value, its health factor at or above the minimum for a new loan, its due date inside the slot's longest term and lend-until, and room in the slot's exposure. A loan that would not be admitted as new cannot be handed over, so a lender cannot pass on a weakening loan.
- **Nothing may be held for the position.** A takeover is refused while any amount is held for the lender position (a partial repayment's principal, interest paid and not yet claimed, under `LenderPayoutsThroughClaimDesign.md`) and while the lender token is inside its transfer wait (`PositionSaleStateGuardDesign.md` 3.5: 15 minutes after the holder's own claim). The outgoing holder claims first, the wait passes, and then the takeover may run; the preview names either reason. So nothing the outgoing lender has earned travels with the position, and the rule that a position cannot be sold in the same moment value leaves it is kept whole.
- **What moves:** the incoming lender's vault pays the outstanding principal into the outgoing lender's vault, measured on arrival. The lender position moves to the incoming lender on the same loan record, through the existing lender-position migration. Interest the outgoing lender earned up to that moment follows the existing seller-claim rule: it is paid to them first out of the borrower's next interest payment. Amended 2026-11-19 (#3811): the incoming slot pays from its owner's lending balance. A takeover of a loan under notice clears the notice and is tested against the term's end.
- **The borrower** signs nothing, pays nothing, and none of their terms change. No initiation fee is charged: no loan is opened.
- The incoming lender is checked as a standing participant (risk access, sanctions) and may not be the borrower. The outgoing slot's exposure is released and the incoming slot's is taken.
- One event states the loan, both lenders, the principal paid, the interest left as a seller claim, and the slot.
- Settled with the builder on 2026-11-15: a keeper acts under the holder's existing mandate for a direct sale, checked through the one sale-exit rule; the incoming principal comes from the slot's reserved capital, as a fill's does; and the loan's record of which slot it came from is rewritten for the incoming slot, so the lend-until limit follows the new lender. Interest earned stays a seller claim.

A loan whose interest is owed for the full term whatever the repayment date is not eligible: what is owed on it is not what has been earned, so face value is not its worth. Selling any loan at a price other than face value is the secondary-market question the owner has set aside, and nothing here opens it.

The review of a fixed-rate takeover tells the outgoing lender that the loan is handed over at face value and that a sale at a price is a separate route, and the incoming slot's owner was told when setting the slot that its minimum rate is the rate it may be given a loan at.

## 8. The common ledger

Running totals per lending asset (and per pair for the instant market), written by the steps that already change them:

Amended 2026-11-19 (#3811, `LendingBalanceDesign.md` 3.7): with one lending balance per lender and asset, Declared is retired and replaced by **set aside**, the sum of lending balances. Available is counted per lender, as the lesser of the balance and the room left on that lender's open slots, so each balance is counted once. Per pair the ledger keeps the lent figures only; the amount available to one pair is an indexer figure and is never summed across pairs. The text below is kept as the record of what was built first.

- **Declared:** the sum of the largest exposure of every Auto-lend slot that is active and whose fill window is still open. Declared is the limit lenders have set, not depth: depth is the **available** total of `TermAverageAndLinkGuardsDesign.md` section 7 (#3714), counted from the capital reserved in each slot under the definition and stated limits given there, and "how full" is principal lent out of slots divided by that principal plus available. A slot with an end date leaves the total when its window closes without anyone acting: its exposure is also recorded against the UTC day its window closes, every write first removes the days that have fully passed, and the view applies the same subtraction. The figure is therefore stated "as of the start of today (UTC)": a slot whose window closes today still counts until the day ends.
- **Lent:** three figures, per asset and per pair. All open principal from every route, which the shortfall reserve's activation check reads. Open principal lent out of Auto-lend slots. Open principal opened through the instant market. Whether a loan was opened through the instant market is fixed when it opens. Whether it counts as lent out of a slot follows the slot it is held from now, and the amount counted is the principal still outstanding on it: a principal repayment lowers the figure by the amount repaid in the same step, a full repayment or a default removes the rest (nothing waits for the lender's claim), and a loan taken over into a slot joins at its outstanding principal. Otherwise "how full" would misstate the exposure in use.

They are exact and cost one counter update per change. Amended 2026-11-17 (#3714): a slot lends only from capital its owner has reserved under the intent's own lien, which changes only through the intent's steps, so the capital reserved in fillable slots is also a ledger figure, **available**, with the day-based end-date cutoff and the other limits stated in `TermAverageAndLinkGuardsDesign.md` section 7; the borrow preview is the binding answer for any amount. Standing offers that serve as sources are not in it; the app adds those from the indexer and labels that part an estimate at the time of reading. The app's "how full" figure is the principal lent out of Auto-lend slots divided by that principal plus available; all-route principal is never divided by it.

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
- "Available" and "how full" for slots are ledger figures, shown "as of the start of today (UTC)" like declared; the part of depth that comes from standing offers is a labelled estimate with its time of reading. Declared is always called the limit lenders have set.
- No promised return and no comparison to named third parties, as everywhere.

## 11. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Lender intent | `instantMarket` and the takeover consent; validation that they require pro-rata; the kind of loan stays the slot's existing choice. |
| New facet for the borrower's entry | `borrowInstant` and its preview. The borrowing, its reserve, its settings and its actions are in `BorrowingDesign.md` section 14. |
| Shared origination step | Accepts a slot as the source for a borrower-initiated fill. The loan's borrowing is written by the caller's entry, not here. |
| In-place extension | The slot's renewal consent stands as the lender's limits for its instant-market loans, bounded by lend-until. |
| Renewal with another lender (6.1) | The renewal entry takes an optional incoming slot; the borrower's renewal limits gain "continue with another lender"; a request may carry renewal limits, and a slot's fill of it is marked as an instant-market loan. Built with renewal. |
| Takeover | A sale at face value into a slot, through the existing sale checks, the lender-position migration and the interest ledger. |
| Ledger | Counters and views (section 8). |
| Views | A slot list for a pair sorted for the app's list builder; a borrowing's summary; whether a takeover would be accepted and why not. |
| Keeper | Renewal already exists; a takeover pass under mandate; alerts by borrowing. New passes ship disarmed, except the renewal pass, which is armed at launch (6.1). |
| Permissionless-steps ledger, indexer, app | Rows for new open steps; borrowing and ledger indexing; the instant-market page, the borrowing's one-line view, wording per section 10. |

Append storage at the tail and run the storage-layout guard's `write`. Check facet sizes with the deploy-sanity suite.

## 12. Tests

1. `borrowInstant`: fills in list order at each source's own price (slot minimum margin, slot minimum rate, offer rate), floating and fixed; a source of the other kind, an offer with full-term interest, or one that refuses the lifecycle settings asked for is skipped and reported; skips a stale, unfit or too-dear slot and reports it; reverts only under the stated least; the fill limit; collateral split and rounding; unused collateral not taken.
2. Every origination refusal applies per fill (health factor, loan-to-value, risk access, sanctions, self-trade, level rules).
3. Actions on a borrowing equal the same single-loan calls made one by one; a loan that cannot complete is reported and the rest complete (`BorrowingDesign.md` section 15).
4. Renewal: needs both consents; a fixed loan renews at its unchanged rate only while both sides' rate limits allow; stops at lend-until; a lender turning it off leaves the due date unchanged; an unfunded renewal changes nothing; the fee difference is charged once per added period.
5. Takeover: the as-new test each way; refused while anything is held for the position and inside the token's transfer wait after a claim, accepted after the holder has claimed and the wait has passed, and the incoming lender pays only the principal still outstanding; principal measured on arrival; the seller claim is paid first from the next interest; exposure released and taken; the borrower's terms are byte-for-byte unchanged; refused past due, in a fallback, with another sale route open, into the borrower's own slot, for a loan with full-term interest, and for a fixed loan whose rate is below the incoming slot's minimum rate or whose lifecycle settings the slot does not accept; a fixed loan that passes moves with its rate and settings unchanged.
6. Ledger totals (declared, available, the three lent figures) equal the sum over slots and loans after any sequence of set, fund, fill, partial and full repayment, takeover, cancel and close-out.
7. With the master switch off, every new entry refuses and existing loans keep their rules.
8. Liquidation of one loan in a borrowing leaves the others untouched.
9. Renewal with another lender (6.1): refused while the loan's own lender would renew at the unchanged rate; accepted for each lender-side reason; the outgoing lender receives exactly what a repayment at that moment pays, through the one order of payment, with an open seller claim, and separately with an open advance, paid in its place; the rate is the incoming slot's minimum and is refused above the borrower's limit, and above the ceiling of that moment; the borrower's record, collateral, lien, token and borrowing are unchanged apart from the rate and the due date; the fee equals a renewal's; the loan's own lender's slot at a higher rate inside the limit keeps the loan with no principal moved; refused with "continue with another lender" off, for an incoming slot that fails the as-new test, for the borrower's own slot, inside the token's transfer wait, and with another route in flight; when refused, the due date is unchanged.
10. A request with renewal limits filled by a slot with the renewal consent, on a top-tier pair, with interest by time and a base term, renews by the same entry. The same request filled by a standing offer, on another pair, or for another term keeps its stated term.

## 13. Alternatives considered

1. **Hold lenders' funds together.** Rejected: it ends the per-user vault, shares every loss, and is the regulated shape the platform avoids.
2. **One loan shared by several lenders.** Tidier for the borrower, but those lenders would share that loan's loss. Rejected as the same thing in small.
3. **A rate set by how full the market is.** Rejected: the protocol would be setting the rate. The reference comes from the #3337 quorum and the margin from the parties.
4. **Only keeper matching of posted requests.** Already exists; it is not instant.
5. **Leave exits to the general secondary market.** That needs pricing rules the owner has set aside. A handover at face value, chosen by the outgoing lender and admitted only as a new loan would be, needs none.
6. **Shared collateral across a borrowing.** Rejected: one lender's liquidation would reach another lender's security.
7. **For a lender who gives no renewal: only alert the borrower.** The design before #3763, kept as the fallback when no slot fits. Not enough alone: a borrower who is away loses the loan though lenders stood ready at a rate the borrower had accepted.
8. **For the same case: close the loan and open a new one through the refinance route.** It works by hand and stays available. Not chosen as the automatic route: each move would open a new loan with a new initiation fee, and its payoff needs the borrower's signature near the moment.
9. **Bind a lender for a notice period longer than the base term.** Rejected: it worsens the lender's exit to improve the borrower's.
10. **Move the loan only at the rate it already carries.** Not chosen: it fails whenever the market has moved above that rate, even inside the borrower's own limit.

## 14. Recommendation and order of work

Build it as designed, top-tier pairs only, behind the master switch:

1. The ledger (small; the shortfall reserve needs it too).
2. Instant borrow and borrowings, fixed-rate first (works before floating loans exist), with the instant-market setting, renewal and takeover for fixed loans.
3. After #3337 part 2 and #3635 part B: the same for floating loans.
4. The app's instant-market page.
5. With renewal, after the reserve: renewal with another lender and the request that asks for no end date (6.1, #3763).

## 15. Open items for the builder to raise, not decide silently

Settled on 2026-11-15: earned interest stays a seller claim at takeover. The second settlement of that day, that renewal uses one reserve per loan and not one per group, was reversed by the owner on 2026-11-19: the reserve is the borrowing's (`BorrowingDesign.md` section 5).

- The timing rule (#3443): a borrower-initiated fill takes standing slot terms, as a direct accept takes an offer; confirm no slot-side ageing rule is bypassed.
- How an action on a borrowing reports partial completion without hiding a failed loan. Settled 2026-11-19: one event lists every loan, what was applied, and each loan skipped with its reason (`BorrowingDesign.md` section 7).
- For 6.1 (#3763): whether an open advance on the loan (`LenderCashOutDesign.md` section 6) is settled inside the step, as a full repayment settles it, or refuses the step in the first build. The design asks for the first, because refusing would let a lender's own advance end the borrower's loan.
- For 6.1: how a caller is kept from choosing a dearer slot when a cheaper one fits. Narrowed 2026-11-19, not closed: the rising ceiling of `BorrowingDesign.md` section 10 limits the choice for the first two days of the window; under the ceiling the caller still chooses, and the borrower's limit stays the stated worst case.
- For 6.1: whether "continue with another lender" is set for every loan of a group in one call. Settled 2026-11-19: it is one setting of the borrowing.
