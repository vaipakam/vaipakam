# Liquidity tiers and the exposure limit: design

**Status:** the owner approved these rules on 2026-11-22 (seven points on the
liquidity rules, with the points on the price rules approved the same day).
This is the design of record for them. Nothing here is built by this document;
the build is part of the refactor.

**Related:** `MarketRateWidgetAndDepthTieredLTV.md` (the depth test and its
decisions of 2026-05-13, two of which this design replaces),
`CollateralConcentrationDesign.md` (the measure of concentration and its
graded response, to which this design adds a limit), `LoanSettingsSnapshotDesign.md`
(what a loan fixes at its opening), `PriceGuardDesign.md` and
`FeedRegistryDesign.md` (where prices and feeds are kept),
`LiquiditySpoofingThreatModel.md`, `RiskFiguresDesign.md` (the figures each
tier gives, and the figures of collateral with no tier).

## 1. Why

The depth test says whether an asset can be sold, and how much of it, at a
stated loss. Three things about it were left loose:

- **What a loan is when only one of its assets is liquid.** The rules spoke of
  each asset by itself. A loan with liquid collateral and a lending asset that
  is not liquid has no health reading, so it cannot be closed out as a priced
  loan, and the collateral by itself still looked priced.
- **How an asset earns a tier.** Every asset started at the first tier, and
  the first loan on a new asset was what proved it. Depth that someone holds
  for longer than the averaging window can still be staged.
- **How much of one asset may be pledged.** The response to concentration
  warned and lowered a cap, and never refused.

The rules below settle each with one rule, and state what each costs.

## 2. When an asset is liquid

An asset is liquid on a network when the price guard has a source for it and a
test sale of the floor size, on that network's own pools, loses no more than
the depth budget. Nothing else makes an asset liquid: no list, no step of
governance, no figure a caller sends, and no reading from another network.

- **A read that fails gives no answer.** Where a price the test needs is
  distrusted, or a read cannot be completed, the test does not say "not
  liquid". It gives no answer, and the step that asked refuses. A loan takes
  the terms of an asset with no price only where the asset has none, never
  because a read failed.
- **A place on the list of quote assets gives an asset no standing.** A quote
  asset is one the test may sell into. It is tested as every other asset is,
  and it earns its tier the same way. What it costs: a quote asset whose own
  depth is thin has a low tier, whatever its name.

## 3. Priced or unpriced is the standing of the loan

A loan has one standing, fixed when it opens:

- It is **priced** only where both of its assets were recorded liquid at the
  opening. Its lien then holds the collateral as priced.
- Otherwise it is **unpriced**. A loan with one asset that is not liquid has
  no health reading, and on default the collateral goes to the lender whole.
  Both parties must have named that asset as not liquid before the loan
  opens, as for any asset with no price.
- The standing holds for the loan's whole life, in both directions. No price
  version, retirement, replacement of the guard, extension or later change in
  depth turns a priced loan unpriced or an unpriced loan priced. A new loan is
  the way to change it.
- A read that fails at the opening refuses the opening. It never records a
  loan as unpriced.
- A record agreed ahead of a loan (an offer, a signed offer, a refinance
  request, an Auto-lend slot) carries the standing each asset had when it was
  made. A fill is refused where an asset's standing then differs, and the
  maker posts again.

The vault holds the same line by its own check: a lien holds the collateral as
the loan stands, written when the lien is made and never changed. The
collateral of an unpriced loan is held as unpriced, also where the asset by
itself has a price, and its hand-over at default is that loan's own route.

The set of assets in use, which a replacement of the guard must vouch for,
keeps its definition (`UnitOfAccountChangeDesign.md`): every asset that some
record holds as priced, the lending asset of a priced loan among them. The
standing changes only how collateral joins it. Collateral joins the set where
its lien holds it as priced, and the collateral of an unpriced loan does not,
since no step values it.

Depth that leaves later never changes a priced loan's standing. Its ratios are
still read by the guard's price, and where its collateral cannot be sold, the
rules for a failed sale apply and share the collateral by its worth.

## 4. The tiers

An asset has two tiers, and a step that uses a tier reads the lower of them.

**The measured tier** is what the chain shows now. A liquid asset earns the
first tier by passing the depth test at the first tier size, the second by
passing at the second as well, and the third by passing at all three. Passing
at a larger size never makes up for failing at a smaller one. An asset that
passes only at the floor size is liquid with no tier.

**The confidence tier** is kept on the chain by the keeper, from checks of
real sale routes, which can show what the depth on the chain cannot.

- It starts at none for every asset. A new asset has no credit.
- A step up is first recorded as waiting. It is held only after renewals have
  confirmed that step's depth, with no gap, for the whole time at depth
  (24 hours proposed). Steps come one at a time, so the third tier comes after
  three times that.
