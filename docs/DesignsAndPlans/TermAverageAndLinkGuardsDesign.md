# Term average and link guards — design

**Status:** owner approved, 2026-11-17. Cards #3713 (contracts), #3714 (funded slots in the instant market), #3715 (app). Design first, no code yet.
**Amends:** `MarketLinkedRateLimitsDesign.md` (#3635) before its part A is built; adds to `RateReferenceDesign.md` (#3337 part 1); amends `InstantMarketDesign.md` section 8.
**Related:** `FloatingRateCapFloorLevelsDesign.md`, #3637 (rate-rise illustration, "fix my rate").

## 1. Why

The owner asked whether a user could drag the fixed or the floating rate by moving depth inside the platform or outside it, whether rates need a curve with caps, and whether fixed loans can have a guide rate. The figure adopted is named the term average.

- **No rate on this platform is computed from depth.** Every rate is typed and signed by the two parties, and a loan fills only where their limits overlap. Moving funds in and out moves no rate. That stays.
- **The outside reference can be pushed**, and one use of it was too exposed: a fixed loan whose limit is linked to the reference read a one-day average whatever its term, so one day's push could be locked for a year.
- **Two signals could be inflated at no cost:** depth declared by a slot with an empty vault, and any figure built from the platform's own loans.
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
- `averaged(asset)` becomes `averaged(asset, window)`, with the three windows as the only values a fill passes. The guidance figure of `MarketLinkedRateLimitsDesign.md` 5b keeps the 24-hour window.

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
- **A create, a direct accept and an instant borrow** at a rate outside the band are refused with a named reason unless the caller's signed terms carry `rateFarFromAverageAcknowledged`. The flag is part of what the user signs. It is never needed inside the band and it never blocks a user who sets it.
- The band applies to fixed rates only. A floating loan's rate follows the reference by its signed formula, and its protection is its cap level.
- A match of two standing offers by a third party asks for no flag: both makers acknowledged at creation if they needed to.
- A rate inside the band when signed and outside when the transaction lands is refused; the app re-quotes. The app sets the flag only after the second confirmation of #3715.
- When the term average is unavailable there is no band and no flag is asked for.

This is a prompt, not a price rule. A manipulated average can at most ask a user for one more confirmation, or fail to ask.

## 7. Depth must be funded to be counted

`InstantMarketDesign.md` section 8 is amended: the **declared** total counts only funded slots.

- A permissionless step marks a slot **unfunded** when it has unused capacity of at least its smallest fill and its owner's free balance in the lending asset is below that smallest fill. A slot that is fully lent has no unused capacity and is never marked.
- An unfunded slot counts in the declared total only for the principal lent out of it now, not for its largest exposure. Its unused capacity leaves the total, and the matching part of its day-of-closing record with it. So "how full" (principal lent out of slots divided by declared) can never pass 100% or lose a lent slot from its base: a slot with 100 declared and 100 lent counts 100 either way, and one with 100 declared, 40 lent and an empty vault counts 40.
- While a slot is unfunded its counted amount follows its lent principal as loans close or are taken over.
- The mark clears, and the slot counts for its full exposure again, when the owner sets or refreshes the slot with the balance present, or a fill from it succeeds.
- The step pays nothing and changes nothing else: an unfunded slot can still be filled the moment funds arrive. A keeper pass backs it, shipped disarmed, with its row in the permissionless-steps ledger.
- The app's depth and "how full" figures use the funded total and say so.

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
| Offer and intent slot | `linkKind` in place of `rateLinked`. Create and accept terms gain `rateFarFromAverageAcknowledged`. |
| Match core and previews | The window by term, the unusual pause, the term-average link, the band fields in every preview; new named reasons appended. |
| Create, direct accept, instant borrow | The acknowledgement check, in one shared place. |
| Instant market ledger | The unfunded mark and its permissionless step (#3714). |

The settings above are read at the fill, for offers not yet loans. A loan's fixed rate, once set, depends on none of them.

## 11. Tests

1. Window by term: a reference pushed for one day moves the 7-day and 30-day reads by the stated fraction; a fill reads the window of its own term; an intent's two fills of different terms read different windows.
2. Daily checkpoints: found across a missed day; a long window continues into the previous series; a 24-hour window does not.
3. Unusual: enters and leaves at the distance; long linked fills refused by name while short ones, unlinked ones and floating ones proceed; "not known" behaves as unavailable.
4. Term average: each table row and a point between rows; unavailable when an average is; in a spike the one-year figure is below the 24-hour average, in a trough above.
5. Term-average link: tightens only; never outside typed limits; unavailable average fills nothing.
6. Band: inside needs no flag; outside without the flag is refused by name on create, accept and instant borrow; with the flag proceeds; a rate that leaves the band before landing is refused; no average means no check.
7. Unfunded mark: set only with unused capacity and a balance below the smallest fill, never on a fully lent slot; the slot then counts for its lent principal only and follows it as loans close; "how full" never passes 100%; clearing restores the full exposure exactly; a fill clears it.
8. Previews agree with the transactions for every case above.

## 12. Alternatives considered

1. **A protocol curve that sets rates from how much is lent.** It makes the protocol the price setter and creates a depth lever to pump.
2. **An on-chain band that refuses a rate far from the average.** Two informed parties may agree any rate under the protocol maximum, and the band would lean on the reference.
3. **Read both a short and a long average and use whichever protects the maker more.** Safer still, but in an honestly falling market a linked lender waits unfilled until the long average catches up.
4. **Floating plus a fixed premium per term as the displayed figure.** Wrong in a spike, when the figure matters most.
5. **A figure from the platform's own loans only.** Thin at launch and the easiest figure to move.
6. **A figure from outside fixed-rate markets.** Few have depth per asset and chain. Possible later as one more input.
7. **Warning in the app only.** An integrator's screen would not carry it; the acknowledgement in the signed terms does.
8. **A deposit to declare a slot.** Taxes honest lenders; posting fees were refused earlier.

## 13. Recommendation and order of work

1. With #3337 part 1: daily checkpoints, `averaged(asset, window)`, the unusual state, `termAverage`.
2. With #3635 part A: the window by term, the pause, `linkKind`, the band fields in previews, the acknowledgement.
3. With the instant market ledger: the unfunded mark (#3714).
4. App and indexer: #3715.

## 14. Open items for the builder to raise, not decide silently

- Whether the rate reference still fits one contract with the term average and daily checkpoints added.
- The starting bounds of each new setting once real readings can be collected.
- Where the acknowledgement check sits so the create, accept and instant-borrow hosts need no room of their own.
