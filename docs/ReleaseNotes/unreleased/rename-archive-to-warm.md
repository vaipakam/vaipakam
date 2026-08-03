## The off-chain backup service is now called "warm"

A naming change, not a behaviour change. What was described throughout as the *archive* service — the scheduled job that copies off-chain data to separate storage nightly, and the storage bucket it writes to — is now called **warm**. Nothing about what it does, when it runs, or what it stores has changed.

**The shared database is not part of this.** It keeps its existing name, and every service still reads and writes exactly the database it did before. That is deliberate and is explained further down: a database cannot be renamed, so adopting the new name would mean moving to a different database — a change to where live data goes, which does not belong in a renaming. If you are looking for which database to point something at, the answer is unchanged.

**The word was carrying two different jobs, and only one of them moved.** "Archive" was naming both the *service* and the *things it stores*. The service is renamed; the stored objects are still archives, and are still called that. So the bucket and the Worker change name, while an archive file is still an archive file — renaming those would have produced phrases like "warm bytes", which is worse than what we started with.

Three things deliberately left alone:

**Historical records.** Dated release notes and archived document snapshots still say "archive", because that is what the system was called on those dates. Rewriting them would make those records claim something untrue about the past.

**A different sense of the same word.** The deploy scripts archive local artefacts into a timestamped folder when redeploying from scratch. Same word, unrelated meaning, untouched.

**Third-party code.** Nothing under the vendored dependency trees was modified.

### What an operator needs to do

The names in the repository are only half of it — the live resources they refer to still carry the old names, and two of them cannot simply be relabelled.

The **storage bucket** cannot be renamed at all: those names are permanent once created. A new one has to be made and the old one retired. Because the platform is pre-live, nothing in the old bucket needs preserving, so this is a create-and-switch rather than a migration — but it is worth being explicit that the retained older copies of each backup do **not** come across, since those are what a recovery would draw on.

The **shared database is deliberately NOT switched by this change.** It cannot be renamed — the platform offers no way to change an existing one's name, so moving to the new name means moving to a new database — and that is a change to where live data is written, which does not belong in a naming change.

Two things made bundling them unsafe rather than merely untidy. The application services redeploy automatically when this lands, so merging would have performed the switch immediately, with no opportunity to sequence it. And the irrecoverable rows were copied ahead of time, so anything written between that copy and the switch would exist only in the old database and be lost when it is retired.

So the replacement database exists and is fully prepared — created, every schema step applied, and the handful of genuinely irrecoverable rows copied and checked — but nothing points at it. The services continue reading and writing the database they always have. Switching over is its own deliberate step, and it needs a fresh copy of those rows taken *after* the last writer has moved, compared for equality, rather than the early copy that is there now.

**A check now enforces that the database is named in one place.** Backing the rename out of the database was itself done twice: the first attempt reached the four service configurations but not the deploy commands, the operator runbooks, or the restore steps — which would have applied schema changes to one database while the services read another. Neither half looks wrong on its own, and nothing fails: the deploy succeeds, the service starts, and the schema it needs is simply somewhere else. So the name is now declared once and verified everywhere it is used, including in the copy-paste blocks operators run by hand and the commands inside package scripts. A partial rename — the exact shape that got past the first attempt — now **blocks the merge** rather than being something a reader has to notice.

That check reads commands, not prose. A sentence in a design document describing the database by name is still only as good as the person who wrote it.

Two more limits worth stating plainly, because a check believed to cover more than it does stops people looking. It matches commands that **name the database directly**; one script builds its command by assembling the name instead, and that one is covered by checking the constant it uses — but a *new* script doing the same thing would have to be added to that list by hand, and nothing detects the omission. And it verifies that every place agrees on one name; it cannot tell you that name is the *right* one.

The **Worker** is created fresh under the new name, and the old one is then deleted — not merely stopped, because a stopped Worker still holds its scheduled slot from a limited pool.

There is one spare slot, so the replacement can be created before the old one goes. (An earlier draft of this note said the pool was full and the two could not coexist; counting the live triggers showed four of five in use, the fifth being held for a service that is not yet deployed. It is worth borrowing during the switch and is free again afterwards.)

**Do not delete the old Worker until the new one has actually run.** A fresh Worker inherits none of the old one's configuration — not the encryption key, not the storage credentials, not the alert channel. So the order is: create it, configure it, watch a scheduled run complete, and only then retire the old one. Deleting first leaves no working backup at all, and the gap would not announce itself.

**The alert channel is the one setting that will NOT stop the Worker if you forget it**, and an earlier draft of this note said the opposite — that it refuses to run until every setting is present. That is true of the storage credentials and the encryption key, and deliberately not true of the alert credentials: a backup that runs unwatched is better than one that refuses to run because its notifier is unconfigured, so a missing alert channel produces a log warning and the backup proceeds.

That is the right trade, and it is a trap here specifically, because the step above uses "an alert arrived" as the signal that the replacement works. If its alert credentials are missing, **no alert arrives and the backup ran perfectly well** — indistinguishable, from the channel alone, from a Worker that never ran. So verify the alert settings are present on the replacement explicitly rather than inferring them from silence, and confirm the run itself in the Worker's own invocation log before retiring anything.

**"An alert arrived" is not that proof, and an earlier draft of this note said it was.** During the changeover both services run on the same nightly schedule and report through the same channel, and the success message did not say which of them sent it. So the old service's alert could be read as the new one's — and acted on by deleting the only one that was actually working. The alert now names the storage bucket it wrote to, which is the one thing that differs between them; so does the failure alert. There is a third alert — the one fired when the Worker cannot start because a setting is missing, which is the likeliest way the replacement fails — and that one cannot name a bucket, because an unset bucket is among the things it reports. It names the Worker instead. All three are now attributable. Check that line says the *new* bucket before deleting anything; if it does not, the replacement has not run yet regardless of how many alerts arrived.

The encryption key deserves its own line. It must be generated locally and kept somewhere outside the hosting provider, because the entire point of it is that losing the provider does not lose the ability to read the backups. A key that exists only as a provider secret is not a backup key; it is a second copy of the same single point of failure.

One provider-side loose end to check rather than assume. The hosting provider can be configured to build a Worker automatically from a directory path recorded on its side; where such a configuration points at the old directory, it will start failing once the rename lands. That does not disturb the running service, which keeps operating from its last successful build — it only means a red build on the provider's dashboard until the project is repointed or replaced.

**It has now happened, and this paragraph took three attempts to get right.** The first draft said the build would fail and show as a red check on every pull request — asserted, not checked. The second looked at the checks reporting on pull requests, found only the indexer's, and concluded no such check existed here. That was the right instinct applied to the wrong sample: the automatic build for the old service reports on **pushes to the main branch**, not on pull requests. Once the rename merged, it went red there — visible on the merge commit, invisible on every pull request that preceded it.

So the loose end is real and is currently outstanding. What has *not* changed is the advice: do not attribute the red mark by timing alone. Open the project, check whether its configured root still points at the removed directory, and read the build log. A genuine build, typecheck or deploy failure in a correctly repointed project produces exactly the same red mark, and only the log separates them.

The lesson worth keeping is the sampling one. "I checked and it does not report" was true of the surface I looked at and false of the one that mattered — a build configured to run on merges was never going to appear in a pre-merge check list.

Until those steps are done the running system is unchanged and unaffected; the repository simply describes it by its new name.
