# vaipakam-offchain-data-archive

Internal-ops Cloudflare Worker that nightly exports Vaipakam's off-
chain footprint to Backblaze B2 on a separate billing/credential
boundary, client-side encrypted with AES-256-GCM using an
operator-offline key. Stage A of the off-chain data resilience plan —
issue [#30 (T-077)](https://github.com/vaipakam/vaipakam/issues/30).
Design notes: [`docs/DesignsAndPlans/OffChainDataResilience.md`](../../docs/DesignsAndPlans/OffChainDataResilience.md).

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
cd ops/offchain-data-archive
# CREDENTIALS MUST BE IN THE ENVIRONMENT — this script reads
# BACKBLAZE_KEY_ID / BACKBLAZE_APP_KEY from `process.env` only and, unlike
# setup-backblaze.mjs, does not load any file. Export the key the MODE needs:
#
#   print / check  ->  the bucket-scoped READ-ONLY key (listBuckets)
#   apply          ->  a temporary key with listBuckets + writeBuckets
#
export BACKBLAZE_KEY_ID=...  BACKBLAZE_APP_KEY=...   # see the modes above
#
# Do NOT source the repo `.env` here, which an earlier revision of this block
# told you to do (#1471 r9). That file is the MASTER key's home — the same two
# variable names, a different and far more dangerous key — so sourcing it either
# supplies nothing (step 7 below has you revoke it after setup) or silently runs
# these commands as the master key, against the capability split this section
# spends a page justifying. One variable pair carries three different keys with
# opposite requirements; nothing at runtime can tell them apart, so the choice
# has to be made here, deliberately, per mode.
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

**What the weekly check does and does not detect — the window's value depends
on this.** `healthcheck.ts` verifies the newest archive against its manifest:
hash, size, decryptability. That catches corruption and a *blind* overwrite. It
does **not** catch an authenticated forgery, and in this scenario it cannot: the
Worker binds BOTH B2 credential pairs plus `BACKUP_ENCRYPTION_KEY`, so an
attacker enumerates the genuine nonce with the read key's `listFiles` and writes
a self-consistent encrypted archive+manifest pair at that exact key. Every check
the healthcheck makes passes.

So the window is not "time after an alert" against a competent attacker — it is
time for a human or an out-of-band signal to notice. Real, but much weaker than
an earlier revision of this file implied, and it is the integrity-is-not-
provenance gap tracked as **#1473**, which is what would actually close it. The
floors in `lifecycle-policy.mjs` are a floor of usefulness, not a sufficiency
argument, and its comments say so.

### Declare the first archive of each long tier (`ARCHIVE_FIRST_*`)

Two optional vars on the Worker:

- `ARCHIVE_FIRST_MONTHLY` — `YYYY-MM` of the first monthly cut this
  deployment wrote.
- `ARCHIVE_FIRST_YEARLY` — `YYYY` of the first yearly cut.

**Set them once each first cut exists.** Without them the healthcheck
derives what *should* be present from what *is* present, and that is
circular: delete the oldest yearly archive and the inferred baseline
advances past it, so the deleted year stops being required; empty the
family entirely and there is nothing left to infer from, so nothing is
reported missing and the tier passes. A detector whose expectations come
from the survivors cannot report a deletion.

They are optional because a fresh deployment genuinely has no baseline to
state. While unset, the tier falls back to the earliest archive it can still
see — enough to catch a gap ABOVE that point, blind to a deletion below it —
and the weekly report appends `COVERAGE DEGRADED` to that tier's line saying
so. The absence of the guarantee is published rather than implied.

A malformed value fails **only its own tier**: a typo in
`ARCHIVE_FIRST_MONTHLY` must not suppress the daily and yearly checks for the
week, or an alert about a typo hides a simultaneous loss elsewhere.

The monthly floor is higher than the daily one, and **#1476 did not change
that** — deliberately, after trying to.

Before #1476, `healthcheck.ts` examined only `manifests/<recent dates>/`, so a
monthly overwrite was detected by nothing at all and the window could not be
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
| `vaipakam-archive` D1 (born-off-chain) | `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`, `notify_state`, `pre_grace_notify_state`, `telegram_links`, `support_tickets` — irrecoverable without backup. |
| `vaipakam-archive` D1 (re-derivable) | `offers`, `loans`, `activity_events`, `oracle_snapshot_state`, `liquidity_confidence`, `indexer_cursor` — kept for restore-performance only; can be skipped on restore in favour of a fresh re-index from block 0. |
| `vaipakam-legal-vault` R2 | Every uploaded legal-hold document. |

## What does NOT get backed up

- On-chain state — the Diamond contract + VPFI token are decentralised
  on chain.
- Workers themselves — Worker code lives in this monorepo and ships
  via `wrangler deploy`; a restore re-runs the deploy.
- Secrets — `BACKUP_ENCRYPTION_KEY`, `B2_*`, `TG_*`. Operator
  maintains these out-of-band (1Password / pass).

## Schedule

Single cron: **`17 3 * * *` UTC** daily (03:17 — non-zero minute
avoids exact-minute B2 contention). On every invocation:

- **Backup** runs unconditionally.
- **Healthcheck** also runs IN PARALLEL when the invocation falls on
  a Monday. Same cron tick fires both via two independent
  `ctx.waitUntil` calls; the operator gets two separate Telegram
  alerts in their natural finish-order (healthcheck first, since
  it's smaller; backup second).

Why one cron instead of two: the Cloudflare Workers free plan caps
an account at 5 cron triggers, and the rest of the org already
occupies 4 (`apps/{keeper,agent,indexer}` + this Worker). One slot is
SPARE today: `ops/mesh-watcher` is code-complete but UNDEPLOYED and takes
the fifth on its first deploy, at which point the cap binds. (`ops/lz-watcher`
held a slot until #1440 removed it.)
Folding healthcheck into the same cron is what keeps this Worker to ONE slot rather than two — it does not by itself put the account at 5/5, which the lines above say is 4/5 today with one slot spare until `ops/mesh-watcher` deploys.
Split back into two crons if/when the account upgrades to Workers
Paid ($5/mo, removes the cap).

Both paths report to Telegram (`TG_OPS_CHAT_ID`).

## Setup

1. **Create a Backblaze B2 account** on a separate billing boundary
   from your Cloudflare account (different email, different card,
   different 2FA).

2. **Run the setup script** to provision the bucket, lifecycle rules,
   and the two scoped Application Keys (write-only + read-only):

   ```bash
   # Master B2 Application Key is read from the repo `.env` —
   # BACKBLAZE_KEY_ID + BACKBLAZE_APP_KEY. After this script runs,
   # the master key only needs to come back out for explicit
   # rotation events; the Worker uses the scoped keys.
   cd ops/offchain-data-archive
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
   - Create the `vaipakam-offchain-data-archive` bucket (allPrivate) if
     missing, reuse if present.
   - Set the FOUR lifecycle rules from `bucket-lifecycle.json` (the setup
     script reads that file rather than carrying its own copy): `archives/`
     and `manifests/`, plus their `-monthly/` counterparts — with the values
     read from that file, not restated here (this line carried a copy of the
     arithmetic until #1471 r10, four sections below the claim that the numbers
     are not repeated in this README). The yearly prefixes get
     NO rule, which is what gives them indefinite retention — an earlier
     revision of this line said "six rules … yearly indefinite", which
     described a rule that does not and should not exist. (The healthcheck
     verifies the newest yearly object since #1476, but treats its ABSENCE as
     expected rather than pageable — a deployment that has not lived through a
     Jan 1 legitimately has none.)
   - Create `vaipakam-offchain-data-archive-write-only` (listBuckets +
     writeFiles, bucket-scoped — NOT listFiles) for the nightly cron.
   - Create `vaipakam-offchain-data-archive-read-only` (listBuckets +
     listFiles + readFiles, bucket-scoped) for the weekly
     healthcheck.
   - Print both key IDs + Application Key strings ONCE. Save them
     to your offline secret store immediately — B2 never shows the
     Application Key strings again.

3. **Generate the AES-256 encryption key** locally and store it
   offline (1Password / pass / a printed paper backup). Never
   commit, never paste in chat, never store in CF in plaintext
   except through the wrangler secret upload:

   ```bash
   openssl rand -hex 32
   ```

4. **Configure the Worker secrets** — paste each value when prompted:

   ```bash
   cd ops/offchain-data-archive
   wrangler secret put BACKUP_ENCRYPTION_KEY        # 64-hex from step 3
   wrangler secret put B2_WRITE_ACCESS_KEY_ID       # from step 2 output
   wrangler secret put B2_WRITE_SECRET_ACCESS_KEY   # from step 2 output
   wrangler secret put B2_READ_ACCESS_KEY_ID        # from step 2 output
   wrangler secret put B2_READ_SECRET_ACCESS_KEY    # from step 2 output
   wrangler secret put B2_ENDPOINT                  # from step 2 output (account-region specific, e.g. "s3.eu-central-003.backblazeb2.com"). Not committed because forks land in different regions.
   wrangler secret put B2_BUCKET                    # from step 2 output (B2 bucket names are globally unique across accounts; forks need their own name).
   wrangler secret put TG_OPS_BOT_TOKEN             # ops-internal Telegram bot — DISTINCT from the user-facing TG_BOT_TOKEN used by apps/keeper + apps/agent. Same bot shared with ops/mesh-watcher.
   wrangler secret put TG_OPS_CHAT_ID               # channel id where ops alerts land (e.g. -1003903308626). Not strictly secret, but kept out of the public repo for free-of-cost obfuscation.
   ```

5. **Deploy** — every operator-specific value lives in the secret
   store, so `wrangler deploy` takes no flags:

   ```bash
   wrangler deploy
   ```

6. **Verify** — kick a manual run via the Cloudflare dashboard's
   "Trigger" button on the cron, or wait for the first 03:17 UTC
   tick. The Telegram alert lands either way.

7. **Revoke the master key from `.env`** once everything is verified.
   It only needed to be there for the one-time setup; keeping it on
   disk is one accidental `git add` away from a leak.

## Restore

See [`docs/ops/OffChainRestore.md`](../../docs/ops/OffChainRestore.md)
for the full procedure. High level:

1. Stand up a fresh Cloudflare account; recreate the Workers / D1 /
   R2 via `wrangler deploy` from the monorepo.
2. Download the most recent encrypted archive from B2 locally.
3. Decrypt with the offline AES key.
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
