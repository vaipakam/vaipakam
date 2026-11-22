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

**What is kept in the unit, on the Diamond:**

| Kind | Examples | Why a change touches it |
| --- | --- | --- |
| Thresholds governance sets | The offer value floor, the least intent fill, the liquidation dust floor, the least principal for a finer payment cadence, the treasury's conversion threshold, the sizes of the liquidity test | Each is compared with a value read from the guard |
| Compiled figures | The default of each threshold and the range its setter accepts | A default of 10 means ten of whatever the unit is |
| Reward weights | The interest per day of each open loan side, the daily totals per network, the totals the reward network (Base) keeps for all networks | A loan opened after a change would be weighed in another unit than one opened before, on the same day |
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
starts at one. Each change multiplies it by the change's rate (new units for one old unit).

Every figure the Diamond keeps in the unit is stored in the **first unit** (the unit the
deployment started in) and passes through one library on its way in and out:

- a figure read for use is the stored figure times the scale;
- a figure written by a setter is given in the unit in force and divided by the scale before
  it is range-checked and stored;
- a compiled default or range is in the first unit, and is read through the same rule.

So a change of unit converts every threshold, default, range, reward weight and fee total at
once and exactly alike, by changing one stored number. Nothing is looped over, and a figure
added next year is covered by construction, provided it goes through the rule. The unit map
(section 8) is what holds that proviso, and it is built with the rule, not after it.

**Rounding is stated per kind of figure.** A threshold a user must clear rounds up when
read. A floor below which something is treated as dust rounds down. A reward weight rounds
down when stored. Dividing by the scale and multiplying back does not always return the
figure given, so a setter's event reports both the figure given and the figure stored.

**Reward weights** are stored in the first unit too: a loan side's interest per day is
valued in the unit in force and divided by the scale when it is registered. A day's weights
stay comparable across a change and across networks, whichever network changes first.

**The sizes of the liquidity test** are stated in the unit and follow the rule like every
threshold. The test converts a size to the feeds' denominator through the guard's rate when
it runs, as one explicit step, and the concentration measure compares against the same unit
figure. Today the two are taken as the same thing, and the build separates them.

**A stored price is never converted.** It keeps the unit of its time, and carries the change
number it was written under. A reader that meets a price from an earlier change number
either uses it only in a ratio with another price of the same number, or reports the number
with it (the daily price record does, so a chart can convert with the published rates).

### 2. A change is one transaction, and only the Diamond can run it

A change of unit needs two things to happen: the registry's price guard pointer moves to a
guard in the new unit, and the Diamond's unit record moves. They happen in one transaction.

- **The registry's part.** For the price guard pointer alone, the registry reads the unit of
  the current guard and of the pending one before it executes. If they differ, it refuses
  unless the caller is the platform's main address. That read is of code not yet trusted, so
  it is given a fixed gas budget, and a read that fails counts as a different unit. The
  registry names the platform's main address as one of its own pointers, under its own
  delay. Apart from this the registry knows nothing about units.
- **The Diamond's part.** Its step refuses unless the registry's pending guard is exactly the
  guard the Diamond's change record names, was proposed on the registry no later than that
  record, and has reached its time. A different guard put in its place on the registry is
  never applied under this change: the change is cancelled and proposed again, with its full
  wait. The step then executes the pointer, runs every check below, and writes the unit
  record. If any check fails the whole transaction fails: the old guard stays, the old unit
  stays, and the pending change stays pending.
- **Reading the proposed guard.** Every ordinary price read refuses a guard in another unit,
  and that stays so. The checks and the previews read the proposed guard through a separate
  reader with the same fixed read budget. It is the one place where a guard in another unit
  is read on purpose, and no ordinary price read can reach it.

There is no moment at which a threshold in one unit meets a price in another, and no moment
at which prices cannot be read.

### 3. The steps

1. **Propose.** Governance proposes the new guard on the registry, as for any guard, and
   records the change on the Diamond: the new guard's address, the new unit's symbol, the
   rate, the widest drift of the rate it accepts, the earliest time, the vault code version
   that names the new guard, and any asset it names as exempt from the price check (with the
   reason). A proposal is of one of two kinds, stated in it: **checked**, or **without the
   old guard** (below). All of it is published as events.
2. **Wait.** A checked change waits at least the longer of the registry's wait for a price
   guard and the unit change wait (a parameter, proposed at 14 days). During the wait the
   guardian or governance may cancel either half. Cancelling one cancels the change and
   clears every check made for it.
3. **Preview.** From the proposal on, anyone can read what the change would do: for a loan,
   its loan-to-value and health factor under the new guard; for an asset, both guards' prices
   and the rate they imply; for each threshold, its figure in the new unit. The app shows a
   loan's holder the change's date and the loan's reading after it.
4. **Check.** Once the time has come, anyone runs the check over the assets in use, in pages.
   Each page reads both guards for its assets, records each asset's implied rate with the
   time, and publishes the two prices as an event.
