## Restore tool: stricter checks on the legal-hold record (#1489)

Before restoring the legal-hold register from a backup, the restore tool now
also checks that every timestamp and record number looks like one the live
service writes, that the action history is in the order it was written, and
that every past disclosure decision (not only the latest one) is in the
service's own format. A backup that fails any of these is refused with a
per-row explanation instead of being restored with a quietly altered history.
