## Thread — every written D1 table now needs an explicit restore classification (PR #TBD)

The #1450 review exposed that the backup's table lists had drifted well
behind the live schema: some tables were unarchived and unrecoverable,
others were missing from the tampering-recovery clear list, and the
failure mode in every case was silence — a migration adds a table,
nothing forces anyone to decide its restore treatment, and the gap
surfaces mid-incident. A new indexer typecheck guardrail (same pattern
as the event-coverage check) closes the silent path: it extracts every
table the indexer, keeper and agent Workers write and fails CI when one
lacks an explicit classification — born-off-chain (archived, imported
on restore), replay-derived (cleared before the block-zero replay), or
decision-needed with a stated reason. It also cross-checks the
born-off-chain class against the backup Worker's own archive list so
the classification and the backup cannot disagree.

The guardrail proved itself on its first run, surfacing four
keeper-written tables every manual sweep had missed. Sixteen tables
remain explicitly decision-needed on #1481's docket — visible debt in
place of silent debt; the issue stays open for those decisions. Part
of #1481.
