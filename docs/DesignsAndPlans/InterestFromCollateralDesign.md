# Interest paid from collateral: a fifth standing instruction (design)

**Status:** owner approved the feature for design and build on 2026-11-19 (second review of the platform survey). Card #3777. Design first, no code yet. Built after the exit instruction (#3752), whose parts it reuses. Reaches a chain by fresh deploy.
**Related:** `StandingInstructionsDesign.md` (#3681: the loan reserve and "pay my interest"), `ExitBeforeLiquidationDesign.md` (#3752: the tolerance, the calm rule, the protected-mode rule), `ForcedSaleSizingDesign.md`, `PayoutDestinationRuleDesign.md`.
**Base:** read on the batch branch of #3743 (`claude/project-thread-ijafuu`), and the design was checked against that code again after it was written: the standing-instruction facet (its setter, its skip reasons, the reserve's interest payment), the shared interest booking, the period library, the periodic settlement and the test a partial release of collateral must pass. The exit instruction (#3752) is designed and not yet built on that branch, so everything this design takes from it (the tolerance, the calm rule for a run, the protected-account rule for a change) is taken from its design document and is built with it or after it.

## 1. Why

A loan with a periodic interest cadence asks the borrower for money at the end of every period. A borrower who pledged an asset that has risen in value, or that grows in value by its own design, has the means to pay inside the loan and still has to bring money from outside. If they miss the date, the interest is collected by a forced sale of collateral after the grace period, with a handling fee and a bonus for whoever settles it.

The "pay my interest" instruction (#3681) covers a borrower who set money aside in a reserve. Nothing covers the borrower who would rather pay from the collateral itself, on their own terms, before any charge applies.

## 2. What the user gets

One more instruction on a loan that has a periodic interest cadence, set by the holder of the borrower position:

> **Pay my interest from my collateral.** At the end of each interest period, sell just enough of my collateral to pay that period's interest, at no worse than the price tolerance I set, and only if my loan stays at or above the health level I chose.

- It needs no money set aside. It spends only the collateral already pledged to that loan, and only to pay interest the borrower already owes.
- **The health level is the borrower's guard.** When the collateral has not kept its value, the sale does not run, and the interest stays due the ordinary way. The borrower chooses the level; the app suggests the loan's health today, so that only value gained from here is spent.
- No handling fee and no bonus. The caller receives nothing.

It is a convenience, not a promise. Section 6 says what it cannot do. It is never described as a loan that repays itself, and no figure of growth is shown or implied for any asset.

## 3. The rule

1. **It is the period's interest payment, made early from collateral on the holder's instruction.** The interest is booked by the one interest booking that the periodic sale and the reserve instruction already share (`StandingInstructionsDesign.md` 4.2; on the batch branch it is the periodic facet's interest-payment booking, which takes the source of the money as an input), and then credited to the period by the period's one crediting function, as the reserve instruction does. This instruction adds a source. There is no second settlement to keep in step.
2. **The amount is computed on-chain.** The period's unpaid interest as the periodic library computes it, less anything the reserve instruction paid first. The caller supplies no amount.
3. **The price is bounded by the holder's tolerance, and the market must be calm**, by the rule of the exit instruction: the sale delivers at least the oracle value of what was sold less the tolerance, and a run by someone other than the holder waits while the pair is not calm against the last two hourly checkpoints. There is no switch to act in a fast market here: an interest payment has days of grace, so waiting costs nothing that the switch would save.
4. **The loan must be at least as healthy after the sale as the holder's level, and never less healthy than a release of collateral would be allowed to leave it.** Taking collateral out of a loan to pay its interest is, for the lender, a partial release of collateral joined to a payment. So the sale must pass the test a partial release passes today: the health factor after it is at least the loan's minimum stamped at opening, and the loan-to-value after it is within the limit stamped at opening. The holder's level sits at or above that minimum.
5. **Anyone may run it, and the caller receives nothing.**
6. **What is left is the position's.** Proceeds above the interest are held for the borrower position and collected by its holder, as the periodic sale already leaves them (`PayoutDestinationRuleDesign.md` 4.2).

## 4. Design

### 4.1 Settings

Written by the current borrower-position holder, or that holder's account manager, through the existing instruction setter, and cleared by the same wallet at any time.

| Setting | Meaning | Bounds (governed) |
| --- | --- | --- |
| Health level | the health factor the loan must have after the sale | from the loan's minimum health factor for a release of collateral (stamped at opening), up to 3.0 |
| Tolerance | how far below the oracle price the sale may fill | 0.5% up to the manual repay-with-collateral cap (3%); the default is 1% |

- Offered only where the loan has a periodic interest cadence and both assets are liquid, priced ERC-20s: the conditions the interest payment and the top-up instructions already need, together.
- **With "pay my interest" (the reserve).** Both may be set. The reserve pays first. The sale covers only what the reserve left unpaid.
- **With the exit instruction.** Both may be set. The exit's level must sit below this instruction's health level, since a loan that is being sold out has nothing to gain from an interest sale first. While the exit is due, this instruction is skipped.
- **The instruction follows the wallet, not the position**, as the others do.
- **Protected accounts.** The exit instruction's rule, from its design (the setter on the batch branch has no such wait yet): a change that can cause more collateral to be sold, or sold at a worse price, waits the account's delay. Setting it, lowering the health level and loosening the tolerance wait. Raising the level, tightening the tolerance and clearing are immediate. While the account is locked or after it was replaced the instruction is skipped, as every instruction is today.
- **Sanctions.** One already set still runs for a flagged holder, as the reserve's interest payment does, because it pays the lender what the lender is owed. Anything above the interest stays held for the position and is not paid out to a flagged holder. Whether a flagged wallet may set a new one follows what the setter does for the other instructions, which the builder reports.

### 4.2 Running it

`runInterestSale(loanId, adapterCalls, validUntil)`, callable by anyone.

- Runs from the end of the period until the end of its grace, when the loan is Active, the instruction is live for the current holder, the period has unpaid interest, and the pair is calm.
- It sells the least collateral whose value, less the tolerance, covers the unpaid interest. Where that amount is below the smallest sale the route accepts, it does not run and the preview says so.
- **The health test.** The health factor and the loan-to-value are computed for the loan as it will stand after the sale, counting the proceeds at the floor: less collateral, and the interest paid off the debt. If the health factor is below the holder's level, or either figure fails the partial-release test of rule 4, nothing is sold.
- **A position that has moved.** The collateral sits under the lien in the stored borrower's vault. Where the position has a new holder, the run consolidates the loan into the holder's vault first, as the top-up does, and is skipped if that does not complete.
- The caller supplies the swap routes to try. Each route must deliver the floor or it is undone and the next is tried. If every route fails the call reverts and nothing has moved.
- The interest is booked by the shared interest booking: the lender's side is paid through the interest ledger (sellers' claims first where a sale left one) and held for the lender position, the treasury takes its share by the loan's stamped rate less the lender's discount, and what arrived is counted as settled on the loan. The payment is then credited to the period by the period's crediting function. When that brings the period to fully paid, it closes in the same transaction.
- No handling fee, no settler bonus, no late charge: the run is inside the period's grace.
- Proceeds above the interest are held for the borrower position (rule 6).
- The event states the period, the interest paid, the collateral sold, the proceeds, the amount above the interest, the health factor before and after, the holder's level, and the caller.

### 4.3 When it does not run

Skipped, with the existing skip event naming the reason, when: the holder is no longer the wallet that set it; the position moved and is not yet consolidated; the holder's protected account is locked or was replaced; the health after the sale would be below the level or fail the partial-release test; the pair is not calm or a checkpoint is missing; the price is missing or distrusted; the exit instruction is due; the loan is busy (the one rule the other instructions use: an offset, a sale listing, a refinance request or a swap order is live on it); the asset or the platform is paused. The reasons that are new here (health, calm, exit due) are added to the skip reasons.

**A skipped period is an ordinary unpaid period.** The borrower may pay by hand (the wallet interest payment of #3779, once built), the reserve may pay, and after the grace the periodic sale collects it with its charges, as today. The holder is alerted at the first skip of a period, with the reason and the date the grace ends.

`previewInterestSale(loanId)` returns whether the instruction is due, the skip reason if any, the amount to sell, the least proceeds a route must deliver, the health factor after, and the end of the grace.

### 4.4 Keeper and app

- **Keeper:** one more step in the standing-instruction pass, with its own arming flag, shipped unset. It depends on the hourly price checkpoint pass being armed on that network. A row in `contracts/permissionless-steps.json`.
- **App,** in "Reserve and instructions": a card "Pay my interest from my collateral", with the health level on the same scale as the health bar, the tolerance, the collateral one period's interest would take at today's price, and the runner's state on this network. The statements of section 6 are shown before the user confirms.
- **Alerts to the holder:** when a sale ran (with every figure of the event), and when a period was skipped and why.
- **Indexer:** the run event. The loan's page shows the payment as "interest paid from your collateral by your instruction".

## 5. Contract changes

| Where | Change |
| --- | --- |
| Instruction record and setter | The health level and tolerance, beside the existing instructions, with the protected-mode rule of 4.1. |
| The sale | The collateral leaves the loan's lien through the vault's swap door, sized by one function in the sale-sizing library (the least sale that covers a need at a floor). The builder places it on the host that already sells pledged collateral to a need, with no fee and no bonus for this kind, or on the repay-with-collateral route, and says which and why. It is not a third copy of either. |
| The booking | The shared interest-only step of #3681, unchanged, paid from the sale's proceeds. |
| Executor and preview | `runInterestSale`, `previewInterestSale`, beside the exit's executors if the facet has room; the builder measures. |
| Pre-deploy checks | The permissionless-steps row, the storage-layout golden file rewritten, facet sizes with the deploy-sanity suite, the refresh-together note. |

## 6. What it cannot do, stated to the user

- **It sells your collateral.** Each run leaves less collateral in the loan. If the asset does not rise, the health level stops the sales, and the interest is then due from you.
- **It does not stop a liquidation.** It pays interest. A falling price is answered by the top-up and exit instructions.
- **The tolerance is the price you accept.** Anyone may run it, and a caller may route the sale so that you receive no more than the floor.
- **It may not run.** It waits for a calm market and for a runner. If it has not run by the end of the grace, the periodic sale collects the interest with its charges.
- **It is not advice about any asset.** The platform does not say that any collateral will grow.

## 7. Tests

1. At the period's end, with health above the level after the sale: the lender, the treasury and the settled interest equal those of the same interest paid from a reserve; no handling fee, no bonus; the caller receives nothing; the period closes in the same transaction.
2. The health test: a loan that would fall below the level after the sale is skipped and nothing moves; so is one that would pass the level and fail the loan-to-value limit stamped at opening; a level below the loan's minimum for a release of collateral is refused at setting. For the same loan and amount, the sale never leaves the loan less healthy than the largest partial release would.
3. With the reserve: the reserve pays first and the sale covers only the remainder; a fully funded reserve leaves nothing to sell.
4. Tolerance and routes: a route under the floor is undone and the next tried; all failing reverts with nothing moved.
5. Calm: refused while the pair is moving or a checkpoint is missing.
6. After a skip, the periodic sale after the grace collects the period as it does today.
7. With the exit instruction due, this instruction is skipped.
8. Proceeds above the interest are held for the borrower position, and the holder's Collect brings them into the vault as free balance.
9. Position transfer: the old holder's instruction is skipped; the new holder sets their own, and its first run consolidates the loan into the new holder's vault before it sells.
10. Protected account: setting, lowering the level and loosening the tolerance wait the delay; the opposite changes are immediate; while locked or after a replacement it is skipped.

## 8. Alternatives considered

1. **Leave it to the periodic sale after the grace.** Today's state. The borrower pays a handling fee and a settler bonus for an outcome they would have chosen without either.
2. **Add the interest to the debt.** The lender would then be paid nothing until the end, which changes what the lender agreed to, and the loan's risk grows with every period. Rejected. A loan with no periodic cadence already exists for two parties who want that.
3. **Sell without a health test.** Simpler, and it would keep selling a falling asset to pay interest, which is the opposite of what the borrower wants. Rejected: the level is the feature.
4. **Measure "growth" from the price at the loan's opening.** The loan does not record that price, and a single stored price is a poor guide after months. The health level is a figure the loan already computes, and the borrower can move it. Recommended in its place.
5. **Move the collateral's own income into the reserve.** Works only for assets that pay income as a separate token, and each needs its own handling. Not designed.
6. **Require the lender's consent.** Not needed: the lender is paid the same interest, on time, and the loan is left no less healthy than a release of collateral, which every borrower may already make without the lender, would leave it.
7. **Let the holder's level go below the release minimum, down to just above liquidation.** It would let the instruction keep paying interest from a loan that is close to being sold out. Rejected: it removes collateral from the lender's security at the moment the lender most needs it, and the exit instruction is the tool for that state.

## 9. Recommendation

Build it as sections 3 and 4, after the exit instruction, reusing its tolerance, its calm rule and the shared interest-only step.

## 10. Open items for the builder to raise, not decide silently

1. Which host carries the sale (section 5), with the measured facet sizes.
2. The smallest sale the route accepts, and whether a period's interest on a small loan falls under it.
3. Whether the upper bound of the health level should sit per asset tier.
4. Whether the run may start a little before the period's end, as the reserve instruction's open item asks.
5. Whether a flagged wallet may set an instruction today, and what the setter does about it for this one (4.1).
