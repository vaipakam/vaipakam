## Thread — Retiring the LayerZero-era backup binding (PR #1450)

The nightly off-chain backup was still exporting a second database
belonging to the retired LayerZero monitor. That monitor's Worker was
deleted earlier: after the move to Chainlink's cross-chain transport it
had been polling a decommissioned stack every five minutes, including one
surface that the securities-feature excision had removed outright.

Its database survived the Worker, and looked orphaned but was not — the
nightly backup still bound and read it. This removes that binding, so the
backup covers only the shared archive database.

Nothing of value is lost. The database held alert de-duplication state and
per-chain block cursors for a transport that no longer exists — operational
scratch space, not records. Manifests written before this change still
list their LayerZero section and remain readable; a manifest describes the
run that produced it, which is the behaviour a restore should expect.

**Deliberate ordering, and the reason it matters.** Deleting the database
first would have broken the nightly backup, and broken it *quietly* — the
failure would surface at 03:17 in a job nobody is watching, not anywhere
obvious. So this change ships and runs one clean nightly first; deleting
the database is a separate operator step afterwards, and irreversible.

Also corrected while here: several comments still described the retired
monitor as holding one of the account's scheduled-job slots. That slot was
freed when it was deleted and is now used by the recycling mesh watcher.

Closes #1440 (repo half). The database deletion remains an operator step,
gated on a green nightly run.
