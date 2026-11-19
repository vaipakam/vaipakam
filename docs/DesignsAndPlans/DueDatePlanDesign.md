# The plan for the due date: continue with another lender, or repay from collateral

**Status:** design for the owner's review. Card: #3785. Asked for by the owner on 2026-11-19: automatic refinance can still end in a default when no lender takes the loan; can the instant market help, can the loan move to a floating rate, is there a better approach.

Related: `InstantMarketDesign.md` 6 and 6.1 (renewal, and continuing with another lender), `StandingInstructionsDesign.md` 4.3 (repay at the due date), `ExitBeforeLiquidationDesign.md` (sell and repay on a health level), `RepaymentByOthersDesign.md` 3.2 (the interest ledger), `DefaultPathsDesign.md` (what is pre-selected).

## 1. What the code does today

Read on the batch branch.

- **Automatic refinance is not automatic for the borrower.** The borrower sets limits on a loan (a highest rate and a latest end). A refinance still needs a request posted by the borrower, with a single-use payment permit signed by the borrower's wallet for the interest and the fee, which lapses. A lender then accepts the request or the matcher fills it; a request that carries the collateral over is filled whole, by one lender. The result is a new loan record with a new pair of position tokens and a new initiation fee on the whole principal. The existing collateral is carried over in place only for the original borrower.
- **It is best effort.** When no lender takes the request, the loan reaches its due date. The late fee starts at once (1% of the principal on the first day, rising to 5%). At the end of the grace period anyone may default the loan: the collateral is sold with a 2% handling fee, a keeper bonus and the forced-sale price floor, or handed to the lender in kind where it cannot be sold.
- **A loan carries one plan for the due date.** The borrower's "repay at the due date" instruction (from the loan's payment reserve, up to one day before the due date), the automatic-extension limits and the automatic-refinance limits are mutually exclusive: the second one set is refused.
- **Extension in place** needs both sides' limits and runs from three days before the due date until the end of grace. It settles the interest, sets the new rate and keeps the loan record.
- **The instant market** has standing capital: Auto-lend slots that take a borrower's direct request at their own minimum rate, and that may give two more consents, renewal and takeover at face value. A takeover is started by the lender and is offered only for a loan the instant market opened.
- **Designed, not built:** renewal of an instant-market loan, and its continuation with another lender when its own lender gives no renewal (`InstantMarketDesign.md` 6 and 6.1). **Designed, being built:** the instruction that sells collateral and repays when the health factor falls below the borrower's level (`ExitBeforeLiquidationDesign.md`).

So the borrower the owner describes has two gaps. Nothing moves the loan to another lender without the borrower posting and signing near the due date. And when no lender exists at all, the only outcome is the late fee and the default, although the borrower's own collateral could have repaid the loan on better terms a day earlier.

## 2. What the user gets

One card on a loan, "At the due date", set once, when borrowing or at any time after. The borrower switches on the steps they want. The order is fixed.

1. **Stay with my lender.** Extend or renew with the same lender inside both sides' limits. Exists.
2. **Continue with another lender.** If my lender does not continue, move the loan to another lender who stands ready, at no more than my highest rate. I keep the same loan, collateral and position, and pay a renewal's fee, not a new loan's.
3. **Repay from my reserve.** Repay in full from the loan's payment reserve shortly before the due date. Exists.
4. **Repay from my collateral.** If the loan is still open shortly before the due date, sell just enough of its collateral to repay it, at no worse than my price tolerance, and leave me the rest.

When every step the borrower chose cannot run, the loan ends as it does today: the due date, the late fee, the grace period, then default.

## 3. The rule

