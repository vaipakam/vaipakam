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

The canonical side records both into a per-chain ledger with an
aggregate integrity clamp: the running sum of a chain's accepted day
credits can never exceed its reported lifetime total, so a reporting
bug or replay can never feed the absorption accounting credit the
availability ledger does not back. Because the clamp's baseline
advances only by accepted credit — never to the reported total —
attribution is order-independent for an honest chain: a delayed
earlier day arriving after a later one, a report jumping over
unreported days, a delayed first day, and the late close of a quiet
day (whose report necessarily pairs the live lifetime total with an
empty old-day amount) all attribute exactly. The last two shapes were
review findings: the review's alternative baseline rule was adopted
outright because the originally drafted per-report clamp could not
survive the quiet-day late close without corrupting a later day's
attribution.

The report widening ships receiver-first: the canonical transport
accepts both the old and the new report shapes (nothing else), so a
not-yet-upgraded mirror or a delayed in-flight report keeps landing —
its recycled figures simply read as absent. The rollout is also
non-atomic per chain: the old sending, fee-quoting, and canonical
receiving surfaces all remain callable, so a chain's diamond and its
transport messenger can upgrade in separate steps in either direction
without a window where the permissionless day-close reverts. This
stage is records-only — public transparency reads expose the per-chain
ledger, but nothing funds, pays, or nets from it until the next mesh
stages size per-chain budgets against it.

Part of #1222.
