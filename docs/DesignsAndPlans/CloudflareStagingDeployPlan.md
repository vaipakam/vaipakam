# Cloudflare Staging Deploy Plan

**Status:** Active — refreshed 2026-05-08 to match the **3-Worker
split** that actually shipped (Stage 3 PR2-5 + the
architectural-rebalance commit). The original 2026-05-07 draft
proposed a 2-Worker shape (`agent` + `keeper`); the implemented
shape is a 3-Worker split (`keeper` + `indexer` + `agent`) with
the read-API + chain-event scan carved into a dedicated Worker
for resource isolation.
**Owner:** Vaipakam protocol team

## 1. Goal

Stand up parallel Worker deployments alongside the existing
production set so this branch's changes can be validated end-to-
end (frontend + indexer + keeper actions) **without touching prod
data**. If the validation goes well, the new workers replace the
existing ones via DNS / env-var swap; if not, prod stays
unaffected.

## 2. Worker / domain split — final 3-Worker shape

| Worker | Domain | What it does | Holds signing key? |
|---|---|---|---|
| **vaipakam-labs** | `labs.vaipakam.com` (today); `vaipakam.com` + `www.vaipakam.com` after cutover | Marketing site, docs, "Launch Vaipakam" button → `defi.vaipakam.com/`. Static, wallet-free. | No |
| **vaipakam-defi** | `defi.vaipakam.com` | The connected app — wallet connect, Dashboard at root, Offer Book, loan flows, Buy-VPFI, Claim Center, plus three wallet-free public-read tools (`/analytics`, `/nft-verifier`, `/protocol-console`). | No |
| **vaipakam-indexer** | `indexer.vaipakam.com` | Chain → D1 sync (chainIndexer.ts), cancelled-offer retention prune, public read-API: `/offers/*`, `/loans/*`, `/activity`, `/claimables/*`. Open-CORS reads. | No |
| **vaipakam-agent** | `agent.vaipakam.com` | Proactive notifications (periodic interest pre-notify, push + Telegram), cross-chain monitoring (buy-watchdog), public Farcaster Frame at `/frames/active-loans`, operator services (`/quote/0x`, `/quote/1inch`, `/scan/blockaid`), Telegram bot webhook (`/tg/webhook`), diagnostics record (`/diag/record`), frontend-facing settings (`/thresholds`, `/link/telegram`). | **NO** (intentional — staging plan §2 contract) |
| **vaipakam-keeper** | (no public domain — internal Worker, cron-only) | Active write-to-chain — HF watcher loop + autonomous liquidation, daily oracle snapshot signer, future offer matcher. | **YES** — single signing-key holder |

The split follows the **read/index vs write/act** axis. Strict
least-privilege:

- `vaipakam-keeper` carries `KEEPER_PRIVATE_KEY` and is the
  ONLY Worker that signs on-chain transactions. Three
  signing tasks co-located there: HF liquidation, daily
  oracle snapshot, future offer matching.
- `vaipakam-agent` holds no signing key. Notification tokens
  (`TG_BOT_TOKEN`, `PUSH_CHANNEL_PK`) and aggregator API
  keys (`ZEROEX_API_KEY`, `ONEINCH_API_KEY`,
  `BLOCKAID_API_KEY`) are operational secrets but not
  fund-moving capability.
- `vaipakam-indexer` is read-only — RPC reads, D1 writes, no
  HTTP-level secrets.

A buggy agent produces stale data; a buggy keeper loses funds.
Different blast radius justifies different deploy cadence +
reviewer sign-off.

## 3. Cloudflare provisioning state (as-deployed)

Operator has provisioned (verified via Cloudflare API
2026-05-08):

- `vaipakam-defi`        — `defi.vaipakam.com` ✓ bound
- `vaipakam-labs`        — `labs.vaipakam.com` ✓ bound
- `vaipakam-indexer`     — Worker exists; **`indexer.vaipakam.com` not yet bound**
- `vaipakam-agent`       — `agent.vaipakam.com` ✓ bound
- `vaipakam-keeper`      — Worker exists; no public domain (by design)

