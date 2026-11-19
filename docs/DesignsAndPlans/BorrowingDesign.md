# A borrowing: one record over a borrower's loans on a pair

**Status:** the owner approved these changes on 2026-11-19, as the "parent position" of the instant market. Card #3808. Design first, no code yet. Reaches a chain by fresh deploy. Section 9 (one close-out for several loans) was reviewed in outline by the security thread on 2026-11-19; its conditions are written in, and it is built last. Section 11 (one borrower token) is a check for the builder, not a decision.

**Related:** `InstantMarketDesign.md` (#3656; this replaces its group label and amends its sections 5, 6, 6.1 and 15), `StandingInstructionsDesign.md` (#3681; this moves its reserve and its settings from the loan to the borrowing), `DueDatePlanDesign.md` (#3785), `ExitBeforeLiquidationDesign.md` (#3752), `RateAuctionDesign.md` (whose loans share the same record), `DefaultPathsDesign.md`, `PositionSaleStateGuardDesign.md` (#3710).

**The name.** The record is called a **borrowing**. The word "position" already means a loan's position tokens throughout the code and the designs (the borrower position, the lender position, the position state guard), and a second meaning beside it would mislead a reader and an auditor. In this document "the borrower token" is a loan's borrower-side position token, and "a borrowing" is the new record over several loans. The app may still show a borrowing as "one position"; that is a word on a screen, not a second record.

## 1. Why

An instant borrow fills from up to eight lenders in one transaction, and a rate auction opens one loan per winning bid. The borrower sees one borrowing. The contracts hold several loans that share only a label.

Read in the code on 2026-11-19:

- The label is a number: `lastInstantGroupId` and `instantGroupOf[loanId]`. `borrowInstant` writes it and one view reads it. Nothing else knows the loans belong together. The group helpers the instant market design describes are not built.
- The payment reserve and the collateral reserve are rows keyed by loan and holder. The standing instructions, the automatic-extension limits and the due-date plan are records keyed by loan.
- Every step that anyone may run (collateral top-up, interest payment, repayment at the due date, extension) names one loan.

So a borrower with eight loans funds eight payment reserves, sets eight plans, and is asked to keep each one topped up. When one loan's reserve runs short its step is skipped although the next loan's reserve holds more than enough. A repayment of the whole borrowing is eight transactions.

## 2. What the user gets

- **One line** for a borrowing on a pair: the total borrowed, the rate now across its loans, the lowest health factor among them, and one set of actions. The loans are listed beneath, each with its lender.
- **One reserve.** One payment reserve and one collateral reserve for the borrowing. Any of its loans may draw on them.
- **One set of settings.** The renewal limits, the plan for the due date, the standing instructions and the exit level are set once and apply to every loan of the borrowing.
- **One transaction** to repay, add collateral or withdraw surplus across the loans the borrower names.
- **Borrow more into the same borrowing** later, at the price of the lenders then standing.
- **A tighter limit when a loan moves to another lender.** The highest rate the loan may move at starts at the loan's own rate and rises over two days to the borrower's limit, so a lender at a lower rate can be taken earlier than a dearer one. It is an earlier chance for the cheaper lender, not a promise that the cheapest is chosen (section 10).

## 3. The rule

1. **A borrowing is a record, never a loan.** It holds an owner, a pair, a list of loans, the settings and the reserve. It holds no debt, no collateral, no lien and no health factor. Its totals are read from its loans.
2. **Each loan stays whole.** One lender, one borrower, its own collateral under its own lien, its own health factor, its own liquidation, its own position tokens. Nothing cross-defaults. One shared loan and one shared collateral holding stay rejected (owner, 2026-11-19).
3. **The borrowing follows the wallet.** A loan counts as in a borrowing only while the holder of its borrower token is the borrowing's owner. This is the fence the instructions already use.
4. **A step that anyone may run names the borrowing, never a loan of the caller's choosing**, wherever it spends the shared reserve. The order among the loans is the contract's.
5. **An action over several loans equals the same single-loan actions made one by one.** The shared work (one movement of funds, one price read) is done once. The settlement of each loan is the one the single-loan entry uses.
6. **No close-out depends on the borrowing.** No repayment, default, liquidation or claim writes to the borrowing's record, so nothing in it can hold a close-out back.

## 4. The record

**Fields.** The owner (a wallet), the lending asset, the collateral asset, the list of its loans, a settings version, and the settings of section 6. The reserves of section 5 are rows keyed by the borrowing and the depositor.

**Its own numbering.** Borrowing ids replace the group ids. The label's two storage fields are replaced by the borrowing record and `borrowingOf[loanId]`. The platform is pre-live and the next deploy is fresh, so nothing is kept beside the new record.

**How a borrowing is opened.**

- By `borrowInstant`, for the loans it opens, unless the borrower names an existing borrowing (section 8). The settings the call carries (the renewal limits, the plan for the due date) become the new borrowing's.
- By a rate auction's settle, for the loans of that auction. The first loan settled opens it and the rest join it.
- By the first fill of a request that carries renewal limits and is filled by a slot (`InstantMarketDesign.md` 6.1, last paragraph). The limits the request carried become the new borrowing's settings.
- By the holder, for one loan that has none, when they first fund a reserve or set anything of section 6. The funding and setting entries take a borrowing, or a loan that has none, and open the borrowing in the same call.

A loan in no borrowing has no reserve and no settings. Nothing is lost by that: a loan needs neither until its holder wants one.

**Which loans may be in one borrowing.** ERC-20 loans on the borrowing's pair, held by the borrowing's owner as borrower. A fixed loan and a floating loan may share a borrowing: the renewal limits carry a highest rate and a highest margin, and each applies to the loans of its kind. This is needed because a fixed loan may continue as a floating one (`DueDatePlanDesign.md` 4.4) and must not leave its borrowing when it does.

**Gathering and separating, by the holder only.** The holder may add a loan they hold to a borrowing of theirs on the same pair, and may move a loan out to a borrowing of its own. Either changes which reserve and which settings that loan uses, and nothing else.

**A gather is a change of settings for the loan gathered, and is checked as one.** The loan comes under the destination's settings, so every check that writing those settings on that loan would meet applies to the gather: the bounds, the refusals (a setting the loan cannot carry refuses the gather, named), the sanctions rule, and the protected account's delay. On a protected account, a gather that would switch on or loosen for that loan anything a direct change would have to wait for (a collateral sale, a sale sooner or at a worse price, a higher highest rate, a floating rate) waits the account's delay before the loan counts as in the borrowing, and may be cancelled meanwhile. Until then the loan keeps the settings it had. A gather that only lessens these is immediate. Without this a protected owner's loan could be put under a live sale instruction at once, which the delay exists to prevent (`ExitBeforeLiquidationDesign.md` 4.1). Moving a loan out to a borrowing of its own leaves it with no instruction, which can only lessen them, and is immediate. A loan that a refinance opens in place of one of the borrowing's loans is added the same way; whether that happens in the refinance itself is an open item (section 16).

**A loan that moves to another wallet** (an obligation handover, a transfer of the borrower token) stays on the old borrowing's list but no longer counts: every step skips it, with the reason "the holder is not the borrowing's owner". The new holder may open their own borrowing for it, which rewrites `borrowingOf` for that loan.

**The list is pruned lazily.** A loan that has closed, or that another holder has taken into their own borrowing, is dropped from the list by the next action on the borrowing, by the next add, or by a prune that anyone may run. A loan that is Active or in the liquidation fallback counts as open. No close-out path touches the list (rule 6).

**A cap on open loans per borrowing.** A governed setting. Its value is set from a measurement (section 16, item 1): the largest count at which a run over the whole borrowing fits comfortably in one transaction. An add that would pass the cap is refused before anything moves.

**Protected accounts.** A lock or a replacement freezes the borrowing's reserve and settings with the rest of the account. What a replacement does with the record is an open item (section 16).

## 5. One reserve per borrowing

This reverses the settlement of 2026-11-15 ("renewal uses the one per-loan reserve, not one per group"), by the owner's decision of 2026-11-19.

- **Two balances**, as now: a payment reserve in the lending asset and a collateral reserve in the collateral asset. They are keyed by the borrowing and the depositor, in the depositor's own vault, under the borrowing's lien in the shared encumbrance total. One library writes them.
- **Every rule of `StandingInstructionsDesign.md` section 3 carries over** with "borrowing" in place of "loan": only the borrowing's owner funds; the depositor withdraws unused reserve at any time; nothing else takes it; the collateral reserve is not collateral until an instruction moves it into a loan's lien; a protected account's delay applies to moving protected balance in.
- **What may draw on it:** an interest payment, a repayment at the due date, the charge of a renewal or a continuation, and a collateral top-up, for any loan that counts as in the borrowing.
- **The limit is the reserve.** An instruction can spend only what the owner placed in the borrowing's reserve, and only on a loan of that borrowing.

**The order of draws is the contract's.** With one reserve for several loans, a step that named one loan would let its caller choose which loan is paid when the reserve cannot pay them all. `StandingInstructionsDesign.md` section 5 gives "the caller chooses nothing" as the reason no keeper permission is needed, and that must stay true. So:

- **The instruction steps name the borrowing.** Each takes a borrowing and walks its open loans in a fixed order. A loan whose step cannot run is skipped with its reason and the walk goes on.
- **One step for every payment from the payment reserve.** Today `runInterestPayment` and `runDueRepayment` are two entries. Two entries on one reserve would give the choice back to the caller: with a repayment of 100 due on one loan, interest of 10 due on another and 100 in the reserve, whoever calls first decides which is paid. So the two become **one payment step with one walk**. It lists every payment that can run now for the borrowing's loans (an interest payment whose instruction is on, a repayment at the due date inside its window) and pays them in the order in which each fell due: an interest payment at its period's end, a repayment at the loan's due date. Ties go to the lower loan id, and to interest before a repayment on the same loan. A payment the reserve cannot cover follows the rule it already has: a repayment is whole or not made, an interest payment may be made in part. There is one entry, so there is no order of calls to choose.
- **The collateral top-up** (`runCollateralTopUp`) draws on the other balance, the collateral reserve. It goes to the lowest health factor first, ties to the lower loan id.
- **The cap of section 4 bounds the walk.** The pair's prices are read once for the walk.
- **Each loan is settled through the same internal step as today**, by a self-call, so one loan's failure unwinds alone.
- **The renewal and continuation entry still names one loan**, because its caller also names the incoming lender for that loan. It is the one draw on the payment reserve outside the payment step, so it is fenced (security review, 2026-11-19). Left open, renewing one loan could drain the reserve and leave a loan that falls due earlier unable to pay, to be sold or charged late. **The entry draws on the shared reserve under two limits:**
  1. Only for the earliest-due loan of the borrowing that is inside its window and still needs a charge, ties to the lower loan id.
  2. Only from what is left of the reserve after setting aside everything the payment step could pay now, across every loan that counts as in the borrowing: whole repayments inside their window and interest due now.

  What the reserve does not give comes from the owner's other free balance in that asset, as an extension's charge already can. If the two together do not cover the charge, the renewal does not run and the loan keeps its due date. The set-aside is computed by the payment step's own sizing read, never a copy of it, in one walk of the borrowing bounded by the cap. The fence is on the payment reserve only; the collateral reserve and the top-up are untouched. Because the amount is set aside and not merely checked, no one has to run the payment step first, and a renewal the reserve can afford is never held back.
- **What that fence costs.** A loan whose own lender gives no renewal and that no other lender takes stays the earliest-due loan in its window until it is repaid or its grace ends. While it does, a later-due loan of the same borrowing renews from the owner's free balance or not at all. The card for a borrowing says so, and the owner's remedies are to keep free balance in the asset or to move a loan to a borrowing of its own.

**The exit before liquidation** (`ExitBeforeLiquidationDesign.md`) takes a borrowing the same way and sells loan by loan, lowest health factor first. A joint sale waits for section 9.

## 6. One set of settings per borrowing

Stored once per borrowing, written by the borrowing's owner or that owner's protected-account manager, and cleared by the same wallet:

| Setting | Was | Now |
| --- | --- | --- |
| The borrower's renewal limits (highest rate, highest margin, latest end, most fee) | per loan | per borrowing |
| "Continue with another lender", term after continuing, accept a floating rate, accept a smaller loan | per loan | per borrowing |
| The three standing instructions and their levels | per loan | per borrowing |
| Repay from my collateral at the due date, with its tolerance and time | per loan | per borrowing |
| Sell and repay before liquidation, with its level, target and tolerance | per loan | per borrowing |

What stays per loan: everything on the lender's side (a slot's consents, a lender's extension limits), and each loan's own run state, such as the time of its last top-up.

- **The settings version** rises by one on every change. An add (section 8) states the version it read.
- **Stopping.** The borrower's "Stop renewals" clears the borrowing's limits and so stops every loan of it. A borrower who wants one loan to end repays that loan, which interest by time allows at any moment, or moves it to a borrowing of its own.
- **Bounds, delays and refusals** are those each setting already has, checked against every loan that counts as in the borrowing when the setting is written. A setting that one loan cannot carry (repay from collateral on a loan whose collateral is not liquid) is refused for the borrowing with that loan named.
- **A loan added later** takes the borrowing's settings as they stand. The add's review says so.

## 7. Actions on a borrowing

One entry per action for the holder: **repay**, **add collateral**, **withdraw surplus collateral**.

- **Which loans.** A list of the borrowing's loans, in the holder's order. An empty list means every open loan. A list longer than the per-transaction limit is refused.
- **How an amount is spread.** One of two modes. "In proportion" spreads it by principal outstanding, the last loan taking the remainder. "In the order given" fills each loan in turn, which is how a borrower repays the dearest loan first. Repay-all needs no mode.
- **Shared work once.** One pull of funds from the wallet or the vault, one price read for the pair, one screening of the caller.
- **Each loan through the single-loan step**, by a self-call, so a loan that cannot complete unwinds alone, is reported with its reason, and the rest complete. Funds meant for a loan that did not complete stay with the holder. Repay-all states exactly what remains.
- **One event** lists each loan, what was applied to it, and each loan skipped with its reason.
- **The test:** the result equals the same single-loan calls made one by one in that order.

The holder's own actions may name loans, because the holder may choose. A step that anyone may run may not (rule 4).

## 8. Adding to a borrowing

`borrowInstant` takes an optional borrowing.

- Only the borrowing's owner may name it, and only for the same pair. The loans opened must carry interest by time, as every instant borrow's do.
- **The call states the settings version it read.** If the settings changed since, the call is refused, so a borrower never adds loans under settings they did not see.
- **A source above the borrowing's own limit is skipped and reported**: the highest rate for a fixed loan, the highest margin for a floating one. A loan must never enter a borrowing already outside the limit that borrowing renews under.
- **The cap on open loans** is checked first, counting only loans still open after a prune.
- Each new loan is an ordinary new loan: its own term from its own opening, its own collateral, its own fee. Fees stay as decided on 2026-11-17 for every loan, with no fee by kind or by route.
- **"Borrowed X of Y"** is an app figure. Y is what the borrower said they wanted; the contracts hold no target and promise none.

A rate auction's loans must fit the cap. That is an item for its builder (section 16).

## 9. One close-out for loans that fall together

The loans of one borrow are opened with collateral in proportion to principal, so a price fall takes their health factors below one at nearly the same moment. Today each is liquidated by its own transaction and its own sale. One sale costs less gas and spares the later loans a price the earlier sales have already moved.

The security thread reviewed this section in outline on 2026-11-19 and found it sound on the conditions below, which are now part of the design. It is built last (section 18) and its build gets its own adversarial review.

- **Which sale.** The health-factor liquidation only, and its single-sale route only. Not the split route, not the internal match, not the time-based default, not the periodic sale.
- **Every named loan must itself be liquidatable at that block.** The caller names loans of one borrowing. If one is not liquidatable, the whole call reverts and nothing moves.
- **One quote per loan.** The caller gives a quoted amount for each loan, and each is checked against that loan's own plan and its own accepted range, exactly as a single liquidation checks it. The amount sold is their sum. A single summed quote is not accepted: its excess could fall on one loan beyond that loan's own range.
- **One sale, two floor checks.** The least output accepted for the sale is the sum of each loan's own floor, each at its own floor rate for its own amount. After the proceeds are divided, each loan's share is checked against that loan's own floor, and the call reverts if any share falls short. So no loan is sold below the price its own rule allows.
- **Proceeds are divided by collateral sold**, the last loan taking the remainder. One sale has one price, so no loan pays for another. Each loan then books through the existing forced-sale booking, lender whole first, with its own handling fee, its own bonus and its own extra held for the borrower. The bonus is per loan and in proportion, so joining loans does not change what a liquidator earns.
- **Each loan runs its own opening and settling steps**, by self-call, so no per-loan guard is skipped: the health test, the fill lock, the forced cancel of a pending swap-to-repay order, the clearing of a sale listing, the pull that a flagged borrower cannot block, the lien, the custody rows and the seller claims.
- **A joint call never enters the fallback.** A larger sale fails more often than a small one, so a failed joint sale must not push loans that could each have been sold alone into the fallback. If the joint sale fails, or any check fails, the whole call reverts and nothing moves. Only the single-loan liquidation reaches the fallback, under its own gate.
- A loan may always be liquidated alone. The joint form removes nothing.

**Limits, stated.**

- A larger trade moves the price more than a small one. A loan whose collateral no longer covers its debt may recover a little less in a joint sale than it would have recovered alone and first. Its own floor still binds, and a liquidator who expects that sells such a loan alone.
- The borrower can make a joint call revert by topping up one of its loans first. That costs the caller gas and nothing else; the caller then liquidates the loans that remain liquidatable, alone or together.

A joint run of the exit before liquidation follows the same conditions and is considered after this is built.

## 10. A rising ceiling for "continue with another lender"

`InstantMarketDesign.md` 6.1 lets a loan whose lender gives no renewal continue with another lender, at that lender's minimum rate and never above the borrower's limit. Its caller chooses the lender, so a caller could pick a dear lender while a cheaper one stood ready. The borrower's limit bounded the harm; this narrows it for the first two days of the window. It does not remove it.

- **The ceiling at a moment** is the most the continued loan's rate may be if the step runs at that moment.
- **It starts at the loan's own rate** when the extension window opens, three days before the due date.
- **It rises in a straight line to the borrower's limit**, which it reaches one day before the due date, and stays there until the end of grace. One day before the due date is when the repayment steps of the plan may begin, so the continuation has had its whole range before any repayment can run.
- **Where the borrower's limit is at or below the loan's own rate,** the ceiling is the limit throughout.
- **Where the window opens less than a day before the due date** (a very short loan), the ceiling is the limit from the start.
- **A floating loan:** the same rule on the margin, from the loan's own margin to the highest margin.
- **A fixed loan continuing at a floating rate:** the rule applies to the starting rate (the reference at that moment plus the margin). The cap on the whole rate stays at or below the borrower's highest rate, as `DueDatePlanDesign.md` 4.4 requires.
- **The loan's own lender at a higher rate** is a candidate under the same ceiling.

A lender whose minimum rate is under the ceiling can be taken as soon as the ceiling passes it. A dearer lender cannot be taken until the ceiling reaches its rate. The rule reads the clock and two stored numbers, so it costs almost nothing on-chain.

**What the contract enforces, and what it does not.** The contract enforces the ceiling of the moment and nothing else about the choice. Among the lenders under that ceiling the caller still chooses, as in 6.1. So:

- Taking the cheapest lender under the ceiling is the **keeper's policy**, not a rule of the contract. The platform's keeper tries the loan's own lender first, then the cheapest lender under the ceiling.
- Anyone else who runs the step may choose a dearer lender that is under the ceiling at that moment, even while a cheaper one stands ready.
- A cheaper lender that appears after the ceiling has passed a dearer lender's rate has no first place. Nor does one the keeper missed earlier in the window.
- From one day before the due date the ceiling is the borrower's limit, and the worst case is the limit, exactly as before this change.

The borrower's limit therefore stays the stated worst case in every review.

**What the borrower is told** is unchanged in substance: "if your lender leaves, this loan may continue with another lender at up to X%". One line is added, and it promises only what the contract enforces: "The highest rate that may be accepted starts at this loan's rate three days before the due date and rises to X% by one day before it. Whoever runs this step chooses the lender within that limit; the platform's keeper chooses the cheapest." Where the keeper pass is not running on a network, the last clause is left out and the card says so, as for every step.

**The renewal keeper pass is on at launch** (owner, 2026-11-19), with no bounty for running it, and the operator alert for a due renewal that has not run is kept. Arming it on each network is still the owner's step.

## 11. One borrower token per borrowing: a check, not a decision

Each loan has its own borrower token today. One token for a whole borrowing would give the borrower one thing to hold, sell or hand over. It is not decided.

Before anyone proposes it, the builder verifies and reports what would happen in three cases:

1. One loan of the borrowing is repaid while the others stay open, and the borrower claims that loan's collateral.
2. One loan of the borrowing is handed to a replacement borrower.
3. One loan of the borrowing is refinanced, which opens a new loan record with a new pair of tokens.

Each of these acts on one loan through its own token today. Until the report, the design stands on one borrower token per loan, with the borrowing as a record that follows the wallet.

## 12. The app's source list

App only; no contract change.

- The borrower chooses how the list of sources is built: **best rate** (cheapest first, as now) or **fewest lenders**, within a rate difference the borrower accepts.
- The review shows, for the list built: how many lenders, the rate across them, and what choosing the other way would change.
- Fewer lenders means fewer loans to manage and less gas, at a slightly higher rate. The app states both and recommends neither.

## 13. What does not change

Decided by the owner on 2026-11-19 with these changes:

- Fees stay as decided on 2026-11-17 for every loan. No fee by kind of loan or by route.
- Idle funds never leave the user's vault, except inside a single transaction that returns them.
- The renewal keeper pass is on at launch, with no bounty, and its operator alert is kept (section 10).
- Large borrows go to the rate auction.
- One shared loan and one shared collateral holding stay rejected.

## 14. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Storage | The borrowing record, `borrowingOf[loanId]`, the governed cap. The group label's two fields go. Reserve rows, instruction records, borrower renewal limits, the due-date plan and the exit level are keyed by borrowing. Run the storage-layout guard's `write`. |
| Reserve library | Lien and release by borrowing and depositor. One writer, as now. |
| Standing instructions facet | Fund, withdraw, set and clear by borrowing (opening one for a loan that has none). The top-up executor takes a borrowing and walks it. The interest and due-repayment executors become one payment step with one walk (section 5). Views by borrowing. Split along a seam if it nears the size limit. |
| New facet for borrowings | Open, gather, separate, prune, the views (a borrowing's loans, totals and settings version), and the actions of section 7. |
| Instant borrow | Takes an optional borrowing and the settings version; opens a borrowing otherwise. |
| Rate auction settle | Opens or joins a borrowing in place of stamping the label. |
| Renewal and continuation entry | Reads the limits from the borrowing; applies the ceiling of section 10; draws its charge from the borrowing's reserve. |
| Exit before liquidation | Level and tolerance by borrowing; the executor walks the borrowing. |
| Joint close-out | A new entry beside the single liquidation, on its own facet (the risk and forced-sale facets have no room): one quote per loan, one sale, the two floor checks, per-loan opening and settling by self-call, and a whole-call revert in place of the fallback (section 9). Built last. |
| Permissionless-steps ledger | Rows for the top-up step, the one payment step and the prune, replacing the per-loan rows. |
| Keeper | The standing-instruction pass and the exit pass read borrowings; the pass's interest and repayment steps become one step with one arming flag. The renewal pass applies the ceiling: own lender first, then the cheapest lender under the ceiling. |
| Indexer | Borrowing opened, loan added, loan removed, settings set, reserve funded and withdrawn, action run. A borrowing table; a loan's row names its borrowing. |
| App | One line per borrowing with its loans beneath; one "Reserve and instructions" panel and one "At the due date" card per borrowing; the add flow; the source list of section 12; the statements of sections 6, 8 and 10. |

## 15. Tests

1. Opening: by an instant borrow, by an auction's settle, by a request filled by a slot, and by the holder for a single loan; the pair is fixed; a loan on another pair or held by another wallet is refused.
2. Membership: a loan whose borrower token moved is skipped by every step with the reason; the new holder opens their own borrowing for it; the old borrowing's list drops it at the next prune; a closed loan is pruned; a loan in the fallback counts as open.
3. No close-out path writes to a borrowing: repay, default, liquidate and claim each loan of a full borrowing, with the list never pruned, and each behaves as for a loan in no borrowing.
4. Reserve: funded once, drawn by any loan of the borrowing; the payment step pays in the order each payment fell due, interest and repayments in one walk, and top-ups go to the lowest health first, whatever the caller does; with a repayment due on one loan, interest due on another and a reserve that covers only one, the outcome is the same on every call; a short reserve pays what it can in that order and skips a repayment it cannot make whole; the depositor withdraws the rest at any time; encumbrance holds against an offer, an intent, a claim and a payout.
5. Settings: set once and read by every loan; the version rises on each change; a setting one loan cannot carry is refused with the loan named; a loan added later takes them.
6. Actions: each equals the same single-loan calls one by one, in both modes; a loan that cannot complete is reported and the rest complete; funds for it stay with the holder; an over-long list is refused.
7. Add: only the owner; same pair; refused on a stale settings version; a source above the borrowing's limit is skipped and reported; the cap is checked after a prune.
8. The ceiling: at the window's opening only a lender at the loan's own rate can be taken; halfway, only lenders up to halfway; one day before the due date and after, any lender up to the limit; a caller may take a dearer lender under the ceiling while a cheaper one stands ready, and the contract allows it (the stated limit of section 10); a limit at or below the loan's rate; a window shorter than a day; the margin for a floating loan; the starting rate for a fixed loan continuing as floating.
9. A fixed loan that continues as floating stays in its borrowing and reads the highest margin from then on.
10. Gather and separate: only the holder; the loan uses the new borrowing's reserve and settings from that moment; no fund moves; a gather is refused where the destination carries a setting the loan cannot; on a protected account a gather into a borrowing with a live collateral-sale instruction, a higher highest rate or a floating rate waits the delay, the loan keeps its old settings meanwhile, no instruction of the destination runs on it before the delay ends, and a gather that only lessens is immediate.
11. The renewal fence: with two loans in their renewal windows, only the earlier-due loan's renewal draws on the reserve, whichever is called first, and the other uses free balance or does not run; with a reserve of 100, a repayment of 100 inside its window on one loan and a renewal charge on another, the renewal takes nothing from the reserve in either order of calls, and the same with interest due now in place of the repayment; with a reserve that covers both, both complete in either order; a charge may be met partly from what is left of the reserve and partly from free balance.
12. Joint close-out: one quote per loan, each refused outside its own range; the least output is the sum of the loans' own floors; a share under its loan's own floor reverts the call; a named loan that is not liquidatable reverts the call; a failed sale reverts and no loan enters the fallback; each per-loan guard fires as in a single liquidation; the bookings equal those of single liquidations at the same price.

## 16. Open items for the builder to raise, not decide silently

1. **The gas of an eight-loan instant borrow, a repay-all, and a whole-borrowing top-up and payment run**, measured. The cap on open loans per borrowing and the per-transaction limit of section 7 are set from it.
2. **The renewal entry's draw order** (section 5). Settled by the security review on 2026-11-19: the two limits written there. The builder confirms the walk fits the entry's size and gas, and that the set-aside calls the payment step's own sizing read.
3. **A refinance's replacement loan:** added to the borrowing inside the refinance, or by the holder afterwards with the app prompting. The refinance facet is near the size limit, so the second is the default unless the first is cheap.
4. **A protected account's replacement:** whether the borrowing record moves to the replacement owner with the tokens, or is opened again there.
5. **The rate auction's bound** on the number of loans against the cap of section 4, for the auction's builder.
6. **The one borrower token** (section 11): the report on the three cases.
7. **Whether every ERC-20 loan should be given a borrowing at origination** rather than at first use. It would remove the "loan in no borrowing" case at the cost of a write on every origination, in facets already near the size limit. This design opens borrowings at first use.

## 17. Alternatives considered

1. **Keep the label and per-loan settings.** The design before this one. It is correct and it is what makes eight loans feel like eight borrowings.
2. **One loan shared by several lenders, with one collateral holding.** Tidiest for the borrower. The lenders would share that loan's loss, and one lender's liquidation would reach another's security. Rejected again by the owner on 2026-11-19.
3. **One reserve per user across every pair.** Fewer deposits still. The limit becomes unclear across unrelated borrowings, and a reserve would need to hold several assets. The borrowing is the unit the borrower already thinks in.
4. **Per-loan overrides of a borrowing's settings.** A setting would then live in two places and the card could not state one rule. A loan that needs its own settings is moved to a borrowing of its own.
5. **Keep the executors per loan and enforce the draw order with a check.** The check would have to prove that no earlier-due loan could run, which means running it. Walking the borrowing does the same work once and leaves the caller no choice. Keeping interest and repayment as two walks was the first draft; it left the caller the choice between them, so they are one step.
6. **Write the borrowing on every close-out so its list is always exact.** It would put a new write, and a new way to fail, on every repayment, default and liquidation. Rejected for the lazy prune.
7. **For the dearer-lender problem: have the contract find the cheapest lender.** It would need a sorted list of slots on-chain, kept by every slot change. The ceiling narrows the choice from the clock at almost no cost, and leaves the rest as a stated limit (section 10).
8. **For the same problem: only the keeper may run the continuation.** It would tie the borrower's continuation to one runner being alive. The step stays open to anyone.
9. **Call the record a "position".** The word the approval used. Not chosen for the record's name: "position" already means a loan's tokens everywhere in the code, and two meanings side by side are an audit hazard. The app may still say it.

## 18. Recommendation and order of work

Build it, behind the instant market's master switch, in this order:

1. The borrowing record, the reserve and the settings keyed by borrowing, with the borrowing-keyed executors. Everything after depends on it.
2. The actions of section 7 and the add of section 8, with the gas measurement that sets the cap.
3. The rising ceiling, with the continuation step it bounds (#3763) and the renewal pass.
4. The app's borrowing view, panels and source list; the indexer's borrowing table.
5. The joint close-out, on the conditions of section 9, with its own adversarial review, and the joint exit after that.

Proposed owners: the Auto-lend build thread for 1 to 3; the security thread for the review of the joint close-out's build; the rate auction's builder for its settle and its bound; the keeper thread for the passes; the indexer and app threads for 4.
