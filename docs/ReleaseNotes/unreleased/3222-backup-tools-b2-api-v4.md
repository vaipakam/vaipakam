## Backup tools — Backblaze API version 4, one shared client (PR #<n>)

The off-chain backup tools now sign in and call Backblaze on its native API
version 4. A key made with today's Backblaze command line is refused by the
version 3 sign-in the tools used, which is what forced the 2026-11-06 restore
drill to mint its ledger read key by hand. Every older key still signs in on
version 4, so nothing needs to be re-issued.

Version 4 reports a key's bucket restriction as a list of buckets. The rule
every tool applies is unchanged in intent and now covers the new case too: a
key may run a job only when it is confined to that job's one bucket, holds no
capability outside the job's allowlist, and has no name prefix. A key
confined to several buckets is refused like an account-wide one.

The three older scripts (the archive bucket setup, the baseline finder and
the lifecycle tool) now use the same shared client as the watcher and the
decrypt tool, so host pinning, retries and the reading of a key's scope live
in one place. The two setup scripts reuse an existing key only by one shared
rule, and create keys with the version 4 bucket list.

The restore runbook now gives the command that creates the ledger read key,
with a one-day expiry, and says why the console's "Read Only" key is refused.

Closes #3222. Closes #3032.

> Caveat: the archive bucket setup script is checked by its shared helpers' tests only; it provisions a real account and was not run against one in this change.
