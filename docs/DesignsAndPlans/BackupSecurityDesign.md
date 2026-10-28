# Backup security — a write-only archive Worker and a ledger it cannot write

Status: **design, accepted in outline by the owner (2026-10-28), not built.**
Covers #1463, #1469, #1473 and #1474. Owner decision D11 (2026-10-16) said one
design covers these together, and #1481 (the table classification) has since
closed on its own, so it is not reopened here.

This document is the design. It changes no code. The build is the three slices
in §8, each its own PR, and every one of them lands before mainnet.

## 1. What is wrong today

The nightly archive Worker (`ops/offchain-data-warm`) holds, in one Cloudflare
environment:

- `BACKUP_ENCRYPTION_KEY`, the symmetric AES-256-GCM key that encrypts every
  archive and also decrypts every archive;
- a B2 **write** key (`listBuckets` + `writeFiles`);
- a B2 **read** key (`listBuckets` + `listFiles` + `readFiles`), used by the
  Monday healthcheck;
- `TG_OPS_BOT_TOKEN`, used for the nightly and weekly reports.

Anyone who can edit Workers on the Cloudflare account gets all four. The
consequences, each already recorded in an issue:

1. **Confidentiality (#1463).** The read key plus the AES key decrypt every
   archive in the bucket: the legal-hold documents, support tickets, Telegram
   links and alert thresholds. The backup is a second full copy of the
   sensitive data, reachable with the same credentials as the live one.
2. **Overwrite in place (#1469).** The read key lists every object, so the
   random nonce in each archive's name no longer hides it. The attacker can
   upload a forged archive at the genuine key. The genuine one survives only as
   a hidden older version until the lifecycle deletes it.
3. **No authorship (#1473).** The manifest proves integrity, never who wrote
   it. A forged archive with a self-consistent manifest passes every check the
   healthcheck and the restore runbook make. The ops channel is no anchor
   either: the same environment holds its bot token, and a bot can edit its
   own messages.
4. **A squeezed recovery window (#1474).** Because a forged overwrite is
   possible, the only defence is the time a superseded version survives
   (`daysFromHidingToDeleting`). The published 30-day promise caps the daily
   prefixes' whole lifetime, so every day of recovery window costs a day of
   ordinary restore history. The declared split is 20 days to hide plus
   9 to delete.

The Worker also logs each archive's full key, nonce included, to Cloudflare's
persisted Worker logs (`observability` is on), and posts it to the ops
channel. So even without the read key, the nonce is not secret from someone
with dashboard access.

## 2. What the design does, in one paragraph

The Worker becomes **write-only in every sense**. It encrypts each archive to
**offline public keys**, so it cannot decrypt anything it wrote. It loses the
read key and the healthcheck, so it cannot list, read or find an existing
archive. It stops writing the nonce anywhere it or Cloudflare keeps. A separate
job outside Cloudflare, the **backup watcher**, reads the bucket every day,
checks each new archive, and records what it found in a **ledger** bucket under
B2 Object Lock in compliance mode, which nobody can rewrite or delete before
its retention ends, the master key included. A restore must match the archive
it decrypts to a ledger entry, and refuses an ambiguous one.

## 3. Encryption to offline public keys (#1463)

### 3.1 The format

Each archive gets a fresh random AES-256-GCM data key. The Worker wraps that
data key with **RSA-OAEP (4096-bit modulus, SHA-256)** once per configured
recipient public key, then discards it. The archive is:

| Bytes | Content |
| --- | --- |
| 7 | magic `VPKARC` + version byte `0x02` |
| 4 | header length, big-endian |
| n | header, UTF-8 JSON (below) |
| rest | AES-256-GCM ciphertext followed by its 16-byte tag |

The header carries the scheme name (`RSA-OAEP-256/A256GCM`), the 12-byte IV,
the archive's `createdAt` and tier and period, and one entry per recipient:
the SHA-256 fingerprint of the recipient's public key (SPKI DER) and the data
key wrapped to it. **The whole header, magic included, is the GCM additional
authenticated data**, so nobody without the data key can change a genuine
archive's stated period or recipients without the decryption failing.

That is all the header authentication buys, and it is worth saying what it
does not: anyone with the public key can build a brand-new archive with any
header. Authorship is §5's job, not the format's.

### 3.2 Why RSA-OAEP

It is in WebCrypto in both the Worker runtime and Node, so the Worker and the
offline restore tool use the same standard primitive and no library. Wrapping
a 32-byte key is all it does, so its size and speed costs are irrelevant here.
An elliptic-curve scheme would give shorter keys, but the X25519 support in
the two runtimes is less uniform, and nothing here needs the saving.

### 3.3 Recipients and key custody

- **Two recipients from the start**: a primary key and an escrow key, held
  apart. Losing every private key makes every archive permanently unreadable;
  two copies is the minimum that is not a single point of failure.
- The **public** keys are committed to the repository
  (`ops/offchain-data-warm/backup-recipients/`), each with its fingerprint, and
  the Worker reads them from there at build time. Nothing about them is secret,
  and committing them means a change of recipient is a reviewed commit, not a
  dashboard edit.
- The **private** keys never reach Cloudflare, GitHub or any server. Each is a
  passphrase-encrypted PKCS#8 file in the operator's offline store.
- **Rotation changes what new archives are written to, never what old ones
  need.** It is two appended sets: first the old and new keys together, for a
  30-day overlap in which the drill (§7.3) proves the new key decrypts, then
  the new key alone. The old key stops receiving new archives at the end of
  the overlap. No archive is re-encrypted, so the old **private** key stays in
  the offline store for as long as any retained archive was written to it.
  For a daily or monthly archive that ends with the archive's lifecycle; a
  yearly archive is kept indefinitely, so its key is too.
- **The recipient set is versioned, not just current.** The directory holds a
  `recipients.json` that lists every set the Worker has ever used, each with
  the date it took effect. A rotation appends a set; it never edits or removes
  an earlier one. So the watcher (§5.3) can judge each archive against the set
  in force when it was uploaded, and the restore drill knows which private
  keys an old archive needs.

### 3.4 What it proves and what it cannot

- After this, a Worker compromise yields **no plaintext from past archives**.
  It still yields everything the Worker reads live (the D1 tables and the
  legal vault), which no backup design can change; the point is that the backup
  no longer adds a second copy to that exposure.
- **Nobody online can check that an archive decrypts.** Today the healthcheck
  decrypts the newest archive each week. After this it cannot, and neither can
  the watcher. Decryptability is proven only by an **offline restore drill**
  (§7.3). The watcher checks the header is well formed and names exactly the
  configured recipients, which catches a wrong-key or truncated write, but a
  passing watcher is not proof of a decryptable archive, and its reports say
  so.

## 4. The Worker loses its reader (#1469)

- **The read key leaves the Worker**, with the Monday healthcheck that was its
  only user. The Worker then holds the write key only (`listBuckets` +
  `writeFiles`: no list, no read, no delete).
- **The nonce stops leaking.** The Worker no longer logs or posts the archive
  key. Its nightly report names the date, the tier, the size and the archive's
  SHA-256, which is enough to match it against the watcher's record and is no
  help in addressing the object.
- Together these restore what the nonce was meant to give, **for archives
  written after slice 2**: to overwrite one in place, an attacker must guess a
  128-bit value. Any extra object or version that does appear is caught by the
  watcher (§5.3).
- **Archives written before slice 2 keep their exposure.** Their full keys,
  nonce included, are already in the ops channel's nightly messages and in
  Cloudflare's persisted Worker logs, and the January monthly and the yearly
  share one nonce. Stopping the leak does not unsay that. For these archives
  the design detects an overwrite the day it lands (the period turns
  ambiguous, and the ledger holds the genuine version's record) but does not
  prevent one, and the genuine version survives only until the lifecycle
  deletes superseded versions. Two steps narrow it: the owner deletes the old
  nightly messages that name archive keys from the ops channel (§9), and
  Cloudflare's persisted logs age out on their own retention. Neither reaches
  a copy someone already took, so these archives stay outside the
  overwrite-prevention claim until they age out, and a yearly one never does.

**Object Lock on the archive bucket itself is deliberately not part of this
design.** It would guard against a key with `deleteFiles`, which only the
master key has, at the price of a retention-versus-lifecycle interaction under
a published deletion promise. The ledger already detects a deleted archive
(§5.3), and the master key's custody is an owner step (§9). If the owner wants
archive-level immutability anyway, it is a separate decision on top of this
one, not a change to it.

## 5. The backup watcher and its ledger (#1473)

### 5.1 Where it runs

A **scheduled GitHub Actions workflow**, `backup-ledger.yml`, daily at 04:17
UTC, an hour after the nightly. GitHub is a different credential boundary from
Cloudflare, and it already hosts the same shape of job: the ingest probe that
opens one alert issue and posts to the ops chat.

Its secrets:

- the archive bucket **read** key (moved here from the Worker). After §3 it
  reads ciphertext only;
- a **ledger** key, restricted to the ledger bucket, with `listFiles`,
  `readFiles`, `writeFiles`, `readFileRetentions` and `writeFileRetentions`,
  and **no `deleteFiles` and no `bypassGovernance`**. `readFileRetentions` is
  what lets the watcher see each entry's retention deadline, which the yearly
  renewal in §5.2 needs;
- the ops bot token and chat id, already used by the ingest probe.

A GitHub compromise therefore yields ciphertext and the power to **add** to
the ledger: new entries, new versions or hide markers. It cannot delete or
alter a stored version, and every reader sees the additions as conflicts,
because of §5.2.

### 5.2 The ledger bucket

A separate B2 bucket, created with **Object Lock enabled** (B2 allows that only
at creation). Each entry the watcher writes carries a **compliance-mode**
retention: nobody can delete it or shorten its retention before it ends,
including the account's master key. Entries hold no personal data (keys,
digests, sizes, timestamps, row counts), so the privacy policy's deletion
promises do not bind them, and they can outlive the archives they describe.

Retention per entry, as defaults for the owner to confirm:

- an entry for a daily or monthly archive: **400 days**, longer than the
  12-month life of the longest of them;
- an entry for a yearly archive: **10 years**, renewed while the archive
  exists. Compliance mode allows a retention to be lengthened, never
  shortened, and the ledger key holds `writeFileRetentions`. Each run, the
  watcher extends to ten years any yearly entry whose archive is still in the
  bucket and whose retention has under a year left, and pages if an extension
  fails. So a yearly archive's ledger protection lasts as long as the archive
  does. If the watcher is ever retired, the yearly archives' supported life
  ends with the last entry's retention, and the retirement must say so.

One entry per archive **version**, named by the B2 file id, which is unique per
upload: `entries/<tier>/<period>/<fileId>.json`. So the honest watcher writes
each ledger name exactly once. An entry records the archive key, file id,
B2's server-side upload time, byte length, SHA-256 (computed by the
watcher from the bytes it downloaded, never copied from the manifest), the
manifest's key and SHA-256, the header's recipient fingerprints, and the
workflow run and commit that wrote it.

**The ledger is only ever read as its full version list.** Object Lock
protects each stored version, not what a plain listing shows as current: the
ledger key can still upload a second version at an existing name, or hide a
name, and a plain listing would then show the newer version or nothing. Every
reader of the ledger, the watcher and the restore tool alike, therefore lists
all file versions under the prefix, hide markers included, and treats a name
with more than one version, or with any hide marker, as a conflict: the watcher
pages on it (§5.3), and the restore refuses unless the operator names the
version to trust (§6). The genuine first version
cannot be deleted before its retention ends, so a version-aware reader always
still sees it.

### 5.3 What the watcher checks and pages on

Each run lists every version in the archive bucket, records each one it has
not recorded before, and checks the whole picture. It pages, through one alert
issue keyed by stable problem names plus the ops chat, on:

- **Missing**: an archive that should exist is not there. The watcher reuses the
  tier rules the healthcheck runs today (`ops/offchain-data-warm/src/tiers.ts`):
  every period a tier should still hold, from its declared first period to now
  and within the tier's retention, is required, not only the newest. So a
  February monthly that never uploaded is still reported in June. The declared
  first periods (today the Worker's `ARCHIVE_FIRST_MONTHLY` /
  `ARCHIVE_FIRST_YEARLY`) move with the check into the watcher, as committed
  values, because a missed cut leaves nothing for the ledger to record.
- **Ambiguous period**: a period holds more than one archive, either two
  nonces or a superseded version at one key. The honest nightly writes exactly
  one per period, so any second one is a write nobody planned.
- **Replay**: a new archive's SHA-256 equals one already in the ledger. A
  genuine archive copied into a newer period is the shape this catches; it is
  what the healthcheck's plaintext date check caught before, and it no longer
  needs the plaintext. There is one honest exception, and it is narrow: today's
  Worker uploads the same encrypted bytes as the January monthly and the yearly
  archive on 1 January. A pair of old-format (symmetric) archives counts as that
  copy only when one is the monthly for `<year>-01`, the other is the yearly for
  the same year, and they share the nonce in their names. Any other equal pair
  is a replay. The new format (§3.1) encrypts each tier separately, with its own
  IV and its tier and period in the authenticated header, so it never produces
  two equal archives, and the exception does not apply to it.
- **Mismatch**: the archive's bytes disagree with its manifest's SHA-256 or
  length, or its header is malformed or names other recipients than the set in
  force at its B2 upload time (§3.3). Judging against the set in force then,
  not today's set, keeps a rotation from turning every older archive into an
  alert.
- **Ledger tampered**: a ledger name has more than one version or a hide
  marker (§5.2). The honest watcher never writes either, so this means the
  ledger key was used by someone else.
- **Deleted early**: an archive the ledger recorded is gone before its
  lifecycle could have removed it. This adds to Missing rather than replacing
  it: Missing knows which periods should exist, and the ledger knows which
  exact archives did exist, so a deleted archive is caught even when another
  archive now sits in its period.

### 5.4 What the ledger proves, and what it cannot

It cannot prove authorship, and nothing can: only the Worker sees the data, so
anything that can sign for the Worker sits where the Worker sits. What it does
prove is **when each archive first existed, recorded by a party the Worker
cannot write to, in a record nobody can rewrite**. So:

- An attacker in the Worker can write forged **future** archives. Each gets a
  ledger entry with its server upload time, and each period that already had a
  genuine archive turns ambiguous and pages.
- Archives written **before** a compromise keep their entries, untouched, and
  are identifiable as the genuine history.
- An attacker in GitHub can add ledger entries, add versions or hide names,
  but cannot remove the genuine versions. Since every reader lists all
  versions (§5.2), a restore sees the conflict instead of being steered by it.

Telling a forged archive from a genuine one inside the compromise window is a
human judgment about when the compromise began. The restore makes that
judgment explicit (§6) rather than hiding it.

## 6. The restore consults the ledger

A new offline tool, `decrypt-archive.mjs`, sits in front of the existing
`restore-from-archive.mjs` (which keeps taking a decrypted archive and is
otherwise unchanged). It takes the downloaded archive, the private key file and
the period being restored, and:

1. downloads every version of that period's ledger entries, hide markers
   included (§5.2). If any name has more than one version or a hide marker, it
   **refuses**, printing every version with its upload time, unless the
   operator names the version to trust (`--ledger-version <id>`);
2. **refuses** unless the archive's B2 file id and its SHA-256, computed
   locally, equal one entry's;
3. **refuses** when the period has more than one entry, printing every entry
   with its server upload time, unless the operator names the entry to use
   (`--entry <fileId>`). The runbook says to pick the newest entry written
   before the compromise began, and to stop if that time is unknown;
4. decrypts, and refuses unless the payload's own `createdAt` agrees with the
   authenticated header and the ledger's period.

The default on any disagreement is **refuse**, never restore-and-flag (the
open question in #1473). A restore is the moment forged data would reach
production, so the tool stops and the operator decides with the evidence in
front of them.

Two questions are kept apart here, because they have different answers for
the same archive:

- **Which key decrypts it** follows the archive's format. An archive written
  before slice 2 is in the old symmetric format and decrypts with the old AES
  key from the offline store; a later one decrypts with a recipient private
  key. The tool reads both formats, and keeps reading the old one for as long
  as any old-format archive is retained, which for the yearly tier is
  indefinitely. No old-format code stays in the Worker.
- **What vouches for it** follows ledger coverage, whatever the format. Slice 1
  records every archive already in the bucket on its first run, and every new
  one from then on, so old-format archives have ledger entries too, and every
  check above applies to them. One limit is stated with the entry: an archive
  that was already in the bucket at the first run is recorded as found then,
  so its entry proves it has not changed since that run, not that it was
  genuine before it.
- Only an archive with **no ledger entry at all** (one that slice 1 never saw)
  needs the `--pre-ledger-archive` flag, and the tool says plainly that nothing
  vouches for it.

## 7. Retention, tickets and the drill (#1474)

### 7.1 The ticket split is not needed

The 2026-10-27 recommendation the owner accepted proposed moving support
tickets into their own prefix so that the main archive could keep a longer
recovery window. Writing this design turned up two reasons that change makes
nothing better, and the owner dropped it (decision 2026-10-28, "Drop the
ticket split"):

1. **The cap is not only the ticket promise.** The privacy policy also says
   plainly that "nightly backup archives are kept 30 days". The daily prefixes
   hold error records, Telegram links and alert thresholds too, so moving the
   tickets out leaves the same 30-day ceiling on them.
2. **The recovery window stops being the defence.** It mattered because an
   attacker could overwrite the newest archive in place, leaving the genuine one
   alive only until the lifecycle deleted it. After §4 that overwrite needs a
   128-bit guess, any extra version pages the same day (§5.3), and the genuine
   archive's ledger entry outlives the archive. Archives written before slice 2
   are the exception (§4): their names are known, so for them the window is
   still the time to act after the watcher pages. The declared 9 days of
   hide-to-delete is that time, and it is enough for a page that arrives the
   same day.

So the lifecycle can stay as declared (20 days to hide, 9 to delete, within the
29-day ceiling `lifecycle-policy.mjs` enforces), and #1474 closes on its third
option, "accept the current split", with this design as the reason.

### 7.2 The live lifecycle

#1474 recorded the live daily prefixes at 30 + 30 days, in breach of the
published promise, and `apply-bucket-lifecycle.mjs --check` reports that
drift. Whether it has been corrected since is not recorded anywhere this
design could check; the `--check` run answers it. Correcting it needs a key with `writeBuckets`, which only the owner
holds. It is an owner step (§9), independent of the build, and should not wait
for it.

### 7.3 The restore drill

Once a quarter, the operator downloads the newest archive of **every tier that
holds one** (daily, monthly and yearly), runs `decrypt-archive.mjs` on each
with every private key that archive was written to (primary and escrow), and
records the outcome per tier and per key on the tracking issue. Each tier is
encrypted on its own (§5.3), so a daily that decrypts says nothing about a
monthly or a yearly. The drill also runs on each tier's **first archive after
the format switch and after every rotation**, as soon as that archive exists,
so a defect in a new set of keys or in one tier's write is found before that
tier's history depends on it. It is the only proof that the archives decrypt
(§3.4), so the runbook schedules it rather than leaving it to an incident.

## 8. The build, in three slices

Each slice is its own PR, each lands before mainnet, and the order matters.

1. **Ledger and watcher, read only.** Add `backup-ledger.yml` and its script,
   writing ledger entries for the archives that exist today, and paging on
   §5.3. It also checks the current symmetric format's manifests, so it runs
   usefully before slice 2. Needs the ledger bucket and keys first (§9).
2. **Public-key encryption, and the Worker loses its reader, in one
   deploy.** The Worker encrypts in the §3.1 format to the committed
   recipients, and the same change removes the healthcheck, the read key, the
   AES key and the `ARCHIVE_FIRST_*` variables, and stops logging and posting
   the archive key. They cannot ship apart: the healthcheck decrypts the
   newest archive with the old symmetric key, so a format switch that left it
   running would report every healthy new archive as a failure. The watcher
   from slice 1 already carries the online checks, so nothing goes unwatched.
   `decrypt-archive.mjs` arrives with the matching refusals (§6), and the
   watcher learns the header check. After merge, the owner deletes the three
   secrets from the Worker (§9).
3. **Docs.** `OffChainRestore.md` (download by file id, the ledger check, the
   entry choice, the drill), `OffChainDataResilience.md` §3.3–§3.6, the Worker
   README, and the privacy policy's encryption sentence if its wording needs
   it (it already says Backblaze holds only ciphertext, which stays true).

## 9. Owner steps

These need the owner's accounts. Exact commands go in each slice's PR.

- **Create the ledger bucket** with Object Lock enabled, and its key with the
  capabilities in §5.1, restricted to that bucket. Before slice 1.
- **Generate the two key pairs offline**, store the private keys apart, and
  hand over the two public keys for slice 2.
- **Add the watcher's secrets** to the repository. Before slice 1.
- **Correct the live lifecycle** to the declared 20 + 9 (§7.2). Now.
- **Delete `BACKUP_ENCRYPTION_KEY` and the two `B2_READ_*` secrets** from the
  Worker after slice 2. Keep a copy of the old AES key in the offline store for
  as long as any old-format archive is retained, which for the yearly tier is
  indefinitely.
- **Delete the old nightly messages that name archive keys** from the ops
  channel, after slice 2 (§4). It narrows, and cannot close, the exposure of
  the archives written before then.
- **Move the master B2 key** out of the developer `.env` into the offline
  store, and use scoped keys day to day (#1469's second finding). The ledger
  survives the master key; the archive bucket does not.

## 10. What this design does not protect

Stated so nobody reads more into it:

- A Worker compromise still exposes the **live** off-chain data the Worker
  reads. The design stops the backup from adding to that, nothing more.
- A Worker compromise can still **forge future archives**. The design makes
  each one visible the day it lands and keeps the genuine history; it cannot
  make the forged one impossible.
- **Losing every private key** loses every archive. Two recipients and the
  drill make that unlikely; nothing makes it recoverable.
- The watcher **cannot prove an archive decrypts**. Only the drill does.
- Archives written **before slice 2** have names that were already published
  (§4). An overwrite of one is detected, not prevented, and the genuine
  version lasts only as long as the lifecycle keeps superseded versions.
- An archive already in the bucket when the watcher first ran is vouched for
  only **from that run on**: its entry proves it has not changed since, not that
  it was genuine before. An archive the watcher never saw has no entry, and the
  restore tool says nothing vouches for it.