1. **A rate does not find money.** A lender who does not continue is paid in full at that moment: the principal by the incoming lender, the interest by the borrower. No step keeps a lender in a loan past the date it agreed to. Changing how a loan's rate is set, fixed or floating, widens the set of lenders who may take it and does nothing else.
2. **One plan, ordered steps.** The rule "one plan for the due date" stays, and the plan becomes a short list in a fixed order. Each step has its own condition and its own window, read on-chain when it runs. There is no orchestrator and no stored "current step".
3. **Each step is an existing settlement.** Step 2 is the in-place extension with a change of lender (the designed 6.1 step). Step 4 is the borrower's own full repayment with collateral, the settlement the health-level instruction uses. Nothing here adds a second way to settle a loan.
4. **Every limit is the borrower's own, and the worst case is stated.** The caller of a step chooses the incoming lender or the sale route and nothing else, and receives nothing.
5. **A convenience, not a promise.** Each step needs someone to run it, a lender or a market to exist, and the checks to pass. The card says so (section 8).

## 4. Design

### 4.1 Settings

Held with the loan's standing instructions, written by the current holder of the borrower position or that holder's account manager, cleared by the same wallet at any time. They follow the wallet, as the other instructions do.

| Setting | Meaning | Bounds |
| --- | --- | --- |
| Stay with my lender | the existing extension or renewal limits | as today |
| Continue with another lender | on or off | offered where 4.2 applies |
| Highest rate | the most the loan's rate may be after a continuation | the platform's highest rate; the warning-band check on setting, as for a renewal limit |
| Term after continuing | the base term the loan runs for after a continuation | one of the base terms the instant market offers; 30 days unless chosen |
| Accept a floating rate | off, or on with the same highest rate as a cap on the whole rate (4.4) | once floating loans exist |
| Accept a smaller loan | off, or the least principal the loan may continue at (4.3) | at least the pair's smallest loan |
| Repay from my reserve | the existing instruction and its lead time | as today, up to one day |
| Repay from my collateral | on or off, with a price tolerance and a time (4.5) | tolerance 0.5% to the manual route's cap; the time as 4.5 |

- "Repay from my reserve" and "repay from my collateral" may both be set. The reserve is tried first (4.6).
- Setting "repay from my collateral" is refused where the manual full "repay with collateral" route could not run on the loan: an asset that is not an ERC-20, an asset that is not liquid and priced, or the holder on the lender side of the same loan.
- **Protected accounts.** The rule of `ExitBeforeLiquidationDesign.md` 4.1 applies: a change that can cause collateral to be sold, sold sooner or sold at a worse price waits the account's delay, and so does a change that raises the highest rate or switches a floating rate on. A change that can only lessen any of these is immediate. A lock or a replacement freezes the plan with the other instructions.
- **Sanctions.** A flagged wallet cannot set the plan. A step already set still runs where it pays a lender what the lender is owed; what is left for a flagged holder is held, as the manual routes hold it.

### 4.2 Continue with another lender, on more loans

`InstantMarketDesign.md` 6.1 designs this step for a loan the instant market opened. This design keeps that step whole and widens which loans may use it.

