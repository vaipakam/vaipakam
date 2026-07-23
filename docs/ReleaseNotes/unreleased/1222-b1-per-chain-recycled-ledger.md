## Thread — Per-chain recycled ledger + widened day-close report (PR #TBD)

The cross-chain recycling mesh (#1222, completion-plan §M3) begins with
its accounting foundation: the canonical chain now learns, per chain,
how much recycled VPFI exists and which day it was absorbed on. Every
chain — Base included — keeps a monotonic lifetime total of its
recycle-bucket credits, and each day-close report to the canonical
aggregator now carries two recycled figures alongside the interest
denominators: that lifetime total (availability accounting that
self-heals across missed or re-ordered reports, because the next report
always carries the full total) and the closing day's credited amount
(the per-day attribution the absorption average will draw on).

The canonical side records both into a per-chain ledger with two
protections. Day attribution is integrity-clamped: a day's accepted
credit can never exceed the increase in that chain's lifetime total, so
a reporting bug or replay can never feed the absorption accounting
credit the availability ledger does not back. And re-ordered
cross-chain deliveries are handled exactly: a report for an earlier day
arriving after a later one was accepted still gets its precise
attribution when its predecessor day is on record — the failure mode
where a delayed day would be clamped against a later, higher baseline
and permanently under-credit its chain is specifically tested. When no
sound baseline exists, the day attribution is conservatively dropped
while availability still self-heals.

The report widening ships receiver-first: the canonical transport
accepts both the old and the new report shapes (nothing else), so a
not-yet-upgraded mirror or a delayed in-flight report keeps landing —
its recycled figures simply read as absent. Deploy ordering therefore
matters once live: the canonical chain's messenger upgrades before any
mirror's. This stage is records-only — public transparency reads expose
the per-chain ledger, but nothing funds, pays, or nets from it until
the next mesh stages size per-chain budgets against it.

Part of #1222.
