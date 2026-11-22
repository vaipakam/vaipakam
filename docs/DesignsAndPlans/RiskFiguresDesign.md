# Risk figures: what a tier gives, what a loan fixes and what is read live: design

**Status:** the owner approved these rules on 2026-11-22 (five points on the
risk figures, with the points on the liquidity rules approved the same day).
This is the design of record for them. Nothing here is built by this document;
the build is part of the refactor.

**Related:** `LiquidityTiersAndExposureDesign.md` (the tiers, the standing of a
loan and the exposure limit, which this design gives their figures),
`CollateralConcentrationDesign.md` (the measure of concentration and its graded
response), `LoanSettingsSnapshotDesign.md` (the settings set a loan fixes at
its opening), `AutonomousLtvAndOracleFallback.md` (the peer reading of a tier's
cap), `MarketRateWidgetAndDepthTieredLTV.md` (the depth test and the switch of
the tier caps), `PriceGuardDesign.md` (the price every value is read at).

## 1. Why

The earlier designs gave each risk figure where it was first needed. Read
together they left six things open:

- **Which way a value rounds at a bound.** A value on the debt side rounds up
  and one on the collateral side rounds down. Nothing said which way a value
  rounds when it is set against a least or against a cap.
- **What the switch of the tier caps leaves in force** when the caps are off.
- **How far a peer reading may move a cap, and what an old reading leaves.**
- **What collateral with no tier is held to.** It now backs a loan
  (`LiquidityTiersAndExposureDesign.md`, section 5), and its figures were
  still to be stated.
- **Which figures a loan fixes at its opening and which are read live.** Each
  figure had its own answer, and no rule classed a new one.
- **Whether one asset may have a figure of its own.** Three settings could
  name an asset. The platform keeps no list of assets, so a figure for one
  asset sits badly with it.

The rules below settle each with one rule, and state what each costs.

## 2. Value, loan-to-value and health

The value of an amount is the amount times the price guard's accepted price, in
the unit of account, by one rule for every step.

- A value on the debt side rounds up, and one on the collateral side rounds
  down. A value set against a least it must reach rounds down, and a value set
  against a cap rounds up. So rounding never favours the step: no loan opens
  and no collateral leaves one smallest part past a bound, and nothing is
  gained by repeating a step at the smallest amount.
- A distrusted price gives no value. The step refuses, or states the figure as
  unknown.
- Loan-to-value is what the loan owes over the value of its collateral. Health
  is the value of the collateral, times the loan's liquidation line, over what
  it owes. Both are read at the loan's price version, by both guards inside
  the settling time of a replacement of the guard, and by both versions inside
  the settling time of a retirement of a price version.
- A bound that a preview states (the most that can be borrowed, the least
  collateral, the most that can be withdrawn) is one the binding check accepts
  in the same block. It is derived by the rule and the rounding of the check
  itself.

## 3. What a tier gives

A tier gives a loan five figures: the cap on its loan-to-value at opening, its
liquidation line, the tight floor of a forced sale, the size its concentration
is measured against, and the discount of the discounted route.

A deeper tier is never held to a more careful figure than a shallower one.
Governance sets one kind of figure for all tiers in one step, and a step that
breaks that order is refused. Each figure is read from the lower of the
asset's measured tier and its confidence tier.

The order holds for the caps a loan reads as well, where a peer reading may
stand in place of a default (section 4). Where a reading puts a deeper tier's
cap below a shallower tier's, the shallower tier's cap is cut to it. So no
shallower tier is lent against at a higher cap than a deeper one, and every
rule below that takes a shallower tier's cap takes one that is no higher.

## 4. The cap on a new loan

**The switch.** One switch of governance says whether the tier caps are on.

- On: a loan opens only at or below its collateral tier's cap, and with health
  at or above the lower floor.
- Off: the same cap holds, and health must reach the higher floor as well. So
  the caps turned off admit no loan that the caps turned on refuse.
- Turning the caps off acts at once. Turning them on waits as a setting does,
  and is refused while the list of quote assets is not set.

What this costs: the switch is no longer a way to lend past a tier's cap. It
is a way to add the higher health floor at once.