- The keeper lowers a tier at once, by any number of steps. The way back is
  earned again.
- Governance may lower a tier at once too, and its lowering stands until
  governance lifts it. While it stands, no renewal, no step of the keeper and
  no passing of time raises the tier above the one governance set. Each
  lowering is published with its grounds, as a pause of an asset is, and so
  is each lifting. Lifting gives nothing back: the tier is then earned again
  from the tier governance set, a step at a time.
- **A tier that is not renewed lapses.** A held tier whose last renewal is
  older than the confidence age (2 hours proposed) reads as none. A lapse is
  not a step down: the next renewal restores the step at once, with no new
  wait, while the last renewal is no older than the time at depth. After that
  the step is lost and is earned again.
- Nothing raises the tier a step uses above the measured tier: no list, no
  step of governance, no keeper and no figure a caller sends.

**The keeper's pass** covers every asset by one published rule. It publishes
each step with the check behind it, and each asset it did not renew with the
reason, and it checks any asset anyone asks for. It runs while the platform is
paused and before a launch, so tiers are earned by the time lending opens, and
the launch check reports both tiers of each asset. Its silence raises an
alert. The pass ships disarmed, as every new keeper pass does.

**What a loan records.** A loan records the tier its collateral had when it
opened. A lower tier reaches new loans at once and never changes an open loan.

What this costs: a fresh deployment and every new asset wait the time at depth
for each step. While the keeper has been silent for longer than the confidence
age, every asset reads with no tier until its next renewal, so new loans are
on the most conservative terms (section 5). No loan is refused for it.

## 5. Collateral with no tier

A liquid asset with no tier still backs a new loan. (This replaces the earlier
line that, with the tier caps on, such collateral backs no loan. With a tier
earned over time, and lapsed while the keeper is silent, that line would stop
lending on every new asset and in every outage.)

- Its figures are no better than the most conservative tier's, in every
  figure, judged figure by figure whatever the order of the tiers: the cap on
  the loan, the liquidation line, the floor of a forced sale and the size its
  concentration is measured against. The figures are in
  `RiskFiguresDesign.md`, section 6.
- It is liquid only by the floor test, which is measured live and asks nothing
  of the keeper. So a keeper's silence takes credit away and never adds any.
- A loan opened on it is recorded as opened with no tier, for its whole life.
  It never takes the discounted route of a liquidation, at any later tier of
  the asset. That includes a loan opened while the keeper was silent. The
  ordinary sale route stays open to it.

## 6. The exposure limit

The response to concentration warns at one threshold and lowers the cap at a
second. A third threshold refuses:

- **The limit.** No new exposure takes the value pledged in one asset past the
  exposure limit (20 times proposed) of that asset's depth. The depth is the
  size of the lower of its measured tier and its proven tier, or the floor
  size where either is none, which is the lowest limit there is.
- **The proven tier** is the highest confidence tier the asset has ever held.
  Only a step up becoming held raises it. No list, no step of governance and
  no figure a caller sends raises it. A lapse, a lost step, a mute, a change
  of the primary source that leaves the asset with one, and a lowering by the
  keeper all leave it as it is. A lowering by governance lowers it, and it
  returns to none only when the asset's primary source leaves the feed
  registry.
- **What follows.** Depth staged on an asset that has never earned a tier
  gives it no large limit. A silent keeper refuses no loan and adds no room,
  since the measured tier is read live and the proven tier does not lapse. The
  keeper cannot lower a limit either, so it is no lever that refuses loans.
- **New exposure only.** The limit refuses a step that pledges collateral for
  a loan that was not open before, or on terms that were not agreed before: a
  new loan, a refinance, an extension on new terms, and every fill (an
  Auto-lend slot, the instant market, a signed offer, a collection offer). A
  loan that replaces a loan in one transaction counts only the increase in
  what is pledged. An extension pledges nothing new, and counts only
  collateral added with it.
- **Never refused.** A top-up of collateral, a cure and a repayment are never
  refused by the limit, at any level of what is pledged. An open loan is never
  changed by a later rise in what is pledged or a later fall in depth.
- **The refusal says why.** A step past the limit is refused by name, with the
  asset and the room left, and the previews show the same room.

What this costs: a new asset has the smallest limit until its first tier is
earned, and one more record is kept for each asset. This changes the decision
of 2026-11-15 that nothing refuses a loan, which had kept a hard limit open
"as one more threshold on the same measure".

## 7. Where the settings are kept

Four settings say where market data is read, as a feed does: the venues, the
fee cap of a pool that counts, the list of quote assets and the averaging
window. They are kept on the price guard's side, in a record of their own.

