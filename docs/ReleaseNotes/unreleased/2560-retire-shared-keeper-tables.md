## Keeper — retire the old shared copies of its five tables (PR #2611)

The keeper moved its operational state to its own database in October
(#2450). Five of those tables (health-factor band state, the commitment
scan and day records, and the remit acknowledgement log and frontier) had
started out in the shared database. A one-time copy moved their rows on
2026-10-18. Since then the shared copies have been dead state: nothing
writes them, and the only reader left was a check that watched them for a
legacy keeper still writing there. That check ran on every keeper tick and
in every keeper deploy. It could not see a legacy keeper that only deleted
rows, and because it read all five shared tables on every tick, any one
failed read among them skipped the whole tick.

This change retires the copies instead of watching them. A new shared
migration drops the five tables, and nothing else. It is safe whichever
keeper build is serving when it lands: the previous build already treated a
missing table as retired. The copy script and its checks are removed. The
keeper's deploy now applies and verifies the private migrations and then
verifies the shared schema, as before. The machine's per-tick gate checks
only that the private migrations are applied. The copy's completion record
stays in the private database as history. Nothing reads it.

What still keeps a second keeper out is the one-runner lease. The cutover
check was only ever defence in depth. Rolling back to a keeper build that
reads the shared copies is no longer possible, because the tables are gone.
The runbook's cutover section now records what happened and where the
procedure went. Closes #2560.