- **Which loans.** An ERC-20 loan, active, with interest by time, on a pair where the instant market is on, whose borrower switched the step on. It no longer matters how the loan was opened: from an instant borrow, an accepted offer, a matched request or an Auto-lend fill.
- **When.** Inside the loan's extension window, and only when the loan's own lender does not continue it: for a loan made from a slot, the lender-side reasons of 6.1; for any other loan, when the lender's extension limits are absent, switched off, or do not admit an extension at the loan's rate for one base term. The entry reads this itself, so the loan's own lender at the unchanged rate always has first place.
- **Who takes it, at what rate, and what each side receives:** as 6.1. One slot with the takeover consent, passing the as-new test at the new rate; the slot's minimum rate, never above the borrower's highest rate; the outgoing lender is paid what a full repayment at that moment pays it, through the lender side's one order of payment, with the principal from the incoming slot and the interest (and any late fee, where the step runs inside the grace period) from the borrower, drawn as an extension's charge is drawn today: the loan's payment reserve first, then the holder's other free vault balance in that asset; the borrower keeps the loan record, the collateral, the lien and the position; the loan is extended from that moment by the in-place extension, for the base term the borrower chose; the fee is the difference for the added time.
- **A loan the instant market did not open becomes an instant-market loan at that moment.** It is then held by a slot, renews under section 6, and its lender may leave by a takeover under section 7. Its record is marked, it keeps the group it already has (a rate auction's loans share one, and the one-position view and the group helpers must go on finding it there) or gets a group of its own where it has none, and the common ledger's instant figure takes its principal at that moment. The ledger's statement changes from "whether the instant market opened a loan is fixed when it opens" to "a loan enters the instant figure when the instant market opens it or continues it, and never leaves it while it is open".
- **A loan that charges full-term interest is not offered this step.** It has no moment before the due date at which the lender may be repaid for less than the whole term, and the instant market's slots take interest by time only. It keeps steps 1, 3 and 4.
- **A pair where the instant market is not on** keeps today's automatic refinance, and steps 3 and 4. Section 7, alternative 4 says why this design does not open a second continuation route there.

### 4.3 Continuing as a smaller loan

Where the incoming slot can take less than the principal (its room or its capital is short) and the borrower switched "accept a smaller loan" on:

- The incoming slot pays what it takes, which is at least the borrower's stated least. The rest of the principal is paid by the borrower in the same step, with the interest, drawn as an extension's charge is drawn (the payment reserve first, then other free vault balance). The outgoing lender still receives the whole amount a full repayment pays. The step is refused when that does not cover the rest.
- The loan continues at the smaller principal with the incoming lender. The collateral is unchanged, so the loan is safer than before; the borrower may release the surplus by the existing partial withdrawal.
- It is one in-place extension with a principal reduction through the interest ledger, the reduction a part repayment makes. The outgoing lender is paid in full, so its agreement to part repayment is not asked.

One loan keeps one lender. Section 7, alternative 5 covers splitting a loan among several incoming lenders.

### 4.4 A fixed loan continuing at a floating rate

Built once floating loans exist (the rate reference series). Until then the setting is absent.

- With "accept a floating rate" on, a slot that prices by the reference plus a margin is a candidate for a fixed loan, only where the continued loan carries a **cap on the whole rate at or below the borrower's highest rate**. The borrower's one number then bounds the loan's rate whether it is fixed or floating. A slot that does not accept such a cap is not a candidate.
- The continued loan is a floating loan from that moment: its formula, floor and cap are set by the extension through the interest ledger, and its review and loan page change to the floating statements.
- A floating loan continuing as a floating loan is 6.1 unchanged: the borrower's limit is the highest margin, and the loan's own cap, or the absence of one, is stated on its own line.
- A floating loan does not continue as a fixed loan under this design. The borrower who wants a fixed rate replaces the loan.

This is the answer to "switch to a flexible rate": it is the borrower's consent, given in advance or at any time, and it helps exactly where a floating-rate lender stands ready and a fixed-rate lender does not.

### 4.5 Repay from my collateral at the due date

The health-level instruction's "close the loan" form (`ExitBeforeLiquidationDesign.md` 4.2), with a date in place of a health level. It is the same executor, sizing, floor, calm-market test, settlement and event. Only the condition differs.

- **Condition.** The loan is Active, the instruction is live for the current holder, and the time is inside the instruction's window:
  - **Before the due date** (the default, owner decision 2026-11-19): from the borrower's lead time before the due date, 12 hours unless changed and at most one day, until the end of grace. A borrower who set a plan for the due date has handed that date to the plan, so the grace period is not time they mean to use. A run before the due date pays no late fee, and the whole grace period stays behind it: a sale that must wait for a calm market can still run in grace, with the late fee of that moment. The card says beside it: "No late fee. If the sale has to wait, it can still run in the grace period."
  - **On the last day of grace** (the borrower's choice): from one day before the end of grace, or from the due date where the grace period is shorter than a day, until the end of grace. The borrower keeps the grace period to repay by hand, and the sale includes the late fee: 1% of the principal on the first day past due, plus 0.5% a day, up to 5%. With the default grace periods that is 1% on a loan under 30 days, 2% on a loan of 30 to 89 days, 4% on a loan of 90 to 179 days and 5% on a longer one. It is still less than a default costs, which adds the handling fee, the keeper bonus and the forced-sale floor to the same late fee. The card warns beside it: "Adds a late fee of F on this loan. If the sale cannot run that day, the loan defaults."
  - The default is the same whether this step is set alone or with the others, so the card has one rule.
  - The card shows the late fee figure for this loan beside both choices.
- **Amount, price and settlement:** as the close form. The debt is what a manual repayment owes at that moment. It sells the least collateral whose value, less the tolerance, covers the debt, and does not run if the whole collateral cannot. The lender is paid in full, the loan ends Repaid, and the unsold collateral and any proceeds above the debt are held for the borrower position.
- **The calm-market wait applies,** and the holder may switch it off for their own instruction, with the statements of that design. Near a date the wait matters more than near a health level. With the default time, a run that waits past the due date pays the late fee and may still run until the end of grace. On the last day of grace there is little time left to wait, and on a loan under 7 days the whole grace period is one hour; a sale that cannot run before the end of grace does not happen, and the loan defaults as today. The card says both.
- **When it does not run:** the skip reasons of that design, and one more: a continuation or a repayment from the reserve could run now (4.6).
- A loan may carry both forms: the health level acts on a price fall at any time, the date acts at the end of the term.

### 4.6 The order

The order comes from each step's window and one check, not from stored state.

| Step | Window | Yields to |
| --- | --- | --- |
| 1. Stay with my lender | the extension window: three days before the due date to the end of grace | nothing |
| 2. Continue with another lender | the same window | step 1: refused while the loan's own lender would continue at the unchanged rate |
| 3. Repay from my reserve | the lead time (up to one day) before the due date, to the end of grace | step 1: skipped while the loan's own lender would continue now. Steps 1 and 2 have also had at least two days first |
| 4. Repay from my collateral | its lead time before the due date by default (12 hours, at most one day), or the last day of grace, to the end of grace | step 3: skipped while the repayment from the reserve could itself run now, which needs that step switched on, live for the current holder, inside its window, and the reserve covering the full repayment. A funded reserve alone does not hold step 4 back: a reserve may be there for interest or an extension with step 3 off. Step 1: skipped while the loan's own lender would continue now |

- A continuation moves the due date, so steps 3 and 4 are no longer inside their windows. Nothing has to cancel them.
- **Steps 3 and 4 read the same check for step 1**: whether the loan's own lender's limits and the borrower's admit an extension now. Their windows overlap step 1's, and both are open to any caller, so the two days' head start alone would not keep a caller from repaying a loan its lender stands ready to continue. While the check passes, the repayment from the reserve and the repayment from collateral each skip with that reason. Today's repayment from the reserve has no such check, because today a loan carries one plan or the other; it gains it with the removal of that exclusion.
- Step 4 cannot check on-chain whether some other lender's slot would take the loan, because the candidate is chosen off-chain. So from step 4's start, a continuation with another lender and a repayment from collateral may both be possible, and whichever is run first happens. The borrower chose both, the caller gains from neither, and the card states it: "from this time, your collateral may be sold to repay even if a lender appears later".
- The platform's keeper tries the steps in order on each pass.
- **The mutual exclusion is replaced** by this order: a loan may carry any of the four steps. Today's refusals (`DueDatePlanExists`) are removed with it. The automatic-refinance limits remain a separate setting for the route that posts a request (4.2, last point), and may stand beside the plan: a refinance request live on the loan pauses every step, as it pauses the other instructions.

### 4.7 Keeper, app and indexer

- **Keeper.** The renewal pass (designed with 6.1) covers step 2 on the wider set of loans: own lender first, then the cheapest slot that fits, a fixed slot before a floating one at the same starting rate. One more step in the standing-instruction pass for step 4, with its own arming flag, shipped unset. Both have rows in the permissionless-steps ledger. An ops alert when a due step has not run.
- **Alerts to the holder.** Before the window opens: what the plan will try and in what order. When a step runs, with its figures. When step 2 found no lender. When step 4 is waiting for a calm market, and when it has passed the due date and the late fee has started. When the plan is exhausted: the loan now ends at its due date, with the time left.
- **App.** One card, "At the due date", replacing the separate automatic-extension, automatic-refinance and repay-at-due cards on a loan. The steps in order, each with its state on this network (the keeper pass runs here or does not, `DefaultPathsDesign.md` rule 7), the borrower's limits, and the statements of section 8. The Borrow review offers the same card. When a borrower chooses automatic refinance (the request to their own terms, or "continue with another lender"), "repay from my collateral" is pre-selected beside it where the collateral is liquid and the keeper pass runs on this network, with its benefit stated, and the borrower can switch it off before confirming (owner decision 2026-11-19, section 10). Where the collateral is not liquid or the pass does not run, the step is shown as not available here and is not selected.
- **Indexer.** The continuation event of 6.1 and the run event of the collateral repayment. The loan's page shows "continued with another lender" and "repaid from your collateral by your instruction", never as a refinance or a liquidation.

## 5. Contract changes

| Part | Change |
| --- | --- |
| The renewal entry (6.1, not yet built) | Admits a loan the instant market did not open, under 4.2; reads the own-lender-first test from the extension limits where the loan was not made from a slot; marks the loan as an instant-market loan and moves the ledger's instant figure; takes a smaller principal with a reserve payment (4.3); with floating loans, changes the loan's pricing through the interest ledger under the cap rule (4.4). |
| Standing instructions | The plan's settings (4.1). The date condition for the collateral repayment, on the health-level instruction's executor (4.5). The yields of 4.6: the repayment from the reserve and the repayment from collateral both skip while the loan's own lender would continue now, and the repayment from collateral also skips while the repayment from the reserve could itself run now (switched on, live, inside its window and fully funded). The mutual exclusion and its error removed. |
| The market ledger | The instant figure takes a continued loan (4.2). |
| Previews | `previewContinuation(loanId, incoming, slot)` and the date form of `previewExit`, each returning whether the step is due, the reason it would be refused, and every figure of the run. |
| Events | The continuation event states whether the loan entered the instant market at this step, the principal the incoming lender took and the part the reserve repaid. The collateral repayment's event states which condition ran it: the health level or the date. |

The accrual segment's restart at a continuation goes through the one writer of `RepaymentByOthersDesign.md` 3.2, as every extension does.

## 6. Tests

1. A loan opened from an accepted offer, on an instant-market pair, whose lender set no extension limits: continued with a slot at the slot's minimum rate; the outgoing lender receives exactly what a full repayment at that moment pays; the borrower's loan record, collateral, lien and position are unchanged; only the renewal fee is charged; the loan is marked instant, the ledger's instant figure rises by its principal, and a later renewal and takeover work on it.
2. Refused: the loan's own lender would continue at the unchanged rate; the slot's rate is above the borrower's highest rate; a loan with full-term interest; a pair where the instant market is off; the reserve short of the interest; outside the extension window; a refinance request, a sale listing or a swap order live.
3. Inside the grace period the outgoing lender also receives the late fee, from the borrower's side.
4. A smaller loan: the slot takes part, the borrower's reserve and free balance repay the rest, the outgoing lender is paid in full, the loan continues at the smaller principal and its health factor is not lower; refused below the borrower's least, and when the borrower's side does not cover the rest.
5. With floating loans: a fixed loan continues with a floating slot only with a cap at or below the borrower's highest rate, and the loan's rate never reads above it afterwards; refused where the slot accepts no such cap, and with the setting off.
6. Repay from collateral at the default time, before the due date: runs from the lead time, pays no late fee; a run delayed past the due date still runs inside grace with the late fee of that moment; sells the least collateral that covers the debt at the tolerance, leaves the rest held for the borrower position; equals the manual full route's figures. Refused before the lead time and after the end of grace. Skipped while the reserve covers the repayment, while the loan's own lender would continue, while the pair is not calm (unless the holder switched the wait off), and when the collateral cannot cover the debt.
7. With the time set to the last day of grace: refused before one day from the end of grace (or before the due date where the grace period is shorter than a day); the late fee at that moment is in the debt and reaches the lender's side as on a manual late repayment; after the end of grace it is refused and the loan may be defaulted as today.
8. Order: with steps 1 to 4 all set and a willing lender, the loan is extended and steps 3 and 4 never run, including when a third party calls the repayment from a funded reserve inside its window before the keeper extends (it skips with the own-lender reason); with no lender and a funded reserve, step 3 repays; with no lender and no reserve, step 4 repays; with no lender, a funded reserve and step 3 switched off, step 4 repays; a continued loan that had a group keeps it; with nothing able to run, the loan defaults as today.
9. A loan carrying both the health level and the date: each runs on its own condition, and the event names which.
10. Protected account: setting the collateral repayment, raising the highest rate and switching the floating rate on each wait the delay; clearing is immediate.
11. All four steps may be set on one loan; the old refusal is gone.

## 7. Alternatives considered

1. **Keep the loan with its lender at a floating rate when nobody else takes it.** The owner's first question. It keeps a lender's money in a loan past the date the lender agreed to, and a higher rate does not make the lender whole if it needed the money. Where the lender is willing to stay at a higher rate, step 1 and 6.1 already do it. Rejected as a forced step.
2. **A lender of last resort from the treasury or the reserve.** It would turn the reserve into a lender to borrowers whom no lender chose, which is the opposite of what it is for, and it would put the platform's own money at the point of worst selection. Rejected.
3. **Improve the posted refinance request instead.** Let anyone post the request from the borrower's standing limits and pay the wallet's share from the reserve. It still ends in a new loan record, a new pair of position tokens and a new initiation fee on the whole principal, where the continuation keeps the record and charges a renewal's fee. It remains the route on pairs outside the instant market, and may be designed later if those pairs need it.
4. **Open the continuation on every pair.** The takeover consent exists only on the instant market's pairs, by the owner's rule that the instant market is blue-chip only. A slot on another pair has agreed to keeper fills at matched terms, not to taking a standing loan at its minimum rate. Widening that consent is a decision about the instant market's scope, not about this plan. Not proposed.
5. **Split the loan among several incoming lenders.** An instant borrow fills from several slots, so a large loan could continue the same way. It would turn one loan record into several, with the collateral, the lien and the position divided at that moment. That is a new operation on a live loan. This design offers the smaller loan (4.3) instead. Left for later, with its own card if large loans show the need.
6. **Sell collateral only after the default.** Today's state. The borrower pays the late fee, the handling fee and the keeper bonus, at a worse floor, for a sale they would have made themselves a day earlier.
7. **Run the collateral repayment at the due date for every loan, without an instruction, or make it a step the borrower cannot switch off.** The owner asked on 2026-11-19 whether it should be compulsory, since the lender must get its asset back. The lender is repaid without it: an unpaid loan defaults at the end of grace and its collateral is sold, with the late fee paid to the lender for the wait, and no borrower can switch that off. A compulsory early sale would take the grace period away from every loan and sell a borrower's collateral a day before a late payment they meant to make. Kept as the borrower's choice, pre-selected, with the outcome of both states stated (section 8). The owner agreed to this on 2026-11-19.
8. **Keep the three plans mutually exclusive and add the new steps as two more.** A borrower would have to pick one outcome in advance, which is the gap this design closes. Rejected for the fixed order.

## 8. What this does not do, stated to the user

On the card and in the review, before the borrower confirms:

- "These steps run only if someone runs them. On this network the platform's keeper does / does not." (per step)
- "Continuing with another lender needs a lender who stands ready at or below your highest rate. If none does, this step does nothing."
- "If your lender leaves, this loan may continue with another lender at up to X% a year." For a floating rate: the reference now, the margin, and the cap, each on its own line.
- "Repaying from your collateral sells part of your collateral. You may receive as little as the oracle price less your tolerance. It waits while the price is moving fast. A sale after the due date includes the late fee, and if it cannot run before the grace period ends, the loan defaults."
- "From this time, your collateral may be sold to repay even if a lender appears later."
- **The outcome of an unpaid loan is stated for both states of "repay from my collateral"** (owner's request, 2026-11-19), because the lender is repaid from the collateral either way and the switch decides only when and at what cost to the borrower:
  - On, before the due date: "If no lender takes your loan and it is not repaid, part of your collateral is sold shortly before the due date to repay it. No late fee, unless the sale has to wait into the grace period."
  - On, on the last day of grace: "If no lender takes your loan and it is not repaid, part of your collateral is sold on the last day of the grace period to repay it, with a late fee of F. If the sale cannot run that day, the loan defaults." The statement shown is always the one for the time the borrower selected.
  - Off, shown as a warning when the borrower switches it off or leaves it off beside an automatic refinance: "If no lender takes your loan and it is not repaid by the end of the grace period, the loan defaults. Your collateral is sold to repay the lender, with a late fee of F and the default's fees." F is this loan's figure. For collateral that cannot be sold, the warning says it is handed to the lender instead.
- "None of this stops a liquidation caused by a fall in your collateral's price. That is what 'Sell and repay before liquidation' and 'Keep my loan healthy' are for."
- "If no step can run, the loan ends at its due date, with the late fee and the grace period, as any loan does."

No step is called a guarantee, protection or insurance, and no rate is promised.

## 9. Recommendation

Build it in two parts, each beside the work it extends:

1. **Repay from my collateral at the due date** (4.5, and the order of 4.6 for steps 1, 3 and 4), with the health-level instruction (#3752). It is small, it needs no lender, and it is the step that answers "no lender takes the loan".
2. **Continue with another lender on more loans** (4.2, 4.3), with renewal and 6.1. The floating-rate setting (4.4) follows with floating loans.

## 10. Choices for the owner

1. **When the collateral repayment runs by default.** Settled by the owner on 2026-11-19: before the due date, with its benefit stated, and "on the last day of grace" as the borrower's own choice with its warning (4.5). The owner first chose the last day of grace, as a fixed term works, and then chose the earlier time for a borrower who set an automatic exit; this design uses the earlier time as the one default, which the owner was told.
2. **Whether it is pre-selected.** Settled by the owner on 2026-11-19: pre-selected when the borrower chooses automatic refinance, where the collateral is liquid and the keeper pass runs, and the borrower can switch it off. The reason: a borrower who asked for an automatic exit has said they do not want a default, and the default that follows a failed refinance sells the same collateral later, on worse terms and after a late fee. A borrower who chose no automatic exit is offered the step and it is not selected. Alternative considered: offered and never pre-selected, since it sells collateral.
3. **Whether "continue with another lender" is pre-selected on a loan the instant market did not open.** Recommended: yes where the keeper pass runs, as `DefaultPathsDesign.md` already pre-selects it on an instant borrow with no end date; the borrower's highest rate is asked beside it.

## 11. Open items for the builder to raise, not decide silently

1. How the own-lender-first test reads for a loan not made from a slot, where the lender's extension limits admit an extension only at a different rate inside the borrower's limit: this design treats that as the lender continuing (step 1), at the lender's rate.
2. Whether marking a loan as an instant-market loan mid-life needs anything beyond the record, the group (kept where there is one) and the ledger figure (rewards, the lend-until limit, the slot's exposure are covered by 6.1's move of the lender position).
3. The size of the renewal entry with 4.2 to 4.4 in it; a split along a seam, never a trim.
4. Whether the date form shares the health-level instruction's storage slot or takes its own row, given that a loan may carry both.
