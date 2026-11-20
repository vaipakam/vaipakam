# A dated end for a loan left in the fallback state

**Status:** agreed by the owner on 2026-11-20: a dated end, with a wait of 30 days. Card #3865. Nothing is built from it yet. It changes one line of intended behaviour: today a loan in the fallback state stays curable until the lender position's holder claims, with no end date.

**Related:** `NetworkWindDownDesign.md` (section 7, which this gives a date to), `BackstopVaultV0Design.md`, `Vpfi1566CanonicalDeliveredBoundDesign.md` (the fallback custody), `PayoutDestinationRuleDesign.md`.

## 1. What happens today

A loan enters the fallback state when a forced sale (a liquidation or a time-based default) finds no working route. In the same transaction the collateral goes back to the borrower's vault under the loan's hold, and a split of it is recorded: the lender's part, the treasury's part and the borrower's part. The split is made on the price at that moment, lender first. If no trusted price was available, the lender's part is the whole lot.

From there the loan ends in one of four ways:

- **The lender position's holder claims.** With a fresh sale attempt if they bring a route, and otherwise by taking the recorded split in kind. The loan becomes final.
- **The borrower cures it,** by repaying in full or by adding enough collateral. A cure returns it to an open loan.
- **The backstop buys the lender's part,** only at the lender's request, and only where that feature is switched on.
- **An internal match** closes it against an opposite loan, when one exists. A match may close only part of it. The recorded split is then scaled down to the collateral that is left, and what the match paid toward the lender is kept for the lender position's holder, to be paid with the eventual claim.

None of these has a date, and three of the four need the lender position's holder or an outside condition. The borrower's own claim opens only once the loan is final. So while the holder does nothing:

- the borrower's part of the split stays under the loan's hold, unless the borrower can cure;
- the loan counts as open for the platform's totals, its keepers and its alerts;
- a network that is winding down cannot reach Closed.

## 2. The proposal

**After a stated wait from the moment a loan entered the fallback state, anyone may finish it in kind.**

The finishing step does exactly what the lender's claim without a route does today, up to the point where that claim pays the holder:

1. The recorded split is applied, as it stands when the step runs: the split made at entry, scaled down by any internal match that has closed part of the loan since. The lender's part moves from the borrower's vault to the lender side's vault, held for the lender position's holder to claim. The treasury's part goes to the treasury. The borrower's part, and any collateral the borrower added without curing, stays in the borrower's vault and becomes the borrower position's claim. What an earlier part match already holds for the lender is not touched by the step: it stays held and is paid by the lender's claim, exactly as it would be after a lender's own claim.
2. The loan becomes final (defaulted), with the same position-token status and the same closing of its reward records as a lender's claim gives it.
3. A request the lender made to the backstop lapses, as it does on a cure.

Then each side collects with its ordinary claim, whenever it likes. The step itself pays no wallet and pays its caller nothing.

**What the step does not do.** It does not try a sale, so it needs no price and no route. It does not run the internal match, so no caller earns a matcher's share by finishing someone else's loan. It does not change the split: the amounts are the record's as it stands, and the step reads them and never works them out again from a price.

**Until the wait has passed, nothing changes.** The lender keeps every choice it has today, and so does the borrower.

## 3. The wait

- **Length.** A bounded setting, 30 days (the owner's figure, 2026-11-20), bounds 14 to 90 days. It is recorded on the loan when it enters the fallback state, so a later change of the setting never moves a date already running.
- **Counted from entry**, on a clock that does not run while the platform is paused, like every other deadline of a loan.
- **A part match does not restart it.** An internal match that closes part of the loan leaves the date where it was.
- **A top-up that does not cure does not restart it.** Otherwise a borrower could put the end off for ever with small amounts.
- **A cure ends it.** The loan is open again. If it falls into the fallback state again later, that is a new entry with a new count.
- **No extension by the lender.** A holder who is present can claim, and one who is away cannot extend. The alternative is in section 7.

## 4. Who is affected, and how

- **The lender position's holder** loses one thing: the open-ended option to wait, after the wait has passed, for a cure or a better sale. What they receive is the part recorded for them at entry, in kind, in their own vault. A holder who wants a sale brings a route with their claim before the date, as today.
- **The borrower position's holder** gains a date on which their part is released. They lose nothing they could rely on: the holder's claim could end the cure at any moment before, and can still.
- **The treasury** receives its recorded part as it does on a lender's claim.
- **The backstop** is not used by this step.

## 5. Edges

- **A flagged holder.** The step registers both holders under the existing sanctions hold exactly as a claim does. A flagged lender's part is deposited in its own vault and stays locked. The step is not refused because a holder is flagged, since the other side must not be held up.
- **A token that refuses the lender side's vault.** The lender's part is parked for it by the existing parked-payment path, and the step completes.
- **The global pause.** The step follows the lender's claim: it does not run while paused, and the wait does not run either.
- **A network that is winding down.** The step stays open in Closing. The earliest Closed day can then count each fallback loan as ending at its date.
- **A legacy custody row** that is not held in the borrower's vault is refused, as every fallback step refuses it.

## 6. What it needs

- **Contracts.** The setting and its bounds. The date recorded at entry. The finishing step beside the fallback custody steps, callable by anyone, with a row in the permissionless-steps ledger. A view of the date for a loan.
- **Keeper.** One pass that finishes loans past their date. It ships disarmed.
- **Alerts.** To both holders at entry (the date is stated), seven days before the date and one day before.
- **App.** The loan's page shows the date and what happens on it for each side, in plain words, for both holders.
- **Indexer.** The finishing event, shown as "finished in kind on its date", never as a claim by the holder.
- **Spec.** The owner's list gains the changed line: curable until the lender's claim or the date, whichever comes first.

## 7. Alternatives considered

- **Leave it as it is.** No change for the lender. A wind-down can wait on one absent holder with no end, and so can a borrower's part.
- **Only the borrower position's holder may finish it.** Only a party acts. It releases a borrower who is present and still leaves a network waiting when both sides are away.
- **Let a network count as Closed with old fallback loans outstanding.** A top-up could still return such a loan to an open loan on a network where prices, sale routes and keepers are no longer kept, so the cure would need a date anyway.
- **Let the lender extend the wait once.** It keeps more of the lender's option. It doubles the longest a wind-down can be held, and a holder who is present enough to extend is present enough to claim.
- **Sell at the date instead of finishing in kind.** It needs a price and a route at a moment nobody chose, on a loan that is in this state because a sale already failed.
- **Reminders only.** Worth doing, and it gives no date.

## 8. Recommendation

The finishing step after 30 days, in kind, callable by anyone, with no extension. The owner chose this, and the 30 days, on 2026-11-20.

## 9. Tests

1. Before the date the step is refused, and every existing route behaves as today.
2. At the date, called by a stranger: each side's claim then pays exactly what a lender's claim without a route would have left them, the treasury receives its part, and the caller receives nothing.
3. A cure before the date ends the count. A later fallback starts a new one.
4. A top-up that does not cure does not move the date, and the top-up is in the borrower's claim after the step.
5. Paused time is not counted.
6. A flagged lender holder: the step completes, the lender's part is locked in its own vault, the borrower claims.
7. A token that refuses the lender side's vault: the step completes with that part parked.
8. A change of the setting does not move a date already recorded.
9. The lender's request to the backstop is void after the step.
10. On a closing network the step runs.
11. A part internal match before the date: the date does not move; the step applies the scaled-down split and takes no more collateral than is left under the loan's hold; the lender's claim then pays both that part and what the match held for the lender; the borrower's and the treasury's parts are the scaled ones.
