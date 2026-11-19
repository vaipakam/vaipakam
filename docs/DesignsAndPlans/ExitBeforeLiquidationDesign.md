# Exit before liquidation: a fourth standing instruction — design

**Status:** owner asked for it on 2026-11-19 ("worth doing it now itself to protect the borrower to some extent at least"), to be built before the pre-audit refactor. Card #3752. It is the swap mode that #1206 asked for and `StandingInstructionsDesign.md` (#3681) left out. Design first, no code yet. Reaches a chain by fresh deploy. The holder's switch for the calm wait (4.1, 4.5) is an owner decision of 2026-11-19.
**Related:** `StandingInstructionsDesign.md`, `ForcedSaleSizingDesign.md`, `PayoutDestinationRuleDesign.md`, `KeeperAuthorityMatrix.md`.
**Base:** the routes and names below were read on the batch branch of #3743 (`claude/project-thread-ijafuu` at `4b747f902`), where the three standing instructions, the loan reserve and the vault-only payout rule are built. Main does not have them yet.

## 1. Why

A borrower whose collateral falls in price has three ways out today, and all three need the borrower to be awake, or to have set money aside:

- add collateral or repay by hand;
- the "keep my loan healthy" instruction, which needs a collateral reserve the borrower funded in advance;
- "repay with collateral" (the full and partial swap-to-repay routes), which sells the pledged collateral and repays, but only when the borrower sends the transaction.

A borrower with no spare money and no phone signal has none of them, and the loan is liquidated. A liquidation costs the borrower more than a sale they would have made themselves:

| | Liquidation | Repaying with collateral |
| --- | --- | --- |
| Keeper bonus | up to 3% of the debt | none |
| Handling fee | 2% of the debt | none |
| Worst price accepted | the liquidation floor (up to 6% below the oracle price, less in a calm market) | at most 3% below the oracle price |
| When it happens | at a health factor below 1 | whenever the borrower chooses |

The figures are the defaults in force. So a borrower who would rather sell and close than be liquidated saves up to five percent of the debt by selling first, and sells at a price bound they chose. This design lets the borrower leave that decision as a standing instruction.

## 2. What the user gets

One more instruction on a loan, set by the holder of the borrower position:

> **Sell and repay before liquidation.** When my loan's health factor falls below a level I choose, sell enough of my collateral to repay, at no worse than the price tolerance I set. Unless I say otherwise, wait while the price is moving fast.

Two forms. The loan carries one of them or neither:

1. **Close the loan (exit).** Sell the least collateral that repays the whole debt, close the loan, and leave the rest of the collateral for me to collect. Offered on every loan the manual full route serves.
2. **Reduce the loan.** Sell the least collateral that brings the loan back to my target, and at least back inside the loan-to-value limit it opened with, and keep the loan open. Offered only where the loan allows partial repayment, since it is a partial repayment.

It needs no reserve and no money set aside. It spends only the collateral already pledged to that loan, and only to pay a debt the borrower already owes.

It is a convenience, not a promise. Section 8 says what it cannot do.

## 3. The rule

