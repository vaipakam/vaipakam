# Fast paths as the default (design)

Card: #3761. Owner request, 2026-11-19: make the instant market the default from the first loan on the platform, with Auto-lend and single-transaction lending on by default and a way for the user to opt out, because those are the ways a lender's or a borrower's offer is filled fastest.

Amended 2026-11-19 (#3763), on the owner's second request the same day: lending and borrowing run with no end date unless the user states a period (rules 7 and 8, sections 3.6 and 4.1).

Amended 2026-11-19 with three points settled with the builder the same day: where the statement of 6.1 stands among the key risks (owner decision the same day), what a loan's page says until renewal is built, and the one entry a lender position has for getting funds out (6.1 and section 12).

Related designs: `InstantMarketDesign.md` (#3656), `FlashLendingDesign.md` (#3748), `IdleLiquidityMatchingDesign.md` section 4a (#3624, one Lend form), `AutoLendLendUntilDesign.md` (#3618, #3619), `RateAuctionDesign.md` (#3758), `LenderCashOutDesign.md` (#3760), `PayoutDestinationRuleDesign.md`.

## 1. Why

The instant market and single-transaction lending draw only from standing sources: Auto-lend slots that carry the matching consent, and (for the instant market) standing lender offers that take interest by time. Until now every one of those consents was something a lender had to find and switch on.

That leaves two gaps on a new platform:

- A borrower's first instant borrow finds nothing to fill it, so the fastest route looks broken on day one.
- A lender who posts a one-time offer waits for a direct accept or a keeper pass, and lends once. The same funds in a slot would be filled at once and lent again when repaid.

Both gaps close if a new lender lands in a slot with the fast consents unless they choose otherwise.

## 2. The rule

**A default is the pre-selected choice in a form the user reviews and signs. Nothing is lent because a user stayed silent.**

1. **Free balance is never lent.** Free balance in a vault, and every payout that lands there under the payout rule, stays free until its owner signs a Lend. Withdraw always finds it.
2. **Consents stay explicit in the contracts.** Each consent is stored as the owner set it, as today. No stored value means "yes" by being unset, and no setter gives a consent the caller did not name.
3. **No account-wide setting.** There is nothing a user must find and turn off. Each choice sits on the review screen of the step that sets it, with its own switch.
4. **One signed step.** The pre-selected choices are set in the same transaction as the slot they belong to, so the user approves them together, sees them together and cannot be left half set.
5. **Opting out is one tap, and it is remembered.** The app keeps the user's last choice for that wallet on that device and opens the form on it next time.
6. **A switched-off feature is stated.** Where a network's own switch is off, the form does not pre-select that choice and says that it is not available on this network.
7. **A choice that needs a runner says whether one is running** (#3763). Renewal, renewal with another lender and re-lending each happen only when someone submits the step. The platform's keeper does that where its pass for that step is switched on for the network. The form shows the state of that pass (running, not running, not known), pre-selects the choice only where it is running, and otherwise says that the step happens only when the user or someone else submits it, with the place in the app to do so.
8. **Open-ended is the pre-selected length** (#3763). A slot has no end date, and an instant borrow asks for none once renewal is built, unless the user states a period. Before signing, the user is told what open-ended means here and what it does not (3.6, 4.1).

## 3. The Lend form

The one Lend form of `IdleLiquidityMatchingDesign.md` 4a stays. What changes is what it opens on.

The lender always states three things, and none of them is ever filled in silently: the amount, the lowest rate accepted and the longest term. The app may show the rates of recent loans on the pair beside the rate field, with their source named. It never submits a rate the lender did not see and confirm.

Pre-selected, each shown on the review screen in plain words with its own switch:

| Choice | What it sets | Where it applies |
| --- | --- | --- |
| Keep lending when repaid | An Auto-lend slot instead of a one-time offer | Every pair an Auto-lend slot may serve |
| Re-lend repayments for me | The keeper permission for the roll action alone, for the platform's keeper (3.2) | Same, where the wallet has not given it already. Never where the platform token is the lending asset |
| Interest by time | `acceptsProRata` on the slot | Same |
| Fill instant borrows | The instant market's fills consent | Top-tier pairs, instant market on |
| Renew loans this slot made | The instant market's renewal consent | Same |
| Take over other lenders' loans at face value | The instant market's takeover consent | Same |
| Also lend for a single transaction | The flash consent, at the fee shown | A flash-eligible lending asset, flash lending on. The pair's collateral asset plays no part (`FlashLendingDesign.md` 4.1) |

Visible and **off**, under "More ways to lend": bids in rate auctions (`RateAuctionDesign.md` 4.7), advances on loans (`LenderCashOutDesign.md` 6.1) and buying existing loans. Each holds funds for a close, or ties them to another lender's loan with no date of its own, so each stays a choice the lender makes on purpose.

**What a slot fills, stated on the review screen.** A slot that takes interest by time fills a request with or without partial repayment. It does not fill a request that allows a prepay listing or carries an interest cadence, because a slot's loans carry neither today (`IdleLiquidityMatchingDesign.md` section 6 leaves that as a later decision). The "either" choice of #3621 is a setting of a one-time offer, not of a slot, and the form keeps that offer's existing preset.

The review screen also carries one link, **Make a one-time offer instead**, which creates an offer and no slot. Unpriced or NFT collateral, NFT rentals, exact deals and loan-purchase offers stay offers as before, and the form opens on the offer for them.

### 3.1 Choices that depend on others

The switches follow the conditions the contracts already set, so the form can never build a batch the contracts would refuse.

- **The instant market's consents need interest by time.** Switching "Interest by time" off switches the three instant-market choices off with it, greyed, with the line "needs interest by time". Switching it back on restores each to what the lender had.
- **The three instant-market choices are separate switches**, as they are separate consents. A lender may keep renewal and switch takeover off. Switching renewal off is shown with its meaning: the slot's instant-market loans stop renewing and fall due on their current due dates.
- **The instant market's consents need a slot that any caller may fill.** A slot limited to authorized solvers shows them off for the same reason.
- **Lending for a single transaction depends on neither.** It needs only a flash-eligible lending asset and the feature being on, so it stays as the lender set it when interest by time is off or the pair is outside the top tier. Amended 2026-11-19 (#3811): the consent belongs to the lender's lending balance for the asset, so the form pre-selects it there, once per lending asset.
- **All slot consents need the slot.** Choosing the one-time offer removes them from the review screen. An offer that takes interest by time is still a source for the instant market by that market's own rule, and the review screen says so.

### 3.2 Re-lending needs a permission, and the form says so

A repayment is lent again by the roll step, which only the slot's owner or a keeper the owner has authorized for the roll action may call. A slot alone therefore does not re-lend by itself.

- The preset includes one more line, **Re-lend repayments for me**, with its own switch. It names the platform's keeper by address and gives it the roll action only: it may return what a slot's loan has repaid, in full or in part, to the slot it came from, inside that slot's limits. It cannot withdraw, change the slot's terms or act on anything else. The batch carries that authorization when the wallet has not given it already.
- With the switch off, "Keep lending when repaid" reads as it then is: each repayment waits as a claim until the lender re-lends it with one tap or collects it. The slot still fills new requests from its un-lent capital.
- **Where the platform token is the lending asset, repayments are never lent again.** The roll step refuses that asset by rule, whoever calls it. The line is shown off and greyed with that reason, the batch carries no authorization for it, and the slot is described as it then is: it lends its capital once, and each repayment returns to the lender by the ordinary claim.
- The review screen states which case the lender is in, using the app's existing reading of the roll permission (allowed, not authorized, not available for this asset, not known), and any cost of a keeper action that the existing roll review states.
- **The roll action alone, and only where that is true.** A keeper acts for a wallet only while the wallet's own keeper access is on, and that one flag covers every keeper the wallet has approved, for every action it gave them. So:
  - Where the wallet's keeper access is on, or the wallet has approved no keeper before, the line is pre-selected. The batch adds the roll action to what the platform's keeper already holds for that wallet, removes nothing and adds nothing else, and turns keeper access on only where no other approval exists for it to bring back.
  - Where the wallet has switched keeper access off and still has keepers approved, the line is **not** pre-selected. Switching it on opens a list of every approved keeper and the actions each would regain, and the lender confirms that list before the batch may carry the flag. The words "the roll action only" are not shown in that case.
- **The permission is not the run.** The line is pre-selected only where the keeper's roll pass is running on this network (rule 7). Where it is not, or that is not known, the review says that a repayment is lent again only when the lender or someone else with the permission submits the step.
- The permission is a wallet's, not a slot's. Where the wallet already gave it, the line shows it as given and the batch carries no call for it. Switching it off on this form leaves an existing permission as it is and says where to remove it.

### 3.3 Two forms of the same consent

The app carries one setting per deployment that decides how the Lend form asks:

- **Pre-selected** (the setting as shipped). The form opens as described above, with the switches on.
- **Choose one.** The form shows two options side by side, "Lend continuously (recommended)" and "Lend once", and neither is selected until the lender taps one. The switches then sit under the option chosen, set as above for "Lend continuously". The lender's own tap carries the choice, at the cost of one more tap.

Both forms end in the same review screen and the same signed batch. The second exists so that the way consent is asked can be changed for a place that requires it without rebuilding the form.

### 3.4 One transaction

The slot's terms, its funding, the roll permission where it is needed, the instant-market consents and the flash consent are sent as one batch through the existing batch entry, which keeps the caller as the user for every step. Every step is marked as required, so a step that fails undoes the whole batch and nothing is left set.

A slot's consents are cleared when its terms are set again. So an edit of a slot's terms from the app is sent with the consents the slot had, in the same batch, and the review screen lists them again.

A consent is usable only after the minimum age the contracts already require (#3443). The form says "ready in a few seconds", not "live".

### 3.5 Slots that exist already

Nothing is set for a slot that exists. Its owner sees one card, "This slot can also fill instant borrows and lend for a single transaction", which opens the same review screen and needs the same signature.

### 3.6 Open-ended unless the lender states a period

Added 2026-11-19 (#3763). Users who have lent through pooled lending expect a position with no end date. A slot already is one, so the form opens that way and says exactly how it differs.

- **No end date is the opening state.** The slot is created with no "lend until" time. **Lend for a set period** is a choice under the form's options, off as the form opens. Switching it on asks for the date, with the wording of `AutoLendLendUntilDesign.md` section 3.
- **The longest term is still the lender's own figure** (3). It is the longest a single loan may run, not how long the slot lends. Beside the field the app says which base terms the instant market's loans run for, so a lender sees when a figure would fill no instant borrow.
- **The review screen says what open-ended means here,** under two headings:
  - *No end date.* The slot keeps lending its capital within the limits shown until the lender stops it. Its instant-market loans renew one base term at a time while the borrower also wants them to. A renewal happens when someone submits it; the review shows whether the platform's keeper does that on this network (rule 7).
  - *Getting funds back.* Capital the slot has not lent can be taken out at any time. Capital in a loan is repaid by the borrower, at any time or by the loan's due date. Stopping renewals stops a renewing loan's due date from moving again, so it then falls due within one base term; any other loan falls due on its own date. A due date is when repayment is owed, not when funds come back: that still depends on the borrower repaying, the grace period, and a close-out if the loan defaults, which can take longer and can return less than was lent (`InstantMarketDesign.md` section 9). Sooner is possible by a handover to another lender at face value or by a sale, where one is available at that moment. **Funds in a loan are not available on demand, and no date of return is promised.**
- **One control to stop.** A slot's card carries **Stop lending**. Its review lists what stops (new loans, renewals, re-lending), what is free now, and for each loan out the date its repayment falls due, labelled as due and never as the date funds come back, with "ask for a handover" beside each loan that qualifies. It uses the slot's existing controls and adds nothing to the contracts.
- **Capital that waits earns nothing.** The slot's card shows lent and waiting amounts side by side, and never a rate for the waiting part.

## 4. The Borrow form

The form opens on **Borrow now**. The borrower states the amount, the collateral and the term. The app shows what the standing sources can fill this moment, from which and at what rate, using the instant market's preview (`InstantMarketDesign.md` section 11 names one for the borrower's entry), so what is shown is what the call does. Until that preview is built the app simulates the call itself and shows that result.

- If the sources cover the amount, one step borrows it.
- If they cover part, the form offers to borrow that part now and post a request for the rest, or to post a request for all of it.
- If they cover none, the form posts a request, and says so before the borrower signs.
- For an amount at or above the smallest auction size, the form names a rate auction as a choice, once that is built.

A posted request has pre-selected the settings that the most standing lenders on that pair accept at that moment: interest by time first among them, and no prepay listing or cadence while slots fill neither (3). The form shows the count of lenders standing ready for the request as set, and how the count changes when the borrower changes a setting. The borrower's highest rate is always stated by the borrower.

### 4.1 No end date unless the borrower states a term

Added 2026-11-19 (#3763). It applies once renewal is built (`InstantMarketDesign.md` section 6). Until then the form offers a stated term only, shows no end-date choice, and says that every loan ends at its due date.

- **"No end date" is the opening state of Borrow now.** **Borrow for a set term** is the choice, with the base terms the instant market offers.
- **With no end date the borrower states two figures, and neither is filled in silently:**
  - the limit a renewal must stay inside. For a fixed loan that is the highest rate, and the app shows the rate of the fill beside the field. For a floating loan it is the highest margin over the reference, which is not a limit on the whole rate: the review shows the reference now, the margin, and the cap where the loan carries one, each on its own line, and says that without a cap the whole rate follows the reference with no upper limit (`FloatingRateCapFloorLevelsDesign.md` section 6). A margin is never shown as "up to X%".
  - the amount set aside in the loan's reserve for interest at renewals (`StandingInstructionsDesign.md` section 3). The app suggests one base term's interest at the loan's rate, shown and editable. Zero is allowed, and the review then says that the first renewal will not happen unless the reserve is funded before it.
- **"Continue with another lender if mine leaves" is pre-selected,** with its own switch (`InstantMarketDesign.md` 6.1). With it off, the loan ends at its due date when its lender stops.
- **The review screen says what open-ended means here:** the loan renews every base term while the lender keeps lending, the reserve covers the interest and the rate stays inside the borrower's limit. A lender may end it at a renewal date. It then continues with another lender inside the borrower's limit (the highest rate of a fixed loan, the highest margin of a floating one), or, where none stands ready, the borrower has until the due date and the grace period to repay. The fee charged for each added term is stated beside it (`FeeLevelsDesign.md`). The review also shows whether the platform's keeper is running renewals on this network (rule 7). Where it is not, or that is not known, "no end date" is not pre-selected, and choosing it shows that each renewal happens only when the borrower or someone else submits it before the due date.
- **A request posted for the rest carries the same choice** where the request can renew (`InstantMarketDesign.md` 6.1, the last part). Its review says that it renews only if a lender who keeps lending fills it, and otherwise ends on its due date.
- The reserve is the borrower's own money held for that loan. What is unused returns when the loan closes.

## 5. Launch configuration

The switches keep their coded default, off, so a deploy that sets nothing lends nothing by these routes. The launch configuration then sets them:

- **Instant market: on** for top-tier pairs from the first deploy, so it is available from the first loan. On a mainnet this holds only where the instant market is inside the audit phase that precedes that deploy.
- **Single-transaction lending: on** beside it, on the same condition for its own build. `FlashLendingDesign.md` kept it off until the instant market is live on a chain. With the instant market live from the start, that condition is met at launch.
- The rate auction, the advance and the purchase of existing loans keep their own switches and their own decisions.

Each switch stays the pause lever for its feature. Turning one on for a network that is already deployed is an owner step.

## 6. What a user sees

- **A new lender:** one form, three figures to state, a review screen that reads as a short list of what their funds may do, one signature.
- **A lender who wants a single loan:** the same form, one link.
- **A borrower:** the amount they can have now and its rate, before anything else.
- **A user arriving from pooled lending:** a position with no end date on either side, and one plain statement of the difference: funds in a loan are not available on demand, and a loan can end at a renewal date.
- **Everyone:** a vault whose free balance never moves without a step they signed.

### 6.1 A loan is a term, not a balance: the words and where they stand

Added 2026-11-19 (#3763, owner's follow-up the same day). A renewing loan is a fixed-rate loan for a term that renews for the same term. It is never shown as a balance the user can draw on. The same statement stands in three places: the review screen before signing, the position's page, and the key risks shown with the Terms before a first acceptance and on the risk page. In the key risks it is not a seventh entry. By the owner's decision of 2026-11-19 it stands inside the lending entry, which then opens: "If you lend: your funds stay in the loan until the borrower repays, and you cannot withdraw them before that. You may be able to sell the loan to another lender, but only if one accepts." The list stays at six. That is a change to the Terms text, so it is published as a new Terms version and a network asks for it only once the owner configures it there.

**Lender, fixed rate.** "This is a fixed-rate loan to one borrower for {term}. It renews for another {term} at the same rate while you and the borrower both keep it going. Funds in a loan cannot be withdrawn. To get them back sooner, use Get cash from this loan, which hands the loan to another lender or sells it when one is available, or stop renewals: repayment then falls due on the loan's due date. Repayment can be late, or short if the borrower defaults."

**Borrower, fixed rate.** "This is a fixed-rate loan from one lender for {term}. It renews at the same rate while you and your lender both keep it going. You can repay on any day and pay interest only for the days used. Your lender can stop renewals. The loan then continues with another lender at no more than the rate limit you set, or you repay by the due date."

- **The borrower is not held to the term.** Every renewing loan charges interest by time, so the borrower's statement says so. What it must also say is the opposite risk, that the lender can end the loan at a renewal date.
- **Variants, never silence.** A loan that does not renew says "It does not renew" in place of the renewal sentence. A floating loan names its rate as the reference plus a margin, never as a fixed rate, and follows 4.1 for its limit. Where the keeper's renewal pass is not running or not known, the renewal sentence says that a renewal happens only when someone submits it (rule 7). With "continue with another lender" off, the borrower's last sentence reads "The loan then falls due on its due date."
- **The action stands beside the statement.** The lender's position shows **Get cash from this loan** (`LenderCashOutDesign.md`) and **Stop renewals**. The borrower's shows **Repay** and **Stop renewals**. The borrower's stop clears the renewal limits of the loan's borrowing, which stops every loan of it (`BorrowingDesign.md` section 6); a borrower who wants one loan to end repays it or moves it to a borrowing of its own. The lender's renewal consent belongs to the slot, so the lender's stop says that it covers every loan the slot made, and lists them before it is signed.
- **Until renewal is built, no screen offers it.** Every loan says "It does not renew". Neither side has **Stop renewals**. The Lend form shows "Renew loans this slot made" as not available yet and sends no renewal consent, so a slot made before renewal ships gets the one-time offer of 3.5 when it does.
- **"Get cash from this loan" is the one entry on a lender position from the start.** It lists the routes the deployment has, in plain words: **Sell now** (a handover at face value, or a sale into a standing buy offer) and **Sell at my price** (a listing). "Borrow against it" is absent until the advance is built. What each route can do at that moment is read from the chain's own answer for a sale and for a handover, never worked out in the app. Where the handover is not deployed, it and its words are left out.
- **Every position shows its next renewal date,** on both sides, labelled as the date the loan renews or falls due, never as the date funds come back (3.6).
- **Balances keep the two apart.** The account's balance view shows three lines: free balance, capital waiting in a slot, and principal in loans, the last labelled "in loans, not withdrawable". Withdraw offers the free balance only, and taking waiting capital out of a slot is its own step.


The app says **pre-selected**, **switch off** and **one-time offer**. It never says auto-invest, never says idle funds are put to work, never presents a suggested rate as the platform's rate, and never states a return. The instant market is never called a pool.

For length the app says **no end date** and **set period** or **set term**. It never says that funds can be withdrawn at any time, never says on demand or instant withdrawal of lent funds, and never calls a slot a deposit or a savings balance.

## 8. Changes

| Where | Change |
| --- | --- |
| Contracts | None expected for the forms. One small read is added for the app, `instantPairEligible(lending, collateral)`, returning whether the instant market is on for this network and whether the pair qualifies, from the same rule the slot's setter enforces (no second copy). Continuing a loan with another lender is a contract change of its own, in `InstantMarketDesign.md` 6.1. The builder confirms that the batch entry carries the slot terms, the funding, the keeper authorization and both consent setters in one transaction with the caller preserved, and that a required step that fails undoes the batch. If the flash consent's build adds its own setter, it must be callable in that batch. |
| Deploy | The launch configuration sets the instant market's switch, and the flash lending switch once built and audited. |
| App (alpha05) | The Lend and Borrow forms, the review screen, the remembered choice, the card for existing slots, the line for a switched-off feature. |
| Indexer and API | Nothing new. The count of lenders standing ready per pair and setting exists (#3319). |
| Keeper | Nothing. |
| Designs | `FlashLendingDesign.md` 4.8 and 8, `InstantMarketDesign.md` 2, `IdleLiquidityMatchingDesign.md` 4a point here. |

## 9. Tests

1. The Lend form as it opens sends one batch, and the slot's terms, funding and consents on chain equal the review screen line for line.
2. Switching one independent choice off leaves that consent unset and the rest set. Switching interest by time off also clears the instant market's consents on the review screen and in the batch, leaves the flash consent as set, and the batch is accepted.
3. "Make a one-time offer instead" creates an offer and no slot.
4. On a network where a feature's switch is off, the choice is not selected, the line says so, and the batch carries no call for it.
5. On a pair outside the top tier the slot is created with no instant-market consent. The flash consent follows the lending asset alone: set when that asset is flash-eligible and flash lending is on, whatever the collateral, and absent otherwise.
6. A required step that fails leaves no slot, no funding and no consent.
7. Editing a slot's terms sends its consents again in the same batch, and they stand afterwards.
8. A payout that lands in the vault of a lender who holds a slot leaves the slot's capital unchanged. Only a repayment of that slot's own loan returns to the slot.
9. A lender who opted out is shown the opted-out form on the next visit on that device.
10. The Borrow form's "now" figure equals what the instant borrow delivers in the same block, and a part fill posts a request for exactly the rest.
11. An existing slot gains no consent until its owner signs the review.
12. With "Re-lend repayments for me" on and no earlier permission, the batch authorizes the platform's keeper for the roll action alone, and a repayment of the slot's loan is lent again by the keeper. With it off, no authorization is sent, the review screen says each repayment waits for the lender, and the keeper's roll is refused.
13. Renewal on with takeover off sets exactly that, and the slot takes over no loan.
14. A wallet with keeper access off and another keeper approved opens the form with "Re-lend repayments for me" off. Switching it on shows that keeper and its actions, and no batch turns keeper access on without that list confirmed. The platform keeper's earlier actions are unchanged by the batch apart from the roll action added.
15. A slot that lends the platform token shows "Re-lend repayments for me" off and greyed, sends no authorization, and its review screen says repayments return by the ordinary claim.
16. A request that allows a prepay listing or carries a cadence is not shown as fillable by a slot, on the Lend review or in the Borrow form's count.
17. With the form set to "choose one", nothing is selected on opening, the form cannot be submitted until an option is tapped, and the batch sent equals the pre-selected form's for the same choices.
18. A slot created from the form as it opens has no "lend until" time. With "Lend for a set period" on, the slot carries the date shown on the review.
19. The Lend review and "Stop lending" show a loan's date only as the date repayment falls due, equal to the due date on chain, with the statement that funds may come back later or short. No screen shows a date of return.
20. Before renewal is built, the Borrow form shows no end-date choice and the batch sets no renewal limits.
21. With renewal built, Borrow now as it opens sets the borrower's renewal limits, the reserve amount on the review and "continue with another lender" in the same transaction as the loans. With "Borrow for a set term" chosen, none of the three is set.
22. No highest rate and no reserve amount is sent that the borrower did not see on the review.
23. With the keeper's renewal pass not running or not known on a network, "no end date" opens unselected and its review says who must submit a renewal. The same holds for "Re-lend repayments for me" and the roll pass, and for "continue with another lender".
24. A floating loan's review shows the reference, the margin and the cap on separate lines, and no line presents the margin as a limit on the whole rate.
25. The review screen and the position's page carry the same statement for the same loan, in the variant that matches it (renewing or not, fixed or floating, runner state, "continue with another lender" on or off). The key risks carry the general statement inside the lending entry, word for word as the Terms version in force has it.
26. Withdraw never offers an amount above the free balance, and principal in loans is shown on its own line as not withdrawable.
27. The lender's "Stop renewals" lists every loan of the slot before signing, and the borrower's clears only the borrowing chosen.
28. Until the pair read exists, a dry run that fails for any reason other than the two named ones shows the pair's state as not known.

## 10. Alternatives considered

1. **A contract default: a new slot carries every consent unless its owner switches it off.** Rejected. Silence would count as consent, a stored "unset" would mean "yes", and a slot set by any other caller of the contracts would lend in ways its owner never saw.
2. **Lend free vault balance by default, with an opt-out.** Rejected, as it was in `FlashLendingDesign.md` section 7. The owner never chose it, payouts land as free balance by rule, and Withdraw must always find them.
3. **Keep everything opt-in.** Rejected. It is the state this design replaces: fills stay slow and the instant market starts empty.
4. **Pre-select every slot consent, with bids, advances and purchases.** Rejected. Those change what a lender holds or for how long, beyond "a loan within my limits".
5. **Always ask, with nothing selected.** Not the setting as shipped: it adds a tap before the first loan. Kept as the second form of 3.3, one setting away.
6. **A reward for standing in a slot.** Rejected. The usage rebate already follows a user's own lending, and a reward for holding funds ready is a different promise.
7. **Turn the switches on later, in stages.** Not chosen for the instant market, since the request is to have it from the first loan. It remains the rule for every feature whose audit phase has not finished.
8. **Hold lenders' funds together so that lent funds can be taken out on demand.** Rejected, as in `InstantMarketDesign.md` section 13. It ends the per-user vault and shares every loss. Open-ended here is made of renewing loans between one lender and one borrower.
9. **Open on a stated period and let the user ask for open-ended.** The state before #3763. Rejected: it is the opposite of what a user arriving from pooled lending expects, and loans would end for no reason either side wanted.
10. **Put the difference from pooled lending in the Terms of Service only.** Rejected as the only place. A user meets it on the review screen before signing and in the key risks, inside the lending entry (6.1).

## 11. Recommendation and order of work

Build it as an app preset over explicit, signed consents.

1. The Lend form's preset, review screen and batch, on the consents that exist (Auto-lend, interest by time, the instant market).
2. The Borrow form's "Borrow now" first.
3. The flash consent joins the preset when flash lending is built.
4. The launch configuration, with the next fresh deploy.
5. Open-ended on the Lend form (3.6) with step 1. Open-ended on the Borrow form (4.1) when renewal is built.

Builders: alpha05 for the forms; the thread that owns the deploy for the configuration; the Auto-lend build thread only if step 1's batch needs a contract change.

## 12. Open items for the builder to raise, not decide silently

Settled with the builder on 2026-11-19:

- **The funding approval is a separate prompt before the batch.** A token approval cannot sit inside the batch, so the review says "2 prompts", names the spender, and asks for the exact funding amount and never an unlimited one. Where the allowance or the free vault balance already covers the funding, it says "1 prompt" and sends no approval. The slot's terms are dry-run before the approval and the whole batch again after it.
- **No wallet batch support is needed.** The batch is the platform's own single transaction.
- **"Borrow now" ships on a simulated call first** and moves to the preview when that is built. The figure is labelled as what this block gives, and the form simulates again right before signing.
- **Pair eligibility has its own read** (section 8). Until it exists the app may dry-run the slot's setter, matching one named refusal for "not on for this network" and one for "pair does not qualify", and showing "not known" for anything else.
- **Inside the lending entry of the key risks, not a seventh entry.** Owner decision 2026-11-19 (6.1). Until that Terms version is published, the statement stands on the review screen and the position's page.
- **Before renewal is built** every loan says "It does not renew", no side has "Stop renewals", and the Lend form sends no renewal consent (6.1).
- **"Get cash from this loan" is used now** as the one entry on a lender position, with the routes the deployment has (6.1).

Still open:

1. The fee the app suggests for single-transaction lending. The line is absent, not greyed, until the flash consent's setter exists.
2. Which of the slot's existing controls gives exactly the outcome "Stop lending" states (no new loan, no renewal, no re-lending, un-lent capital free), and what the roll step does for a slot in that state.
3. Whether the suggested reserve amount in 4.1 should cover one base term or more.
4. Whether a lender needs a stop for one loan alone (6.1). Today the renewal consent is the slot's, and a handover request is the per-loan route.
5. Where the app reads a keeper pass's state from (rule 7): a status the keeper publishes per network and step, or the time of the platform keeper's latest run of that step on chain. Where neither answers, the state is "not known".
