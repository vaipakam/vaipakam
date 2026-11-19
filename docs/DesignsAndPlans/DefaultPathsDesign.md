# Fast paths as the default (design)

Card: #3761. Owner request, 2026-11-19: make the instant market the default from the first loan on the platform, with Auto-lend and single-transaction lending on by default and a way for the user to opt out, because those are the ways a lender's or a borrower's offer is filled fastest.

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

## 3. The Lend form

The one Lend form of `IdleLiquidityMatchingDesign.md` 4a stays. What changes is what it opens on.

The lender always states three things, and none of them is ever filled in silently: the amount, the lowest rate accepted and the longest term. The app may show the rates of recent loans on the pair beside the rate field, with their source named. It never submits a rate the lender did not see and confirm.

Pre-selected, each shown on the review screen in plain words with its own switch:

| Choice | What it sets | Where it applies |
| --- | --- | --- |
| Keep lending when repaid | An Auto-lend slot instead of a one-time offer | Every pair an Auto-lend slot may serve |
| Re-lend repayments for me | The keeper permission for the roll action alone, for the platform's keeper (3.2) | Same, where the wallet has not given it already |
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
- **Lending for a single transaction depends on neither.** It needs only a flash-eligible lending asset and the feature being on, so it stays as the lender set it when interest by time is off or the pair is outside the top tier.
- **All slot consents need the slot.** Choosing the one-time offer removes them from the review screen. An offer that takes interest by time is still a source for the instant market by that market's own rule, and the review screen says so.

### 3.2 Re-lending needs a permission, and the form says so

A repayment is lent again by the roll step, which only the slot's owner or a keeper the owner has authorized for the roll action may call. A slot alone therefore does not re-lend by itself.

- The preset includes one more line, **Re-lend repayments for me**, with its own switch. It names the platform's keeper by address and gives it the roll action only: it may return what a slot's loan has repaid, in full or in part, to the slot it came from, inside that slot's limits. It cannot withdraw, change the slot's terms or act on anything else. The batch carries that authorization when the wallet has not given it already.
- With the switch off, "Keep lending when repaid" reads as it then is: each repayment waits as a claim until the lender re-lends it with one tap or collects it. The slot still fills new requests from its un-lent capital.
- The review screen states which of the two the lender has, using the app's existing reading of the roll permission (allowed, not authorized, not known), and any cost of a keeper action that the existing roll review states.
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

## 4. The Borrow form

The form opens on **Borrow now**. The borrower states the amount, the collateral and the term. The app shows what the standing sources can fill this moment, from which and at what rate, using the instant market's preview (`InstantMarketDesign.md` section 11 names one for the borrower's entry), so what is shown is what the call does. Until that preview is built the app simulates the call itself and shows that result.

- If the sources cover the amount, one step borrows it.
- If they cover part, the form offers to borrow that part now and post a request for the rest, or to post a request for all of it.
- If they cover none, the form posts a request, and says so before the borrower signs.
- For an amount at or above the smallest auction size, the form names a rate auction as a choice, once that is built.

A posted request has pre-selected the settings that the most standing lenders on that pair accept at that moment: interest by time first among them, and no prepay listing or cadence while slots fill neither (3). The form shows the count of lenders standing ready for the request as set, and how the count changes when the borrower changes a setting. The borrower's highest rate is always stated by the borrower.

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
- **Everyone:** a vault whose free balance never moves without a step they signed.

## 7. Wording rules

The app says **pre-selected**, **switch off** and **one-time offer**. It never says auto-invest, never says idle funds are put to work, never presents a suggested rate as the platform's rate, and never states a return. The instant market is never called a pool.

## 8. Changes

| Where | Change |
| --- | --- |
| Contracts | None expected. The builder confirms that the batch entry carries the slot terms, the funding, the keeper authorization and both consent setters in one transaction with the caller preserved, and that a required step that fails undoes the batch. If the flash consent's build adds its own setter, it must be callable in that batch. |
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
14. A request that allows a prepay listing or carries a cadence is not shown as fillable by a slot, on the Lend review or in the Borrow form's count.
15. With the form set to "choose one", nothing is selected on opening, the form cannot be submitted until an option is tapped, and the batch sent equals the pre-selected form's for the same choices.

## 10. Alternatives considered

1. **A contract default: a new slot carries every consent unless its owner switches it off.** Rejected. Silence would count as consent, a stored "unset" would mean "yes", and a slot set by any other caller of the contracts would lend in ways its owner never saw.
2. **Lend free vault balance by default, with an opt-out.** Rejected, as it was in `FlashLendingDesign.md` section 7. The owner never chose it, payouts land as free balance by rule, and Withdraw must always find them.
3. **Keep everything opt-in.** Rejected. It is the state this design replaces: fills stay slow and the instant market starts empty.
4. **Pre-select every slot consent, with bids, advances and purchases.** Rejected. Those change what a lender holds or for how long, beyond "a loan within my limits".
5. **Always ask, with nothing selected.** Not the setting as shipped: it adds a tap before the first loan. Kept as the second form of 3.3, one setting away.
6. **A reward for standing in a slot.** Rejected. The usage rebate already follows a user's own lending, and a reward for holding funds ready is a different promise.
7. **Turn the switches on later, in stages.** Not chosen for the instant market, since the request is to have it from the first loan. It remains the rule for every feature whose audit phase has not finished.

## 11. Recommendation and order of work

Build it as an app preset over explicit, signed consents.

1. The Lend form's preset, review screen and batch, on the consents that exist (Auto-lend, interest by time, the instant market).
2. The Borrow form's "Borrow now" first.
3. The flash consent joins the preset when flash lending is built.
4. The launch configuration, with the next fresh deploy.

Builders: alpha05 for the forms; the thread that owns the deploy for the configuration; the Auto-lend build thread only if step 1's batch needs a contract change.

## 12. Open items for the builder to raise, not decide silently

1. Whether the funding step in the batch needs an approval the wallet must sign first, and how the review screen states a second prompt where it does.
2. Whether a wallet that cannot send the batch (a wallet with no batch support through the app's connector) is offered the steps one by one, with the same review screen before the first.
3. The fee the app suggests for single-transaction lending.
4. Whether the borrower entry's preview of `InstantMarketDesign.md` section 11 is built as a view before the Borrow form opens on it, or the form ships on a simulated call first.
