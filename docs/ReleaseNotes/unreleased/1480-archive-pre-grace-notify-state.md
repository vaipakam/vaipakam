## Thread — the nightly backup now archives `pre_grace_notify_state` (PR #TBD)

The pre-grace warning dedupe table (added with the T-092 pre-grace
watcher) was missing from the nightly backup's born-off-chain table
list, which had two consequences found during #1450's review: no
restore could ever recover it, and a replace-style selective restore of
`user_thresholds` destroyed it as a foreign-key cascade side effect
with nothing to re-import. The table now rides in the required
born-off-chain set, and every table-list surface (Worker README,
restore runbook §4, resilience design doc) says so. Archives written
before this change do not carry the table; restoring from one loses the
dedupe rows, and the observable consequence is duplicate pre-grace
warnings — stated in the restore runbook rather than discovered.
Closes #1480.
