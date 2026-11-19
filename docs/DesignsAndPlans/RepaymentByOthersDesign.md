# Wallet repayments: in full, in part, or the interest so far, by the borrower or anyone not on the lender's side (design)

**Status:** owner direction of 2026-11-19, in two parts. A part repayment should be open to the same people as a full repayment, with no special rule for a guarantor. And the interest accrued on a loan should be payable at any time, whether or not the loan allows part repayment, because interest is not principal. Card #3779. A small contract change, built before the pre-audit refactor. Reaches a chain by fresh deploy.
**Related:** `FeaturesOverExistingPartsDesign.md` section 2 (borrow for someone), `StandingInstructionsDesign.md` (#3681: the shared interest booking), `PayoutDestinationRuleDesign.md`, `RepaymentRecordDesign.md`.
**Base:** read on the batch branch of #3743 (`claude/project-thread-ijafuu`): the repayment facet, the standing-instruction facet, the periodic facet, the shared interest booking, the period library and the authority library. The design was checked against that code again after it was written.

## 1. What the code does today

| Action | Who may do it | Other conditions |
| --- | --- | --- |
| Repay in full (a loan of an ERC-20) | anyone who is not on the lender's side: not the stored lender, not the holder of the lender position, not the manager of either | the loan is Active or in a pending fallback; inside the repayment window; no swap order committed on the loan |
| Repay in part (a loan of an ERC-20) | **only the holder of the borrower position** | the lender agreed to part repayment when the loan was made; the amount is at least the asset's smallest part and less than the whole principal; inside the repayment window; no swap order committed and no refinance request live on the loan; the health factor must not fall |
| Pay interest only, from a wallet | **nobody**, the borrower included | the only interest-only payment is the "pay my interest" instruction, which draws on a reserve that only the holder may fund and runs from a period's end. A part repayment does pay the interest accrued so far, but always with principal, and only where the lender agreed to part repayment |
| A rental | the renter only, in full or in part | the fees come from the renter's own prepaid amount in their vault |

So a relative, an employer, a friend or the person a loan was taken for can close a loan, and cannot pay toward it. A borrower who wants to pay the interest by hand has to fund a reserve first and then run the instruction, and on a loan with no interest periods has no way at all short of repaying in full.

The books already carry what an interest payment at any moment needs. The one interest booking counts what arrived as interest settled on the loan, so it leaves the remaining debt, the health factor and the amount due at repayment. The period library keeps a second, per-period count of interest paid in the middle of a period and closes the period at its end when that count covers the period's expected interest. A part repayment uses both today. Section 3.2 replaces the per-period count with a reading of the one loan ledger, because the count is wrong in two cases a wallet payment would meet often.

Nothing was found that depends on the part repayment being the holder's alone. The steps a stranger's payment could disturb (a refinance request, a committed swap order) already refuse a part repayment while they are live, whoever sends it.

## 2. The rule

1. **One authority for every wallet repayment of an ERC-20 loan: anyone who is not on the lender's side.** In full, in part, or the interest so far.
2. **Interest is not principal.** The interest accrued so far may be paid at any time on any ERC-20 loan, with or without the lender's agreement to part repayment and with or without interest periods. It pays the lender what the loan already owes them, sooner, and leaves the whole principal lent for the whole term, which is what a lender who refused part repayment asked for.
3. **Every other condition of a part repayment stays exactly as it is.** It still needs the lender's agreement to part repayment, the smallest part, the repayment window, a loan with no refinance request or swap order live, and a health factor that does not fall.
4. **The payer pays from their own wallet and gains nothing.** The collateral, the position and everything the loan releases stay the borrower position's. The app says so to the payer before they sign.
5. **The lender's side stays excluded**, by the same rule the full repayment uses, so a lender cannot pay their own loan to themselves.
6. **A rental is unchanged.** Its fees come from the renter's prepaid amount, so only the renter settles it.

## 3. Design

### 3.1 Part repayment by another person

- The part-repayment entry takes the lender-side exclusion in place of the holder-only check, for a loan of an ERC-20. The rental branch keeps the renter-only check.
- The amounts, the split, the accrual reset, the period credit and the health test are unchanged. The money is drawn from the caller, as it already is.
- The event gains the payer, as the full repayment's event already has it.
- The holder cannot refuse a payment toward their loan. That is already true of the full repayment, which does more. The holder is alerted to every payment by another address, with the payer and the amounts.

### 3.2 The interest so far, from a wallet

`payInterest(loanId, maxAmount)`, callable by anyone who is not on the lender's side.

- **When.** At any time while the loan is open and inside its repayment window. Not only at a period's end, and on a loan with no interest periods too. It is refused while a swap order is committed on the loan, as both wallet repayments are. It is not refused while a refinance request stands: that guard protects the principal and the collateral a request was priced against, and an interest payment leaves both alone.
- **How much.** The payer states a ceiling. The entry pays the smaller of that ceiling and the interest accrued to that moment and not yet settled, at the loan's own rate on its open principal. It never pays more than has accrued, so interest is never taken in advance. Interest accrues by the second, so a figure read before signing is already a little short when the transaction lands. A ceiling lets "pay all of it" succeed without that race. Nothing owed is refused with its own error. The event states the amount actually paid, and the app's approval is for the ceiling exactly, never an unlimited amount.
- **What it changes.** Nothing but the interest owed. The principal, the term, the rate, the due date and the collateral are untouched. The amount paid leaves the loan's remaining debt, so the health factor rises or stays where it was, and it is charged once: a later part repayment, a full repayment or a sale of collateral for interest finds it already settled.
- **It is not cheaper or dearer to pay early.** Interest is charged on the open principal and does not compound, so paying it sooner changes when the lender receives it and not how much the loan costs. The loan's full-term minimum is unchanged. The review says so.
- **How it is booked.** By the one interest booking the periodic sale and the reserve instruction already share, with the wallet as a new source: the lender's side is paid through the interest ledger with sellers' claims first and held for the lender position, the treasury takes its share by the loan's stamped rate less the lender's discount, and what arrived is counted as settled on the loan.
- **On a loan with interest periods** the payment needs no second booking. A period is judged from the loan's interest ledger (next point), which the shared booking has already updated. A period that is covered by its end closes without a sale of collateral. So a borrower can pay a period's interest early, in one payment or several, and the grace and the sale apply only to what is still unpaid.
- **A period is judged from the loan's one interest ledger, never from a count of its own.** Today the period library keeps its own count of interest paid since the last period closed, compares it with the period's expected interest, and resets it to zero when the period closes. That count goes wrong in two ways. A payment that covers more than the closing period loses the rest: with one unit a day and a 30-day period, paying 30.5 on day 30.5 closes the first period and forgets the 0.5, so the second period later reads half a unit short with all interest paid. And the expected interest is worked out on the principal as it stands at the moment of the check, while a part repayment lowers the principal before the count is read, so a period that ran at the old principal is measured against the new one. Carrying the excess forward (this design's first answer) repairs the first case and makes the second worse, because the excess is then measured against the wrong expected figure. The root is that two books describe one fact. The loan already has one book that is right in both cases: interest accrues on the current accrual segment at the principal that segment ran at, every interest payment adds to the interest settled, and every step that changes principal first charges all interest due and restarts the segment, keeping any amount paid beyond it as credit. So the rule is:
  - The **shortfall of the period ending at a boundary** that has passed is the interest accrued on the current accrual segment up to that boundary, on the loan's own accrual basis, less the interest settled, and never below zero. When the segment began after the boundary the shortfall is zero, because the step that restarted the segment charged everything due before it.
  - A period is **covered** when its shortfall is zero. The checkpoint advances over every period whose boundary has passed and which is covered, in one loop that all callers share.
  - The **grace, the periodic sale's sizing, the reserve instruction and the views** read that one shortfall. Nothing is carried from period to period, because nothing is counted per period.
  - The per-period count and the per-period expected figure stop deciding anything. Whether they stay as reported figures or are removed is the builder's choice; the next deploy is fresh, so there is no stored state to keep.

  With one unit a day and a 30-day period: paying 30.5 on day 30.5 covers the first period, and on day 60 the second reads 29.5 short. Halving the principal on day 30 while paying the 30 due restarts the segment, the first period is covered, and on day 60 the second reads 15 short, which is what half the principal accrued. A part repayment has both gaps today, so this is a correction for every caller and not only for the wallet entry.
- **The interest settled is always credit against the current accrual segment.** The period rule stands on that, so every step that restarts the segment nets and carries in the same step: it charges the interest due (the gross for the segment less the interest settled) and writes back only what was paid beyond the gross. The part repayment, the partial swap-to-repay, the partial liquidation and the obligation handover do this today. The in-place extension does not: it charges the segment's gross interest without taking off what a sale or the reserve already settled, and leaves the settled figure standing on the new segment. Under the period rule that old credit would mark new periods as covered, and today it already charges settled interest a second time at the extension and gives it back against the next segment. The extension is corrected to net and carry like the others. To keep it from recurring, the restart sits behind one writer: one library function takes the segment's gross interest, returns what is due, writes the carried excess and stamps the new start, and every restarting step calls it. A check in the pre-deploy gate refuses any other write of the segment's start, as the loan-terms check does for principal and rate.
- **A pause lengthens the period it falls in.** Interest accrues through a pause, and a period's boundary moves later by the paused time, as every loan deadline does. So a period that held a pause is longer, and the interest owed at its boundary is the interest for its real length. The per-period expected figure counted the nominal days only; the ledger is right, and the functional spec states it with the build.
- **A sale that recovers less than the shortfall leaves the rest owed, and the next period's settlement sells for it.** Today the per-period count restarts at zero, so the periodic settlement never returns to that remainder; it stays in the debt, counts in the health factor and is collected at repayment or default. Under the period rule it is part of the next boundary's shortfall. It is interest past due, there is at most one sale per period under the same slippage floor, and a deeper case is the health-factor liquidation's. Excluding it would need a second count of interest, which is what this section removes.
- **No agreement to part repayment is needed,** by rule 2.
- A delivery the token refuses, or one that arrives short, undoes the payment.
- **With the reserve instruction set on the same loan:** the instruction pays what is still unpaid at the period's end, and finds less or nothing owed after a wallet payment. The two never pay the same interest twice, because both read the same settled figure.
- **Very small payments.** A payment that leaves interest unpaid must be at least the loan's smallest part repayment (the principal times the asset's smallest-part setting). A payment of all the interest accrued so far is always accepted, however small. Where the asset has no smallest-part setting, there is no floor.

### 3.3 Screening the payer

A repayment stays open to a flagged borrower so that the lender can be made whole. That reason does not reach a flagged outsider, who has no duty to the lender. Today no entry screens a payer who is not the holder, so a flagged outsider can repay a loan in full. The rule from here: the current holder of the borrower position, read from the chain at that moment, is never refused; any other payer is screened like a new deposit, on all three entries. This tightens today's full repayment for a flagged outsider, on purpose. The holder's own repayment is as open as before.

### 3.4 App and indexer

- A loan's page offers **Repay**, **Pay part** (where the loan allows it) and **Pay interest** (where any has accrued) to the holder and to any connected wallet that is not on the lender's side. **Pay interest** shows the interest so far, pre-filled, and on a loan with interest periods what the current period still needs and its end date. Each review states the amount, what it pays, and: "You are paying a loan you do not hold. Nothing comes back to you. The collateral stays with the borrower position."
- The holder's page shows payments made by other addresses, marked as such.
- The indexer reads the payer from the three events. The repayment record (`RepaymentRecordDesign.md`) counts a loan for its holder whoever paid.
- "Borrow for someone" (`FeaturesOverExistingPartsDesign.md` section 2) then needs nothing of its own: the other person uses these three actions.

## 4. Contract changes

| Where | Change |
| --- | --- |
| The repayment facet, part repayment | The lender-side exclusion in place of the holder-only check on the ERC-20 branch. The payer in the event. |
| A wallet entry for interest | `payInterest`, on the periodic facet beside the shared booking (the repayment facet has no room for it). It pays the smaller of the ceiling and the interest accrued and not yet settled, draws from the caller, calls the shared booking, and then runs the period library's loop so a period this payment covers closes at once. A new source value in the booking. It emits the per-loan interest-paid event (#3755) through the one hook every interest payment uses. |
| The period library | One shortfall figure read from the loan's interest ledger (3.2), and one loop that advances the checkpoint over every covered period, shared by all callers (the part repayment, the partial swap-to-repay, the partial liquidation, the reserve instruction, the periodic settlement and the wallet entry). The grace, the sale's sizing and the views read the same figure. The per-period paid count and expected figure no longer decide anything. |
| The accrual segment's restart | One writer for the segment's start: it nets the interest settled against the segment's gross, returns the interest due, writes back the excess and stamps the new start. The part repayment, the partial swap-to-repay, the partial liquidation, the obligation handover, the offset and the in-place extension call it. A pre-deploy check refuses any other write of the segment's start. |
| The in-place extension | Charges the netted interest through that writer. Today it charges the gross and leaves the settled figure standing. |
| Screening | As 3.3, on the full repayment, the part repayment and the interest entry. If the repayment facet has no room for it, the facet is split along a seam and not trimmed. |
| Pre-deploy checks | Selectors in every registration place, the permissionless-steps ledger (both entries have a caller rule, so the builder records how the ledger classes them), ABI exports, the keeper ABI sync, the indexer's event coverage. |

## 5. Tests

1. A part repayment from an address that is not the holder: accepted where the loan allows part repayment; the lender, treasury, principal and period figures equal the same payment made by the holder; the collateral and the position are untouched.
2. Refused: from the stored lender, from the holder of the lender position, from the manager of either; on a loan that does not allow part repayment; below the smallest part; for the whole principal; outside the window; with a refinance request or a swap order live.
3. A rental's part payment from another address is refused, as today.
4. Interest from a wallet, by the holder and by another address, in the middle of a period, at its end and on a loan with no interest periods: the lender, treasury and settled figures equal the same interest paid from a reserve; the principal, term and collateral are unchanged; the health factor does not fall; a ceiling above the interest accrued pays exactly what has accrued; refused when nothing is owed, when a payment that leaves interest unpaid is below the floor, outside the repayment window, with a swap order committed and from the lender's side; accepted while a refinance request stands, and that request still settles for the right amount.
5. After a wallet interest payment: a period covered by its end closes with no sale; the periodic settlement sells only for what is left; the reserve instruction pays only what is left; a later part repayment and a later full repayment charge that interest once; the total interest of a loan paid this way equals the total of the same loan paid at the end. A payment made after a period's end that covers that period and part of the next closes the first, and the second then needs only the rest; a payment that covers two whole periods closes both; no period of a loan whose accrued interest is fully settled ever reads short. With a part repayment inside a period, at its boundary and after it: each period's shortfall equals what the loan's ledger says was accrued and unpaid at that boundary, at the principal the interest actually ran at, and the total sold or paid over the loan's life equals the total interest. The same cases through the partial swap-to-repay and the partial liquidation. An extension of a loan whose interest was settled mid-term by a sale or the reserve charges that interest once, and the first period of the new segment is not covered by old credit. A period that held a pause owes interest for its real length. A periodic sale that recovers less than the shortfall leaves the rest in the next period's shortfall, and at most one sale runs per period.
6. A wallet interest payment works on a loan that does not allow part repayment.
7. The events carry the payer.
8. Screening: a flagged address that is not the holder is refused on all three entries; a flagged holder is not; an unflagged outsider is accepted.

## 6. Alternatives considered

1. **Leave the part repayment to the holder.** Today's state. Another person can close a loan and cannot pay toward it, which is the wrong way round: the larger action is the open one.
2. **Let the holder name the addresses that may pay part.** The first proposal for "borrow for someone". It adds a setting and a list to guard an action that only gives the holder money. Rejected on the owner's direction.
3. **Let another person fund the holder's reserve.** The reserve follows its depositor and returns to them, so a stranger's deposit would become the holder's to withdraw, or the stranger's to pull back at will. Rejected.
4. **Pay interest by a part repayment only.** A part repayment always retires principal and needs the lender's agreement to it. A borrower who simply wants to pay the interest has no direct way. The wallet entry closes that.
5. **Allow an interest payment only from a period's end, on loans with interest periods.** The first draft of this design, following the reserve instruction. Rejected on the owner's direction: interest is owed on every loan from its first second, the books already take a payment at any moment, and a borrower with funds today should not have to wait for a date to reduce what they owe.
6. **Take interest in advance, before it has accrued.** It would be a deposit held against a future debt, with the question of who gets it back if the loan closes early. The payment reserve already does that job, in the holder's own vault. Rejected.
7. **Open the rental's part payment too.** Its fees are drawn from the renter's own prepaid amount, so there is nothing for another person to pay. Not applicable.
8. **Keep the per-period count of interest paid and carry what exceeds a closed period into the next.** This design's first answer to a payment made after a period's end. It measures the excess against an expected figure worked out on the principal at the moment of the check, so it is wrong whenever principal changed inside the period, and it keeps two books for one fact. Rejected for the one ledger in 3.2.

## 7. Recommendation

Build sections 2 and 3: one authority for wallet repayments of an ERC-20 loan, and a wallet entry that pays the interest so far on any of them at any time.

## 8. Settled with the builder (2026-11-19), and what stays open

Settled:

1. **Screening.** No entry screened a payer who is not the holder. Section 3.3 now states the rule to build.
2. **Host.** `payInterest` sits on the periodic facet, beside the shared booking.
3. **Floor and ceiling.** Section 3.2: the argument is a ceiling, and a payment that leaves interest unpaid has a floor.
4. **Rewards.** Unaffected. The borrower-side reward accrues on the loan's principal and rate and stays with the holder of the borrower position, whoever paid.
5. **Busy loan.** Refused with a swap order committed, accepted with a refinance request standing (3.2). The builder confirmed from the code that a refinance sizes the old lender's due at settlement and credits the interest already settled once, and that the payoff permit is a ceiling. So an interest payment made while a request stands lowers the wallet's share of the payoff and is charged once.
6. **The period rule.** The builder checked the definition in 3.2 against every step that changes principal or rate: each restarts the accrual segment, so the interest accrued up to a boundary is exact on the current segment and zero when the segment began after it. A loan that owes full-term interest accrues pro rata until it closes, so the pro-rata shortfall is right for it. The settlement runs only after a boundary and its grace, so the boundary has always passed. One function gives the shortfall to the sale, its previews and the views. The check found one break, the in-place extension, corrected in 3.2 with the one writer for the segment's restart. The pause and the short recovery are settled as 3.2 states them.
7. **The per-period count and expected figure** are removed when nothing outside the period library reads them, and otherwise kept as reported figures only. The builder says which with the build.

Open:

1. Whether the reserve instruction should also be allowed to run before a period's end now that a wallet payment may. This design leaves the instruction as it is.

