# vaipakam-offchain-data-warm

Internal-ops Cloudflare Worker that nightly exports Vaipakam's off-
chain footprint to Backblaze B2 on a separate billing/credential
boundary, encrypted to offline recipient public keys so the Worker
cannot read back anything it wrote. Stage A of the off-chain data resilience plan —
issue [#30 (T-077)](https://github.com/vaipakam/vaipakam/issues/30).
Design notes: [`docs/DesignsAndPlans/OffChainDataResilience.md`](../../docs/DesignsAndPlans/OffChainDataResilience.md).

## Encryption to offline public keys (#1463)

Each archive gets a fresh AES-256-GCM data key, wrapped with RSA-OAEP
(4096-bit, SHA-256) to every recipient in the set in force, then dropped
(`src/archiveFormat.ts`; design:
[`BackupSecurityDesign.md`](../../docs/DesignsAndPlans/BackupSecurityDesign.md)
§3). The recipient **public** keys are committed in
[`backup-recipients/recipients.json`](./backup-recipients/recipients.json),
one versioned set per rotation, and bundled at build time; the **private**
keys are passphrase-protected files in the operator's offline store and never
reach Cloudflare, GitHub or any server. Each tier is sealed on its own, with
its own data key, IV and nonce, so the January monthly and the yearly are
unrelated ciphertexts. The Worker holds one B2 key, write-only, and no
decryption key; it runs no healthcheck and never logs or posts an archive's
name. Decrypting is offline only, with `scripts/decrypt-archive.mjs`, which
reads both this format and the old symmetric one and refuses an archive the
ledger below does not vouch for
([`OffChainRestore.md`](../../docs/ops/OffChainRestore.md) §3).

**Nobody online can check that an archive decrypts.** The watcher checks that
its header is well formed and names exactly the recipients in force; only the
offline restore drill proves decryption.

## The backup watcher and its ledger (#1469, #1473)

Nothing the Worker checks about its own archives survives the Worker being
compromised, because it holds the keys those checks would rely on. So the
archives are also watched from GitHub, a different credential boundary:
`.github/workflows/backup-ledger.yml` runs `scripts/backup-ledger.mjs` daily at
04:17 UTC, an hour after the nightly. Each run records every archive version it
has not seen in a separate **ledger bucket with Object Lock**, one entry per
version under a compliance-mode retention nobody can shorten (the master key
included), with the SHA-256 and length the watcher computed from the bytes.
The Worker holds no key to that bucket. It then pages, through one alert issue
and the ops chat, on a missing period, a period holding more than one archive,
a copy of an older archive in a newer period, an archive that disagrees with
its manifest (re-checked whenever the manifest changes), a ledger entry with a
second version or a hide marker, an archive hidden or deleted before its
lifecycle could do it, a yearly entry whose retention could not be
lengthened, a public-key header that is malformed, names another period or
does not name exactly the recipient set in force when the archive was
written, and an old-format archive written after the switch to the new one. The design and its limits are in
[`BackupSecurityDesign.md`](../../docs/DesignsAndPlans/BackupSecurityDesign.md)
§5; the rules are `scripts/lib/ledger-rules.mjs`, pinned by
`scripts/backup-ledger.test.mjs`.

**Setup, once** (owner): with the master key in the repo `.env` and `gh` signed
in as a repository admin,

```bash
cd ops/offchain-data-warm
npm run backup:ledger:setup
```

It creates the ledger bucket with Object Lock, creates the watcher's two keys
(its own archive read key, and the ledger key without `deleteFiles` or
`bypassGovernance`), and stores them straight into the repository's Actions
secrets, printing neither. Then run the **Backup ledger** workflow once from
the Actions tab to record the archives that exist today. Until the keys exist,
the workflow keeps one "Backup watcher not running" issue open, which is the
honest state.

**Acknowledging a page.** An investigated problem key goes into
`BACKUP_ACKNOWLEDGED` in the workflow, in a reviewed commit; nothing else
silences it. The first monthly and yearly periods are committed there too
(`ARCHIVE_FIRST_MONTHLY` / `ARCHIVE_FIRST_YEARLY`); the run summary prints the
earliest period present to help confirm them.

## Bucket lifecycle — declared, not console-only

The B2 bucket's retention behaviour is declared in
[`bucket-lifecycle.json`](./bucket-lifecycle.json) and applied by
[`scripts/apply-bucket-lifecycle.mjs`](./scripts/apply-bucket-lifecycle.mjs).

It is committed because it was previously **live state that existed nowhere in
the repo**: unreviewable, undetectable when it drifted, and only discoverable
by querying the API. That is how `daysFromHidingToDeleting: 1` went unnoticed
— the setting that meant a superseded archive was deleted a day later, so a
forged overwrite left nothing to fall back on (#1469).

```bash
# From the REPOSITORY ROOT this needs the `cd` — the root `package.json` has
# none of these scripts, so copying the block without it fails with a
# missing-script error rather than anything that hints at the cause (#1471 r4).
cd ops/offchain-data-warm
# CREDENTIALS MUST BE IN THE ENVIRONMENT — this script reads
# BACKBLAZE_KEY_ID / BACKBLAZE_APP_KEY from `process.env` only and, unlike
# setup-backblaze.mjs, does not load any file. Export the key the MODE needs:
#
#   print / check  ->  the bucket-scoped READ-ONLY key (listBuckets)
#   apply          ->  a temporary key with listBuckets + writeBuckets
#
export BACKBLAZE_KEY_ID=...  BACKBLAZE_APP_KEY=...   # see the modes above
#
# ── THE TWO CREDENTIAL SETS IN `.env` ────────────────────────────────
#
#   BACKBLAZE_MASTER_KEY_ID / BACKBLAZE_MASTER_APP_KEY
#     The account MASTER key. Account-wide: writeBuckets, deleteBuckets,
#     writeKeys, deleteKeys, writeFiles, deleteFiles, bypassGovernance.
#     Used by ONE script — setup-backblaze.mjs — because provisioning
#     creates buckets, mints keys and writes lifecycle rules. Removed
#     from `.env` after setup (step 7).
#
#   BACKBLAZE_KEY_ID / BACKBLAZE_APP_KEY
#     The bucket-scoped READ-ONLY key: exactly listBuckets + listFiles +
#     readFiles. Stays in `.env`. Used by read tooling such as
#     `find-archive-baselines.mjs`, which REFUSES anything holding more.
#
# The names differ on purpose. They previously did not, and a single pair
# carrying keys with opposite authority is what made the instructions
# below contradict each other for two revisions.
# ─────────────────────────────────────────────────────────────────────

# Do NOT source the repo `.env` here, which an earlier revision of this block
# told you to do (#1471 r9). Since the credential split, `.env`'s
# BACKBLAZE_KEY_ID / BACKBLAZE_APP_KEY hold the bucket-scoped READ key and the
# master lives under BACKBLAZE_MASTER_*. Sourcing it therefore gives `apply`
# a key that CANNOT write, so the run fails partway rather than at the check —
# and gives `print` / `check` exactly what they want, which is the trap: the
# same command block behaves correctly in two modes and wrongly in the third.
# Export the key the MODE needs, per the list above.
#
# (This warning previously said `.env` was the master key's home under these
# same names, and concluded that sourcing it would run these commands AS the
# master. Both were true before the credential split and neither is now. The
# advice survived; its reasoning did not — see the two-sets block above.)
npm run bucket:lifecycle:print   # what B2 currently has
npm run bucket:lifecycle:check   # does live match the declaration?
npm run bucket:lifecycle:apply   # make live match the declaration
```

**Capabilities, and why they differ deliberately.** `print` and `check` need
only `listBuckets`, so the ordinary bucket-scoped **read-only** key works —
drift has to be observable without holding anything dangerous. `apply` needs
`writeBuckets`, which **neither pipeline key has**, on purpose:
the write key exists to push objects, not to reconfigure the bucket. Use a
temporary key scoped to this bucket with `listBuckets` + `writeBuckets`,
then delete it.

> **`readBucketLifecycleRules` / `writeBucketLifecycleRules` are not B2
> capabilities.** An earlier revision of this section asked for them, so the
> documented least-privilege procedure could not be followed — B2 rejects the
> key creation. `b2_update_bucket` authorises against `writeBuckets`, and the
> rules are READ back through `b2_list_buckets` under plain `listBuckets`.
> Confirmed against the live read-only key, whose full capability set is
> `listBuckets listFiles readFiles` and which reads the lifecycle rules
> without difficulty — which is also why `--check` and `--print-live` need
> nothing beyond it.

Do **not** use the master key for this. It also carries `deleteBuckets`,
`deleteFiles`, `deleteKeys` and `bypassGovernance` — none of which this task
needs, and all of which turn a mistyped lifecycle edit into a potential data
loss. `apply` reads the result back rather than trusting the write, so a
successful run is evidence, not an assumption.

**What the settings mean, and where the numbers live.** The values themselves
and the reasoning that fixes them are in `scripts/lifecycle-policy.mjs` — the
one module both writers import — and are deliberately NOT repeated here.
An earlier revision of this section restated them and then closed by claiming
they were not restated anywhere else; three review rounds each corrected one
copy of the same sentence (#1471 r6/r7/r8) before the duplication itself was
treated as the defect. Run `npm run bucket:lifecycle:print` for live values.

What is worth saying here is the threat model the settings serve, which is not
duplicated anywhere:

`daysFromHidingToDeleting` governs a version that is no longer current — either
hidden by the age rule, or **superseded by a newer upload at the same key**.
The second case is the one that matters. The Worker's write key has
`writeFiles` but **not** `deleteFiles`, so a compromised Worker can overwrite
an archive and never delete one: the genuine copy survives as a hidden older
version until *our own* rule removes it. That window is the entire fallback,
and at its original value of 1 day it was effectively no window at all — which
is what #1469 exists to fix.

**What detects an overwrite — the window's value depends on this.** Before
slice 2 the Worker bound a read key and the symmetric decryption key beside
its write key, so one compromised environment could find an archive's nonce
and write a self-consistent forgery at that exact name, and the weekly
healthcheck it ran would pass it. Slice 2 removed the read key, the decryption
key and the healthcheck, and stopped the nonce leaking (#1463, #1469): an
overwrite in place now means guessing a 128-bit value. The backup watcher
above is what detects one anyway: an overwrite adds a second version, which
the watcher reports the same day, and the ledger keeps the genuine version's
digest and upload time where the Worker cannot reach them. Archives written
before slice 2 keep their exposure, because their names were already in the
ops channel and the Worker logs (design §4). The floors in
`lifecycle-policy.mjs` are a floor of usefulness, not a sufficiency argument,
and its comments say so.

### Declare the first archive of each long tier (`ARCHIVE_FIRST_*`)

The first monthly and yearly cut are committed facts, because a detector whose
expectations come from the survivors cannot report a deletion of the oldest
period (#1476). Since slice 2 they live in ONE place, the backup watcher's
workflow (`.github/workflows/backup-ledger.yml`); the Worker no longer reads
them. A malformed value fails only its own tier.

The monthly floor is higher than the daily one, and **#1476 did not change
that** — deliberately, after trying to.

(The rest of this subsection is the reasoning as it stood before slice 2, when
the Worker's weekly healthcheck was the routine inspection; the floors it
derives are unchanged.) Before #1476, `healthcheck.ts` examined only
`manifests/<recent dates>/`, so a monthly overwrite was detected by nothing at
all and the window could not be
justified by detection in any form; it simply had to outlast the monthly write
cadence. #1476 closed that gap: the weekly run now reads every prefix family.

It did not earn a shorter window. The run verifies the NEWEST period of each
family in full — hash, size, decryption — while every older period still inside
retention gets a presence-and-pairing check, which an archive corrupted or
overwritten in place passes unchanged. The floor's derivation is "the window
outlives one full cycle of the routine inspection", and that only holds for the
periods actually inspected in full. Rotating the full check across the retained
months implies a floor near 78 days, not a shorter one. See the note above
`MIN_RECOVERY_DAYS_MONTHLY` in `lifecycle-policy.mjs`.

Raising the daily ceiling at all means excluding support tickets from that tier,
which means tickets have no backup — a product decision, tracked as **#1474**.

## What gets backed up

| Source | Coverage |
| --- | --- |
| `vaipakam-warm` D1 (born-off-chain) | `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`, `notify_state`, `pre_grace_notify_state`, `telegram_links`, `support_tickets`, `loan_orphans` — irrecoverable without backup. |
| `vaipakam-warm` D1 (hybrid, #1481) | `signed_offers` — born off chain, with columns the indexer projects from chain events. The restore imports the user's part and leaves the projected part to the block-zero replay. |
| `vaipakam-warm` D1 (re-derivable) | `offers`, `loans`, `activity_events`, `oracle_snapshot_state`, `liquidity_confidence`, `indexer_cursor` — kept for restore-performance only; can be skipped on restore in favour of a fresh re-index from block 0. |
| `vaipakam-legal-vault` R2 | Every uploaded legal-hold document. |

Every table any Worker writes has exactly one of these treatments, and
`apps/indexer/scripts/check-table-classification.mjs` refuses a tree where a
written table has none, or where this backup, the restore converter and
`docs/ops/OffChainRestore.md` disagree with it (#1481).

## What does NOT get backed up

- On-chain state — the Diamond contract + VPFI token are decentralised
  on chain.
- Workers themselves — Worker code lives in this monorepo and ships
  via `wrangler deploy`; a restore re-runs the deploy.
- Secrets — `B2_*`, `TG_*`, and offline, the recipient private keys and
  the old AES key (still needed for archives written before slice 2). The
  operator maintains these out-of-band (1Password / pass).

## Schedule

Single cron: **`17 3 * * *` UTC** daily (03:17 — non-zero minute
avoids exact-minute B2 contention). It runs the nightly backup and nothing
else: the Monday healthcheck that shared the tick left with slice 2.

Why one cron: the Cloudflare Workers free plan caps cron triggers per
account, and this Worker takes one.

**How much of that budget is left is in
[`docs/ops/CloudflareCronSlots.md`](../../docs/ops/CloudflareCronSlots.md),
not here.** This paragraph used to do the arithmetic itself and got it
wrong for months, in the company of every other copy of the same
arithmetic: none of them could see `vaipakam-offchain-data-archive` — this
Worker's own predecessor, which has no source in this repository and so is
invisible to anyone counting `crons` entries across the tree (#1977).

**Whether it is still armed is the authority's answer, not this file's.** An
earlier revision said here that it *is* armed on the same minute as the
schedule below — true when written, and it would have survived the #1977
retirement untouched, because the occupancy gate matches numbers and this
sentence carries none. A present-tense claim about the account is exactly
what the paragraph above tells you not to put here; I wrote one two lines
later, in the sentence explaining why (Codex #1978 r29).

Split back into two crons if/when the account upgrades to Workers
Paid ($5/mo, which raises the cap to 250 rather than removing it).

The run reports to Telegram (`TG_OPS_CHAT_ID`): per archive its tier,
period, size and SHA-256, and never its name.

## Setup

1. **Create a Backblaze B2 account** on a separate billing boundary
   from your Cloudflare account (different email, different card,
   different 2FA).

2. **Run the setup script** to provision the bucket, lifecycle rules,
   and the two scoped Application Keys (write-only + read-only). Since
   slice 2 only the write key goes to the Worker; the read key is for
   local read tooling (step 7):

   ```bash
   # The MASTER B2 Application Key is read from the repo `.env` as
   # BACKBLAZE_MASTER_KEY_ID + BACKBLAZE_MASTER_APP_KEY — deliberately
   # NOT the BACKBLAZE_KEY_ID / BACKBLAZE_APP_KEY pair, which holds the
   # scoped READ key (listBuckets + listFiles + readFiles) used by
   # read-only tooling. Only this script needs account-wide authority:
   # it creates buckets, mints application keys and writes lifecycle
   # rules. After it runs, the master key only comes back out for
   # explicit rotation events; the Worker uses the scoped keys.
   cd ops/offchain-data-warm
   node scripts/setup-backblaze.mjs
   ```

   > ⚠️ **This script is initial provisioning, NOT a key-rotation
   > path.** Re-running it rewrites the bucket's six lifecycle rules
   > to the values coded in this tree before it touches either key —
   > silently reverting any tuning applied to the live bucket since
   > (the hidden-version retention window in particular; see
   > `docs/ops/OffChainRestore.md` §2). To rotate the scoped keys,
   > create/delete them directly via the B2 console's App Keys page
   > (or the B2 CLI's key create/delete commands — subcommand names
   > differ across CLI major versions, check `b2 help`), and leave
   > the lifecycle rules alone (#1450 r28).

   The script is idempotent in the provisioning sense — a re-run
   converges the bucket to THIS TREE's declared state (which is
   exactly why it must not be used mid-incident). It will:
   - Create the `vaipakam-offchain-data-warm` bucket (allPrivate) if
     missing, reuse if present.
   - Set the FOUR lifecycle rules from `bucket-lifecycle.json` (the setup
     script reads that file rather than carrying its own copy): `archives/`
     and `manifests/`, plus their `-monthly/` counterparts — with the values
     read from that file, not restated here (this line carried a copy of the
     arithmetic until #1471 r10, four sections below the claim that the numbers
     are not repeated in this README). The yearly prefixes get
     NO rule, which is what gives them indefinite retention — an earlier
     revision of this line said "six rules … yearly indefinite", which
     described a rule that does not and should not exist. (The backup
     watcher treats a yearly tier's ABSENCE as expected rather than pageable
     until `ARCHIVE_FIRST_YEARLY` is set — a deployment that has not lived
     through a Jan 1 legitimately has none.)
   - Create `vaipakam-offchain-data-warm-write-only` (listBuckets +
     writeFiles, bucket-scoped — NOT listFiles) for the nightly cron.
   - Create `vaipakam-offchain-data-warm-read-only` (listBuckets +
     listFiles + readFiles, bucket-scoped) for local read tooling. It
     is never a Worker secret: a read key beside the write key is what
     let one compromised environment find and overwrite an archive.
   - Print both key IDs + Application Key strings ONCE. Save them
     to your offline secret store immediately — B2 never shows the
     Application Key strings again.

3. **Generate the recipient key pairs** offline, on the machine that will
   keep them (a primary and an escrow, stored apart), and commit only the
   public halves to `backup-recipients/recipients.json` with their
   fingerprints (see that folder's README). The private keys never leave
   the offline store:

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -aes-256-cbc -out backup-primary.key.pem
   openssl pkey -in backup-primary.key.pem -pubout -out backup-primary.pub.pem
   ```

4. **Configure the Worker secrets** — paste each value when prompted. There
   is no encryption secret:

   ```bash
   cd ops/offchain-data-warm
   wrangler secret put B2_WRITE_ACCESS_KEY_ID       # from step 2 output
   wrangler secret put B2_WRITE_SECRET_ACCESS_KEY   # from step 2 output
   wrangler secret put B2_ENDPOINT                  # from step 2 output (account-region specific, e.g. "s3.eu-central-003.backblazeb2.com"). Not committed because forks land in different regions.
   wrangler secret put B2_BUCKET                    # from step 2 output (B2 bucket names are globally unique across accounts; forks need their own name).
   wrangler secret put TG_OPS_BOT_TOKEN             # ops-internal Telegram bot — DISTINCT from the user-facing TG_BOT_TOKEN used by apps/keeper + apps/agent. Same bot shared with ops/mesh-watcher.
   wrangler secret put TG_OPS_CHAT_ID               # channel id where ops alerts land. Not strictly secret, but kept out of the public repo for free-of-cost obfuscation.
   ```

   A deployment from before slice 2 also holds `BACKUP_ENCRYPTION_KEY` and
   `B2_READ_ACCESS_KEY_ID` / `B2_READ_SECRET_ACCESS_KEY`, which the Worker no
   longer reads. A deploy does not remove a secret, so delete those three
   (`wrangler secret delete <NAME>`), and the `ARCHIVE_FIRST_MONTHLY` var from
   the dashboard, after the slice-2 deploy. Keep the old AES key itself
   offline.

5. **Deploy** — every operator-specific value lives in the secret
   store, so the deploy takes no flags. `npm run deploy` runs `wrangler
   deploy` with the commit it was built from recorded on the version, which
   the deploy-lag check reads back (#2242):

   ```bash
   npm run deploy
   ```

6. **Verify** — kick a manual run via the Cloudflare dashboard's
   "Trigger" button on the cron, or wait for the first 03:17 UTC
   tick. The Telegram alert lands either way.

7. **Put the generated READ key into `.env`**, then remove the master.

   Step 2 prints a bucket-scoped read-only key (listBuckets + listFiles
   + readFiles). Local read tooling — `find-archive-baselines.mjs` — needs
   it, and nothing until now put it on disk:

   ```bash
   # In the repo-root .env, SET these to the READ key from step 2 output.
   # On an existing deployment they currently hold the pre-split master;
   # overwrite them.
   BACKBLAZE_KEY_ID=<read key id from step 2>
   BACKBLAZE_APP_KEY=<read application key from step 2>
   ```

   **Verify BEFORE removing anything** — this check gates the deletion, so
   it has to run while the working master is still in place:

   ```bash
   npm run archive:baselines
   ```

   It refuses a master key by capability, refuses an unscoped one, and
   refuses a half-written pair — so success means the credential now on
   disk is genuinely the scoped read key. Print order matters: the first
   line names the credential source it used, and it must be
   `.env BACKBLAZE_KEY_ID/APP_KEY`. If anything fails, fix the pasted key
   and re-run; the master is still there and nothing is lost.

   **Only once that passes**, remove `BACKBLAZE_MASTER_KEY_ID` +
   `BACKBLAZE_MASTER_APP_KEY` — those two lines and no others. They were
   needed only for this one-time setup, and an account-wide key on disk is
   one accidental `git add` away from a leak.

   > An earlier revision put this check AFTER the removal while telling
   > you to "verify before you delete anything" — so a mistyped read key
   > was discovered only once the working credential was already gone.

   > Two revisions of this step said "revoke the master key" while the
   > setup step above pointed at `BACKBLAZE_KEY_ID` — so following both
   > literally deleted the read key and left the actual account master on
   > disk, which is precisely backwards. The names moved at the credential
   > split and the instructions did not. `npm run archive:baselines` is
   > the cheap check: it refuses a master key by capability, so if it
   > succeeds, what is on disk is genuinely read-only.

## Restore

See [`docs/ops/OffChainRestore.md`](../../docs/ops/OffChainRestore.md)
for the full procedure. High level:

1. Stand up a fresh Cloudflare account; recreate the Workers / D1 /
   R2 via `wrangler deploy` from the monorepo.
2. Download the archive version to restore from B2, by its file id.
3. Decrypt offline with `scripts/decrypt-archive.mjs`, which checks it
   against the backup ledger first, using a recipient private key (or the
   old AES key, for an archive written before slice 2).
4. `wrangler d1 execute --file=<dump.sql>` to restore the born-off-
   chain tables; re-bootstrap the indexer from block 0 for the
   re-derivable tables.
5. `wrangler r2 object put` per object for the legal-vault.
6. Run the indexer event-coverage guardrail; smoke-test on testnet
   before re-pointing production.

## Out of scope

- **Multi-cloud writes** — Stage C of the resilience plan. Design
  notes in `OffChainDataResilience.md` §4.
- **Active-active redundancy for keeper / agent / mesh-watcher** —
  cold standby only; see design doc §4.5.
