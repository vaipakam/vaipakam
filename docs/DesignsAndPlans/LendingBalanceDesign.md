# One lending balance, room for a term loan, and notice to leave: design

**Status:** design for the builders. The owner approved the six items on 2026-11-19 and decided the last one the same day ("facts now, the move as a later card"). Design first, no code yet. Reaches a chain by fresh deploy. Cards: #3811 (one lending balance), #3814 (the "Available now" line), #3812 (make room), #3813 (notice to leave), #3815 (the borrower's mirror), #3816 (the later one-transaction move).
**Related:** `InstantMarketDesign.md` (slots, renewal, takeover, the ledger), `TermAverageAndLinkGuardsDesign.md` section 7 (available), `FloatingRateLoansDesign.md` and `MarketLinkedRateLimitsDesign.md` section 5 (floating loans and floating slots), `DueDatePlanDesign.md` and `BorrowingDesign.md` (the borrower's plan for the due date), `KeeperApprovalsReviewDesign.md` ("lend again what comes back"), `FlashLendingDesign.md`, `PayoutDestinationRuleDesign.md`.
**Base:** read on main at `2687a4cbf`.

## 1. What was approved

1. **One lending balance** per lender and lending asset, shared by all of that lender's Auto-lend slots. Each slot keeps its own terms, lend-until time and largest exposure. Nothing is held together across lenders.
2. **Lend at the floating rate while a term loan waits.** A lender has a term slot and a floating slot on the one balance, and whichever borrower comes first is served. When a term borrower arrives while the money is out at the floating rate, one transaction hands the floating loan to another lender's waiting slot at face value and opens the term loan.
3. **The borrower's mirror**, app work only: borrow now at the floating rate, keep a fixed-term request open, and the refinance route replaces the first loan when a term lender takes the request.
4. **Notice to leave**, on floating loans only, agreed at opening. Where no lender is ready to take a loan over, its lender gives notice and the loan falls due 3 days later.
5. **The base term stays 7 or 30 days.** No 1-day term.
6. **An "Available now" line** per pair, as facts the borrower reads, with no guidance to move a loan. The one-transaction move of a loan held elsewhere is a later card (section 9).

Already decided and not reopened here: the opening fee and the yield fee are the same for every loan kind and term; lenders never share interest; the platform holds no funds together on or above it; no self-adjusting margin; idle funds leave a vault only in a one-transaction flash loan. Pre-selecting a margin of zero on floating slots is paused by the owner and is not in this design.

## 2. What the code does today

- **Capital is reserved per slot.** `fundLenderIntent` moves the amount into the lender's own vault and liens it under one slot: `lenderIntentCapital[owner][lendingAsset][collateralAsset][slot]`, written only by `LibEncumbrance.lienIntentCapital` and `unlienIntentCapital`. A lender with a term slot and a second slot on the same asset funds each separately, and money in one cannot serve the other.
- **Nine places read or move that figure:** the slot's fund, withdraw, roll and re-commit steps; the shared slot-fill rule (`LibIntentFill`); the instant fill's sizing; the takeover's incoming slot; the match preview; the slot views; the market ledger; the backstop vault's seed; and the registry that lists a slot for keepers once its capital covers one smallest fill.
- **The ledger** keeps, per asset and per pair, Declared (the sum of the largest exposure of open slots), Available (the sum of each slot's lesser of capital and unused exposure) and Lent, with day buckets so a slot with an end date leaves at the end of its closing UTC day without a transaction. No rule on-chain reads Declared or Available; only views do.
- **A lender leaves** an instant-market loan by a takeover at face value when another slot is ready, started by the lender. Otherwise the lender turns renewal off and waits for the loan's due date, which is up to one base term away.
- **A loan's due date** is read only through `LibLoanClock`, from the loan's start and term. The grace period is read from the term (`gracePeriod(durationDays)`: one hour under 7 days, one day under 30, three days under 90). The extension window opens three days before the due date, or one day after the start if that is later (`AUTO_EXTEND_WINDOW`). A loan's start and term have three listed writers, held by the pre-deploy check of step 1d4.
- **An in-place extension is refused while a refinance request is live on the loan** (`LibRefinanceRequest.assertNone`).
- **Floating loans and floating slots are designed and not yet on main.** Sections 4 and 6 are built on them.

## 3. One lending balance

### 3.1 The rule

1. A lender has **one lending balance per lending asset**: an amount in the lender's own vault, under one lien, that only the lender's slots on that asset may lend.
2. **A slot holds no money.** It holds terms. A fill of a slot may take no more than the balance, and no more than the slot's own unused exposure.
3. **The first fill is served.** Slots of one lender do not reserve parts of the balance against each other. A lender who wants an amount kept for one slot sets the largest exposure of the others so that they cannot reach it.
4. **Every public figure counts a balance once.**

### 3.2 The balance

| Step | Rule |
| --- | --- |
| Storage | `lendingBalance[owner][lendingAsset]` replaces the per-slot capital mapping, which is removed. Pre-live: nothing is migrated and no old field is kept beside the new one. The lien total is the one that exists; the balance is its row. Two writers in `LibEncumbrance` replace the two capital writers, and nothing else writes the figure. |
| Add | The owner. The checks are today's funding checks: unflagged, may open commitments, current on the Terms, and the lending asset not paused. Free balance already in the vault is taken first, then one transfer from the wallet for the rest, as an instant borrow takes its collateral: the free-balance part goes through the free-balance ledger's spend and the Ready-balance host. No slot has to exist first. A collateral asset's pause is a matter for the slot and the fill, not for the balance. |
| Withdraw | As a slot's capital is withdrawn today: the same callers, the same recovered-account rule, the same outflow class, and the account's own delay where it has one. Open at all times, whatever the state of the slots or the switches. |
| Views | The balance of one owner and asset, and a paged list of an owner's assets that have a balance or a slot. |

### 3.3 Slots

- A slot keeps every term it has. It loses only its capital.
- **A lender may have at most 16 active slots on one lending asset across all pairs** (governed, 8 to 32), beside the existing limit of 8 per pair. The owner's own steps and the views walk that list, so it must be bounded.
- **A lender's active slots on one lending asset may close on at most 4 different days** (governed, 2 to 8). Any number of slots may share a day or have no end date. The ledger's day rule needs this bound (3.7). Setting a slot that would add a fifth day is refused by name.
- Switching a slot off leaves nothing behind in it. The money is in the balance and serves the lender's other slots.

### 3.4 Fills and takeovers

- A fill of a slot needs the amount to be at least the slot's smallest fill, within the slot's unused exposure, and within the balance. It draws from the balance. Every other check of the shared slot-fill rule is unchanged.
- The incoming slot of a takeover pays the principal from its owner's balance.
- **A call that fills two slots of one lender** sees the balance fall after the first fill. The instant borrow's preview and the match preview carry a running draw per lender, so a preview never counts one balance twice.

### 3.5 Money that comes back

- **The roll of a repaid loan and the re-commit of held payments** put the money back into the balance, under the lien. The guards are today's: the slot's owner is still the loan's lender and still holds the lender token, the origin slot is active and inside its lend-until time, and the origin slot's "lend again what comes back" setting is on (`KeeperApprovalsReviewDesign.md`). With the setting off, the money stays free in the owner's vault.
- **A takeover the lender starts** pays the outgoing lender's vault as free balance, as today. The lender chose to leave.
- **A handover that makes room** (section 4) pays into the balance.

### 3.6 Finding balances and slots

- The registry keeps, per owner and lending asset, the list of that owner's active slots. It is written when a slot is set or switched off.
- **The keeper feed lists funded balances, not slots.** A balance is listed while its owner has an active slot on the asset and the balance is at least the smallest fill of any of those slots. That floor is recomputed from the owner's list when a slot is set or switched off, so a balance change costs one comparison. A listing therefore still needs real money, as today.
- The feed's reader pages balances and returns each owner's slots with the amount each could fill now. A fill writes its own slot and its owner's balance, and never walks the owner's other slots.

### 3.7 The ledger

Per lending asset the ledger states three things.

| Figure | Definition | Cost |
| --- | --- | --- |
| **Set aside** | The sum of all lending balances in the asset. | One counter, moved by each balance change. |
| **Available** | The sum, over lenders, of the lesser of the lender's balance and the lender's **open room**. Open room is the sum of the unused exposure of the lender's slots that are active, inside their fill window, and have at least their own smallest fill of room. A balance below the floor of 3.6 counts as zero. | Below. |
| **Lent** | Unchanged: all open principal, principal lent out of slots, and principal opened through the instant market. | Unchanged. |

- **Declared is retired.** It was the sum of the limits lenders typed. With one balance behind several slots, those limits overlap by design, and their sum says nothing a reader can use. Set aside is money, is exact, and counts each balance once. Each slot's own limit stays visible on the slot.
- **"How full"** stays principal lent out of slots divided by that principal plus available.
- **Available stays exact on-chain, with no keeper.** Each lender has one record per asset: the balance, the open room, and up to four closing days with the room that closes on each. From that record the lender's contribution is known for today and for each day after a closing. The asset's counter keeps day buckets, as Declared's does today, and each touch of a lender's record removes that lender's old schedule and adds the new one. The cost is bounded by the four days. The figure is stated "as of the start of today (UTC)", as now.
- **Per pair, the ledger keeps Lent only.** A balance serves every pair its lender has a slot on, so a stored per-pair available figure would have to move in every one of those pairs at each fill. The amount available to one pair is computed by the indexer from the slot and balance events and can be checked against the per-slot view. It is always labelled "available to this pair", and it is never summed across pairs, because the same balance appears in each (section 8).
- **Stated limits.** The three limits of `TermAverageAndLinkGuardsDesign.md` section 7 stand. One is added: a balance at or above the floor may still be below the smallest fill of every slot that has room left; it is counted, and the excess is never more than one smallest fill per lender. The borrow preview stays the binding answer for any amount.
- The host stays `MarketLedgerFacet`. A balance change self-calls it as a slot change does. The call made from inside repayments and defaults still never reverts.

### 3.8 Flash lending

`FlashLendingDesign.md` names a slot's un-lent capital as the source, with a consent and a fee per slot. With one balance that would put two fees on the same money. So, amended:

- **The source is a lender's lending balance.** The consent "lend for one transaction" and its fee belong to the balance: one switch and one fee per lending asset.
- A flash loan names lenders, not slots. A lender may be named once, and a draw is never more than that lender's balance.
- The lender must be live as a slot owner must be today (unflagged, may open commitments, current on the Terms, not locked or replaced), and the consent must have stood its minimum age. No slot has to be active: the money was set aside to lend. Where the Lend form pre-selects this consent (`DefaultPathsDesign.md`), it pre-selects it on the balance.
- Everything else in that design is unchanged: the vault's own outcome check, the nesting, the entry lock, the fee split, the eligible assets.

### 3.9 The backstop vault and adapters

The backstop vault and an aggregator adapter are lenders like any other: one balance per asset, slots per pair, each bounded by its largest exposure. The backstop's seed adds to its balance. Its per-pair limit is the slot's exposure, which governance sets as it sets the seed today.

### 3.10 What a lender sees

One figure per asset, "Lending balance", with Add and Withdraw. Beneath it, the slots that lend from it, each with its terms, its limit, what it has lent and what it could lend now. The Lend form asks for the amount once and then for the terms of each slot. Where a lender sets a second slot, the form says: "Your slots share one balance. Whichever borrower comes first is served."

## 4. Making room for a term loan

### 4.1 The rule

A slot that makes fixed-rate loans may carry one more consent: **make room**. In the lender's words: "When this slot can make a loan and my lending balance is short, hand over floating loans made from my balance, at face value, to make room."

1. **It runs only inside a fill of that slot**, in the same transaction, and the whole fill is refused if the room is not made. A handover can never be run for its own sake.
2. **It is the takeover that exists**, with two differences: the lender's standing consent stands in for the lender's own call, and the principal lands in the lender's lending balance, from which the fill then draws.
3. **Only as much as the fill needs.** A handover is refused once the balance already covers the fill. Loans move whole, so the last one may free more than was needed; the rest stays in the balance.

### 4.2 Design

- **Which loans may be handed over.** A floating loan that a takeover would accept today (active, opened through or continued into the instant market, interest by time, not past due, not in a fallback, no other route open on it), made from a slot of the same lender on the same lending asset, whose lender and lender-token holder are still that lender. Every refusal a takeover has applies: an amount held for the lender position, the lender token inside its transfer wait, the opening checks of a sale. The caller names another loan.
- **Who takes each loan.** Another lender's slot with the takeover consent, chosen off-chain, passing the as-new test in full. It pays from its own lending balance.
- **How it is called.** The step that fills a slot takes an optional list of handovers: the loan, the incoming lender and the incoming slot. At most 4 for one fill (governed, 1 to 8). The matcher's fill and the instant borrow's per-source fill both take it. In an instant borrow a source whose room cannot be made is skipped and reported, with its handovers undone, like any refusing source.
- **Where it lives.** One host, self-called by both fill sites before the draw. Both are close to the size limit, and the takeover's code is already in its own facet.
- **What the outgoing lender keeps.** Interest earned to that moment stays a seller claim on the loan, as in any takeover. The slot's exposure is released and the loan's slot record is rewritten for the incoming slot.
- **What the floating borrower sees.** Nothing changes for them, as in any takeover. The loan page says the loan continues with another lender.
- **Where no slot is ready,** nothing is forced. The term fill is refused, and the term slot fills when money returns to the balance. The lender may give notice by hand (section 6). Nothing gives notice automatically (section 13).
- **Protected accounts.** The consent is a slot term and follows whatever rule the slot's terms follow.
- **Events.** The takeover's event states that it made room and for which slot. The fill's event lists the handovers.

### 4.3 What cannot be gamed, and what is stated

- **Moving a loan to one's own slot.** It needs a real fill of the lender's term slot in the same transaction: a borrower with collateral, at least the slot's smallest fill, and the opening fee on the new loan. The fee alone is about a week of interest at ordinary rates. The incoming lender gains a loan it could have had from a new borrower.
- **A term borrower who repays early.** Where the term slot charges interest by time, the money returns to the balance and the floating slot may lend it again; the lender has lost the time between. This is the ordinary position of a lender whose term loan is repaid early. The slot's review says: "A lender who wants the whole term's interest sets this slot to full-term interest."
- **Stated to the lender:** "Room is made only when another lender's slot is ready to take your floating loan at face value. If none is, the term loan waits."

## 5. The borrower's mirror (app only)

A borrower borrows now at the floating rate and also posts a refinance request for the same loan on fixed terms ("fix my rate", #3637, kept standing). When a term lender takes the request, the existing refinance settles the floating loan and opens the fixed one. No contract changes.

Two facts from the code shape the app flow:

- **A live request holds back the loan's renewal** (section 2). So the app sets the request's expiry no later than the opening of the loan's renewal window, and offers to post it again after the loan has renewed. The card says: "Your request stays open until D. After your loan renews, post it again to keep looking for a fixed rate."
- **The request carries a payment permit signed by the wallet**, which lapses. Posting again is one signature.

Not proposed now: a request that survives a renewal. It would change what a request is priced against, which is a contract change with its own review (section 13).

## 6. Notice to leave

### 6.1 The rule

1. **Only a floating loan carries it, and the loan record says so.** A floating loan opened through the instant market, or continued into it at a floating rate, is stamped with a notice period of 3 days. A fixed-rate loan never is, and neither is a floating loan opened outside the instant market for a stated term. Both sides agree to it at opening: the slot's instant-market setting states it to the lender, and the borrower's own call for a floating instant borrow carries the acknowledgement, as it carries the others. The borrower's setting "accept a floating rate" in the plan for the due date states it too.
2. **The lender gives notice once.** The loan then falls due 3 days later, and never earlier than 4 days after it started. Where the loan is already due sooner than that, the date does not move and the notice still stands as the lender's decision not to renew.
3. **Notice moves the due date and nothing else.** Not the rate, not the interest owed, not the grace period, not the collateral.
4. **A lender who gave notice has left.** It does not renew the loan and its slots do not take the loan back.

### 6.2 Design

- **Who.** The holder of the lender position, or that holder's account manager. Not a keeper and not anyone else. A flagged wallet is refused.
- **When.** The loan is active, carries the notice period, has no notice open and is not past due. Otherwise the call is refused by name.
- **The date.** The notice date is three days after the later of the moment of notice and one day after the loan's start. The extension window opens three days before a due date and never in the loan's first day, so the borrower's plan always has the whole window. The loan's due date is the earlier of the notice date and the term's end.
- **The clock.** The loan gains one field, the notice due date, with one writer and one clearer, both in `LibLoanClock`. The loan's due date is the earlier of the term's end and the notice date, each moved by the time the platform was paused after it was set. Every reader already reads the one clock. The loan's start and term are not written, so the three listed writers of step 1d4 stay three; that check gains the notice field with the clock as its only home.
- **The grace period is the loan's own.** It is read from the loan's term, which notice does not change: one day on a 7-day base term, three days on a 30-day one. A noticed loan never falls into the one-hour grace of a term under 7 days.
- **The late fee** runs from the due date the clock gives, as on any loan.
- **Interest and fees.** Interest is by time, so nothing is owed for the days cut off. The opening fee is not refunded, and none is added. The review says both.
- **What the borrower's plan does.** The window is open from the notice. "Stay with my lender" is refused: notice is a reason on the lender's side, read by the one own-lender check. "Continue with another lender" runs under its rising ceiling, from the loan's own margin at the notice to the borrower's highest margin one day before the due date. "Repay from my reserve" and "Repay from my collateral" keep their lead times. Where nothing runs, the loan is due, then in grace, then closed out, as any loan.
- **What ends a notice.** A continuation with another lender and a takeover both clear it: the incoming lender accepted the loan as new and gave no notice. A takeover puts the due date back to the term's end, so the takeover's as-new test, and a handover's under section 4, read the term's end for a noticed loan: that is the date the incoming lender takes on. A plain transfer of the lender token does not clear it. The lender cannot withdraw it (section 13).
- **A live refinance request** neither stops a notice nor is cancelled by it. It is one of the borrower's ways to replace the loan.
- **Not a candidate.** While a notice stands on a loan, no slot of the lender who gave it may take that loan in a continuation. Without this a lender could give notice to re-price its own loan up to the borrower's limit.
- **Events and alerts.** One event: the loan, the lender, the moment of notice and the new due date. The borrower is alerted at once, with what the plan will try and when.

### 6.3 What is stated

- **To the borrower, before borrowing at a floating rate:** "Your lender may give 3 days' notice. The loan is then due. Your plan for the due date can move it to another lender or repay it. The opening fee is not refunded."
- **To the lender, on giving notice:** "Notice does not return your money in 3 days by itself. The loan falls due then. The borrower's plan may move it to another lender or repay it. If not, the grace period and the ordinary close-out follow."
- The due date is never shown to the lender as the date funds come back.

## 7. The base term

The base term of an instant-market loan stays 7 or 30 days, floating or fixed. A 1-day term is not offered:

- the extension window opens at the later of three days before the due date and one day after the start, so on a 1-day loan it would open at the due date and the borrower's plan would have no time to run;
- a term under 7 days has a grace period of one hour;
- the short exit a 1-day term was meant to give the lender is what notice gives, with three days for the borrower.

No work follows from this section.

## 8. The "Available now" line

App and indexer work, built with the instant market. No contract change beyond 3.7.

- **Per pair, three facts and one sentence:** the amount available to this pair; the lowest rate at which any of it is offered; the rate at or below which half of it sits; and "rates are set by lenders". Never one figure alone.
- **How the amount is counted.** For each lender, the lesser of the lending balance and the room left on that lender's slots for this pair, each lender once. Standing offers that can serve as sources are added and labelled an estimate, as today.
- **How the rates are counted.** A lender's balance is placed on that lender's cheapest slots for the pair first, as a borrower would fill them. A floating slot is shown as the reference now plus the slot's margin, labelled as today's rate.
- **Never summed across pairs.** The per-asset total shown anywhere is the on-chain Available.
- **Beside it, the borrower's own quote** for the amount they type, from the borrow preview, which is the binding figure.
- **When the indexer is behind,** the line says the figures are not known now. It does not show an old figure as current.
- **No campaign, no comparison with any other lender's rate, and no wording that guides a borrower to move a loan.**

## 9. The one-transaction move: a later card

Not built now (#3816). Recorded so the later card starts from the right facts.

- **The platform's own flash loan cannot be taken by an outside contract to fund it.** `FlashLendingDesign.md` rule 4 closes the platform to every outside call while a flash loan is open, so the borrowed money cannot be used on a platform step in the same transaction, and an instant borrow is a platform step.
- **So the move is its own platform entry.** The Diamond is the receiver. It draws from flash-consenting balances through the same vault call, a connector repays the debt held elsewhere and releases the collateral into the borrower's vault, the ordinary instant borrow runs as a self-call, and its proceeds repay the draws. Each lending vault still checks its own outcome.
- **The debt repaid is always the calling wallet's own**, never an address the caller passes.
- **Connectors are neutral.** One per interface shape, under a neutral name, declaring only the functions it calls. The contracts it may call are a governed list of addresses per network. Code, events, errors, ABIs, documents and the app carry ids and addresses only.
- **In the app** it is a plain option in the borrow form, off by default, named for what it does. Its review shows what will happen and what it costs.
- It is a new facet with outbound calls, so it has its own card and audit phase, after the flash and instant-market builds.

## 10. Contract changes

| Part | Change |
| --- | --- |
| Storage | The per-slot capital mapping is removed. Added: the lending balance per owner and asset; the per-balance ledger record (open room, closing days, floor); the per-owner slot list per asset; the flash consent and fee on the balance; the make-room consent on a slot; the notice period and notice due date on a loan. The golden layout file is rewritten, and the break is acknowledged as fresh-deploy only. |
| `LibEncumbrance` | The two capital writers become two balance writers. |
| `LenderIntentFacet` | Fund and withdraw act on the balance. Roll and re-commit return to it. Setting a slot enforces the two new limits and keeps the owner's list and floor. |
| `LibIntentFill`, `InstantFillFacet`, `OfferMatchIntentFacet`, `LibOfferMatch` | A fill draws from the balance; sizing and both previews read it with a running draw per lender; the optional handover list. |
| `InstantTakeoverFacet` | The incoming slot pays from its owner's balance. The make-room host. Clearing a notice on a takeover. |
| `MarketLedgerFacet`, `LibMarketLedger` | Set aside replaces Declared. Available per lender and asset with the bounded schedule. Per pair, Lent only. A balance host beside the slot host. |
| `LenderIntentViewFacet`, registry | The balance views; the feed of funded balances; the per-slot "could fill now" figure. The per-slot capital view is removed. |
| `BackstopFacet` | The seed adds to the backstop's balance. |
| `LibLoanClock`, the loan record | The notice field, its writer and clearer, and the due date as the earlier of two dates. |
| The lender's exit facet | `giveNotice`. Where it lives is the builder's choice by size; a split along a seam, never a trim. |
| The renewal and continuation entry | Notice as a lender-side reason; the lender who gave notice is not a candidate; a continuation clears the notice and stamps the notice period on a loan that becomes floating. |
| Pre-deploy checks | The walker of step 1d4 also holds the notice field to the clock as its only writer. `giveNotice` is caller-gated and needs no row in the open-steps ledger. The fill entries keep their rows. |
| ABIs | Re-exported for the apps and the public keeper bot. Removed selectors are swept by the all-facets refresh; this reaches a chain by fresh deploy in any case. |

## 11. Off-chain changes

- **Keeper.** The matcher reads the feed of funded balances and sizes a fill from the balance. For a term slot with the make-room consent it finds the handovers: the lender's eligible floating loans, smallest sufficient set first, each with the cheapest ready slot. The renewal pass already covers a noticed loan, whose window is open. One alert to the borrower at notice. No new pass and no new arming flag.
- **Indexer.** A table of lending balances and the changes to the slot tables (next free migration number, additive). The per-pair available figure and its split by rate. The notice event. The balance events replace the per-slot funding events; the event-coverage check is updated. A loan's due date and grace end are read from the clock's view or from the notice event, never computed from the start and term.
- **App.** The lender's balance and slots (3.10), the make-room switch on a term slot, the notice action and its statements, the "Available now" line (section 8), the borrower's mirror (section 5).
- **Public keeper bot.** ABI sync in its own PR.

## 12. Tests

1. Two slots of one lender on one asset, one balance: either may be filled up to the balance and its own limit; after one fill the other sees the reduced balance; the sum lent never passes the balance.
2. A call that names both slots of one lender: the second fill is sized from what the first left; both previews agree with the call.
3. Add from free balance, from the wallet, and from both; withdraw; a withdrawal with every slot switched off; the lien total equals the balance plus the lender's other liens after every step.
4. Roll and re-commit return to the balance with the setting on, and leave the money free with it off or with the origin slot switched off or past its lend-until time.
5. A takeover in draws the incoming lender's balance; a takeover the lender starts pays free balance.
6. The seventeenth active slot on an asset and a fifth closing day are refused by name.
7. Ledger: set aside equals the sum of balances after random sequences; available equals, for each lender, the lesser of balance and open room, summed, recomputed from scratch after random sequences of adds, withdrawals, fills, repayments, defaults, takeovers and slot changes; a lender with five slots and one balance is counted once.
8. Ledger days: a slot whose window closes today counts until the UTC day ends and leaves without a transaction; with four closing days the figure is right after each; a lender untouched for longer than the roll bound is right at its next touch.
9. The call from inside a repayment or a default never reverts for a ledger reason.
10. The feed lists a balance only at or above the floor and with an active slot; a dust balance with active slots is not listed.
11. Flash: a lender named twice is refused; a draw is never above the balance; the consent with no active slot lends; a second slot's terms change does not clear it.
12. Make room: a term fill with the balance short hands over one floating loan, the principal lands in the balance, the term loan opens, the outgoing lender's interest is a seller claim, the incoming slot's balance and exposure move, and the floating borrower's loan is unchanged.
13. Make room refused: outside a fill; with the balance already sufficient; without the consent; for a fixed loan; for a loan of another lender, a sold position, a loan with an amount held, a token inside its wait; an incoming slot that fails the as-new test; a fifth handover. A fill whose room is not made reverts whole, and in an instant borrow that source is skipped with nothing moved.
14. Notice: given by the holder on a floating instant loan, the due date becomes three days later; in the loan's first day it becomes four days after the start; the grace period equals the loan's own before and after; the late fee starts at the new date; a pause after the notice moves the date.
15. Notice refused: a fixed loan; a loan without the period; a second notice; a caller who is not the holder; a flagged holder; past due. A notice given when the term's end is sooner moves no date and still stops the renewal with that lender.
16. After notice: the own-lender renewal is refused; a continuation with another lender runs from the first moment at the loan's own margin and later up to the borrower's limit, and clears the notice; no slot of the lender who gave notice is accepted; a takeover clears the notice back to the term's end and is tested against that date; a plain transfer keeps it; a live refinance request stays live and can still replace the loan.
17. With nothing able to run, the noticed loan is due, then in grace for its own period, then defaultable, and never earlier.
18. The step 1d4 check fails on a write to the notice field outside the clock.

## 13. Alternatives considered

1. **Keep capital per slot and let the lender move it between slots.** The lender, or a keeper, must act each time a borrower arrives at the other slot, which is the idle money this removes.
2. **One balance per lender across all assets.** A balance is an amount of one asset. Rejected as meaningless.
3. **Slots reserve shares of the balance.** That is per-slot capital under another name. The largest exposure already gives a lender a hard cap per slot.
4. **Keep Declared as the sum of limits.** It would be inflated by every lender with more than one slot. A cap per lender on the sum was considered; it is not linear and would need the same schedule as Available, for a figure nobody acts on.
5. **Compute Available lazily and refresh it by a keeper-backed open step.** Cheaper per touch, but the figure would be stale after every closing day until someone acted, and it reverses the decision that this figure needs no keeper. The builder may come back to it only with measured costs and the design thread's agreement.
6. **Keep a stored per-pair Available.** Every fill would write every pair its lender serves. The indexer figure with an on-chain check per slot is exact enough for a line that is always shown beside the binding quote.
7. **Make room by repaying the floating loan** instead of handing it over. It would end a borrower's loan for the lender's convenience. A handover leaves the borrower untouched.
8. **Let anyone run a handover whenever a term request is waiting.** A waiting request is not a loan. Tying the handover to the fill is what stops it being used to move loans between lenders.
9. **Give notice automatically when a term fill is waiting.** It would bring a borrower's due date forward for a fill that may never come.
10. **Make room from fixed loans too.** At face value a fixed loan moves only where its rate is at or above the incoming slot's minimum, and which of a lender's fixed loans should give way to which is a preference this design does not have a setting for. Left out; floating loans are the stated case.
11. **Notice by rewriting the loan's term.** It would make the loan's grace period a short term's (one hour under 7 days), would add a fourth writer of the start and term, and can only land on whole days. A separate date read by the one clock avoids all three.
12. **A notice the lender may withdraw.** A lender could give and withdraw it to push a borrower's plan into acting and then stand still. Final is simpler, and a lender who wants the loan back lends again.
13. **Notice on fixed-rate loans.** A fixed rate is a promise for the term. Not offered, by the owner's decision.
14. **A 1-day base term** as the lender's short exit. Section 7.
15. **A refinance request that survives a renewal,** so the borrower's mirror needs no re-posting. A contract change to what a request is priced against. Not now.

## 14. Recommendation and order of work

Build in four parts.

| Part | What | Depends on |
| --- | --- | --- |
| L1, #3811 | One lending balance and the ledger (section 3), with the keeper, indexer and app consumers in the same PR, and the public bot's ABI sync after | Nothing. It is the base of the rest and of the flash build's consent. |
| L2, #3814 | The "Available now" line (section 8) | L1, and the instant market live on a network |
| L3, #3812 | Make room (section 4) | L1 and floating slots (#3635 part B) |
| L4, #3813 | Notice to leave (section 6) | Floating instant-market loans, and renewal with the continuation step (#3763) |

The borrower's mirror (section 5, #3815) is app work that needs floating loans and the refinance route for them. The base term (section 7) needs no work.

## 15. Wording

- "Lending balance", "set aside to lend", "add", "withdraw". Never "deposit", "savings", "pool", a shared fund, or "withdraw any time".
- "Make room". Never "call", "recall" or "callable".
- "Notice to leave", "3 days' notice". Never "on demand".
- "Available to this pair", "rates are set by lenders". Never a yield, a return, or a comparison with another lender.

## 16. Open items for the builder to raise, not decide silently

1. The measured cost of the ledger's schedule on a fill, on a repayment of a slot-held loan, and on an instant borrow of eight fills. If it is too high, come back before choosing alternative 5.
2. Whether the two new limits (16 slots, 4 closing days) are right once measured.
3. Where the make-room host and `giveNotice` live, by facet size.
4. Whether setting the make-room consent or the flash consent on a protected account should wait the account's delay.
5. Whether the notice period is best stamped as a duration or as a mark with the fixed three days, given that the extension window is a fixed constant too.
6. Each reader of a loan's due date that does not go through the one clock, if any is found.
