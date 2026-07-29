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

Two further hazards surfaced in review and are closed here. The
disaster-restore runbook still told an operator to recreate the retired
monitor's database, wire it into config, and deploy that monitor — on a
real restore that would resurrect a decommissioned service and consume one
of the account's five scheduled-job slots. And the retired monitor's own source tree
was still deployable by its documented command. Review then established
that **no configuration edit can make a source tree undeployable** — every
guard sits inside the artifact an operator overrides, and removing the
config is worse still, because the tool then inherits a parent one and
deploys under the wrong name. So the tree was **deleted outright**. Git
history is the rollback path; there is no retained copy in the working
tree.

The archive format keeps its version number. Nothing about the shape
changed except that one optional section is no longer produced, so bumping
the version would force restore tooling to branch for no benefit — the
runbook now states plainly that the section is optional within the current
version, and how to handle an older archive that still carries it.

Review of those runbook edits then turned up several procedures that were
already wrong independently of this change, and they are corrected here
rather than left for the incident that would find them:

- The credential-rotation sequence destroyed the working bot token as its
  first step and only afterwards went looking for where to write the
  replacement. Telegram allows no overlap — revoking a token is what
  issues its successor — so the outage cannot be removed, only shortened.
  Everything that does not need the new credential now happens first, and
  exactly one command runs during the outage.
- Rotating the notification signer changes which channel the platform
  publishes to, but the procedure left the app pointing users at the old
  one. Anyone opening the alerts page would have subscribed, successfully
  and silently, to a channel that would never post again. Updating the
  app is now part of the main path rather than a footnote to a fallback.
  The procedure was also built on an operation the notification service
  does not implement. It described transferring ownership of the existing
  channel to a replacement identity, with a fallback for when the
  compromised wallet refuses to co-operate — but there is no ownership
  transfer to attempt, so there was no fallback either, just one path
  presented as two. Rotating the signing key always changes which
  identity the platform posts as, and the service will reject posts from
  an identity it has no record of. So the procedure is now written as
  what it is: a migration to a newly created channel, which costs a stake
  and does not bring existing subscribers with it. Both facts are stated
  up front rather than discovered mid-incident.
- The disaster restore claimed both public websites carried their own
  domain attachments. They do not — they are plain Worker deployments,
  so a restore that followed the steps exactly brought the platform back
  with neither public address resolving, and the redirect that serves the
  `www` hostname is a zone-level rule that travels with nothing at all.
  Each binding is now listed explicitly.
- The restore also smoke-tested the backup writer one section before
  deploying it, and offered to import the retired monitor's rows into a
  database whose table definitions were deleted along with the monitor.
  Both now sequence correctly, and the schema is recovered from history.
- Two credential lookups listed the account's secrets with the default
  page size, which is smaller than the number of secrets held — so the
  one being rotated could simply be absent from the output, with nothing
  to indicate the list had been truncated.

Part of #1440. The card stays open for the operator steps: redeploy,
confirm one clean nightly, then delete the database.
