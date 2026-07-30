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
# CREDENTIALS MUST BE IN THE ENVIRONMENT. Unlike setup-backblaze.mjs, this
# script does not load the repo `.env` — the npm scripts invoke plain `node`,
# and it reads BACKBLAZE_KEY_ID / BACKBLAZE_APP_KEY from `process.env` only.
# Without this the commands exit before contacting B2 at all.
set -a; . ../../.env; set +a          # or export the two vars by hand
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

**What the numbers mean.** `daysFromHidingToDeleting` governs a version that
is no longer current — either hidden by the age rule, or **superseded by a
newer upload at the same key**. The second case is the one that matters: the
Worker's B2 key has `writeFiles` but **not** `deleteFiles`, so an attacker who
compromises the Worker can only overwrite an archive, never delete one. The
genuine version survives until *our own* rule removes it. At 1 day that was
effectively immediately; the declaration sets **9** on the daily prefixes and **31** on the monthly ones.

Why 9 and not 30, which an earlier revision of this file said: the daily
prefixes' worst-case object lifetime is capped by a **published promise** —
`PrivacyPolicy.md` states a support ticket's backup copies persist at most 30
days beyond deletion, and tickets live only in this tier. Worst case is the
SUM of both lifecycle terms, so the whole daily budget is 29 days (30 minus a
day of headroom, because the B2 clock starts at upload and a ticket can be
pruned from D1 between export and upload). The split is 20 to hide + 9 to
delete.

9 rather than 8: the forged-overwrite detector is the **weekly** healthcheck,
so at 7 days an overwrite landing just after one Monday becomes deletable as
the next Monday's alert fires — the alert races the deletion. 9 puts detection
strictly inside the window and leaves two days to act.

**What the weekly check does and does not detect — the recovery window's value
depends on this.** `healthcheck.ts` verifies the newest archive against its
manifest: hash, size, decryptability. That catches corruption and a *blind*
overwrite. It does **not** catch an authenticated forgery, and in the scenario
this section is about it cannot: a compromised Worker yields both B2 credential
pairs **and** `BACKUP_ENCRYPTION_KEY` from the same environment, so the
attacker can enumerate the genuine nonce with `listFiles` and write a
self-consistent encrypted archive+manifest pair at that exact key. Every check
the healthcheck makes passes.

So the recovery window is not "time after an alert" for a competent attacker —
it is time for a human or an out-of-band signal to notice. That is a real but
much weaker property than an earlier revision of this file implied, and it is
the same integrity-is-not-provenance gap tracked as #1473, which is what
actually closes it. The floors below are the floor of usefulness, not a
sufficiency argument.

The monthly floor is higher for a worse reason, stated plainly rather than
buried: `healthcheck.ts` examines only `manifests/<recent dates>/`, so it never
looks at the monthly prefixes and **a monthly overwrite is detected by nothing
today**. A short window there could not be justified by "the detector will
catch it", so it instead has to outlast the monthly write cadence. Extending
the healthcheck to cover the monthly tier is #1476, and until it lands the
monthly guarantee is genuinely weaker than the daily one.

Raising the ceiling at all means excluding support tickets from this tier,
which means tickets have no backup — a product decision, tracked as #1474.
The ceilings are enforced in `scripts/lifecycle-policy.mjs`, which both
writers must pass through; the numbers are not restated anywhere else.

## What gets backed up

| Source | Coverage |
| --- | --- |
| `vaipakam-archive` D1 (born-off-chain) | `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `user_thresholds`, `notify_state`, `telegram_links`, `support_tickets` — irrecoverable without backup. |
| `vaipakam-archive` D1 (re-derivable) | `offers`, `loans`, `activity_events`, `oracle_snapshot_state`, `liquidity_confidence`, `indexer_cursor` — kept for restore-performance only; can be skipped on restore in favour of a fresh re-index from block 0. |
| `vaipakam-lz-alerts-db` D1 | `lz_alert_state`, `scan_cursor`, `oft_balance_history` — alert dispatch history + mint/burn imbalance series + per-chain scan cursor. |
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
occupies 4 (`apps/{keeper,agent,indexer}` + `ops/lz-watcher`).
Folding healthcheck into the same cron keeps the account at 5/5.
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

   The script is idempotent — safe to re-run. It will:
   - Create the `vaipakam-offchain-data-archive` bucket (allPrivate) if
     missing, reuse if present.
   - Set the FOUR lifecycle rules from `bucket-lifecycle.json` (the setup
     script reads that file rather than carrying its own copy): `archives/`
     and `manifests/` at 20 + 9 = 29 days worst case, `archives-monthly/`
     and `manifests-monthly/` at 334 + 31 = 365. The yearly prefixes get
     NO rule, which is what gives them indefinite retention — an earlier
     revision of this line said "six rules … yearly indefinite", which
     described a rule that does not and should not exist. (Their being
     unverified by the healthcheck is a separate gap, #1476.)
   - Create `vaipakam-offchain-data-archive-write-only` (listBuckets +
     listFiles + writeFiles, bucket-scoped) for the nightly cron.
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
   wrangler secret put TG_OPS_BOT_TOKEN             # ops-internal Telegram bot — DISTINCT from the user-facing TG_BOT_TOKEN used by apps/keeper + apps/agent. Same bot shared with ops/lz-watcher.
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
- **Active-active redundancy for keeper / agent / lz-watcher** —
  cold standby only; see design doc §4.5.
