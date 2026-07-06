# vaipakam-offchain-data-archive

Internal-ops Cloudflare Worker that nightly exports Vaipakam's off-
chain footprint to Backblaze B2 on a separate billing/credential
boundary, client-side encrypted with AES-256-GCM using an
operator-offline key. Stage A of the off-chain data resilience plan —
issue [#30 (T-077)](https://github.com/vaipakam/vaipakam/issues/30).
Design notes: [`docs/DesignsAndPlans/OffChainDataResilience.md`](../../docs/DesignsAndPlans/OffChainDataResilience.md).

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
   - Set six lifecycle rules: `archives/` + `manifests/` 30-day,
     `archives-monthly/` + `manifests-monthly/` 365-day, plus
     `archives-yearly/` + `manifests-yearly/` indefinite.
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
