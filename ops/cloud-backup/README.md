# vaipakam-cloud-backup

Internal-ops Cloudflare Worker that nightly exports Vaipakam's off-
chain footprint to Backblaze B2 on a separate billing/credential
boundary, client-side encrypted with AES-256-GCM using an
operator-offline key. Stage A of the off-chain data resilience plan —
issue [#30 (T-077)](https://github.com/vaipakam/vaipakam/issues/30).
Design notes: [`docs/DesignsAndPlans/OffChainDataResilience.md`](../../docs/DesignsAndPlans/OffChainDataResilience.md).

## What gets backed up

| Source | Coverage |
| --- | --- |
| `vaipakam-archive` D1 (born-off-chain) | `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit` — irrecoverable without backup. |
| `vaipakam-archive` D1 (re-derivable) | `offers`, `loans`, `activity`, `oracle_snapshot_state`, `liquidity_confidence_*`, `current_holder`, `indexer_cursor` — kept for restore-performance only; can be skipped on restore in favour of a fresh re-index. |
| `vaipakam-lz-alerts-db` D1 | `lz_alerts`, `lz_cursor` — alert dispatch history. |
| `vaipakam-legal-vault` R2 | Every uploaded legal-hold document. |

## What does NOT get backed up

- On-chain state — the Diamond contract + VPFI token are decentralised
  on chain.
- Workers themselves — Worker code lives in this monorepo and ships
  via `wrangler deploy`; a restore re-runs the deploy.
- Secrets — `BACKUP_ENCRYPTION_KEY`, `B2_*`, `TG_*`. Operator
  maintains these out-of-band (1Password / pass).

## Schedule

- **Nightly backup**: `17 3 * * *` UTC (03:17 — non-zero minute avoids
  exact-minute B2 contention).
- **Weekly healthcheck**: `0 9 * * 1` UTC (Mondays 09:00) — confirms
  the latest archive exists, decrypts cleanly, manifest SHA matches.

Both paths report to Telegram (`TG_OPS_CHAT_ID`).

## Setup

1. **Create a Backblaze B2 account** on a separate billing boundary
   from your Cloudflare account (different email, different card,
   different 2FA). Create a private bucket — convention:
   `vaipakam-offchain-backup`. Enable lifecycle rules:
   - Keep 30 daily snapshots, then transition to monthly retention
     (12 monthlies), then transition the January archive of each year
     to indefinite retention.
2. **Create a write-only Application Key** scoped to that bucket
   only. `list / write` capabilities, no `read / delete`. This means
   a CF compromise that exfiltrates the key still can't damage
   existing backups (write-only ≠ overwrite-capable on B2 when paired
   with the lifecycle rules).
3. **Generate the AES-256 encryption key** locally and store it
   offline (1Password / pass / a printed paper backup). Never commit
   it.

   ```bash
   openssl rand -hex 32
   ```

4. **Configure the Worker secrets**:

   ```bash
   cd ops/cloud-backup
   wrangler secret put BACKUP_ENCRYPTION_KEY    # the 64-hex-char value from step 3
   wrangler secret put B2_ACCESS_KEY_ID
   wrangler secret put B2_SECRET_ACCESS_KEY
   wrangler secret put TG_BOT_TOKEN             # same bot used by lz-watcher
   ```

5. **Set the public vars** in `wrangler.jsonc` (or via
   `wrangler deploy --var`) — leave the JSONC defaults empty
   intentionally so an accidental deploy can't proceed without
   operator action:

   ```bash
   wrangler deploy --var B2_ENDPOINT:s3.eu-central-003.backblazeb2.com \
                   --var B2_BUCKET:vaipakam-offchain-backup \
                   --var TG_OPS_CHAT_ID:-1001234567890
   ```

6. **Verify** — kick a manual run via the Cloudflare dashboard's
   "Trigger" button on the cron, or wait for the first 03:17 UTC
   tick. The Telegram alert lands either way.

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
