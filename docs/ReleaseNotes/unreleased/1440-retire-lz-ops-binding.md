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
monitor as holding one of the account's scheduled-job slots. It was freed
when the monitor was deleted and is currently **unused** — the recycling
mesh watcher is its intended occupant but has not been deployed yet, so
anyone planning capacity from those comments would have believed the
account was full when it has a slot free. The comments that attributed the
slot cost to creating a database rather than to deploying a scheduled
service were corrected in the same pass.

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
- The restore deployed all three background services at the point where
  it created their databases — which starts their every-minute scheduled
  work immediately, hours before the data those schedules read has been
  restored or checked. The consequences were not symmetric and not all
  harmless: the event reader would begin recording from wherever it found
  itself and then be reset out from under itself; the alerting service
  would start messaging users from half-imported thresholds, because its
  alert duties are not behind the switch that holds back its
  transaction-signing duties; and the retention passes would begin
  deleting expired rows from tables still being imported one at a time,
  before the row-count check meant to confirm the import could see them.
  The restore now deploys all three with their schedules switched off and
  re-arms them in stages, each once its own data is verified — the same
  discipline the nightly backup writer already had a warning for, applied
  to the services that read rather than write.
- The restore rebuilt every credential but nothing restored the
  operational switches that decide whether the platform's autonomous
  duties run at all. They are not secrets, are not in the archive, and
  are not committed to the repository, so a restore could finish with the
  signing key in place and every autonomous duty silently off —
  indefinitely, and looking exactly like a deliberate configuration. They
  are now part of what an operator is told to keep offline, with an
  explicit re-arming step that runs last, after the smoke test, and a
  warning that the convenient way to set them applies to one deployment
  only and is undone by the next.
- A verification aid added earlier in this change logged the recipient of
  every successful notification. That branch is routine — it fires for
  every alert the platform sends — so it would have built a standing
  record of which wallet was notified when, as a side effect of making a
  key rotation checkable. The recipient is no longer logged; the channel,
  which is the field a rotation actually changes, still is. The failure
  branch keeps the address, where it is the diagnostic and the volume is
  exceptional.
- The compromise inventory said every credential it lists is held by both
  public-facing services. Three entries are not: the keeper's signing key
  belongs to one service alone, and two of the per-chain endpoints are
  held by services the section does not even name. A responder reading it
  would have scoped both the exposure and the post-rotation check to the
  wrong set. Each entry now names its actual consumers. Further down, the
  same document still explained at length why the two services keep
  *separate* copies of a shared credential — the pre-split arrangement,
  and the exact opposite of how they are configured now. That reasoning
  is marked superseded and replaced with what shared storage actually
  implies for an incident: exposure is shared by default, one rotation
  covers every consumer, and the per-service rotation command updates
  nothing.
- The Telegram rotation put the freshly minted replacement token into a
  command line, one step after taking care to accept the same token
  through a prompt so it would not be recorded. That wrote it into shell
  history and into the process list, where any other user of the machine
  could read it — undoing the precaution and leaving the credential
  behind on the workstation an attacker was just evicted from. The
  request is now assembled so the token reaches neither.
- The instruction to confirm the schedules were really switched off named
  a command that cannot see schedules — it reports deployments and
  versions. It would have shown a healthy deployment while the
  every-minute schedule was still live, which is precisely the mistake
  the check exists to catch. Replaced with a schedule-aware query.
- The restore told an operator to copy every saved credential straight
  into the replacement account — correct after a lockout or a billing
  dispute, and exactly wrong after a compromise, which the same document
  now explains: anyone able to edit the services can read every one of
  those values. Following it would have handed the rebuilt platform back
  to whoever caused the incident, with the cutover reading as a clean
  recovery. The step now branches on *why* the restore is happening, and
  the compromise branch is a rotation rather than a restore, naming each
  credential and what rotating it costs.
- The compromise branch above told an operator to replace the signing key
  and sweep the old one's remaining gas. Sweeping gas is housekeeping, not
  revocation: the old address keeps every permission it held, and anyone
  can fund it again for pennies. Worse, there are **two** separate
  authorities and revoking one leaves the other — the remittance duty
  authorises against its own configured address, not the role, so an
  attacker whose role was revoked could still move reward budget. The
  branch now revokes both, on every chain rather than only the secondary
  ones, and says to read both back before re-arming.
- The archive-selection guidance was checked against the live backup
  storage rather than reasoned about, and two of its assumptions turned out
  to be wrong in the unsafe direction. It had said the naming scheme
  guarantees a forged archive cannot displace the genuine one, so two files
  under one date would be evidence of tampering. In fact a forgery can be
  written at the genuine file's own name, and the storage is configured to
  delete a superseded copy about a day later — so the original does not
  persist as something to fall back on, and finding a single copy is not
  evidence of safety. The step now inspects versions rather than files, says
  so explicitly, and records that the daily series only reaches back about a
  month, so a compromise older than that leaves the monthly copies as the
  only candidates. Making forgery impossible rather than detectable is a
  storage-configuration decision and is filed separately.
