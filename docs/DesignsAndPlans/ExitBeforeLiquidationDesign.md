# Exit before liquidation: a fourth standing instruction — design

**Status:** owner asked for it on 2026-11-19 ("worth doing it now itself to protect the borrower to some extent at least"), to be built before the pre-audit refactor. Card #3752. It is the swap mode that #1206 asked for and `StandingInstructionsDesign.md` (#3681) left out. Design first, no code yet. Reaches a chain by fresh deploy.
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

> **Sell and repay before liquidation.** When my loan's health factor falls below a level I choose, sell enough of my collateral to repay, at no worse than the price tolerance I set.

Two forms. The loan carries one of them or neither:

1. **Close the loan (exit).** Sell the least collateral that repays the whole debt, close the loan, and release the rest of the collateral to me. Offered on every loan the manual full route serves.
2. **Reduce the loan.** Sell the least collateral that brings the health factor back to my target, and keep the loan open. Offered only where the loan allows partial repayment, since it is a partial repayment.

It needs no reserve and no money set aside. It spends only the collateral already pledged to that loan, and only to pay a debt the borrower already owes.

It is a convenience, not a promise. Section 8 says what it cannot do.

## 3. The rule

1. **It is the borrower's own repayment, made on a standing instruction.** The sale, the amounts, the split and the events are those of the manual "repay with collateral" routes. Only the authority differs: the manual route needs the holder's transaction, this one needs the holder's instruction to be live and its condition to be true. There is no second settlement path to keep in step.
2. **The condition is read on-chain at the block it runs in.** The loan's health factor, from the loan's stamped settings (#3437), is below the holder's level.
3. **The amount is computed on-chain.** The caller supplies no amount.
4. **The price is bounded by the holder's tolerance.** The sale must deliver at least the oracle value of what was sold, less the tolerance. The tolerance is never looser than the manual route's cap.
5. **Anyone may run it, and the caller receives nothing.** No bonus, no fee, no share of the sale.
6. **No handling fee and no keeper bonus.** The platform takes what it takes on any repayment (its share of the interest) and nothing more.
7. **Everything the borrower is left with lands in the holder's vault as free balance**, under the payout rule: the released collateral, and any proceeds above the debt.

## 4. Design

### 4.1 Settings

Written by the current borrower-position holder, or that holder's account manager, through the existing instruction setter, and cleared by the same wallet at any time:

| Setting | Meaning | Bounds (governed) |
| --- | --- | --- |
| Form | close the loan, or reduce it | reduce only where the loan allows partial repayment |
| Level | the health factor below which it runs | 1.03 to 1.40 |
| Target (reduce only) | the health factor a reduction restores | above the level by the top-up's margin, at most 2.0 |
| Tolerance | how far below the oracle price the sale may fill | 0.5% up to the manual route's cap (3%); the app suggests 1.5% |

- Setting it is refused where the matching manual route could not run on that loan: collateral or lending asset not an ERC-20, either not liquid and priced, the holder on the lender side of the same loan.
- **Setting it is refused while the health factor is already below the level.** It would run at once. The app sends the user to the manual route, where they see the figures before they sign.
- **With "keep my loan healthy".** Both may be set. The level must then sit below the top-up's trigger by the same margin, so the top-up acts first. The sale is skipped while a top-up could run now and would lift the health factor to the level or above.
- **With the due-date plans** (repay at the due date, automatic extension, automatic refinance): independent. Those act on the date, this acts on health.
- **The instruction follows the wallet, not the position**, as the others do. It runs only while the position's holder is the wallet that set it.
- **Protected accounts.** Setting the instruction, raising the level or loosening the tolerance waits the account's delay, because each can cause collateral to be sold at a loss up to the tolerance. Lowering the level, tightening the tolerance and clearing are immediate. A lock or a replacement freezes it with the others.
- **Sanctions.** A flagged wallet cannot set it. One already set still runs, because it pays the lender what the lender is owed; what is left for a flagged holder is held, as the manual route holds it.

### 4.2 Running it: close the loan

`runExit(loanId, adapterCalls, validUntil)`, callable by anyone.

- Runs only when the loan is Active, inside its repayment window (not past the end of grace), the instruction is live for the current holder, and the health factor is below the level.
- The debt is what a manual repayment owes at that moment: principal, interest by the loan's own terms (full-term interest where the loan carries it), and a late fee after the due date.
- It sells the least collateral whose value, less the tolerance, covers the debt. This is the manual route's sizing with the holder's tolerance in place of the cap. If the whole collateral cannot cover the debt at that floor, it does not run.
- The caller supplies the swap routes to try, as a liquidator does. Each route must deliver the floor or it is undone and the next is tried. If every route fails the call reverts and nothing has moved.
- Settlement is the manual full route's: the lender is paid in full, the platform takes its share of the interest, the loan ends Repaid, both position tokens are marked as a repaid loan's are.
- The unsold collateral is released from the loan's lien, and any proceeds above the debt are credited, to the holder's vault as free balance.
- The event states the health factor before, the level, the collateral sold, the proceeds, the debt paid, the amount above the debt, the collateral released and the caller.

### 4.3 Running it: reduce the loan

`runReduce(loanId, adapterCalls, validUntil)`, callable by anyone, under the same conditions.

- It sells the least collateral that brings the health factor to the target, counting the proceeds at the floor. Selling collateral to repay debt raises the health factor whenever the collateral is worth more than the debt after the tolerance, which holds for any loan at or above a health factor of 1.
- Settlement is the manual partial route's, with its rules unchanged: the accrued interest is paid first, the rest retires principal, the loan's smallest partial repayment applies, and the health factor after must not be lower than before.
- Where the amount needed is below the loan's smallest partial repayment, the smallest is used. Where it would repay the whole principal, the call closes the loan as 4.2 does.
- The top-up's minimum interval (one hour to start) applies between two reductions on one loan.

### 4.4 When it does not run

Skipped, with the existing skip event naming the reason, when: the holder is no longer the wallet that set it; a top-up should act first (4.1); the price is missing or distrusted; the asset or the platform is paused; the collateral cannot cover the debt at the floor (4.2); or a step is in flight on the loan that the manual route refuses beside. Where the manual route would cancel a pending step itself, this does the same.

A sale whose routes all fail reverts, so it leaves no event. The preview below reports that the instruction is due, and the keeper's alert tells the holder when a due instruction has not run.

`previewExit(loanId)` returns whether the instruction is due, the skip reason if any, the amount to sell and the least proceeds a route must deliver. The keeper builds its quote from it and the app shows it.

### 4.5 What the caller can and cannot do

The caller chooses the route, and nothing else. A caller who brings a poor route can leave the holder with as little as the floor. The holder's loss from a hostile caller is therefore bounded by the tolerance they chose, and the app says so beside the setting. The platform's keeper asks for the best quote, as it does for a liquidation.

A caller cannot run it early, change the amount, redirect a payment or take any of the proceeds.

### 4.6 Keeper and app

- **Keeper:** one more step in the standing-instruction pass, with its own arming flag, shipped unset. It reads `previewExit`, builds the swap quote with the liquidation pass's quote builder, and submits. A row in `contracts/permissionless-steps.json` for each executor. An ops alert when a due instruction has failed more than a set number of times.
- **App:** in "Reserve and instructions", a card "Sell and repay before liquidation": the form, the level on the same scale as the health bar, the tolerance, and a plain estimate of what a sale at the level would leave the user against what a liquidation would. The statements of section 8 are shown before the user confirms.
- **Alerts to the holder:** when the health factor nears the level, when the instruction runs (with every figure of the event), and when it was due and could not run.
- **Indexer:** handles the run event and the existing repayment events; the loan's page shows the closing as "repaid by your instruction", not as a liquidation.

## 5. Contract changes

| Where | Change |
| --- | --- |
| Instruction record and setter | The form, level, target and tolerance, beside the three existing instructions. The protected-mode delay rule of 4.1. |
| The two "repay with collateral" routes | Each gains a second authority, "the holder's live instruction", reached only by self-call from the executors, and takes the price floor as an input bounded by the cap. The manual entries pass the cap, as today. Sizing, settlement and events are not copied. |
| Executors and preview | `runExit`, `runReduce`, `previewExit`. In their own facet if the instruction facet has no room; the builder measures. |
| Reduce sizing | One function in the sale-sizing library: the least sale that reaches a target health factor at a floor. |
| Pre-deploy checks | Rows in the permissionless-steps ledger; the storage-layout golden file rewritten; facet sizes with the deploy-sanity suite; the refresh-together note for the executors and the two routes. |

## 6. Tests

1. Exit: at a health factor just below the level the loan closes Repaid; the lender receives what a manual repayment pays; the treasury receives its share of the interest and no handling fee; the caller receives nothing; the unsold collateral and the amount above the debt are the holder's free balance.
2. The same loan and price run by the manual full route gives identical lender, treasury and borrower figures at the same tolerance.
3. Health factor at or above the level: refused.
4. Tolerance: a route delivering below the floor is undone and the next tried; all failing reverts with nothing moved; a tolerance outside the bounds is refused at setting.
5. Collateral that cannot cover the debt at the floor: skipped with its reason; the liquidation routes still work.
6. Reduce: the sale is the least that reaches the target; the smallest-partial rule; the whole-principal case closes the loan; the interval; refused at setting on a loan that does not allow partial repayment.
7. With a top-up set: the level above the trigger is refused; the sale is skipped while a top-up could run and would suffice; it runs when the reserve is empty.
8. Setting while the health factor is below the level is refused.
9. Position transfer: the old holder's instruction is skipped; the new holder's works.
10. Protected account: setting, raising the level and loosening the tolerance wait the delay; lowering, tightening and clearing do not; a lock freezes it.
11. A flagged holder: cannot set; a set one runs, the lender is paid and the holder's part is held.
12. Past the end of grace: refused, and the time-based default proceeds as today.
13. A hostile caller's route that delivers exactly the floor succeeds, and the holder's loss equals the tolerance and no more.
14. Every skip reason of 4.4 emits and changes nothing.
15. An invariant over random prices and sequences: a run never pays the lender less than a manual repayment would, never pays the caller, and never sells more than the amount `previewExit` reported plus the manual route's margin.

## 7. Alternatives considered

1. **Leave it to liquidation and the app's warnings.** The status quo. It costs the borrower the bonus and the handling fee, and helps nobody who is away.
2. **A keeper permission the borrower grants (#1206 as first written).** Adds a grant to manage and a dependence on one keeper. Rejected for the reason the other instructions rejected it.
3. **Only the platform's keeper may run it**, so no outsider can bring a poor route. Rejected: a step only one party can run fails when that party is down, and the cost of that failure here is a liquidation. The tolerance bounds a poor route instead.
4. **Sell through the forced-sale host as a new kind of forced sale.** Rejected: that host ends a loan as a default does, with claims for both sides and the default's charges. This is a repayment, and uses the repayment's settlement.
5. **Pay the caller a small reward.** Makes outside callers likely, but it is a cost on the borrower and a reason to push a price to the level. Not now; see 9.
6. **Use the liquidation's price floor.** Rejected: it is looser than the manual route's cap, and the point of the instruction is a better price than a liquidation.
7. **Wait a few minutes below the level before acting**, against a brief dip. Rejected for the first version: the wait is the time the instruction exists to save, and a liquidation acts on one reading too. See 9.
8. **Exit only, no reduce.** Simpler. Kept as the build order (exit first), because a borrower who wants to stay in the loan is better served by a reduction.

## 8. What this does not do, stated to the user

- **It may not run in time.** A price that falls past the level and the liquidation level in one step leaves nothing to act on. Whichever of this and a liquidation is included first wins.
- **It may not run at all.** A market moving faster than the tolerance, a paused asset, a distrusted price or a keeper outage each leave the loan as it was.
- **It cannot be undone.** A closed loan is closed at that moment's price, and a later recovery in the price is not the borrower's.
- **A reduction can repeat.** In a long fall each reduction costs its slippage, and the loan can still be liquidated between two of them.
- It does not touch the loan reserve, lend the borrower anything, or act on a loan whose collateral is an NFT or is not priced.

## 9. Recommendation

Build it as designed: the two manual routes gain one more authority, two executors anyone may call, the holder's own tolerance as the price bound, and no payment to the caller. Build the exit first and the reduction second. Ship the keeper step disarmed.

## 10. Open items for the builder to raise, not decide silently

1. The complete list of in-flight steps the manual routes refuse beside or cancel, confirmed against the code, so 4.4 names each one.
2. Whether a caller should be repaid its gas from the amount above the debt, capped. Designed: no.
3. Whether to add the holder's optional wait below the level (alternative 7) once the first version has run on a testnet.
4. Whether the level's lower bound (1.03) leaves the keeper enough time on each network's block time, measured on the testnets.
5. Whether the protected-mode delay on setting (4.1) should apply as designed. The secured-vault builder may show it is not needed, or that the manual routes need the same rule.