5. **Apply.** Anyone runs the final call. It accepts only checks made within the check window
   (a parameter, proposed at one hour), checks any asset that came into use since, reads the
   wrapped coin and the assets with the most pledged value again at that moment, and applies.
   A keeper pass backs the check and the apply, and ships disarmed.

### 4. The guards

| # | Guard | What it stops |
| --- | --- | --- |
| G1 | Only governance proposes. The wait is at least the price guard's own. The guardian may cancel. One change may be pending at a time. Only the guard the proposal named is ever applied (section 2) | A change nobody had time to read, and a guard swapped in late under an earlier proposal's wait |
| G2 | The change is atomic (section 2) | A threshold compared with a price in another unit, and a window with no prices |
| G3 | **The two guards must agree on every asset in use.** For each asset in use, and for the network's wrapped coin, the two guards' prices give the rate that asset implies. The highest and the lowest implied rate may differ by no more than twice the price tolerance (a parameter, proposed at 1%). No single asset is the anchor | A new guard that misprices any asset, the wrapped coin included. With the implied rates that close, no pair's price, and so no loan-to-value or health factor, differs between the guards by more than twice the tolerance |
| G4 | An asset the old guard vouches for and the new one does not fails the change | A liquid asset silently becoming unpriced, which would change how a default on it settles |
| G5 | An asset the old guard has a source for but cannot vouch for at that moment fails a checked change, unless the proposal named it exempt | A stale moment used to pass an unchecked price |
| G6 | The rate governance named must lie within the proposal's stated drift (at most the rate drift cap, proposed at 5%) of the middle of the implied rates, as read in the final call | A mistyped or inverted rate, and a rate gone stale during the wait |
| G7 | The rate of one change, and the scale after it, lie inside fixed ranges | A figure overflowing or rounding to nothing |
| G8 | No second change within the cool-down (a parameter, proposed at 180 days). The cool-down does not bind a change back to the unit before, at the inverse rate, which still passes every other guard and its wait | Churn, and a pair of changes used to walk a figure, without locking in a mistake |
| G9 | A change converts and never sets. No threshold is given a new figure by a change. Changing one stays its own governed step with its own range | A policy change carried inside a unit change |
| G10 | The step moves no asset and touches no loan, lien, claim or balance | Any path from a change of unit to a user's funds |
| G11 | Every stored price carries its change number, and is never compared across numbers | An old price read as a new one |
| G12 | The proposal, a cancel, each check page and the applied change are events. Together they name both units, both guards, the rate, the scale and each asset's two prices | A change that cannot be reconstructed from the record |
| G13 | **The settling time.** For a stated time after a change (proposed at two hours, the time the hourly checkpoints need), every step that reads a loan-to-value or a health factor asks both guards, wherever the old one still vouches, and goes ahead only if both readings allow it. A liquidation needs the loan to be liquidatable under both. A new loan, a collateral withdrawal and a cure need both to permit | Whoever runs the apply choosing the instant and, in the same transaction or the next, liquidating or borrowing on the difference between the guards. In the settling time nothing can be done that only the change made possible |
| G14 | **Vaults change with it.** A vault holds the guard's address in its code. The apply refuses unless the vault code version the proposal names holds the new guard and has waited the vault code wait. The step makes that version current and revokes every version that names another guard. A revoke moves a pinned vault to the current version, by the vault domain's own rule | A vault left reading the old guard, whose own checks would then refuse a close-out the platform allows |