- The archive-selection flow reads "take the most recent one that
  verifies". After a compromise that is the attack. Whoever can read the
  services holds both the storage write credential and the encryption key,
  so they can upload a *newer* archive of their own choosing that is
  correctly checksummed and genuinely decrypts — every check in that
  section passes, and the newest-first rule selects it. The checks prove
  the file is intact and encrypted under our key; they cannot say who
  encrypted it, and nothing downstream re-establishes that. Selection is
  now by *time* rather than recency: rotate the storage keys first,
  establish the earliest possible compromise moment, choose an archive
  safely before it, and accept the extra data loss. Two files under one
  date is now called out as evidence of tampering rather than a duplicate
  to ignore — the immutable naming means the genuine archive survives
  beside any forgery. And re-encrypting the history under a fresh key,
  previously recommended, is explicitly deferred until after selection: it
  launders a poisoned set into the new key and destroys the one signal that
  distinguished it.
- Switching off the scheduled work was not enough to hold the event reader
  still: it has a second writer. A committed flag routes incoming webhook
  deliveries through a durable object that runs the same indexing, so the
  moment the replacement address answered, pre-existing webhooks would
  resume writing and advancing the cursor — the very race the schedule
  change was meant to prevent, arriving through a different door. Both
  writers are now closed together and re-opened together, after the cursor
  reset.
- One restore step was described as safe to run early because the
  background service only reads and sends messages at that point. One of
  its passes signs transactions on the strength of the key alone, without
  consulting the master switch — so the step could broadcast from a
  freshly re-uploaded key before anything had checked it, and within a
  ten-minute window each day it would. That service's schedule and its
  switches now move together at the last step, and the missing guard in
  the code is filed separately.
- The restore also claimed two prerequisites for the remittance duty had
  to be rebuilt. Neither does: the database change is committed and
  applied by an earlier step, and the on-chain permission lives on chain
  and survives losing the account entirely. Left as written it would have
  kept remittance switched off indefinitely while it was ready to run. The
  step now says to verify both, and reserves rebuilding them for the case
  where the signing key was actually replaced.
- Three documents pointed at an application address that does not exist —
  the page was moved when the routes were flattened, and the only
  surviving compatibility path is an unrelated one. An operator verifying
  a notification-channel migration would have landed on a blank page and
  been unable to confirm the thing they were checking.
- Both credential rotations end by redeploying the keeper, and a plain
  redeploy of that service deletes the switches that decide whether its
  autonomous duties run at all — because those switches are operator-set
  and not recorded in the repository, so each deploy rebuilds the set
  from what *is* recorded. A rotation carried out correctly, under
  incident pressure, would therefore have left liquidation, matching,
  remittance and reporting silently off, indistinguishable from having
  been turned off on purpose. Both steps now preserve them, and the rule
  is written once in a place the steps point at rather than repeated. The
  underlying fix — recording the values so no deploy can drop them, which
  also makes the live state reviewable — is a configuration change and is
  filed separately; it reaches the routine deploy path too, not only
  these two rotations.
- The document justified keeping a scoped backup-read credential inside a
  service on the grounds that it can only reach encrypted data, with the
  decryption key held offline. That is true if the storage provider is
  breached and false if the cloud account is: the same service also holds
  the decryption key, so anyone able to edit it can take both and read
  every archive in the clear — including the uploaded legal documents.
  The claim is now stated accurately, with the boundary it really
  provides, and separating the two is filed as a design decision to make
  before mainnet.
- The check on whether the restore had re-armed the autonomous duties
  read the service's log output. Every one of those duties returns
  silently when its switch is off *and* when it is on with nothing to do,
  so silence proved nothing and a restore could finish with remittance or
  reporting still dark. It now reads the deployed configuration back
  directly. Writing that up turned up a trap worth stating: the main
  switch accepts any capitalisation while the two it gates accept only
  lowercase, so one spelling arms one duty and silently skips the others.
- Two more credentials were being typed onto command lines — the
  Cloudflare recovery token, in a check added earlier in this same change,
  and the third-party marketplace key, whose surrounding text claimed a
  prompt would appear while the command as written suppressed it. Both now
  use the prompt-and-stdin pattern, so neither reaches shell history or
  the process list.
- The resilience plan listed the nightly backup writer among the services
  a paused copy in a second account could take over. It cannot: its
  database and object-store bindings can only address resources in the
  account it runs in, so a standby copy is attached to that account's
  empty storage rather than to the lost data, and unlike the others it
  has no address or switch to redirect. Its recovery is the restore
  itself, which is why it is deployed last. Described that way now.

Part of #1440. The card stays open for the operator steps: redeploy,
confirm one clean nightly, then delete the database.