- Governance changes them under the guard's delay, and a change that waits can
  be cancelled as any setting of the guard can.
- The platform and the feed registry both read that one record. The registry
  so finds a pool for its entry check without reading the platform.
- They are no part of a price version. Every read uses the ones in force at
  that moment.

The other figures of the liquidity test stay settings of the platform: the
floor size, the tier sizes, the depth budget, the consistency band, the time
at depth, the confidence age and the exposure limit. Each has a fixed range
and changes only under its delay.

## 8. The steps that act on a named asset

The platform keeps no list of permitted assets. Beside the pause of an asset,
these steps act on a named asset, and each only takes away or records what the
asset earned by the one rule every asset is held to: the mute of a rate
source, the confirmation of a fall of an exchange rate, the guardian's stop of
one asset's price, the keeper's step of a confidence tier, governance's
lowering of a confidence tier (section 4), and the step by which governance
sets an asset's pledged amount right (`RiskFiguresDesign.md`, section 8). No
setting gives a named asset a figure of its own (`RiskFiguresDesign.md`,
section 11).

## 9. Figures

| Figure | Proposed | Changed by |
| --- | --- | --- |
| The time at depth before a confidence tier rises a step | 24 hours | Governance, under the setting's delay |
| The confidence age | 2 hours | Governance, under the setting's delay |
| The exposure limit, as a multiple of the asset's depth | 20 | Governance, under the setting's delay. Above the high threshold of concentration |

The figures are proposed and are confirmed with the parameters table.

## 10. Tests

- A read that fails, at each place the test reads: no answer, and the step
  refuses. A loan is never recorded unpriced for it.
- A loan with each pair of readings for its two assets: priced only where both
  are liquid. The default of an unpriced loan whose collateral by itself has a
  price. Each record agreed ahead, filled after an asset's standing changed.
- A step up held one second before and after the time at depth, two steps
  tried at once, depth that left and came back, a renewal missed while a step
  waits, a new asset's first loan.
- A tier read one second before and after the confidence age, a renewal that
  restores it, and a renewal after the time at depth.
- A confidence tier set above the measured tier, by each actor.
- Renewals across the time at depth while a lowering by governance stands, a
  step of the keeper tried then, and the tier earned again after the lifting.
- An extension past the limit that adds no collateral, and one that adds some.
- Collateral with no tier set against every figure a tier gives, with the
  tiers in each order. A loan opened with no tier, put to the discounted route
  at every later tier.
- The limit one unit inside and outside the room left, on each kind of new
  exposure. A refinance past the limit that pledges no more, and one that
  pledges more. A top-up, a cure and a repayment far past it.
- Depth staged on an asset that never held a tier. A proven tier across a
  lapse, a lost step, a mute, a change of the primary source, a keeper's
  lowering, a lowering by governance, and a source that leaves and returns.
- The keeper stopped for longer than the confidence age and for longer than
  the time at depth: no loan refused, every new loan on the terms of
  section 5.
- A change of each of the four guard-side settings read by the platform and by
  the registry in the same block.

## 11. Alternatives considered

1. **A third route for a loan with one liquid asset.** Not taken. One standing
   for the loan closes every place at once, and the vault can hold it.
2. **Keep the start at the first tier.** Not taken: the first loan on a new
   asset should not be what proves it.
3. **A lapsed tier still reads as held, up to the measured tier, for the time
   at depth.** Not taken. The keeper's checks may show what the chain cannot,
   so a tier nobody has renewed should not be relied on. A silent keeper would
   otherwise change nothing for a day.
4. **Refuse a loan on collateral with no tier.** Not taken: it stops lending
   on every new asset and in every keeper outage.
5. **The limit reads the measured depth alone.** Not taken: depth staged for
   longer than the window would earn a never-confirmed asset a large limit.
6. **The limit reads the tier a loan's terms read.** Not taken: a keeper
   silent for two hours would refuse new loans on every asset.
7. **Stay with the graded response alone.** Not taken. A failed sale is one
   lender's loss here, but the reserve and every lender on the asset share the
   one event that a large pledged total makes likely.
8. **Leave the four settings with the platform.** Not taken: the feed registry
   would have to read the platform to find a pool, and it must not.

## 12. Recommendation

Build the rules of sections 2 to 8 in the refactor, with the figures of
section 9 confirmed first.

## 13. Open items

- The keeper's published rule for a confidence tier, and its alert, are
  stated with the keeper's passes.

Settled since this design was written, by the owner's approval of the risk
figures on 2026-11-22: the figures that collateral with no tier gets and the
figures each tier gives (`RiskFiguresDesign.md`), how an extension counts
toward the limit (section 6), and what a lowering by governance does
(section 4).