**The assets in use** are every asset that a live loan, a lien (an open offer's among them),
an open offer, an Auto-lend slot or a standing commitment names. The set is readable on the
chain. It is built on the totals the platform already keeps (the pledged total of each
asset, and a principal total of each asset kept by the one writer of principal), and an
asset joins it when a total or an open offer first names it. An asset that comes into use
after the change is priced by the new guard like any new asset.

**A change without the old guard.** If the old unit's feeds are gone, the old guard vouches
for little or nothing. That path is never fallen into: it is chosen in the proposal, and it
waits twice the unit change wait. On it, an asset the old guard cannot vouch for is no
failure (G5 is off). Every asset the old guard still vouches for is checked in full (G3, G4
and G6 among those assets). Where it vouches for none, the rate is governance's named figure
alone, and the record and the event say the rate was unchecked. What a wrong rate can do
then is bounded by G10: thresholds scale wrongly until governance resets them or changes
back (G8), and reward weights of loans opened after the change are off against those before.
No loan's figures and no balance change.

**In a pause.** The step is governance's configuration and moves nothing, so a pause does
not refuse it. Dead feeds are a likely reason for both a pause and a change.

### 5. What a change does to each thing

| Thing | At the change |
| --- | --- |
| A loan, a lien, a claim, a balance | Nothing |
| Loan-to-value, health factor | Read from the new guard, within twice the price tolerance of the old reading (G3). For the settling time a step needs both readings to allow it (G13). After it the new guard's reading stands alone, and the preview has shown it for the whole wait |
| A threshold, its default and its range | Same worth, shown in the new unit |
| Reward weights | Unchanged in the first unit. New loans are weighed through the scale |
| The fee record and its total | Unchanged in store. Read in the new unit at the change's rate |
| The daily price record | Kept, with its change number |
| Hourly checkpoints | Count as none until the new guard has written two hours of them. For that time the forced-sale floor is the full configured figure and an offer's price-move guard refuses a fill, as after any guard swap |
| An offer's recorded guard prices | Kept. The comparison is a ratio, but its two ends are now read from different guards, so a guarded offer can trip, or pass, on the change alone by up to twice the tolerance. The app reports that as the change, not as a move of the market |
| Vaults | Every vault runs the version that names the new guard from the change's own transaction (G14). The vault's checks are ratios and bounds in tokens and need no unit. A pin held on a revoked version ends, and its owner may pin the new one |

### 6. More than one network

Each network changes by its own governance step. One change uses one rate on every network,
named in each proposal with the same earliest time. Every figure in the unit that travels
between networks (the daily interest totals, a budget) travels in the first unit with the
sender's change number, so a network on the far side of a change never misreads it. The
reward network adds up days correctly while networks are on either side of a change. The
cross-network launch check compares unit records and reports a network left behind.

### 7. Outside the contracts

- **App.** Every value shows the unit read from the chain, never a fixed sign. A pending
  change is shown with its date. History is shown in the unit of its time, or converted at
  the published rate, and the screen says which.
- **Indexer.** Every stored value carries its change number. A change is one event, handled
  without a reset.
- **Keeper and agent.** Thresholds and alert texts read the unit record. On an unknown
  change number the keeper's value-dependent passes stand down and alert.

### 8. The unit map

The fact that nothing owed is kept in the unit, and the proviso in section 1, are held by a
check and not by care. A manifest lists every stored field that is a value or a price, with
its kind: first unit through the rule, price with change number, or ratio. A pre-deploy
check reads the storage layout and the code and refuses a field that reads a value from the
guard and stores it without being in the manifest, and any read of a first-unit field that
bypasses the rule. Every message between networks is on the same manifest.

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
7. **Check a fixed basket of assets instead of every asset in use.** Simpler, and rejected:
   the asset left out of the basket is the one a wrong feed would hurt.
8. **Compare every asset with the wrapped coin's implied rate.** Rejected: if the new guard
   misprices the wrapped coin itself, every honest asset fails and the named rate is checked
   against the wrong figure. The spread of all implied rates has no anchor to get wrong.
9. **Let only governance or the keeper run the apply, and refuse a liquidation in the same
   transaction.** Rejected: the transaction after it is as good to whoever is watching. The
   settling time (G13) removes the gain instead of the caller.
10. **Leave vaults to follow by the ordinary vault code change.** Rejected: between the two,
    a vault and the platform would read different guards, and a pin could hold a vault on a
    guard that has stopped vouching.

## Recommendation

Build the design above. Before a change of unit is ever used, prefer the guard swap that
keeps the unit when the trouble is only with feeds: it is already built and changes nothing
a user sees.

## What is deferred

- The values of the parameters (the waits, the two tolerances, the cool-down, the ranges)
  are proposals. They are fixed in the canonical parameters table.
- The peg rule for a guard whose feeds are quoted in another unit is designed with the first
  such guard.
- The canonical statements (price and authority domains) are written from this design once
  it is approved.

## Build items

1. The unit record, the rule library and every unit figure moved behind it (thresholds,
   defaults, ranges, reward weights, the fee record), with the rounding of each kind. The
   setters and their events. The unit map and its pre-deploy check are built with this item,
   not after it, so a figure added during the build cannot slip past.
2. The change record on the Diamond, the propose, cancel, check and apply steps, the
   previews, and the separate reader for a proposed guard.
3. The registry: the main address as one of its pointers, and the refusal of a unit-changing
   price guard from any other caller, with the budgeted read of each guard's unit.
4. The readable set of assets in use, on the pledged total and a new principal total.
5. The change number on stored prices. The sizes of the liquidity test stated in the unit,
   the test's conversion to the feeds' denominator, and the concentration measure on the
   same figure.
6. The settling time: the two-guard reading on every step that reads a loan-to-value or a
   health factor.
7. The vault code version bound to a change, made current and the others revoked by the
   change's step.
8. A guard in a second unit for testing, with the peg rule in that unit.
9. Every message between networks that carries a figure in the unit: first unit and change
   number.
10. App, indexer, keeper and agent (section 7). The keeper pass for the check and the apply.
11. Tests: every guard G1 to G14 with a refusal test; a loan book walked through a change
    with every balance and every loan figure compared before and after; an apply and a
    liquidation tried in one transaction and in the next; a guard replaced on the registry
    during the wait; a change on one network with reward days added up across two; the
    change without the old guard.
12. A drill before mainnet: a full change of unit on a fork of each testnet, from proposal to
    apply, with the comparison report kept. It is a row of the launch register.

All of it is contract work for the build after the fresh deploy's batch, in the refactor's
structure. It needs a fresh deploy: the unit record and the first-unit rule change what
stored figures mean.
