## Backups — a watcher and a ledger the backup job cannot write (PR #3033)

The nightly off-chain archive Worker checked its own archives, with keys it
also held, so nothing it checked could survive the Worker being compromised.
This adds the first slice of the backup security design: a daily watcher that
runs on GitHub instead of Cloudflare, and a ledger bucket under Object Lock
that the Worker holds no key to.

Each run records every archive version it has not seen before: it downloads
the archive, computes its SHA-256 and length from the bytes, compares them with
the archive's manifest, and writes one ledger entry under a compliance-mode
retention that nobody, the account master key included, can delete or shorten.
Entries for daily and monthly archives are kept 400 days, longer than the
archives themselves; entries for yearly archives are kept ten years and
lengthened every run while the archive still exists.

It then pages, through one alert issue and the ops chat, on a missing period,
a period holding more than one archive, a copy of an older archive in a newer
period, an archive that disagrees with its manifest, a ledger entry with a
second version or a hide marker (the ledger key can add, never remove, so any
addition the watcher did not make is visible), an archive deleted before its
lifecycle could remove it, and a yearly entry whose retention could not be
lengthened. A run that cannot reach a verdict opens a separate "not running"
issue, so an unknown state is never reported as a broken backup. Nothing it
prints names an archive, because the random part of an archive's name is what
keeps a leaked write key from replacing it.

A one-time setup script creates the ledger bucket and the watcher's two
narrowly scoped keys and stores them straight into the repository's secrets
without printing them. Until the owner runs it, the workflow reports that it
is not running.

Advances #1469 and #1473 (slice 1 of three in
docs/DesignsAndPlans/BackupSecurityDesign.md). Slice 2 moves the Worker to
encryption for offline public keys and removes its read key and healthcheck.

> Caveat: archives already in the bucket on the ledger's first run are recorded as found then; their entries prove they have not changed since, not that they were genuine before.
> Caveat: the original account setup script and the baseline finder still carry their own copies of the B2 authorize helper; moving them onto the shared module is #3032.