**The cap of a tier.** Each tier has a default cap and a ceiling.

- A usable peer reading stands in place of the default, lower or higher. It is
  usable while it is no older than the usable age and peer reads are not
  paused.
- A reading that stops being usable leaves the lower of it and the default,
  until a new usable reading or a change of the default that has waited. An
  old reading so never raises a cap by falling away.
- Whichever applies is cut to the tier's ceiling when a loan reads it, and to
  the cap of every deeper tier (section 3).
- A rise needs two readings in different hours. A refresh lifts the cap that
  applies past the higher of the default and the cap that applied before it
  only as far as the lower of its reading and the reading before it, and only
  where that earlier reading was found in an earlier hour, counted as the
  hourly checkpoints count hours (section 9). Otherwise the cap stays at that
  bound. The rule is measured against the cap that applies, so a waiting
  reading that falls and still lies above that cap lifts nothing in the same
  hour. The first reading for a tier is held to the default. A refresh that
  lowers the cap applies at once. So a refresh timed to a spike lifts no cap
  past that bound.
- A reading past half the usable age raises a notice while it still applies.

**The peer reading.** Anyone may refresh it.

- It is made from what other lending platforms that governance names lend
  against the reference assets that governance names for the tier.
- A reference asset counts only where at least two platforms agree within the
  agreement band. Its value is the lowest of those that agree. So a reference
  asset's value is never above what a second platform lends at, and one
  platform that loosens its own figure lifts nothing past the others that
  agree.
- A tier gets a reading only where at least two reference assets count. The
  reading is their median less the tier's haircut, stored as found, however
  low.
- A read that fails, or finds the asset not lent against or frozen there,
  counts as no reading.
- A refresh stays open in a pause. It writes a record and moves nothing, and
  no cap should change at the end of a pause because nobody could refresh.
- Being named as a reference gives an asset no tier, no standing and no figure
  of its own. It is read like any other asset.

**What never happens.** No cap that a loan reads is above its tier's ceiling,
and none is above the hard ceiling. One platform alone never raises a cap past
what a second platform lends at. No quick step raises one: turning the caps
off, a pause of peer reads and a reading that grows old each leave every cap
at or below what it was. A cap rises only by a new usable reading or by a
setting that has waited, and past the higher of the default and the figure
before it only by two readings found in different hours.

## 5. The liquidation line

Each tier has a liquidation line: the loan-to-value past which a loan of that
tier can be liquidated. A shallower tier has the lower line, so it is
liquidated earlier and keeps the wider cushion. The loan records the line of
its collateral's tier at its opening, and its health is read against that line
for its whole life. The line applies whether the tier caps are on or off.

## 6. Collateral with no tier

A liquid asset with no tier backs a loan on these figures, each no better than
any tier's:

| Figure | For collateral with no tier |
| --- | --- |
| The cap | The lowest cap that applies to any tier then, a peer reading counted, less the step. Never below the least cap, and never above that lowest cap |
| The health floor | The higher one, also with the tier caps on |
| The liquidation line | The lowest any tier has |
| The floor of a forced sale | The full floor, while the asset has no tier |
| The discounted route | Closed for the loan's life |
| Concentration | Measured against the floor size |

The least cap stops the step from taking the cap to nothing. It never lifts
the cap above a tier's: where the lowest cap of any tier is itself at or below
the least cap, collateral with no tier has that lowest cap. The loan records
that it had no tier, with its cap, its health floor and its line.

**The margin below the line.** Every cap for collateral with no tier, the
least cap included, lies below the lowest liquidation line of any tier by at
least a margin. This is checked at every change of a line or of a cap, and a
change that would break it is refused. Where a read still finds a cap above
it, the cap is cut to that line less the margin. So no loan on such collateral
opens at its line or near it.

## 7. What a loan records, and what is read live

**Recorded at the opening, for the loan's whole life:** its standing as priced
or unpriced, its collateral's tier or that it had none, its liquidation line,
the cap and the health floor it opened under, the discount of its tier, and
the level of concentration its collateral was at.

- No later change of a tier, a setting, a peer reading or what is pledged moves
  any of them, and no extension does. A new loan is the way to new figures.
