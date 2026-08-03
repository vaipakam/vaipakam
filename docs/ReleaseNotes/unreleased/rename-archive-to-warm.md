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

The **shared database** keeps its contents and identity; only its label changes.

The **Worker** is created fresh under the new name, and the old one must then be deleted — not merely stopped. It holds a scheduled slot from a limited pool, and the account has no spare, so leaving it in place blocks the replacement from running on schedule.

Until those steps are done the running system is unchanged and unaffected; the repository simply describes it by its new name.