D1 databases:

- `vaipakam-alerts-db` (`50850eab-…`) — **PRODUCTION D1, untouched**
- `vaipakam-archive`   (`3cffebf5-…`) — staging D1 for the new
  Workers. Migrations not yet applied (one-time step).

Pre-existing primary infra (untouched until staging is proven):

- `vaipakam-hf-watcher`  — primary Worker on `api.vaipakam.com`,
  cron `* * * * *`, reads/writes `vaipakam-alerts-db`.
- `vaipakam`             — primary marketing Worker on
  `vaipakam.com` + `www.vaipakam.com`.

## 4. Per-Worker configuration

### 4.1 `vaipakam-defi` (frontend)

Static-asset deploy, build-time env vars (Vite injects at
`pnpm build`, baked into the JS bundle):

```
VITE_DEFAULT_CHAIN_ID=84532
VITE_BASE_SEPOLIA_RPC_URL=<provider URL>
VITE_<CHAIN>_RPC_URL=...
VITE_WALLETCONNECT_PROJECT_ID=...
VITE_INDEXER_ORIGIN=https://indexer.vaipakam.com   # NEW (staging) — replaces VITE_API_ORIGIN
VITE_AGENT_ORIGIN=https://agent.vaipakam.com       # NEW (staging) — replaces VITE_API_ORIGIN
```

NO secrets — the frontend bundle is static.

### 4.2 `vaipakam-indexer`

- **Custom domain:** `indexer.vaipakam.com` (binding pending —
  add to wrangler.jsonc `routes`).
- **D1:** `vaipakam-archive`, `migrations_dir: "migrations"`.
- **Cron:** `* * * * *` — chain-event scan + cancelled-offer
  retention prune.
- **Secrets** (all `RPC_*`):
  ```
  RPC_BASE_SEPOLIA, RPC_OP_SEPOLIA, RPC_ARB_SEPOLIA
  ```
  Add others as new chains come online.

### 4.3 `vaipakam-agent`

- **Custom domain:** `agent.vaipakam.com` ✓
- **D1:** `vaipakam-archive` (read-mostly: link_codes,
  thresholds, diag_errors, cross-Worker reads of indexer's
  loan tables).
- **Cron:** `* * * * *` — periodic-interest pre-notify,
  buy-watchdog, diag retention.
- **Secrets:**
  ```
  RPC_*           — same chains as indexer
  TG_BOT_TOKEN    — STAGING bot token (NOT prod)
  PUSH_CHANNEL_PK — STAGING channel signer (NOT prod)
  ZEROEX_API_KEY  — for /quote/0x proxy
  ONEINCH_API_KEY — for /quote/1inch proxy
  BLOCKAID_API_KEY — for /scan/blockaid proxy (currently missing — fail-soft 503 until set)
  ```
- **Vars (non-secret):**
  ```
  TG_BOT_USERNAME=<staging bot @-handle>
  FRONTEND_ORIGIN=https://defi.vaipakam.com,https://labs.vaipakam.com
  DIAG_SAMPLE_RATE=1.0
  DIAG_RETENTION_DAYS=90
  ```
- **Holds NO signing key.** This is the staging plan §2 contract.

### 4.4 `vaipakam-keeper`