- A later withdrawal of collateral, and a cure, are held to the cap and the
  health floor the loan recorded.

**Read at that moment, for every loan:** the prices, at the loan's price
version; whether collateral can be sold, and the depth a sale meets; the tier
and the calm test that a tight floor reads; and every figure of the liquidity
test. They describe the market of that moment, so a sale respects the depth
there is. Three settings are read at the sale as well: the calm bound, the
coverage and the tight floor of each tier.

**The rule that classes a figure.** A figure that decides who is owed what, or
at which reading the other side may act, is recorded at the loan's opening. A
figure that describes the market is read live, and so is a setting that says
how the market is read at a sale. Every later design that adds a figure of
risk classes it by this rule, and a figure of the first kind is never read
live for an open loan. The close-out's own figures are classed by it too: the
line at which collateral counts as collapsed, the most a forced sale may lose,
the reward of a liquidator and the sizing of a part liquidation.

**The bound on what is read live.** A change of a figure read live can choose
between a sale and the rules for a failed sale, and can set the floor of a
sale between a tight figure and the full one. It never turns a priced loan
unpriced, never moves the loan's line, cap, health floor, discount or
standing, and never lets a sale lose more than the widest figure a vault
accepts. So no change of a setting liquidates, traps or re-prices a loan that
is sound by the figures it opened on.

What this costs: a loan keeps the figures of its opening when later settings
would have been kinder to it, and one more figure, the health floor, is kept
on each loan.

## 8. Concentration

`CollateralConcentrationDesign.md` keeps the measure and the graded response.
This design adds four rules to it.

- **The pledged amount equals the liens.** For each asset the platform keeps
  the amount pledged under the live collateral liens of priced loans, with the
  collateral held after a failed sale. Every step that makes, changes or ends
  such a lien moves the amount in that step, through the one writer of liens,
  so the amount always equals their sum.
- **A release is never refused for the amount.** No release of collateral, and
  no close-out that makes one, is refused because of the pledged amount. Where
  the amount is less than a release takes, it stops at zero, and an event
  names the asset and what was short. From then, until governance has set the
  amount right, a new loan on that asset has the response of the high
  threshold. The keeper alerts operators on the event. A fault in this record
  so costs new loans room, and never holds a party's collateral.
- **The level a loan records does not depend on the keeper.** It is measured
  against the size the exposure limit uses, the lower of the asset's measured
  tier and its proven tier, which does not lapse. So no loan is marked for its
  life because the keeper was silent.
- **High, for the shallowest tier and for no tier.** At or above the high
  threshold the cap is the next shallower tier's, which is never above its
  own (section 3). For the shallowest tier, and for collateral with no tier,
  it is the cap already given less the step, never below the least cap and
  never above the cap already given. So High never raises a cap. This holds
  whether the tier caps are on or off,
  and no health floor changes. Where the lowered cap is not below what the
  loan is held to already, nothing is lowered, and the reading and the
  interface say so.

The thresholds are read live for new loans and are no part of what a loan
records. A refinance and a roll open loans and are judged. An extension in
place opens none and is not.

## 9. The checkpoints and the calm test

- The platform keeps one series of hourly checkpoints and one of daily
  checkpoints for each asset. The first caller in an hour, or in a day, writes
  that slot, and anyone may be that caller. A keeper pass backs it.
- A slot holds the guard's accepted price at the newest price version of that
  moment, and names that version. A distrusted price writes no slot. A slot is
  never written twice: the first write of an hour stands, and nobody replaces
  or corrects it.
- Writing a slot moves no funds and gives the caller nothing. It stays open in
  a pause. With no slot written then, every sale would have the full floor and
  every guarded offer would refuse once the pause ends.
- A pair is calm when the rate of its two assets now is within the calm bound
  of their rate at each of the last two hourly checkpoints. The look back so
  reaches at least an hour, whoever wrote the newest slot.
- Each comparison has both ends on the same settings: the rate now is read at
  the version the slot names. So a change of settings alone never reads as a
  move of the market.
