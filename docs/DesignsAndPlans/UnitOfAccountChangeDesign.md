# Changing the unit of account on a live deployment

Status: design, for the owner's review. Nothing here is built.

## Why

The platform measures value in one unit of account, the numeraire (the US dollar on the retail
deployment). On 2026-11-09 the owner decided that the unit is fixed when a deployment is
built ("Fix numeraire at deploy"): the price guard carries the unit as part of its identity,
the Diamond records the unit's symbol once, and a guard in any other unit is refused at every
price read. A different unit meant a new deployment.

On 2026-11-22 the owner replaced that decision: the option to change the unit must exist on
a live deployment, because no unit, and no token that tracks one, can be relied on to keep
its worth or its price feeds for the life of the platform. The change must carry its own
security guards. This document is that design.

The earlier live switch (`setNumeraire`, removed with #3272) is not brought back. It was
removed for a sound reason: once prices live in the guard and thresholds in the Diamond, a
switch made in two places is a race between two contracts. The design below removes the race
instead of accepting it.

## What the scout found

**Nothing a user is owed is kept in the unit.** A loan's principal, interest, collateral, a
lien, a claim, a vault balance and a fallback split are all amounts of tokens. Loan-to-value
and the health factor are ratios of two values in the same unit, so the unit cancels. A
change of unit therefore has no figure of a loan to convert. This is the fact the whole
design rests on, and the build must keep it true (see "The unit map" below).

Two things a party pays or receives are worked out from a value in the unit and a stored
figure, and both are covered. The Full tariff's charge is the "rate per unit" row below. The
reward ceiling worked out per unit of the network's coin divides a value in the unit by a
second price read outside the guard: its retirement is already decided (2026-11-19, #919 and
#3581) and is a precondition of this build.

**What is kept in the unit, on the Diamond:**

| Kind | Examples | Why a change touches it |
| --- | --- | --- |
| Thresholds governance sets | The offer value floor, the least intent fill, the liquidation dust floor, the least principal for a finer payment cadence, the treasury's conversion threshold, the sizes of the liquidity test | Each is compared with a value read from the guard |
| Compiled figures | The default of each threshold and the range its setter accepts | A default of 10 means ten of whatever the unit is |
| Reward weights | The interest per day of each open loan side, the daily totals per network, the totals the reward network (Base) keeps for all networks | A loan opened after a change would be weighed in another unit than one opened before, on the same day |
| Rates per unit | The Full tariff's governed figure, in VPFI for each unit of opening fee per year, with its default and range | It multiplies a value in the unit, so it must move the opposite way to a threshold |
| The fee record | The value of each fee the treasury received, and the running total | A total over two units is no figure |
| Stored prices | The daily price record, the hourly checkpoints, the two prices an offer's price-move guard records | A price in the old unit must never be compared with one in the new |

**What already protects stored prices.** Every comparison of an hourly checkpoint has both
ends on one price version of one guard, and a checkpoint another guard wrote counts as no
checkpoint (#3437). The pair comparisons are ratios of two prices, which carry no unit.

**What a new guard can already do without a change of unit.** A guard reads feeds in a
predominant denominator, which may differ from its unit, and converts through a rate. So
"the feeds quoted in the unit are going away" is solved today by a new guard that reads feeds
quoted in something else and still answers in the same unit. That swap is delayed and can be
cancelled, and the Diamond accepts it. A change of unit is needed only when the unit itself
is to be left.

**What that swap lacks today.** Any guard that reports the same unit is adopted on its wait
alone, by anyone's call, with no check that it agrees with the guard it replaces. It could
do every harm the guards below exist to stop. So this design gives every replacement of the
price guard the same step, and a change of unit is the case of that step whose rate is not
one (section 2).

**A loan and its guard.** A loan can keep being priced on the price settings it was opened
under (#3437), and a vault accepts only the guards its code lists: the one new loans use and
a small number of earlier ones. A replacement of the guard therefore has to say what happens
to open loans and to vaults. Section 5 does, and it changes both of those rules.

**Two things the next guard needs.** Neither matters while the feeds are quoted in the unit,
as they are today. Both are build items below.

- The rule that lets a stable asset's answer be older when it sits at a peg takes one dollar
  as the implied peg of a feed's answer. A guard whose feeds are quoted in another unit needs
  the peg stated in that unit.
- The sizes of the liquidity test are held on the Diamond in the predominant denominator. This
  design states them in the unit, so they follow the rule of section 1 like every threshold.

**Outside the contracts.** The app already reads the unit's symbol from the chain in several
places and shows it. The indexer stores values without their unit. The keeper's thresholds
and alerts assume the unit.

## The design

### 1. One unit record, one rule

The Diamond keeps a unit record: the unit's symbol, a **scale**, the number of changes so
far, and the time of the last one. The scale is a fixed-point number with 18 decimals and
starts at one. Each change of unit multiplies it by the change's rate (new units for one old
unit).

Every figure the Diamond keeps in the unit is stored in the **first unit** (the unit the
deployment started in). One library holds the scale, and each kind of figure has one way
through it:

| Kind | Stored as | Read for use as | Examples |
| --- | --- | --- | --- |
| A value | First unit | Stored times the scale | Every threshold, its compiled default and its range. The sizes of the liquidity test. The fee record, when shown |
| A rate per unit | Per first unit | Stored divided by the scale | The Full tariff's figure in VPFI per unit per year |
| A weight | First unit | Stored, never converted | Reward weights and their totals. They are divided by one another, so both must be read raw. Converted only to be shown |
| A price | The unit of its time, with its change number | Only with a price of the same number, or with its number | The daily price record, hourly checkpoints, an offer's recorded prices |
| A ratio | No unit | As stored | Loan-to-value, health factor, every figure in basis points |

A setter is given its figure in the unit in force, and converts it before it is
range-checked and stored. So a change of unit converts every threshold, default, range, rate
and total at once and exactly alike, by changing one stored number. Nothing is looped over,
and a figure added next year is covered by construction, provided it has a kind. The unit
map (section 8) is what holds that proviso, and it is built with the rule, not after it.

**Rounding is stated per figure.** A floor a user must clear never reads below the figure
governance gave, and a cap never reads above it: the setter rounds the stored figure the way
that keeps this true, and its event reports both the figure given and the figure stored. A
floor below which something is treated as dust rounds down. A reward weight rounds down when
stored.

**Reward weights.** A loan side's interest per day is valued in the unit in force and
divided by the scale when it is registered. A day's weights stay comparable across a change
and across networks, whichever network changes first. The rate governance names may differ
from the true one by the stated drift, so weights registered after a change can be off by up
to that against those before. It is stated, not hidden.

**The sizes of the liquidity test** are values in the unit. The test converts a size to the
feeds' denominator through the guard's rate when it runs, as one explicit step, and the
concentration measure compares against the same unit figure. Today the two are taken as the
same thing, and the build separates them.

### 2. One step for every replacement of the price guard

Every replacement of the price guard goes through one step on the Diamond, whether the unit
changes or not. A replacement that keeps the unit has a rate of exactly one.

- **The registry's part.** The registry lets only the platform's main address execute a
  pending price guard. It names that address as one of its own pointers, under a delay no
  shorter than the price guard's own least delay, so that changing it is never the faster
  way to a new guard. It reads nothing from a guard that is only proposed, and knows nothing
  about units.
- **The Diamond's part.** Its step refuses unless the registry's pending guard is exactly the
  guard the Diamond's record of the replacement names, was proposed on the registry no later
  than that record, and has reached its time. A different guard put in its place on the
  registry is never applied under this record: the replacement is cancelled and proposed
  again, with its full wait. The step then executes the pointer, runs every check below, and
  writes the unit record. If any check fails the whole transaction fails: the old guard
  stays, the old unit stays, and the pending replacement stays pending.
- **Reading a guard that is not the platform's.** Every ordinary price read refuses a guard
  in another unit, and that stays so. Two guards are read on purpose although they are not
  the platform's: the proposed guard before the apply (the checks, the previews, and G15 at
  the first use of an asset), and the replaced guard after it (the settling time and the
  second key). Both go through one separate reader with the same fixed read budget, and
  nothing else can reach it. A figure of the platform is never valued through it: it answers
  only "does this guard vouch, and at what price". What a failed read does is stated with
  each guard that uses it.

There is no moment at which a threshold in one unit meets a price in another, and no moment
at which prices cannot be read.

That a routine replacement which keeps the unit also carries the paged check, the settling
time and the second key is intended. What they guard against comes from a change of feeds,
not from a change of unit. Its cost is a second guard read on a liquidation of an older loan
for the older-loan period.

### 3. The steps

1. **Propose.** Governance proposes the new guard on the registry and records the
   replacement on the Diamond: the new guard's address, the unit's symbol, the rate (one when
   the unit stays), the widest drift of the rate it accepts, the earliest and the latest
   time, and any asset it names as exempt from the agreement check, with the reason. A
   proposal is of one of two kinds, stated in it and shown for the whole wait: **checked**,
   or **without the old guard** (below). All of it is published as events.
2. **Wait.** A replacement that keeps the unit waits the registry's wait for a price guard.
   A change of unit waits at least the unit change wait (a parameter, proposed at 14 days).
   During the wait the guardian or governance may cancel either half. Cancelling one cancels
   the replacement and clears every check made for it. After the latest time the replacement
   lapses: the step refuses it, and governance cancels the registry's half before it can
   propose again.
3. **Preview.** From the proposal on, anyone can read what the replacement would do: for a
   loan, its loan-to-value and health factor under the new guard; for an asset, both guards'
   prices and the rate they imply; for each threshold, its figure in the new unit. The app
   shows a loan's holder the date and the loan's reading after it. Where the old guard no
   longer vouches for an asset, the preview shows the new reading alone and says that it has
   nothing to compare it with.
4. **Check.** Once the time has come, anyone runs the check over the assets in use, in pages.
   Each page reads both guards for its assets, records each asset's implied rate with the
   time, and publishes the two prices as an event. A page does not stop at an asset that
   fails a guard: it records the failure and names the asset in its event, and the apply is
   refused while one stands, so governance can see which asset to act on or re-make the
   proposal.
5. **Apply.** Anyone runs the final call. It accepts only checks made within the check window
   (a parameter, proposed at one hour), checks any asset that came into use since, reads the
   wrapped coin and the assets with the most pledged value again at that moment, and applies.
   A check older than the window is no check: the asset's page is run again first. A keeper
   pass backs the check and the apply, and ships disarmed.

A book too large to read in one transaction cannot have every asset read at the instant of
the apply. Two things cover the time between an asset's page and the apply. The window
bounds it to an hour, in which the two guards' readings of one asset move together unless
one of them is at fault. And the settling time (G13) checks again at the point of use: for
its length, no step on a loan goes ahead unless both guards allow it, so a reading that
parted from the other after its page cannot be acted on.

### 4. The guards

They hold for every replacement of the price guard. G7 to G9 concern a change of unit only.

| # | Guard | What it stops |
| --- | --- | --- |
| G1 | Only governance proposes. The wait is at least the price guard's own. The guardian may cancel. One replacement may be pending at a time, and it lapses at its latest time. Only the guard the proposal named is ever applied (section 2) | A replacement nobody had time to read, a guard swapped in late under an earlier proposal's wait, and a proposal kept pending for a moment of someone's choosing |
| G2 | The replacement is atomic, and only the platform's main address can execute the registry's price guard pointer (section 2) | A threshold compared with a price in another unit, a window with no prices, and a guard adopted without these checks |
| G3 | **The two guards must agree on every asset in use.** For each asset in use, and for the network's wrapped coin, the two guards' prices give the rate that asset implies. The highest and the lowest implied rate may differ by no more than twice the price tolerance (a parameter, proposed at 1%). No single asset is the anchor | A new guard that misprices any asset, the wrapped coin included. With the implied rates that close, no pair's price, and so no loan-to-value or health factor, differs between the guards by more than twice the tolerance |
| G4 | **The new guard must price what is in use.** At the apply the new guard must vouch for every asset in use that the old guard has a source for, whether or not the old guard can vouch at that moment. It holds on both kinds of proposal, and no exemption lifts it | A liquid asset becoming unpriced, which would move a loan to the settlement that only loans whose two parties agreed to it may take, and a replacement that lands with the loan book unpriced |
| G5 | An asset the old guard has a source for but cannot vouch for at that moment fails a checked replacement, unless the proposal named it exempt. An exemption lifts G3 and G5 for that asset and nothing else | A stale moment, or an outage of the network's sequencer, used to pass an unchecked price |
| G6 | The rate governance named must lie within the proposal's stated drift (at most the rate drift cap, proposed at 5%) of the middle of the implied rates, as read in the final call. When the unit stays, the middle must lie within the price tolerance of one | A mistyped or inverted rate, a rate gone stale during the wait, and a guard that reports the old unit while pricing in another |
| G7 | The rate of one change, and the scale after it, lie inside fixed ranges | A figure overflowing or rounding to nothing |
| G8 | A further change of unit inside the cool-down (a parameter, proposed at 180 days) is not refused: it waits twice the unit change wait | Churn, and a pair of changes used to walk a figure, without closing the way out if the second unit fails early |
| G9 | A change converts and never sets. No threshold is given a new figure by a change. Changing one stays its own governed step with its own range | A policy change carried inside a unit change |
| G10 | The step moves no asset and writes no loan, lien, claim or balance | A direct path from a replacement to a user's funds. What a replacement can still move is stated below the table |
| G11 | Every stored price carries its change number, and is never compared across numbers | An old price read as a new one |
| G12 | The proposal, a cancel, each check page and the applied replacement are events. Together they name both units, both guards, the rate, the scale and each asset's two prices | A replacement that cannot be reconstructed from the record |
| G13 | **The settling time.** For a stated time after a replacement (proposed at two hours, the time the hourly checkpoints need), every step that uses a price asks both guards, wherever the old one still vouches for both assets. A step that reads a loan-to-value or a health factor goes ahead only if both readings allow it: a liquidation needs the loan to be liquidatable under both, and a new loan, a collateral withdrawal and a cure need both to permit. A step that prices an amount goes ahead only while the two guards' readings of its pair are within twice the price tolerance of each other, and waits otherwise: the least output of a forced sale (at a default by time and at a sale for interest), the split at a close-out in kind, the collateral handed over on the discounted route, a match between loans, and the backstop's par check. A repayment reads no price and is untouched | Whoever runs the apply choosing the instant and, in the same transaction or the next, liquidating, borrowing or settling on the difference between the guards. In the settling time nothing can be done, and no amount can be sized, that only the replacement made possible |
| G14 | **Vaults change guard in the same transaction.** The vault code names one price guard and no earlier one. The step applies the waiting change of the vault code that makes current a version naming the new guard, and is refused unless, after it, the current version names the new guard and no live version names another. That change of the vault code can be applied by this step alone | A vault and the platform reading different guards at any moment, a pinned vault included, and a vault whose own bound holds only against the more lenient of two guards |
| G15 | **The set of assets closes for the wait.** From the proposal on, an asset may come into use only if the proposed guard also vouches for it, and the rate its two prices imply lies within twice the price tolerance of the rate the network's wrapped coin's two prices imply at that moment. The two prices are never compared unconverted, and the named rate is not the measure, since it may lie up to the drift from the implied rates (G6) | A small loan opened on an asset only the old guard prices, used to block the replacement |
| G16 | **The second key for older loans.** For a longer stated period after a replacement (a parameter, proposed at 30 days, never shorter than the settling time), a loan that started before the replacement was proposed has a second key on every line at which someone other than its borrower's side may take or sell the collateral by a reading of its health factor or loan-to-value: the liquidation line on every route (the single sale, the split sale, the discounted route and a partial liquidation), the line above it at which a match between loans is allowed, and the loan-to-value line at which the collateral counts as collapsed. While the new guard reads the loan past such a line by no more than the band (twice the price tolerance), the old guard must read it past the line too. Beyond the band the new guard's reading decides alone. The key ends early for an asset as stated below the table. A loan that started, was extended or was refinanced after the proposal reads the new guard alone: it was opened with both readings in view. It holds for every replacement, whether or not the unit changes | A borrower liquidated on a small difference between the two guards that appears after the settling time, on a loan they opened under the old one. The band bounds what the lender's side can lose to an old guard that vouches wrongly, at every moment and with no step needed |

**The assets in use** are every asset that a live loan, a lien (an open offer's among them),
an open offer, an amount set aside to lend, an Auto-lend slot or a standing commitment
names. The set is readable on the chain. It is built on the totals the platform already
keeps (the pledged total of each asset, and a principal total of each asset kept by the one
writer of principal), and an asset joins it when a total or an open offer first names it.
That joining is the one seam where G15 reads the proposed guard: an asset already in use is
never asked again. So a proposed guard that cannot be read refuses, for the wait, only the
first use of an asset that is not yet in use. An asset let in while the guards agree can
still part from the other reading before the apply and fail G3. The move must be a real one,
and the check names the asset.

**Open loans move with the guard, and older loans keep a second key.** From the apply,
every open loan is read on the new guard. That is a stated exception to "a loan keeps the
price settings it was opened under": a replacement of the guard is the retirement of the old
one for every loan at once. Leaving loans on the old guard would put off the jump to each
loan's own later move, where nothing checks it, and would leave them on feeds that may be
dying. G3 bounds the jump, G13 keeps anyone from acting on it at once, and the preview shows
it for the whole wait.

A borrower who opened a loan under the old guard had no part in the replacement. So the old
guard stays a second key on the steps that can take their collateral (G16). The test of an
older loan is its own start time against the time the replacement was proposed, so it needs
no new field. Nothing else waits on the old guard after the settling time. A repayment, a default
by time and a forced sale for interest never read it.

The second key is bounded three ways, so that it never becomes a way to hold a liquidation
off:

- **A band.** G3 held the two guards within twice the price tolerance of each other at the
  apply. A larger gap is not the replacement's doing: it is the market, or an old guard at
  fault. So the key is asked only while the new guard reads the loan inside the band below
  the line. A loan the new guard reads further under water is liquidated on that reading
  alone.
- **An end when the old guard cannot vouch.** Anyone may record that the old guard cannot
  vouch for an asset. If it still cannot when a stated time has passed (proposed at two
  hours), the key is over for every loan that names the asset. One stale moment does not
  end it, and a lender waits no longer than that time on a dead feed. Where the replaced
  guard's own controls stop it vouching for an asset, the key ends for it the same way.
- **An end when the two guards part.** Anyone may record that the rate an asset's two prices
  imply differs by more than the band from the rate they implied when the asset was checked
  for the apply, which the check recorded. If it still does when the same stated time has
  passed, the old guard is unreliable for that asset and the key is over for it. The named
  rate is not the measure here: it may itself lie some way from the implied rates (G6).

A record lives for twice the stated time and then lapses unconfirmed. Anyone may clear it
before then by a read that shows the opposite: the old guard vouching, or the implied rate
back inside the band. Neither a record nor the step that confirms it counts while the network's
sequencer is down or inside the recovery time after an outage. A keeper pass backs these
steps.

The band, not these ends, is what bounds the lender's side: at no moment can the old guard
hold a loan out of liquidation that the new guard reads more than the band under water. The
ends only stop the platform asking a guard that has nothing left to say.

**A key outlives a later replacement.** A second key names its guard and runs for its own
period. A later replacement inside that period neither ends it nor takes its place: the
loan then holds one key for each replacement since it started whose period still runs, and
while the guard in force reads the loan inside the band, every one of those keys must read
it below the line. Each key has its own ends. Without this, a second replacement by a guard
that agrees with the first would drop the protection of the loans opened before both. The
number of keys running at once is bounded by the older-loan period over the shortest wait
of a replacement.

**Two guards' prices are never compared unconverted.** After a change of unit the two
guards answer in different units. Wherever a rule here sets one guard's reading of an asset
beside the other's (G3, G15, the end of the second key, a preview), what is compared is the
rate the two prices imply: against the other assets' implied rates (G3), against the wrapped
coin's at that moment (G15), or against the asset's own at the check (the end of the key).
Where a rule compares readings of a pair, or of a loan, each reading is a ratio inside one
guard and needs no conversion (G13, G16).

**A read that ran out of gas is no answer.** Several guards turn "the guard cannot vouch"
into a decision: G4, G5, G15 and the two ends of the second key. Every read of the old guard
and of a proposed guard is handed the fixed read budget, and a read that ran out of it fails
the whole step by name. It never counts as "cannot vouch", so no caller can fake an outage
by starving a read. A step that reads two guards hands each its own budget, and the least
gas the step needs is stated with both in it.

**When the old guard is wrong, not dead.** An old guard that still vouches but prices an
asset wrongly would fail its own replacement at G3. The route is a checked proposal that
names the asset as exempt from the agreement check, with the reason, shown for the whole
wait and in the preview of every loan that names the asset. The exemption lifts G3 and G5
for that asset and nothing else: G4 holds, every other asset is checked in full, and the
rate is checked among the others. The settling time and the second key do not ask the old
guard about an exempt asset, since its reading is the one judged wrong. An exemption is the
one place a checked replacement can move a loan's reading without a bound, which is why it
is named asset by asset. Nothing here is faster than the wait: while the proposal waits the
old guard is still in force, and what limits harm in that time is the price guard's own
means and the pause.

**What a replacement can still move.** It writes no balance, but thresholds decide outcomes.
The sizes of the liquidity test decide whether an asset counts as liquid, and so whether a
default on it is sold or settled in kind. The dust floor decides the size of a part
liquidation. The offer floor, the least fill and the cadence threshold decide only what may
be opened. A checked change holds the rate within the drift, so these lines move by at most
that. On the unchecked path they move by whatever the rate is wrong by, until it is
corrected.

**A change without the old guard.** If the old unit's feeds are gone, the old guard vouches
for little or nothing. That path is never fallen into: it is a kind of proposal, shown for
the whole wait, and it waits twice the unit change wait. A checked proposal fails whenever
an asset cannot be vouched for (G5), a sequencer outage included. On this path, an asset the
old guard cannot vouch for is no failure. Every asset it still vouches for is checked in
full (G3 and G6 among those assets), and G4 holds as always. Where the new guard can price
the old unit itself, as one currency in another, the named rate must lie within the drift of
that price. Where nothing can check it, the rate is governance's named figure alone, and the
record and the event say it was unchecked.

**Correcting an unchecked rate.** A rate applied unchecked may be corrected by governance:
the same unit, the same guard, a new rate, the full unit change wait, published like a
change, outside the cool-down. A checked rate is never corrected, because it was held within
its drift when it was applied. A change may be corrected more than once, each time with the
full wait, and the rate as corrected stays inside the range one change may have (G7), so a
run of corrections cannot rescale the thresholds (G9).

A correction must also put right the reward weights registered under the wrong rate, since
weights are stored and read raw. An unchecked change and each correction of it take a change
number of their own. A weight registered under any of those numbers is marked with it and
summed apart, number by number, in each day's total, in the totals the reward network keeps
and in every message between networks. Each number's weights and totals are read through
that number's own factor: one until a correction, and after each correction the rate that
number applied over the latest corrected rate. So weights registered before a first
correction and between two corrections are each repaired by the right figure, for every
reward day not yet closed. A day already closed stays as it was paid, and the correction's
event names the days it could not reach. No weight registered under a checked rate is
marked or kept apart.

**In a pause.** The step is governance's configuration and moves nothing, so a pause does
not refuse it. Dead feeds are a likely reason for both a pause and a replacement.

### 5. What a replacement does to each thing

| Thing | At the apply |
| --- | --- |
| A loan, a lien, a claim, a balance | Nothing is written |
| Loan-to-value, health factor | Read from the new guard for every open loan, within twice the price tolerance of the old reading (G3). For the settling time a step needs both readings to allow it (G13). After it the new guard's reading stands alone, except that a loan opened before the replacement keeps the second key on a liquidation by health factor, inside the band, for the older-loan period (G16) |
| A threshold, its default and its range | Same worth, shown in the new unit |
| A rate per unit | Same charge for the same worth |
| Reward weights | Unchanged in the first unit. New loans are weighed through the scale |
| The fee record and its total | Unchanged in store. Shown in the new unit at the change's rate |
| The daily price record | Kept, with its change number |
| Hourly checkpoints | Count as none until the new guard has written two hours of them. For that time the forced-sale floor is the full configured figure and an offer's price-move guard refuses a fill |
| An offer's recorded guard prices | Kept. The comparison is a ratio, but its two ends are now read from different guards, so a guarded offer can trip, or pass, on the replacement alone by up to twice the tolerance. The app reports that as the replacement, not as a move of the market |
| Vaults | Moved to a version that names the new guard, in the same transaction (G14). The vault's own checks are ratios and bounds in tokens and hold no figure in the unit |

**Vaults change in the step, not before it and not after.** A vault takes its price guard
from its own code, so that its bounds hold even if a step of the platform is wrong. If a
version listed two guards, a vault would accept either, and its bound would hold only
against the more lenient one. So a version names one price guard. Before the step can pass:
a version that names the new guard is registered and waits the vault code wait; every other
live version but the current one is revoked, which moves a vault pinned to one onto the
current version; and the change that revokes the current version and names the new one as
its successor is proposed and waits. The step applies that last change itself. A change of
the vault code that names another price guard than the platform's can be applied by this
step alone, never by anyone else and never apart from it. And a version that names another
price guard than the platform's cannot be pinned, nor a pin to it applied, until the step
has made it current. So there is no moment at which a vault and the platform read different
guards, by the registry's route or by an owner's pin. If the step fails, the change stays waiting.
If the replacement is cancelled or lapses, governance cancels it.

So the wait of a replacement is bounded from below by the vault code wait, plus the longest
pin delay protection sets, plus the time the revokes take. The unit change wait is stated in
the parameters table with that bound.

The second key is the platform's own extra condition and never the vault's: a vault reads
only the guard its code names.

**Three approved vault statements change with this**, and all are the owner's to approve
with this design: a change of the vault code that has waited is applied by anyone, except
one that names another price guard, which only the replacement step applies; a pin is
refused to a version that names another price guard than the platform's; and the short list
of earlier price guards a version may carry is no longer used for price guards.

**A loan's guard is worked out, never stored.** No loan and no lien stores the address of a
guard or a price version. Each is read on the platform's guard of the moment. Only so can
the step move every open loan while writing none (G10).

### 6. More than one network

Each network replaces its guard by its own governance step. One change of unit uses one rate
on every network, named in each proposal with the same earliest and latest time.

- Every figure in the unit that travels between networks (the daily interest totals, a
  budget) travels in the first unit with the sender's change number, so a network on the far
  side of a change never misreads it.
- A network on which the step has not passed is behind. While it is, its new weights are
  valued in the old unit, so they drift against the others by however far the true rate has
  moved from the named one. The cross-network launch check reports it, and governance either
  completes the change there or changes back everywhere. The latest time of the proposal
  bounds how long this can last without a new decision.
- A network added after a change starts at the fleet's scale and change number, not at one.

### 7. Outside the contracts

- **App.** Every value shows the unit read from the chain, never a fixed sign. A pending
  replacement is shown with its date and its kind. History is shown in the unit of its time,
  or converted at the published rate, and the screen says which.
  During the wait both sides of a loan see both guards' readings of it. In the older-loan
  period, an older loan shows both readings to its borrower and to its lender, and says that
  inside the band a liquidation by health factor needs
  both, and until when.
- **Wording.** No text of the app, the notices or the Terms names a currency as the
  platform's unit. Each says "the unit of account" and shows the symbol read from the chain,
  so a change of unit changes no text.
- **Indexer.** Every stored value carries its change number. A change is one event, handled
  without a reset.
- **Keeper and agent.** Thresholds and alert texts read the unit record. On an unknown
  change number the keeper's value-dependent passes stand down and alert. The liquidation pass
  reads both guards for an older loan in the older-loan period, and a pass backs the two
  steps that end the second key for an asset.

### 8. The unit map

The fact that nothing owed is kept in the unit, and the proviso in section 1, are held by a
check and not by care. A manifest lists every stored figure that is a value, a rate per
unit, a weight, a price or a ratio, with its kind. It covers every contract of the platform
and not only the Diamond: the backstop's vault, the treasury's vault and its limits, and
every message between networks.

A pre-deploy check reads the storage layouts and the code and refuses:

- a stored figure that is multiplied by, divided into or compared with a value read from the
  guard, unless the manifest names its kind;
- a figure read otherwise than its kind allows (a value read raw, a weight read through the
  scale, a rate multiplied where it must be divided);
- a figure in the unit on a loan, a lien, a claim or a vault;
- a guard's address or a price version stored on a loan or a lien.

Two statements are owed to the canonical specification from this: a vault holds no figure in
the unit, and nothing owed to a party is stored in the unit.

## Alternatives considered

1. **Keep the unit fixed and deploy anew for another unit** (the decision of 2026-11-09).
   Safest and nothing to build. Replaced by the owner: a new deployment strands every open
   loan on the old one for its term.
2. **Convert each stored figure in the change's transaction.** Rejected: compiled defaults
   and ranges cannot be converted, per-loan reward weights are too many for one transaction,
   and the list of fields must be kept complete by hand for ever.
3. **Tag every figure with its unit and convert at each read.** Rejected: every reader
   carries a conversion, and one that forgets compares two units silently.
4. **Governance restates every threshold in the change** (what the removed switch did).
   Rejected: a unit change could then carry a policy change (G9).
5. **Take the rate from the guards at the moment of the change, with no named rate.**
   Rejected: each network would take a slightly different rate, which skews reward weights
   between networks, and the figure would rest on one instant's reading.
6. **Leave the registry as it is and let the Diamond catch up in a second transaction.**
   Rejected: between the two, every price read fails. Anyone could open that window by
   executing the pointer first.
7. **Guard only a replacement that changes the unit, and leave a same-unit guard swap on
   the registry's wait alone.** Rejected: the unguarded swap could do every harm the guards
   stop, so the cheapest way round them would be not to call a change a change of unit. One
   step for both is also simpler, since the registry reads nothing from a proposed guard.
8. **Check a fixed basket of assets instead of every asset in use.** Simpler, and rejected:
   the asset left out of the basket is the one a wrong feed would hurt.
9. **Compare every asset with the wrapped coin's implied rate.** Rejected: if the new guard
   misprices the wrapped coin itself, every honest asset fails and the named rate is checked
   against the wrong figure. The spread of all implied rates has no anchor to get wrong.
10. **Let only governance or the keeper run the apply, and refuse a liquidation in the same
   transaction.** Rejected: the transaction after it is as good to whoever is watching. The
   settling time (G13) removes the gain instead of the caller.
11. **Leave vaults to follow by the ordinary vault code change, or make a version that lists
    both guards current beforehand.** Rejected. By the first, a vault and the platform would
    read different guards between the two, and a pin could hold a vault on a guard that has
    stopped vouching. By the second, a vault would accept either guard, so its own bound
    would hold only against the more lenient one, with no date at which the old one goes.
12. **Leave each open loan on the unit and the guard it was opened under until it closes**
    (the owner's question of 2026-11-22). It would spare an existing borrower any move in
    their readings. Not recommended: the jump would then come at each loan's own later move
    with nothing checking it, values read on the old guard would meet thresholds scaled to
    the new unit, two guards and two sets of thresholds would run side by side for the
    longest loan's term, and older loans would stay on the feeds the change exists to
    leave, where a dead feed leaves a loan that cannot be liquidated. The second key (G16)
    gives that borrower the protection without those costs.
13. **Let governance exempt an asset the new guard cannot price.** Rejected: a liquid asset
    would become unpriced for loans whose parties never agreed to settle in kind.
14. **Refuse any second change inside the cool-down.** Rejected: if the second unit fails
    early there would be no way out for months. A longer wait keeps the brake and the exit.
15. **Keep the both-guards rule to the settling time for every loan, with no longer period
    for older loans.** Simpler, and it stops a liquidation at the change itself. Not
    recommended: the two guards can drift apart after two hours, and a borrower who opened
    under the old one would then be liquidated on the new one's reading alone.

## Recommendation

Build the design above, with one unit for every loan and the second key for older loans.

Three points in it are the owner's to decide, and the design is written to the recommended
answer of each:

- how loans opened before a replacement are priced after it: the second key inside a band
  (recommended), older loans staying on the old unit (alternative 12), or the settling time
  alone (alternative 15);
- that a change of the vault code naming another price guard is applied by the replacement
  step alone, where an approved vault statement lets anyone apply a change that has waited,
  and that such a version cannot be pinned before the step;
- that a version of the vault code no longer lists earlier price guards.

When the trouble is only with feeds, prefer a replacement that keeps the unit: it goes
through the same step and the same guards, and changes no figure a user sees.

## What is deferred

- The values of the parameters (the waits, the two tolerances, the cool-down, the settling
  time, the older-loan period, the ranges) are proposals. They are fixed in the canonical
  parameters table.
- The peg rule for a guard whose feeds are quoted in another unit is designed with the first
  such guard.
- The canonical statements (price and authority domains) are written from this design once
  it is approved.

## Build items

Precondition: the reward ceiling worked out per unit of the network's coin is retired
(#919, #3581), so no reward figure divides a value in the unit by a second price.

1. The unit record, the rule library with its five kinds, and every figure moved behind it
   (thresholds, defaults, ranges, the tariff's rate, reward weights, the fee record), with
   the rounding of each. The setters and their events. The unit map and its pre-deploy check
   are built with this item, not after it, so a figure added during the build cannot slip
   past.
2. The replacement record on the Diamond, the propose, cancel, check, apply and correct
   steps, the previews, and the separate readers for a proposed guard and for the old guard,
   each with the fixed read budget and the named failure for a read that ran out of it.
3. The registry: the main address as one of its pointers, set when the registry is
   deployed, and the price guard pointer executable by that address alone.
4. The readable set of assets in use, on the pledged total and a new principal total, and
   the rule that closes it during a wait (G15), at the one seam where an asset joins it.
5. The change number on stored prices. The sizes of the liquidity test as values in the
   unit, the test's conversion to the feeds' denominator, and the concentration measure on
   the same figure.
6. The settling time and the second key for older loans (G13, G16). Each two-guard question
   has one host that every route calls (may this loan be liquidated; is this step
   permitted), since the routes have no room to carry it themselves. The steps that end the
   key for an asset, and their keeper pass. The rule of one price for an asset in one
   transaction (#3987) keys by guard as well as by asset.
7. The vault condition (G14): the version registry's rule that a change naming another price
   guard is applied by the replacement step alone and cannot be pinned before it, the step's
   apply of it, and its read of
   the live versions, which must be walkable or be given a list it can prove complete. The
   vault code keeps one price guard.
8. A guard in a second unit for testing, with the peg rule in that unit.
9. Every message between networks that carries a figure in the unit: first unit and change
   number. A new network's start at the fleet's scale.
10. App, indexer, keeper and agent (section 7). The keeper pass for the check and the apply.
11. Tests: every guard G1 to G16 with a refusal test; a loan book walked through a change
    with every balance and every loan figure compared before and after; the tariff's charge
    and a reward share compared before and after; an apply and a liquidation tried in one
    transaction and in the next; an older loan the new guard alone reads below the line,
    tried inside the older-loan period inside and below the band, after the period, after
    the old guard's feed stops, after the two guards part, and across a second replacement
    inside the period; an asset brought into use during the wait of a change of unit; a pin
    asked to the successor version before the apply; a
    correction with weights registered before it and a reward day closed before it; a read
    starved of gas at each guard that reads; a guard replaced on the registry during the
    wait; a small loan opened during the wait on an asset the new guard does not price; a
    same-unit replacement by a guard that disagrees; a change on one network with reward
    days added up across two; the change without the old guard and its correction.
12. A drill before mainnet: a full change of unit on a fork of each testnet, from proposal to
    apply, with the comparison report kept. It is a row of the launch register.

All of it is contract work for the build after the fresh deploy's batch, in the refactor's
structure. It needs a fresh deploy: the unit record and the first-unit rule change what
stored figures mean.
