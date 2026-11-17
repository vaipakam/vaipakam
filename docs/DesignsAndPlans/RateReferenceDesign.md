# The rate reference: quorum, index and checkpoints — design

**Status:** design note for #3337 part 1, which the card requires before any code. The product was decided by the owner on 2026-11-08 (#3337). Design for review before build.
**Related:** `FloatingRateCapFloorLevelsDesign.md` (#3337 part 2: floating loans, cap and floor levels), `MarketLinkedRateLimitsDesign.md` (#3635: the averaged reference), `PriceGuardDesign.md` (#3272, the pattern shared), `LoanSettingsSnapshotDesign.md` (#3437), `RatePricedCollateralDesign.md` (#3683, the same reader and bounded-movement ideas).

## 1. What part 1 delivers

One number per lending asset and chain, the **reference**: an annual variable borrowing rate taken from several outside public lending markets. And one running total built from it, the **index**, from which interest over any period and an average over any window are exact.

Part 1 builds the reference, the index, its hourly checkpoints and the averaged read. It opens no loan and moves no funds. Floating loans (part 2) and market-linked limits (#3635) read what it provides.

Scouting on 2026-11-16 found the three things to reuse: the standalone price guard (non-upgradeable, delayed changes, a guardian mute, found through the protocol registry); the hourly price checkpoint writer (first caller in a UTC hour sets that hour); and the keeper reward library, which pays a gas reward from the keeper budget. No rate source, index or reader exists yet.

## 2. Where it lives

**A standalone, non-upgradeable contract, the rate reference, beside the price guard and found through a registry pointer.** It holds the source bindings, the settings, the index and the checkpoints. The Diamond holds none of them.

Reasons: it is a quorum over outside sources, which is the price guard's job in another unit; its settings need the same delayed-change and guardian-mute discipline; and keeping it out of the Diamond keeps a pricing input from being changed by a facet refresh. The price guard itself is not extended: it is close to its size limit and prices a different thing.

A floating loan records the rate reference's address and the **series** it opened on (section 10) with the price guard's address (#3437), and the borrower and lender sign both as the definition of their reference. A series is one fixed configuration with its own index, so nothing governance changes later alters what an open loan accrues.

## 3. Sources and readers

- **A source is an outside lending market's current variable borrowing rate for the asset on this chain.** Each kind of market is read through a **reader**: a small fixed contract with no owner and no settings that returns the rate as a simple annual rate, 1e18-scaled, and whether the read succeeded. A reader converts whatever the market reports (a per-second or per-block rate, a compounded yearly figure) to that one convention, so the quorum compares like with like.
- **A binding** names, per asset, up to five sources: the reader, the market, and the market's own identifier for the asset. A binding is fixed for the life of its series: a different source list, removal of a source included, is a new series opened by a delayed change (section 10). The guardian or the owner may **mute** a source at once; unmuting waits the delay. A mute does not take the source out of the quorum: it stops the asset's reference from moving at all (section 4).
- **Two reader shapes ship first:** a market that reports a current variable borrow rate per asset, and a market that reports a borrow rate per unit of time at its current utilisation. More are added as contracts later without touching the rate reference.
- **The build admits no real source.** Each comes later as a governance proposal with the checklist below. Outside markets' testnet deployments are thin and their rates mean nothing, so the three testnets use **mock sources**: test contracts whose rate the test admin sets, at least three per asset, refused on every mainnet chain id. The real readers are exercised in fork tests.
- **Fewer than three sources bound to an asset means no reference for it.** A floating offer or a market-linked limit for that asset is refused by name; fixed loans are untouched. No lower minimum is offered: with two sources one bad reading decides the rate. The same holds at every update: a new reference is accepted only from three or more readings (section 4). An asset bound to exactly three sources therefore holds whenever one read fails, so four or five is the sound number to propose.
- Names of markets stay out of the repository. The app names an asset's sources to users.

**Checklist for proposing a source**, kept with the proposal: the market's size in the asset on this chain; how its rate is computed; what it costs to move that rate within one transaction and for an hour; who can upgrade or pause the market and with what delay; its rate convention and the reader used; and that it is independent of the asset's other sources (not the same liquidity or the same rate curve under another name).

## 4. Reading the quorum

An update reads every source bound to the asset. A read that fails is left out.

- **While any source of the asset is muted, the reference holds.** A mute is a stop and nothing else. If it only dropped the source, the guardian could turn a set of readings that do not agree into one that does, or shift the median, and so change the rate on open loans at once. A source list without it is a new series, opened by a delayed change, for new loans; a mute holds the last agreed figure on every series that lists the source until it is unmuted after the delay.
- With three or more readings and no mute: take the **median**. It is accepted if at least two readings, the median counted, lie within the **agreement tolerance** of it.
- Otherwise the previous reference **holds**, and the event says why (a muted source, fewer than three readings, or no agreement). Two readings are never enough, however close.

The accepted figure is then limited two ways. It may not exceed the series' ceiling, which is the protocol's maximum interest rate when the series opens. And it may not differ from the previous reference by more than the **step limit**: a rate of change per hour, applied to the time since the last update and counted as at most one update interval. Calling the update many times in a row therefore moves the reference no further than waiting would, and a long gap does not store up a large jump.

## 5. The index

The index is the running total of `reference × time`. Each update first adds **the reference that was in force** multiplied by the seconds since the last update, and only then stores the newly accepted reference for the period that follows.

That order matters. Whoever sends the update chooses its moment, and a market's rate can be pushed for the length of one transaction. Because a new reading prices only the time after it, bounded by the step limit, and the next update corrects it at the same speed, pushing a source buys an attacker a fraction of a percentage point of annual rate for about an hour, on loans they would also need to hold.

- The year is 365 days, as in per-second interest everywhere else (#3169).
- While the reference holds, the index keeps growing at the held figure. Loans must accrue something, and the last agreed figure is the fair one. A second running total, **held time**, grows by the same seconds, so any reader can tell how much of a window was held.
- **Time nobody observed counts as held too.** When an update arrives later than one update interval after the last, the seconds beyond that interval are added to held time, whether or not the quorum agreed at either end: the reference was carried over them, not measured. A day without updates followed by one good update therefore leaves the averaged read unavailable until enough freshly observed time has built up, instead of certifying yesterday's figure.
- The update for an asset does nothing if less than the minimum spacing has passed since the last one.
- Part 2 adds the cap and floor level totals to the same update (`FloatingRateCapFloorLevelsDesign.md` section 3). The update is written with that hook in mind; part 1 leaves it empty.

**Starting a series.** Opening a series, an asset's first or a later one, is a delayed change. Its first reference is measured when the change is proposed and is updated, under the step limit, through the delay; the index starts at zero when the change executes. A reading pushed up in the executing transaction therefore gains nothing. (The same rule the rate-priced collateral binding uses.)

## 6. Checkpoints and the averaged reference

> **Added 2026-11-17 (#3713, `RateGuideAndLinkGuardsDesign.md`).** The rate reference also records a daily checkpoint, takes the window as an argument (`averaged(asset, window)`), reports an "unusual" state in `status`, and serves `guide(asset, term)`. That design states each.

- The first update in each UTC hour records a **checkpoint**: the index, the held time and the timestamp, keyed by the hour, as the hourly price checkpoints are. Each checkpoint also names the hour of the one before it, so a reader finds the checkpoint it needs in a few reads without scanning.
- **`averaged(asset)`**, on the rate reference, returns the average reference over the window and whether it is **available**, exactly as `MarketLinkedRateLimitsDesign.md` section 4.3 defines: from the newest checkpoint at least the window old (24 hours by default, bounded 12 to 72); available only if the index was updated within the staleness limit, that checkpoint is at most twice the window old, and held time is no more than half of the window.
- `LibRateReference` in the Diamond is the one place facets read it through the registry pointer. It carries no second copy of the rule.
- **`status(asset)`** returns the current reference, the index, the time of the last update, whether the reference is holding and since when, and whether it is stale: not updated within the staleness limit, or holding for longer than it. Part 2 refuses to open a new floating loan on a stale reference. Open loans keep accruing at the held figure.

## 7. Settings and starting values

All bounded in the contract. The first four and the source list are **fixed in a series** when it opens; a different value is a new series. The last three decide only whether a new loan or a market-linked limit may use the reference now, never what an open loan accrues, and are changed through the delayed changes.

| Setting | Start | Bounds | Why |
| --- | --- | --- | --- |
| Update interval | 1 hour | 15 minutes to 6 hours | The card's "about hourly"; matches the hourly price pass. |
| Minimum spacing between updates | 15 minutes | 5 minutes to the interval | Stops repeated calls; the step limit already removes their effect. |
| Step limit | 0.5 percentage points of annual rate per hour | 0.1 to 5 | A real market move of several points is followed within a day; a one-transaction push is worth almost nothing. |
| Agreement tolerance | 3 percentage points | 0.5 to 10 | Sound markets differ by a point or two for the same asset; this rejects an outlier, not ordinary spread. |
| Sources per asset | 3 to 5 | fixed | Bounds the update's cost. |
| Staleness limit | 3 update intervals | 2 to 12 | As proposed in the market-linked design. |
| Averaging window | 24 hours | 12 to 72 | `MarketLinkedRateLimitsDesign.md`. |
| Live series per asset | 3 | 2 to 4 | Bounds the update's cost. |

The starting values are to be checked against real readings before any real source is admitted (open items).

## 8. Who updates it, and the reward

The update is open to anyone, like the hourly price checkpoint, and nothing breaks if it is late: interest accrues at the held reference and the averaged read reports itself unavailable.

**No on-chain reward in part 1.** The platform keeper runs the update in the same hourly pass that records price checkpoints and accepted rates, with its own arming flag, shipped disarmed. The card asked for a small reward paid from the treasury's interest share; no such route exists, and building one adds a fund path and a way to farm it for a step that already has a keeper behind it. If a reward is wanted later, it is one Diamond entry that calls the update and pays the existing gas reward from the keeper budget, at most once per asset per interval, with no change to the rate reference. This is a departure from the card and is listed for the owner (open items).

## 9. The platform's own rate as a quorum member

**Not in part 1.** The card allows the platform's own matched-loan rate to join as one member on pairs with real volume, under wash-loan guards. Before there is volume it could not qualify, and its guards (size and time weighting, per-wallet share cap, distinct counterparties, exposure against organic volume) are a design of their own.

It needs no place held for it: when built, it is one more reader, reading a Diamond view, listed in a new series opened by a delayed change, like any source. Loans on earlier series are not touched by it. `MarketLinkedRateLimitsDesign.md` section 4.4 and the cap and floor design already say which loans it must leave out.

## 10. Series: how it fits the settings a loan carries

Under #3437 any governance-settable state behind an address a loan carries must be versioned or stop-only. The rate reference keeps that rule without exception.

- **A series is one immutable configuration for an asset:** its source list, update interval, minimum spacing, step limit, agreement tolerance and ceiling. It has its own reference, index, held time and checkpoints. Nothing in a series can be changed after it opens.
- **A change of sources or of any of those settings opens a new series** by a delayed change. New loans open on the asset's newest series; a loan stores the series it opened on and reads only that one for its whole life. So a configuration change never alters what an open loan accrues, and nobody is asked to accept terms they did not sign.
- **An old series keeps being updated while any open loan reads it.** Each series counts its open loans (part 2 raises and lowers the count); the update writes every series of the asset with a count above zero, and the newest. A series with no loans that is not the newest is no longer written. Live series per asset are bounded; opening one more is refused, by name, until an old series' last loan has closed.
- **A mute is stop-only** and reaches every series that lists the source at once: each holds at its last agreed figure for as long as the mute stands (section 4). It can never make a reading acceptable that was not, nor move a figure. A source that has failed for good therefore leaves an old series holding until its loans end: they accrue at the last agreed figure, which both parties' terms allow for, and a borrower who wants a moving rate again refinances onto the newest series. The review says so.
- **The newest series is the asset's reference** for market-linked limits, the averaged read, the views and the app.
- The staleness limit, the averaging window and the bound on live series are platform settings read for new loans and limits only. The index, held time and checkpoints are measured state.

The cost is one index write per live series at each update, at most the bound above, in place of one. Part 2's level totals are kept per series in the same way.

## 11. Events and views

- **Per update:** the asset, each source's reading or why it was left out, the accepted reference or the reason it held, whether the step limit or the maximum applied, the new index and held time, and the checkpoint if one was written.
- **Views:** `status`, `averaged`, the bindings and settings, a checkpoint by hour, and each source's current reading with its state (live, muted, failing).
- The rate reference is listed as a standalone contract in the ABI manifest, and the update has its row in the permissionless-steps ledger.

## 12. Contract and off-chain changes

| Where | Change |
| --- | --- |
| Rate reference (new, standalone) | Series (bindings and fixed settings), delayed changes that open a series, mute, the update over an asset's live series, each series' index, held time and checkpoints, the per-series loan count and its two callers-only entries for the Diamond, `averaged`, `status`, views, events. Measure its size in the same change. |
| Readers (new) | Two fixed reader contracts. A test-only mock source. |
| Protocol registry | A pointer to the rate reference. |
| `LibRateReference` (Diamond) | A thin read of `averaged` and `status` through the pointer. |
| Deploy scripts | Deploy the readers and the rate reference; record them in the deployment artifact; mock sources on testnets only. |
| Keeper | The update in the hourly pass, own flag, disarmed. |
| Indexer and app | Decode the update events; a rate history per asset. Follow-up work for those threads. |

No Diamond storage changes in part 1.

## 13. Tests

1. Quorum: median of three, four and five; no agreement holds; two readings hold even when equal; one reading holds; a failing reader is left out; the hold event names the reason. A mute holds the reference whatever the other readings are: four readings that do not agree stay held after any one is muted, and three that agree are held, not re-read, once one is muted.
2. Limits: the step limit over a short and a long gap, counted as at most one interval; many updates in one block move the reference no further than one; the protocol maximum.
3. Index: equals the sum of in-force reference times seconds over any sequence; a new reading never prices time before it; growth at the held figure while holding; held time equals the seconds held plus the seconds of every gap beyond one update interval. After a 24-hour gap and one good update the averaged read is unavailable, and becomes available only when held time is back to half the window or less.
4. A source pushed for one transaction, with the update sent in it, changes interest over the next hour by no more than the step limit allows, and the next update returns at the same speed.
5. Checkpoints: one per UTC hour, first caller; the link to the previous hour; `averaged` over the window, and unavailable for each stated reason.
6. Starting an asset: the first reference is the one measured at proposal and carried through the delay; a pushed reading at execution gains nothing; fewer than three sources is refused.
7. Delayed changes, bounds on every setting, mute at once and unmute after the delay; a new series without a muted source moves again for new loans while the old series stays held; a series cannot be opened with fewer than three sources.
8. Readers: each converts its market's convention to the one annual rate, against a fork; the mock source is refused on a mainnet chain id.
9. Minimum spacing: an early update changes nothing.
10. Series: a change of sources or of a fixed setting opens a new series and leaves the old one's reference, index and settings untouched; a loan on the old series accrues exactly as if no change had happened; the update writes every series with open loans and the newest, and stops writing an emptied old one; the bound on live series refuses one more; only the Diamond can move a series' loan count.

## 14. Alternatives considered

1. **Extend the price guard.** One contract fewer, but the guard is near its size limit and prices a different thing with different failure rules. Rejected.
2. **Keep the index in the Diamond.** Simpler reads, but a pricing input would then change with a facet refresh, and the Diamond would carry source settings again after #3272 moved them out. Rejected.
3. **Apply each new reading to the time before it** (the reading at the end of an interval prices that interval). Slightly fresher, and it lets the sender of an update price the past hour with a reading taken in a pushed moment. Rejected for the order in section 5.
4. **A time-averaged reading inside each reader.** Stronger against a push, but each market would need its own history kept on-chain. The step limit and the order of accrual give the bound more cheaply. Possible later for a source that offers its own average.
5. **Allow two sources where a chain has only two.** Rejected: one bad reading would then hold or move the reference.
6. **An on-chain reward for the update now.** Rejected for part 1 (section 8).
7. **The own-rate member now.** Deferred (section 9).

8. **One shared index per asset, with configuration changes reaching open loans.** One write per update, but it changes what open loans accrue without their parties' consent, against #3437. Rejected for series (section 10).
9. **A new rate reference contract for every configuration change.** The same isolation, at the cost of a deployment and a registry change each time and one keeper target per contract. Series give it inside one contract.

## 15. Recommendation

Build the rate reference as a standalone contract with readers, the median quorum, the step limit, accrual at the in-force reference, hourly checkpoints and the averaged read, one immutable series per configuration, mock sources on testnets and no real source admitted by the build.

## 16. Open items for the builder to raise, not decide silently

- For the owner: no on-chain reward for the update in part 1 (the card asked for one), and the platform's own rate left out of part 1.
- The starting step limit and agreement tolerance, once real readings for the first assets can be collected off-chain.
- The exact fixed-point scale of the index, chosen so that part 2's interest formula loses nothing against per-second fixed interest.
- Whether the rate reference fits one contract with part 2's level totals added, or needs the reader split the price guard took.
