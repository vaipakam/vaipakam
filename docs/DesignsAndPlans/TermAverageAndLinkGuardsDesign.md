# Term average and link guards — design

**Status:** owner approved, 2026-11-17. Cards #3713 (contracts), #3714 (funded slots in the instant market), #3715 (app). #3714 and the acknowledgement field on instant borrow are built on the batch branch; the rest follows with #3337 part 1 and #3635 part A. Reviewed 2026-11-17 after the build: sections 6.4 and 7 state what was built and the wording settled for the prompt.
**Amends:** `MarketLinkedRateLimitsDesign.md` (#3635) before its part A is built; adds to `RateReferenceDesign.md` (#3337 part 1); amends `InstantMarketDesign.md` section 8.
**Related:** `FloatingRateCapFloorLevelsDesign.md`, #3637 (rate-rise illustration, "fix my rate").

## 1. Why

The owner asked whether a user could drag the fixed or the floating rate by moving depth inside the platform or outside it, whether rates need a curve with caps, and whether fixed loans can have a guide rate. The figure adopted is named the term average.

- **No rate on this platform is computed from depth.** Every rate is typed and signed by the two parties, and a loan fills only where their limits overlap. Moving funds in and out moves no rate. That stays.
- **The outside reference can be pushed**, and one use of it was too exposed: a fixed loan whose limit is linked to the reference read a one-day average whatever its term, so one day's push could be locked for a year.
- **Two signals could be inflated at no cost:** depth read from a slot's declared limit when it has reserved no capital, and any figure built from the platform's own loans.
- **A term average shown beside the rate field helps users and is safe** as long as it prices nothing. It is called an average because that is what it is: an average of rates already observed, never advice or a forecast (owner, 2026-11-17).

## 2. What does not change

- The protocol sets no rate. There is no curve from how much is lent, and no band that refuses a rate two parties agree under the protocol maximum.
- A link only tightens the maker's typed limit (`MarketLinkedRateLimitsDesign.md` 4.1).
- The floating reference's own guards (median of three or more, agreement, step limit, hold on a mute, per-loan series, cap and floor levels) are unchanged.

## 3. The window a link reads grows with the term

A linked limit reads the average reference over a window chosen by the term of the loan the fill would open:

| Term of the loan | Window | Setting bounds |
| --- | --- | --- |
| Up to 30 days | 24 hours | 12 to 72 hours |
| Over 30 days, up to 365 days | 7 days | 3 to 14 days |
| Over 365 days | 30 days | 14 to 60 days |

The gain from a pushed reference grows with the term it is locked for; the cost of the push grows with the days it must be held. Matching them keeps the cost in step with the prize.

- The term is the term of the loan being opened in that fill, so an intent or a flexible offer reads the window for each fill's own term.
- **Available** keeps its meaning for each window: the index is fresh, a checkpoint at least the window old and at most twice the window old exists, and held time is no more than half of the window.
- `averaged(asset)` becomes `averaged(asset, window)`, with the three windows as the only values a fill passes. The figure shown for "today" beside a rate field (`MarketLinkedRateLimitsDesign.md` 5b) keeps the 24-hour window.

## 4. Daily checkpoints

The rate reference records, beside each hour's checkpoint, a **daily checkpoint**: the first update of each UTC day stores the index, the held time and the timestamp keyed by the day, with the day of the one before it. A window of 7, 30 or 90 days is then found in one or two reads.

A new series starts with no history. For the long windows only, a read that reaches back before the series opened continues into the asset's previous series, which was the asset's reference at that time. The averaged figure for a 24-hour window never does: it waits for the new series' own first day.

## 5. A "market unusual" state

When the 24-hour average differs from the 30-day average by more than the **unusual distance** (5 percentage points of annual rate, bounded 2 to 15), the asset's reference is **unusual**.

- While unusual, a linked limit fills nothing for a loan whose term is over 30 days. The preview gives the reason by name (`ReferenceUnusual`, appended to each preview's error list).
- Not affected: unlinked offers and intents, floating loans, linked fills of 30 days or less.
- `status(asset)` reports the state. If the 30-day average is not available, the state is "not known" and long linked fills wait, as they do when the reference is unavailable.
- A real change of level clears the state by itself as the 30-day average follows.

## 6. The term average

### 6.1 What a fixed rate is

A fixed rate for a term is roughly the floating rate expected on average over that term. It is one figure for both sides; the gap between what a saver receives and a borrower pays elsewhere is an intermediary's spread, and this platform has none. Floating rates on-chain jump and then return to their usual level, so for a long term the fair fixed rate is often below a spiking floating rate and above a depressed one.

### 6.2 The figure

`termAverage(asset, term) = w × A24 + (1 − w) × A90`

`A24` is the 24-hour average, `A90` the 90-day average (or the longest available window of at least 30 days). `w` comes from a stated table, with straight-line steps between rows:

| Term | Weight on `A24` |
| --- | --- |
| Up to 7 days | 100% |
| 30 days | 75% |
| 90 days | 50% |
| 180 days | 25% |
| 365 days and over | 10% |

- The table is a setting changed only by a delayed change, with each weight bounded and non-increasing in the term.
- The term average adds no premium for the term. Nothing on-chain measures one honestly.
- **Available** when both averages it needs are available. A term of 7 days or less needs only `A24`.
- One view on the rate reference, `termAverage(asset, term)`, returns the figure, the two averages, the weight and whether it is available. The Diamond reads it through `LibRateReference`. The app, the indexer and an integrator therefore show the same figure.

### 6.3 A maker may link to the term average

The link on an offer or an intent slot gains a **kind**: the averaged reference (section 3) or the term average. The single `rateLinked` flag of `MarketLinkedRateLimitsDesign.md` 4.6 becomes `linkKind` (none, reference, term average), with the same margin field.

- A term-average link's linked rate is `termAverage(asset, term of the loan being opened) + margin`, floored at zero.
- Every rule of a link holds: it only tightens the typed limit; when the term average is unavailable the link fills nothing; the unusual state pauses fills over 30 days; a loan filled through any link is marked and left out of figures built from the platform's own loans.
- A term-average link is the safer choice for a long term: its long average carries most of the weight, so a short push moves it little.

### 6.4 The warning band and its acknowledgement

A rate is **outside the band** when the term average is available and the rate is above 1.5 times it or below half of it, and at least 2 percentage points away from it. The three figures are settings with bounds.

- **Every preview** (create, accept, match, intent fill, instant borrow) returns the term average, whether the rate is outside the band, and by how much. An integrator reads the same answer the app does.
- **Every step in which a user sets, changes or takes a fixed rate** is refused with a named reason when that rate is outside the band, unless the step's terms carry `rateFarFromAverageAcknowledged`. Those steps are: creating an offer, changing an existing offer's rate (the rate-only edit and the general edit), setting or changing an intent slot's rate, a direct accept, and an instant borrow. The rule is tied to the write of the rate, not to a list of entry points: one shared check is called by every writer of an offer's or a slot's fixed rate and by every taker step, so an edit can never put an unacknowledged rate on the book. Where the step is signed the flag is part of what is signed; where the user calls directly it is a field of their own call. It is never needed inside the band and it never blocks a user who sets it.
- The band applies to fixed rates only. A floating loan's rate follows the reference by its signed formula, and its protection is its cap level.
- A match of two standing offers by a third party asks for no flag: each maker acknowledged when they last wrote their rate, if they needed to.
- A rate inside the band when signed and outside when the transaction lands is refused; the app re-quotes. The app sets the flag only after the second confirmation of #3715.
- When the term average is unavailable there is no band and no flag is asked for.
- **What the prompt says (#3715).** The second confirmation shows three plain figures and the user's own rate, not a formula: "Floating rate for <asset>: 8.2% today, 6.1% over 30 days, 5.4% over 90 days. Your fixed rate of 15% for 1 year is well above these. Continue?" The three figures are `averaged(asset, window)` for 24 hours, 30 days and 90 days; one that is unavailable is shown as "not available", never as a number. Where the blended figure itself is shown it has one label, "average for this term".
- **The event states it (#3719).** The loan-opened, offer-created, offer-modified and intent-set events carry a `warnings` mask that the contract derives from this check (one bit for a fixed rate far above the term average, one for far below). It is never a caller input, so a website cannot send it empty, and the platform's own alert can say that a loan opened at a rate far from the average.

This is a prompt, not a price rule. A manipulated average can at most ask a user for one more confirmation, or fail to ask.

## 7. Depth is counted from reserved capital

A slot's **declared** exposure is a limit its owner typed. It is not money. A slot lends only from the capital reserved for it, which is held under the intent's own lien, per slot, and changes only through the intent's own steps (funding, a fill, a repayment returned to the slot, an exit). That figure is exact on-chain, so depth is counted from it and nothing needs marking.

`InstantMarketDesign.md` section 8 is amended:

- The ledger gains **available**, per lending asset and per pair: the sum of each slot's **fillable amount** over active slots whose fill window is open. A slot's fillable amount is the lesser of its reserved capital and its unused exposure, and it is zero when that lesser figure is below the slot's smallest fill, because no fill of it can succeed.
- A slot's **unused exposure** is its largest exposure less the principal still outstanding on the loans made from it. A principal repayment reduces that outstanding figure in the same step, by the same amount, so repaid principal frees room; room returns at a partial repayment, a full repayment or a default, and never waits for the lender's claim; the sum of the outstanding figures is the "lent out of slots" figure below, so both sides of "how full" come from one record.
- One helper recomputes a slot's fillable amount and adjusts the totals by the difference. It is called wherever reserved capital, outstanding principal or the slot's settings change: funding and exit, a fill, a repayment, a loan closing or being taken over into or out of a slot, a slot being set, changed or switched off.
- **"How full"** is principal lent out of slots divided by that principal plus available. It cannot pass 100%, and a fully lent slot stays in its base.
- **Declared** stays as it is and is always labelled as the limit lenders have set, never as depth.
- There is no permissionless step and no keeper pass for this.

**What the figure is, and is not.** Available is the capital reserved in slots that the ledger counts as fillable. It is a stated ledger figure, not a promise that a given borrow will succeed; the binding answer for any amount is the borrow preview, which runs every check of the fill. Three limits are part of its definition and are stated wherever it is shown (the view's own description, and the app's label):

- **End dates are counted by UTC day.** A slot with an end date leaves the totals through the same day-of-closing record the declared total uses, so a slot whose window closes today still counts until the day ends. Available and "how full" are therefore stated "as of the start of today (UTC)", exactly as declared is. Counting to the second would need a transaction at each closing, which is the permissionless step this design avoids.
- **A slot too new to fill.** A slot just set, or just given instant consent, counts from that moment. As built, the minimum terms age is bounded to 1 to 60 seconds (default 5), so no slot is held out of the totals for being new; the borrow preview still refuses a fill inside that age.
- **The figure reads the lien, not the balance.** If a vault ever held less than its liens, a fill would refuse and never over-lend, and the total would overstate until the slot's next change. The asset rules exclude the tokens that could cause this.

A slot with a large declared exposure and no reserved capital therefore adds nothing to depth, a slot holding less than its smallest fill adds nothing, and a slot whose capital is fully lent is neither dropped nor double counted. The earlier wording that slots' depth is what "can be lent at this moment" is withdrawn in favour of the definition above. Marking a slot unfunded by a permissionless call was considered and rejected: it tested the wrong balance and needed a keeper to stay current.

## 8. Figures built from the platform's own loans

A standing rule, written into the functional spec when the first such figure is built, for the app's recent-rates band, any ranking, and the own-rate source if it is ever added:

- each loan is weighted by the interest paid on it so far, never by principal;
- left out: loans whose rate came from a link, loans between addresses the self-trade rule would refuse, loans younger than a minimum age;
- one wallet's share of the weight is capped, and the figure is not shown below a minimum number of distinct lenders and of distinct borrowers;
- the figure is a trimmed median or a quartile band, never a mean.

A wash loan opened and closed at once weighs almost nothing, and one held long enough to weigh pays the yield fee on every unit of weight.

## 9. The liquidity tier

An asset's tier is the lower of the on-chain probe and the keeper-confirmed tier. The keeper's relay must raise a tier only after confirmations spread over several days and lower it on one. The keeper thread confirms this and adds the rule if it is missing. No contract change is expected.

## 10. Contract changes

| Where | Change |
| --- | --- |
| Rate reference | Daily checkpoints; `averaged(asset, window)`; the unusual state in `status`; `termAverage(asset, term)`; the weight table, the windows, the unusual distance and the band figures as bounded settings under the existing delayed change. |
| `LibRateReference` | Thin reads of the above; the effective-bound helpers take the loan's term and the link kind. |
| Offer and intent slot | `linkKind` in place of `rateLinked`. The terms of every step that sets, changes or takes a fixed rate gain `rateFarFromAverageAcknowledged`. |
| Match core and previews | The window by term, the unusual pause, the term-average link, the band fields in every preview; new named reasons appended. |
| Offer create, both offer rate edits, intent slot set and change, direct accept, instant borrow | The acknowledgement check, in one shared place, called at the write of the rate. |
| Instant market ledger | The available total and its one helper; a slot's outstanding principal reduced at each principal repayment (#3714). No new permissionless step. |

The settings above are read at the fill, for offers not yet loans. A loan's fixed rate, once set, depends on none of them.

## 11. Tests

1. Window by term: a reference pushed for one day moves the 7-day and 30-day reads by the stated fraction; a fill reads the window of its own term; an intent's two fills of different terms read different windows.
2. Daily checkpoints: found across a missed day; a long window continues into the previous series; a 24-hour window does not.
3. Unusual: enters and leaves at the distance; long linked fills refused by name while short ones, unlinked ones and floating ones proceed; "not known" behaves as unavailable.
4. Term average: each table row and a point between rows; unavailable when an average is; in a spike the one-year figure is below the 24-hour average, in a trough above.
5. Term-average link: tightens only; never outside typed limits; unavailable average fills nothing.
6. Band: inside needs no flag; outside without the flag is refused by name on offer create, on both offer rate edits, on an intent slot's set and change, on accept and on instant borrow; an offer edited from inside the band to outside it cannot be written without the flag; with the flag proceeds; a rate that leaves the band before landing is refused; no average means no check.
7. Available: a slot with declared exposure and no reserved capital adds nothing; reserved capital above unused exposure counts only up to the exposure; a slot whose lesser figure is below its smallest fill adds nothing and adds again once it reaches it; for every slot the outstanding figure equals the sum of outstanding principal of its open loans, and a partial repayment frees exactly that much exposure; funding, exit, a fill, a repayment, a closing, a takeover and a setting change each move the totals by exactly the difference; a slot with an end date leaves the totals at the end of its closing day with no transaction; "how full" never passes 100%.
8. Previews agree with the transactions for every case above.

## 12. Alternatives considered

1. **A protocol curve that sets rates from how much is lent.** It makes the protocol the price setter and creates a depth lever to pump.
2. **An on-chain band that refuses a rate far from the average.** Two informed parties may agree any rate under the protocol maximum, and the band would lean on the reference.
3. **Read both a short and a long average and use whichever protects the maker more.** Safer still, but in an honestly falling market a linked lender waits unfilled until the long average catches up.
4. **Floating plus a fixed premium per term as the displayed figure.** Wrong in a spike, when the figure matters most.
5. **A figure from the platform's own loans only.** Thin at launch and the easiest figure to move.
6. **A figure from outside fixed-rate markets.** Few have depth per asset and chain. Possible later as one more input.
7. **Warning in the app only.** An integrator's screen would not carry it; the acknowledgement in the signed terms does.
8. **A permissionless mark on slots whose owner's vault is short.** The first form of section 7. A slot's capital is reserved under its own lien, not free balance, so the mark tested the wrong figure, and an exact counter needs no mark and no keeper.
9. **A deposit to declare a slot.** Taxes honest lenders; posting fees were refused earlier.

## 13. Recommendation and order of work

1. With #3337 part 1: daily checkpoints, `averaged(asset, window)`, the unusual state, `termAverage`.
2. With #3635 part A: the window by term, the pause, `linkKind`, the band fields in previews, the acknowledgement.
3. With the instant market ledger: the available total (#3714).
4. App and indexer: #3715.

## 14. Open items for the builder to raise, not decide silently

- Whether the rate reference still fits one contract with the term average and daily checkpoints added.
- The starting bounds of each new setting once real readings can be collected.
- Where the acknowledgement check sits so the create, edit, slot, accept and instant-borrow hosts need no room of their own.
