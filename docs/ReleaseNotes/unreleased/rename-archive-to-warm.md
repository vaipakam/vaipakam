## The off-chain backup service is now called "warm"

A naming change, not a behaviour change. What was described throughout as the *archive* service — the Cloudflare Worker that copies off-chain data to separate storage nightly, and the database it shares with the indexer — is now called **warm**. Nothing about what it does, when it runs, or what it stores has changed.

**The word was carrying two different jobs, and only one of them moved.** "Archive" was naming both the *service* and the *things it stores*. The service is renamed; the stored objects are still archives, and are still called that. So the bucket and the Worker change name, while an archive file is still an archive file — renaming those would have produced phrases like "warm bytes", which is worse than what we started with.

Three things deliberately left alone:

**Historical records.** Dated release notes and archived document snapshots still say "archive", because that is what the system was called on those dates. Rewriting them would make those records claim something untrue about the past.

**A different sense of the same word.** The deploy scripts archive local artefacts into a timestamped folder when redeploying from scratch. Same word, unrelated meaning, untouched.

**Third-party code.** Nothing under the vendored dependency trees was modified.

### What an operator needs to do

The names in the repository are only half of it — the live resources they refer to still carry the old names, and two of them cannot simply be relabelled.

The **storage bucket** cannot be renamed at all: those names are permanent once created. A new one has to be made and the old one retired. Because the platform is pre-live, nothing in the old bucket needs preserving, so this is a create-and-switch rather than a migration — but it is worth being explicit that the retained older copies of each backup do **not** come across, since those are what a recovery would draw on.

The **shared database cannot be renamed either** — the platform offers no way to change the name of an existing one, so a new database has to be created and the old retired. This was the one live resource I had expected to be a simple relabel, and it is not.

That turned out to be cheap here, and the reason is worth recording rather than assuming next time: almost everything the database holds is rebuilt from chain history on demand, so it does not need moving at all. What genuinely could not be recreated came to six rows — a couple of notification settings and a handful of test support tickets — which were copied across and checked to match. The rest is left for the indexer to rebuild from the beginning of chain history, which is precisely what the restore procedure already prescribes for that class of table.

The **Worker** is created fresh under the new name, and the old one is then deleted — not merely stopped, because a stopped Worker still holds its scheduled slot from a limited pool.

There is one spare slot, so the replacement can be created before the old one goes. (An earlier draft of this note said the pool was full and the two could not coexist; counting the live triggers showed four of five in use, the fifth being held for a service that is not yet deployed. It is worth borrowing during the switch and is free again afterwards.)

**Do not delete the old Worker until the new one has actually run.** A fresh Worker inherits none of the old one's configuration — not the encryption key, not the storage credentials, not the alert channel — and it refuses to run at all until every one of them is set, by design. So the order is: create it, configure it, watch a scheduled run complete and its alert arrive, and only then retire the old one. Deleting first leaves no working backup at all, and the gap would not announce itself.

The encryption key deserves its own line. It must be generated locally and kept somewhere outside the hosting provider, because the entire point of it is that losing the provider does not lose the ability to read the backups. A key that exists only as a provider secret is not a backup key; it is a second copy of the same single point of failure.

There is one visible consequence in the meantime, and it is expected rather than a fault. The hosting provider builds the Worker automatically from a path recorded on its side, and that path is the old directory — so from the moment the rename lands, that build fails. It does not disturb the running service, which keeps operating from its last successful build; it only means the automated check for the old Worker reports red until the provider-side project is pointed at the new location or replaced. Anyone reading a red check there should not go looking for a defect in the change.

Until those steps are done the running system is unchanged and unaffected; the repository simply describes it by its new name.