- A pair that cannot be shown calm is not calm. That is so where a slot is
  missing for either asset in either hour, a price cannot be read, a slot
  names a version the guard has retired, or a replacement of the guard is
  inside its settling time.
- There is one test. The floor of a forced sale and an offer's price-move
  guard both read it.

## 10. The floor of a forced sale

A forced sale loses no more to the market than the full floor. It is held to
the tight floor of its collateral's tier only where both of these hold: the
pair is calm, and the collateral is worth at least the coverage figure of all
the loan owes.

- The tier is the one the asset has at that moment, with depth read as a
  close-out reads it. So a loan that opened with no tier has a tight floor
  once its asset has earned a tier, and the full floor until then.
- Where a condition fails or cannot be shown, the sale has the full floor at
  once. A missing input only widens the floor, and never tightens it.
- No tight floor is set below its least.
- This holds for every forced sale: a liquidation on every route, a part
  liquidation, a default by time and a sale for interest.

## 11. The settings, and a named asset

Each figure of this design is a setting with a fixed range, changed only under
its delay and published. A change reaches loans that open after it, and no
figure an open loan recorded moves. The three settings a sale reads reach
every sale after the change. A figure that is a value in the unit of account
follows a change of unit as every threshold does.

**No setting gives a named asset a figure of its own.** Three settings that
named one asset are dropped: a ceiling on one asset's cap, a cap on one
asset's liquidation bonus, and thresholds of concentration for one asset. A
named asset is made more careful only by three things, and each only takes
away:

- **Its pause**, with its fixed and published grounds.
- **A lower confidence tier.** Governance may lower an asset's confidence
  tier at once, as the keeper may. A lowering by governance stands until
  governance lifts it: no renewal, no step of the keeper and no passing of
  time raises the tier above the one governance set. Each lowering is
  published with its grounds, as a pause of an asset is, and so is each
  lifting. Lifting gives nothing back. The tier is then earned again from the
  tier governance set, a step at a time
  (`LiquidityTiersAndExposureDesign.md`, section 4).
- **A short pledged amount** (section 8), until governance has set it right.

What this costs: governance cannot give one asset a tighter cap or threshold
than its tier has. It can pause the asset, or lower its confidence tier and
say why.

## 12. Figures

| Figure | Proposed | Range |
| --- | --- | --- |
| The health floor of a new loan | 1.5 | 1.2 to 2.0 |
| The lower health floor, while the tier caps are on | 1.0 | Fixed |
| The default cap of each tier | 50, 60 and 65 percent | Never above the tier's ceiling |
| The ceiling of each tier's cap | 55, 69 and 82 percent | Never above the hard ceiling of 82 |
| The haircut off each tier's peer reading | 0, 0 and 5 points | At most 10 |
| The usable age of a peer reading | 14 days | To be stated |
| The agreement band between platforms | 30 points | To be stated |
| The liquidation line of each tier | 80, 85 and 90 percent | To be stated, not falling from the first tier to the third |
| The step off a cap | 10 points | 5 to 25 |
| The least cap for collateral with no tier | 20 percent | 10 to 40 |
| The least margin below the lowest line | 10 points | 5 to 30 |
| The caution and high thresholds of concentration | 5 and 10 times the size | 2 to 20, and above caution up to 50 |
| The calm bound | 2 percent | To be stated |
| The coverage a tight floor needs | 110 percent | To be stated |
| The tight floor of each tier | 4.5, 3.5 and 2.5 percent | Each at or above a least of 1 percent |

Governance changes each under the setting's delay, except the lower health
floor, which is fixed. The figures are proposed and are confirmed with the
parameters table.

## 13. Tests

- A value one smallest part either side of a least and of a cap, on each
  bound of this design, and a step repeated many times at the smallest amount.
  Each bound a preview states, used exactly and one smallest part past it.
- A loan one smallest part inside and outside each bound in each state of the
  switch. A loan that the caps turned on refuse, tried with the caps off. The
  switch turned in the block before a loan opens.