1. **It is the borrower's own repayment, made on a standing instruction.** The sale, the amounts, the split and the events are those of the manual "repay with collateral" routes. Only the authority differs: the manual route needs the holder's transaction, this one needs the holder's instruction to be live and its condition to be true. There is no second settlement path to keep in step.
2. **The condition is read on-chain at the block it runs in.** The loan's health factor, from the loan's stamped settings (#3437), is below the holder's level.
3. **The amount is computed on-chain.** The caller supplies no amount.
4. **The price is bounded by the holder's tolerance, and the market must be calm.** The sale must deliver at least the oracle value of what was sold, less the tolerance. The tolerance is never looser than the manual route's cap. A run by someone other than the holder is refused unless the pair is calm against the last two hourly price checkpoints, the same test the forced-sale floor uses, so a run cannot be timed into a moment when the oracle and the market disagree. The holder may switch this wait off for their own instruction (4.1). The tolerance, the health test and the refusal on a stale or distrusted price apply either way.
5. **Anyone may run it, and the caller receives nothing.** No bonus, no fee, no share of the sale.
6. **No handling fee and no keeper bonus.** The platform takes what it takes on any repayment (its share of the interest) and nothing more.
7. **Everything the borrower is left with is held for the borrower position and collected by its holder**, exactly as the manual full route leaves it: the unsold collateral on the borrower's claim, and any proceeds above the debt on the position's surplus. This is the payout rule's case of a step someone else triggered (`PayoutDestinationRuleDesign.md` 4.2, table rows 2 and 6): the amount travels with the position, and one Collect brings it into the holder's vault as free balance. Nothing reaches a wallet.

## 4. Design

### 4.1 Settings

Written by the current borrower-position holder, or that holder's account manager, through the existing instruction setter, and cleared by the same wallet at any time:

| Setting | Meaning | Bounds (governed) |
| --- | --- | --- |
| Form | close the loan, or reduce it | reduce only where the loan allows partial repayment |
| Level | the health factor below which it runs | 1.03 to 1.40 |
| Target (reduce only) | the health factor a reduction restores | above the level by the top-up's margin, at most 2.0. A reduction always restores at least the health factor at the loan's opening loan-to-value limit (4.3), so a lower target has no effect, and the app shows the figure that will apply |
| Tolerance | how far below the oracle price the sale may fill | 0.5% up to the manual route's cap (3%); the default is 1% |
| Act in a fast market | off: the run waits until the pair is calm (rule 4). On: the run does not wait | off by default; only the holder's own choice turns it on |

- Setting it is refused where the matching manual route could not run on that loan: collateral or lending asset not an ERC-20, either not liquid and priced, the holder on the lender side of the same loan.
- **Setting it is refused while the health factor is already below the level.** It would run at once. The app sends the user to the manual route, where they see the figures before they sign.
- **With "keep my loan healthy".** Both may be set. The level must then sit below the top-up's trigger by the same margin, so the top-up acts first. The sale is skipped while a top-up could run now and would lift the health factor to the level or above.
- **With the due-date plans** (repay at the due date, automatic extension, automatic refinance): both may be set. Those act on the date, this acts on health. A refinance request that is live on the loan pauses this instruction like any other step in flight (4.4).
- **The instruction follows the wallet, not the position**, as the others do. It runs only while the position's holder is the wallet that set it.
- **Act in a fast market.** The switch changes one thing: whether the calm test of rule 4 is applied to this holder's run. With it on, the sale must still deliver the oracle value less the holder's tolerance, the health factor must still be below the level, and a stale or distrusted price still refuses the run. No governed setting and no caller can turn it on for a holder, and there is no platform-wide form of it. What the holder gives up is stated in 4.5 and shown before they confirm.
- **Protected accounts.** One rule: a change that can cause more collateral to be sold, or sold at a worse price, waits the account's delay; a change that can only lessen either is immediate. So setting the instruction, raising the level, raising a reduction's target, loosening the tolerance, switching "act in a fast market" on and changing the form each wait the delay, on a new instruction and on one already live. Lowering the level, lowering the target, tightening the tolerance, switching "act in a fast market" off and clearing are immediate. While a change waits, the instruction runs on its old settings. A lock or a replacement freezes it with the others.
- **Sanctions.** A flagged wallet cannot set it. One already set still runs, because it pays the lender what the lender is owed; what is left for a flagged holder is held, as the manual route holds it.

### 4.2 Running it: close the loan

`runExit(loanId, adapterCalls, validUntil)`, callable by anyone.

- Runs only when the loan is Active, inside its repayment window (not past the end of grace), the instruction is live for the current holder, the health factor is below the level, and the pair is calm (rule 4) or the holder has switched the calm wait off (4.1). "Calm" is the shared rule of `LibPairCalm` with the forced-sale floor's bound (2% to start): the pair's rate now is within the bound of its rate at both of the last two hourly checkpoints. A missing checkpoint reads as not calm. With the wait switched off the same read is still made, and its answer is recorded but no longer decides the run: the shared rule already answers one of three ways (calm, moving, no checkpoint) without reverting, and the run goes ahead on any of them.
- The debt is what a manual repayment owes at that moment: principal, interest by the loan's own terms (full-term interest where the loan carries it), and a late fee after the due date.
- It sells the least collateral whose value, less the tolerance, covers the debt. This is the manual route's sizing with the holder's tolerance in place of the cap. If the whole collateral cannot cover the debt at that floor, it does not run.
- The caller supplies the swap routes to try, as a liquidator does. Each route must deliver the floor or it is undone and the next is tried. If every route fails the call reverts and nothing has moved.
- Settlement is the manual full route's: the lender is paid in full, the platform takes its share of the interest, the loan ends Repaid, both position tokens are marked as a repaid loan's are.
- The unsold collateral and any proceeds above the debt are left as the manual full route leaves them: held for the borrower position, for its holder to collect (rule 7).
- The event states the health factor before, the level, the collateral sold, the proceeds, the debt paid, the amount above the debt, the collateral released, the caller, whether the run was made with the calm wait switched off, and the calm rule's answer at that moment as read: calm, moving, or not known because a checkpoint was missing. A run with the wait in force can only state calm; a run with it switched off states whichever of the three was read, so the record shows a sale made in a fast market as one and never states a market as calm or moving when that was not checked.

### 4.3 Running it: reduce the loan

`runReduce(loanId, adapterCalls, validUntil)`, callable by anyone, under the same conditions.

- It sells the least collateral that brings the health factor to the higher of two figures, counting the proceeds at the floor: the holder's target, and the health factor at which the loan is back inside the loan-to-value limit it opened with. The manual partial route refuses a result above that limit, so a sale sized to a lower target would revert every time. The preview reports which of the two applied. Selling collateral to repay debt raises the health factor whenever the collateral is worth more than the debt after the tolerance, which holds for any loan at or above a health factor of 1.
- Settlement is the manual partial route's, with its rules unchanged: the accrued interest is paid first, the rest retires principal, the loan's smallest partial repayment applies, and the health factor after must not be lower than before.
- Where the amount needed is below the loan's smallest partial repayment, the smallest is used. Where it would repay the whole principal, the call closes the loan as 4.2 does.
- The top-up's minimum interval (one hour to start) applies between two reductions on one loan.

### 4.4 When it does not run

Skipped, with the existing skip event naming the reason, when: the holder is no longer the wallet that set it; a top-up should act first (4.1); the price is missing or distrusted; the pair is not calm, or an hourly checkpoint is missing (neither applies where the holder has switched the calm wait off); the asset or the platform is paused; the collateral cannot cover the debt at the floor (4.2); or the loan is busy. "Busy" is the one rule the three existing instructions already use: a preclose offset offer, a collateral listing, a swap-to-repay order or a refinance request is live on the loan. The holder is alerted when a busy state begins on a loan that carries this instruction, because the instruction is paused until it ends.

A sale whose routes all fail reverts, so it leaves no event. The preview below reports that the instruction is due, and the keeper's alert tells the holder when a due instruction has not run.

`previewExit(loanId)` returns whether the instruction is due, the skip reason if any, the amount to sell, the least proceeds a route must deliver, the calm rule's answer now (calm, moving or no checkpoint), whether the holder has switched the calm wait off and, for a reduction, which target applied. The keeper builds its quote from it and the app shows it.

### 4.5 What the caller can and cannot do

The caller chooses the route, and nothing else. A caller who brings a poor route can leave the holder with as little as the floor, and the holder should expect exactly that: anyone may run it, so a caller who routes the sale through a market of its own and keeps the difference will often arrive before the platform's keeper does. **The tolerance is therefore the price the holder accepts, not a worst case.** The app says so beside the setting, and shows the cost at the chosen tolerance against the cost of a liquidation. The platform's keeper asks for the best quote, as it does for a liquidation.

The calm test (rule 4) closes the other way a caller could gain: running at a moment when the oracle price is away from the market, where a floor measured from the oracle bounds nothing real. It also keeps a brief dip in the reported price from closing a loan for good.

**What a holder gives up by switching the wait off.** The floor is measured from the reported price, and in a fast market the reported price can trail the market. The two directions differ:

- **The reported price is above the market** (the market is still falling). Where the gap is wider than the tolerance, the floor sits above what any route can deliver, every route fails, and nothing moves. This fails safe, and it also means the switch does not make the instruction run in every fall. Where the gap is narrower, the sale goes ahead and the holder is paid from the higher reported price.
- **The reported price is below the market** (the market has turned up). The run can go ahead. The holder is paid no less than the reported price less the tolerance, so the caller can keep the gap between the two prices as well, and the holder's cost measured against the market is more than the tolerance. The loan may also be closed or reduced at a moment when, at the market's own price, it was above the level.

The platform does not state a bound for that gap, because it depends on how the price source updates. What still holds with the switch on: the health factor read from the reported price is below the level the holder chose, the sale delivers that price less the tolerance, and a price the guard reads as stale or distrusted refuses the run. In return the instruction can act in a fall of more than the calm bound, where the default would wait and a liquidation could arrive first. The choice is the holder's, and the app states both sides before it is confirmed.

A caller cannot run it early, change the amount, redirect a payment or take any of the proceeds.

### 4.6 Keeper and app

- **Keeper:** one more step in the standing-instruction pass, with its own arming flag, shipped unset. The step depends on the hourly price checkpoint pass being armed on that network; where it is not, every run with the calm wait in force is refused for a missing checkpoint, and the app's card says so: on that network the instruction can act only with the wait switched off, every such run is recorded with the market's state not known, and the card states both plainly and does not present the switch as a fix. It reads `previewExit`, builds the swap quote with the liquidation pass's quote builder, and submits. A row in `contracts/permissionless-steps.json` for each executor. An ops alert when a due instruction has failed more than a set number of times.
- **App:** in "Reserve and instructions", a card "Sell and repay before liquidation": the form, the level on the same scale as the health bar, the tolerance, the "act in a fast market" switch (off, with the two cases of 4.5 in plain words beside it and a confirmation of its own when turned on), and a plain estimate of what a sale at the level would leave the user against what a liquidation would. The statements of section 8 are shown before the user confirms.
- **Alerts to the holder:** when the health factor nears the level, when the instruction runs (with every figure of the event, and a plain line when the sale was made while the price was moving fast, or while that could not be told), when it was due and could not run, and when it is waiting for a calm market.
- **Indexer:** handles the run event and the existing repayment events; the loan's page shows the closing as "repaid by your instruction", not as a liquidation.

## 5. Contract changes

| Where | Change |
| --- | --- |
| Instruction record and setter | The form, level, target, tolerance and the "act in a fast market" switch, beside the three existing instructions. The protected-mode delay rule of 4.1. |
| The two "repay with collateral" routes | Each gains a second authority, "the holder's live instruction", reached only by self-call from the executors, and takes the price floor as an input bounded by the cap. The manual entries pass the cap, as today. Sizing, settlement and events are not copied. |
| Executors and preview | `runExit`, `runReduce`, `previewExit`. In their own facet if the instruction facet has no room; the builder measures. |
| Reduce sizing | One function in the sale-sizing library: the least sale that reaches a target health factor at a floor. |
| Pre-deploy checks | Rows in the permissionless-steps ledger; the storage-layout golden file rewritten; facet sizes with the deploy-sanity suite; the refresh-together note for the executors and the two routes. |

## 6. Tests

1. Exit: at a health factor just below the level the loan closes Repaid; the lender receives what a manual repayment pays; the treasury receives its share of the interest and no handling fee; the caller receives nothing; the unsold collateral and the amount above the debt are held for the borrower position, and the holder's Collect brings both into the vault as free balance.
2. The same loan and price run by the manual full route gives identical lender, treasury and borrower figures at the same tolerance.
3. Health factor at or above the level: refused.
4. Tolerance: a route delivering below the floor is undone and the next tried; all failing reverts with nothing moved; a tolerance outside the bounds is refused at setting; the default is 1%.
5. Calm: a run is skipped while the pair has moved past the bound against either of the last two hourly checkpoints, and when a checkpoint is missing; it runs once both are within the bound; the liquidation routes are not affected by the test.
6. Collateral that cannot cover the debt at the floor: skipped with its reason; the liquidation routes still work.
7. Reduce: the sale is the least that reaches the higher of the holder's target and the opening loan-to-value limit, and the preview names which; a target below that limit still runs and does not revert; the smallest-partial rule; the whole-principal case closes the loan; the interval; refused at setting on a loan that does not allow partial repayment.
8. With a top-up set: the level above the trigger is refused; the sale is skipped while a top-up could run and would suffice; it runs when the reserve is empty.
9. Setting while the health factor is below the level is refused.
10. Position transfer: the old holder's instruction is skipped; the new holder's works.
11. Protected account: setting, raising the level, raising the reduction target, loosening the tolerance and changing the form each wait the delay, on a new instruction and on a live one, and the old settings apply until the wait ends; lowering the level or the target, tightening and clearing do not wait; a lock freezes it.
12. A flagged holder: cannot set; a set one runs, the lender is paid and the holder's part is held.
13. Past the end of grace: refused, and the time-based default proceeds as today.
14. A hostile caller's route that delivers exactly the floor succeeds, and the holder's loss equals the tolerance and no more.
15. Every skip reason of 4.4 emits and changes nothing, including each of the four busy states.
16. An invariant over random prices and sequences: a run never pays the lender less than a manual repayment would, never pays the caller, and never sells more than the amount `previewExit` reported plus the manual route's margin.
17. The calm wait switched off: the switch is off on a new instruction; with it on, a run goes ahead while the pair is moving and while a checkpoint is missing, and the event states calm, moving or not known as it was read in each of the three cases; a route below the holder's floor is still undone; a health factor at or above the level still refuses; a stale or distrusted price still refuses; a reported price above the market by more than the tolerance leaves every route failing and nothing moved; one holder's switch has no effect on another holder's loan; on a protected account switching it on waits the delay and the calm wait applies until then, and switching it off is immediate.

## 7. Alternatives considered

1. **Leave it to liquidation and the app's warnings.** The status quo. It costs the borrower the bonus and the handling fee, and helps nobody who is away.
2. **A keeper permission the borrower grants (#1206 as first written).** Adds a grant to manage and a dependence on one keeper. Rejected for the reason the other instructions rejected it.
3. **Only the platform's keeper may run it**, so no outsider can bring a poor route. Rejected: a step only one party can run fails when that party is down, and the cost of that failure here is a liquidation. The tolerance bounds a poor route instead.
4. **Sell through the forced-sale host as a new kind of forced sale.** Rejected: that host ends a loan as a default does, with claims for both sides and the default's charges. This is a repayment, and uses the repayment's settlement.
5. **Pay the caller a small reward.** Makes outside callers likely, but it is a cost on the borrower and a reason to push a price to the level. Not built.
6. **Use the liquidation's price floor.** Rejected: it is looser than the manual route's cap, and the point of the instruction is a better price than a liquidation.
7. **Wait a few minutes below the level before acting**, against a brief dip. Not needed: the calm test of rule 4 does this work with a rule the platform already has.
8. **No calm test.** The first draft. Rejected on the security review of 2026-11-19: a floor measured from the oracle bounds nothing when the oracle is away from the market, and anyone may choose the moment.
9. **The calm test always applies, with no switch for the holder.** The safest price, and the second draft. Not chosen (owner decision, 2026-11-19): the falls that end in liquidation are often the fast ones, and a holder who would rather sell at a worse price than be liquidated should be able to say so. The switch is the holder's own, off by default, and the security review of 2026-11-19 agreed to it on four conditions, all in the design: off by default and delayed on a protected account (4.1); the holder's floor still binds (rule 4); the health test and the stale-price refusal still apply (4.2); the app states the trade (4.5, 4.6).
10. **A tolerance that starts tight and widens with time** since the level was crossed, so competing callers bid the holder's cost down. A better price for the holder, at the cost of one more recorded step. Kept for after the first version has run on a testnet.
11. **Exit only, no reduce.** Simpler. Kept as the build order (exit first), because a borrower who wants to stay in the loan is better served by a reduction.

## 8. What this does not do, stated to the user

- **It may not run in time.** A price that falls past the level and the liquidation level in one step leaves nothing to act on. Whichever of this and a liquidation is included first wins.
- **It does not act in a fast market, unless you switch that wait off.** While the price has moved more than the calm bound (2% to start) against either of the last two hourly marks, it waits. A sharp fall can therefore reach liquidation before it may run. Left as it is, it protects best against a slow decline.
- **With the wait switched off it can cost more than the tolerance.** It may then sell while the reported price is behind the market. If the market has already turned up, you are paid from the lower reported price, and your loan may be closed when it would have recovered. If the market is still falling faster than the reported price, it may not be able to sell at all (4.5).
- **It costs about the tolerance.** Expect the sale to fill near the floor (4.5).
- **It may not run at all.** A market moving faster than the tolerance, a paused asset, a distrusted price, a missing hourly mark (while the calm wait is in force) or a keeper outage each leave the loan as it was.
- **It cannot be undone.** A closed loan is closed at that moment's price, and a later recovery in the price is not the borrower's.
- **A reduction can repeat.** In a long fall each reduction costs its slippage, and the loan can still be liquidated between two of them.
- **It pauses while another step is live on the loan**: an offset offer, a listing, a swap-to-repay order or a refinance request. The app says so when the instruction is set and when the pause begins.
- **What is left is collected, not sent.** After an exit the holder collects the remaining collateral and any amount above the debt into the vault.
- It does not touch the loan reserve, lend the borrower anything, or act on a loan whose collateral is an NFT or is not priced.

## 9. Recommendation

Build it as designed: the two manual routes gain one more authority, two executors anyone may call, the holder's own tolerance as the price bound, a calm market as the condition unless the holder has switched that wait off for their own instruction, and no payment to the caller. Build the exit first and the reduction second. Ship the keeper step disarmed.

## 10. Settled with the builder (2026-11-19)

1. **Steps in flight:** the existing "loan busy" skip, for all four states (4.4).
2. **The borrower's leftovers:** the manual full route's settlement is kept, so they are held for the position and collected (rule 7).
3. **Reduce sizing:** the higher of the holder's target and the opening loan-to-value limit (4.3).
4. **Gas:** the caller is not repaid.
5. **The optional wait below the level:** replaced by the calm test (rule 4), required by the security review of 2026-11-19 together with the 1% default tolerance.
6. **The level's lower bound (1.03):** measured on each testnet once the keeper step runs there.
7. **Protected accounts:** the delay is built as 4.1 states it, for every change that can cause more collateral to be sold or a worse price.
8. **The holder's switch for the calm wait** (owner decision, 2026-11-19): built as 4.1 and 4.5 state it. It is one more field on the instruction and one branch in the executors' condition; the price floor, the health test and the price guard's refusals are not touched by it.
8. **Where the code goes:** the executors and the preview in their own facet if the instruction facet has no room.

One thing found on the way is outside this design: the manual full route leaves a live preclose offset offer or refinance request on the books when it closes the loan. Whether that route should cancel them is a separate card.