- No public domain (cron-only, no fetch handler).
- **D1:** `vaipakam-archive` (reads notify_state + thresholds,
  cross-Worker reads of indexer's loan + offer tables).
- **Cron:** `* * * * *` — HF watcher loop. The daily oracle
  snapshot pass internally pre-checks the 00:00–00:09 UTC
  window + a D1 last-day guard, so most ticks exit
  immediately.
- **Secrets:**
  ```
  KEEPER_PRIVATE_KEY  — single signing key, gas-funded on every
                        chain with an RPC_* set
  RPC_*               — same chains as indexer + agent
  TG_BOT_TOKEN        — for HF-band-downgrade alerts (currently missing — sendMessage fail-soft)
  PUSH_CHANNEL_PK     — same (currently missing — sendPush fail-soft)
  ZEROEX_API_KEY      — for serverQuotes liquidation orchestration (currently missing — DEX-only fallback)
  ONEINCH_API_KEY     — same (currently missing)
  ```
- **Vars (non-secret):**
  ```
  KEEPER_ENABLED=false  — initial. Flip to "true" only after the
                          validation window in §6.
  ```

## 5. Wrangler config layout

Single source-tree per Worker; no environment-flag gymnastics:

```
apps/
  defi/wrangler.jsonc           # vaipakam-defi
  labs/wrangler.jsonc           # vaipakam-labs
  indexer/wrangler.jsonc        # vaipakam-indexer
    migrations/                  # D1 schema migrations (moved from ops/hf-watcher)
  agent/wrangler.jsonc           # vaipakam-agent
  keeper/wrangler.jsonc          # vaipakam-keeper
```

Each `wrangler.jsonc` declares the right cron, D1 binding, vars,
and (for indexer + agent) custom-domain `routes`. The previous
`ops/hf-watcher/` monolith is decommissioned in source as part of
Stage 3 PR5.

## 6. Rollout sequence

| Step | Owner | What happens |
|---|---|---|
| 1 | Operator | Provision Cloudflare resources per §3 (DONE 2026-05-07) |
| 2 | Author | Patch wrangler.jsonc with `vaipakam-archive` D1 ID + `indexer.vaipakam.com` route (Stage 3 follow-up commit) |
| 3 | Operator | `cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote` (one-time schema apply) |
| 4 | Operator | `wrangler secret put` for the missing secrets per §4.3 + §4.4 (BLOCKAID, ZEROEX, ONEINCH on keeper, etc.) |
| 5 | Operator | `wrangler deploy` for each of `apps/{keeper,indexer,agent}`. This activates crons + binds `indexer.vaipakam.com`. |
| 6 | Operator | Update `apps/defi/.env.local` with `VITE_INDEXER_ORIGIN` + `VITE_AGENT_ORIGIN`; `pnpm build && wrangler deploy` `vaipakam-defi`. |
| 7 | Both | Smoke-test `defi.vaipakam.com` end-to-end against `agent.vaipakam.com` + `indexer.vaipakam.com`, with `KEEPER_ENABLED=false` (alert-only, no autonomous liquidation). |
| 8 | Operator | Flip `KEEPER_ENABLED=true` on `vaipakam-keeper` after the validation window. |
| 9 | Both | Run for N days observing for divergence vs prod. |
| 10 | Both | If green: bind `vaipakam.com` + `www.vaipakam.com` to `vaipakam-labs` (replacing the older `vaipakam` Worker); decommission `vaipakam-hf-watcher` + unbind `api.vaipakam.com`. |
|   |   | If issues: revert (env-var rollback on `vaipakam-defi`); no prod impact. |

## 7. Open questions / known gaps

1. **`indexer.vaipakam.com`** — not yet bound in Cloudflare.
   Goes in alongside the wrangler config patch (§6 step 2).

2. **Bot/push-channel secrets on `vaipakam-agent`** — confirmed
   STAGING tokens (operator verified 2026-05-08).

3. **D1 cost** — running two D1 instances (`vaipakam-alerts-db`
   for prod + `vaipakam-archive` for staging) doubles the
   Workers Free Tier rows quota. Both have retention prunes
   (`CANCELLED_OFFER_RETENTION_DAYS=30`, `DIAG_RETENTION_DAYS=90`)
   so growth is bounded. If quota tightens, lower retention
   on the staging instance further.

4. **`KEEPER_ENABLED`** — set as a non-secret var on
   `vaipakam-keeper` with initial value `"false"`. Flip to
   `"true"` only after §6 step 7's validation window passes.

## 8. Effort

| Stage | Effort |
|---|---|
| §3 Cloudflare provisioning | DONE |
| §6 step 2 (config patch) | 30 min author |
| §6 steps 3-6 (apply + deploy + frontend env flip) | 1 hr operator |
| §6 steps 7-9 (validation window) | N days observation |
| §6 step 10 (cutover) | 30 min operator |