- A peer reading below and above the default and above the ceiling. A reading
  one second before and after the usable age. Peer reads paused with a reading
  below and above the default. A low reading grown old. A ceiling lowered
  between a refresh and a loan. A reading that puts a deeper tier's cap below
  a shallower tier's, read by a loan of each tier and of none, below High and
  at High. A lowest tier cap at and below the least cap. A raised reading read
  before and after a refresh in the same hour and in a later one, with the
  cap before it below and above the default. A waiting reading that falls and
  stays above the cap that applies. A first reading above the default, a
  reading that lowers the cap, and readings that rise at every refresh.
- One platform alone, two that disagree past the band, one reference asset, a
  failed read, a frozen asset, one platform raised far above the other, and
  the lowest platform raised alone, up to and past the second. A refresh in a
  pause. A reference asset's own tier and cap.
- Collateral with no tier, with the tiers' figures set so that each tier in
  turn is the most conservative. Every setting of a line and of a cap changed
  in turn so the margin would be broken.
- Each recorded figure read after its setting, the tier and the peer reading
  changed, and across an extension. A withdrawal at the recorded bound after
  the setting moved each way. Every figure read live moved to each end of its
  range between a loan's opening and each close-out.
- The pledged amount set against the sum of liens after every step that
  touches a lien. A release larger than the amount on every route that
  releases collateral, a new loan on that asset before and after the amount is
  set right, and the alert.
- A loan opened while every confidence tier had lapsed: the level it records.
- Two callers of a checkpoint in one hour, a distrusted price at the hour, a
  slot written in a pause, a second write by each actor, and the newest slot
  written in the block of a sale by its caller. Each missing input of the calm
  test in turn.
- Each condition of the tight floor failing alone on each kind of forced sale,
  and a tight floor set below its least.
- Renewals across the time at depth while a lowering by governance stands, and
  the tier earned again after it is lifted.

## 14. Alternatives considered

1. **With the caps off, hold a loan to the health floor alone.** Not taken. A
   step that acts at once would then admit loans the caps refuse.
2. **An old peer reading falls back to the default.** Not taken: where the
   reading was below the default, the cap would rise because nobody refreshed.
3. **Take the median of the platforms for a reference asset.** Not taken. The
   lowest of those that agree costs a little room, and bounds what one
   platform that loosens its own figure can do by the figure of a second.
4. **A raised reading waits a set time before it applies.** Not taken: it is
   a new figure. A second reading in a later hour, which anyone may refresh,
   is asked for instead.
5. **Keep the three per-asset settings.** Not taken. Each gives a named asset
   terms of its own, and the pause and the confidence tier already make one
   asset more careful without choosing its figures.
6. **A lowering by governance that renewals lift, as a lowering by the keeper
   is.** Not taken: it would last one renewal.
7. **Read every risk figure live.** Not taken. A change of a setting could
   then liquidate or trap a loan that is sound by the figures it opened on.
8. **Record every figure, the floor of a sale among them.** Not taken: a sale
   must respect the depth there is, and a loan that opened with no tier would
   keep the full floor after its asset had earned a tier.
9. **Refuse a release when the pledged amount is short.** Not taken. A fault
   in a record would hold a party's collateral.
10. **Give collateral with no tier the shallowest tier's own figures.** Not
   taken: an asset that has earned no tier should not have the terms of one
   that has.

## 15. Recommendation

Build the rules of sections 2 to 11 in the refactor, with the figures of
section 12 confirmed first.

## 16. Open items

- The ranges marked "to be stated" in section 12.
- The step by which governance sets a pledged amount right, and how a lowering
  of a confidence tier is published, are stated with the governance steps.
- The alerts for an ageing peer reading and for a short pledged amount are
  stated with the keeper's passes.
- The close-out's own figures are classed by the rule of section 7 when the
  close-out rules are written.
- `RatePricedCollateralDesign.md` gave rate-priced tokens thresholds of
  concentration one step tighter, set for each token. That setting goes with
  the per-asset thresholds, and the class of rate-priced tokens has no tighter
  threshold by a rule of its own either, since a rate source has its own
  guards. This is settled.
- Whether rate-priced collateral is measured a second time on its underlying
  is open for the refactor: the value pledged across every token that names
  one underlying, set against that underlying's tested size, with the same
  thresholds and the same response, read on the higher of the two ratios. It
  would name no asset.
