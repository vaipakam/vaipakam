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
| **vaipakam-agent** | `agent.vaipakam.com` | Proactive notifications (periodic interest pre-notify, push + Telegram), public Farcaster Frame at `/frames/active-loans`, operator services (`/quote/0x`, `/quote/1inch`), Telegram bot webhook (`/tg/webhook`), diagnostics record (`/diag/record`), frontend-facing settings (`/thresholds`, `/link/telegram`). | **NO** (intentional — staging plan §2 contract) |
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
  the retired `BLOCKAID_API_KEY`, see §4.3) are operational secrets but not
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
  diag retention, support-ticket retention
  (`pruneOldSupportTickets`, which ENFORCES the 12-month
  support-ticket deletion promise — disabling or misconfiguring
  this schedule stops that deletion happening).
  (#1651: `buy-watchdog` was scheduled here; #687-A removed it
  with the VPFI buy surface.)
- **Secrets:**
  ```
  RPC_*           — same chains as indexer
  TG_BOT_TOKEN    — STAGING bot token (NOT prod)
  PUSH_CHANNEL_PK — STAGING channel signer (NOT prod)
  ZEROEX_API_KEY  — for /quote/0x proxy
  ONEINCH_API_KEY — for /quote/1inch proxy
  # (#1651: BLOCKAID_API_KEY was listed here for a /scan/blockaid proxy.
  #  ET-001 dropped that proxy — index.ts states there is no transaction-scan
  #  proxy at all; the pre-sign preview is a frontend eth_call. Nothing to set.)
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

### 4.5 How to actually provision the secrets above — two mechanisms

The secrets in §4.1–§4.4 are **not** all created the same way, and the
wrong command completes successfully while leaving the binding empty at
runtime. Check which list a secret is in before running anything.

**(a) Secrets Store entries — everything declared under
`secrets_store_secrets`.** All `RPC_*`, `TG_BOT_TOKEN`,
`PUSH_CHANNEL_PK`, `ZEROEX_API_KEY`, `ONEINCH_API_KEY`,
`OPENSEA_API_KEY`, `DIAG_WALLET_HMAC_KEY`, `KEEPER_PRIVATE_KEY` and the
`ALCHEMY_WEBHOOK_SIGNING_KEY_*` set. These are **account-level** entries
in a Cloudflare Secrets Store, bound into a Worker by store ID + secret
name. `wrangler secret put` does **not** create or populate them — it
creates a separate per-Worker secret that nothing here reads. Use:

```bash
wrangler secrets-store secret create 1e66429d0fa24aa38a27bc05b7bcf63e \
  --name <SECRET_NAME> --scopes workers --remote
```

- `1e66429d0fa24aa38a27bc05b7bcf63e` is the store ID; all three Workers
  (`agent`, `keeper`, `indexer`) bind the **same** store, so a secret is
  created once and every Worker declaring it picks it up.
- `--scopes workers` is required (the flag has no default).
- `--remote` is required — it defaults to `false`, which writes to a
  *local* persistence directory and silently does nothing for a deploy.
- Omit `--value`; wrangler prompts for it. Passing it inline leaves the
  secret in shell history.
- The store is shared, so a secret two Workers declare (e.g. `RPC_BASE`,
  `TG_BOT_TOKEN`) must **not** be created twice.

**(b) Plain per-Worker secrets** (`secret_text`) — ordinary Worker
secrets, not store entries. These *do* use `wrangler secret put`, run
from the owning Worker's directory:

```bash
( cd apps/agent  && wrangler secret put TG_OPS_BOT_TOKEN )
( cd apps/agent  && wrangler secret put TG_OPS_CHAT_ID )
( cd apps/keeper && wrangler secret put KEEPER_ENABLED )   # prompts; enter: true
```

- `TG_OPS_BOT_TOKEN` / `TG_OPS_CHAT_ID` (agent) — non-blocking for the
  rollout: while unset, support-ticket ops-notify skips and tickets
  still land in D1.
- **`KEEPER_ENABLED` (keeper) — blocking for step 8.** Step 8 arms the
  keeper by flipping this, and there is no other mechanism to do so.
  Because it is a secret rather than a var, its value cannot be read
  back from the API or dashboard, so a missed `secret put` is
  indistinguishable from a deliberate "off" — the keeper stays dark and
  step 9's observation window looks quiet while nothing is running
  (#1475).
- `REWARD_REMIT_ENABLED` / `REWARD_COMMIT_ENABLED` (keeper) — same
  mechanism, optional. Both were **absent** on the live Worker as of the
  2026-07-30 readback (the reward passes are dark). Set them only if
  the rollout intends to arm those passes, and only after the keeper EOA
  is authorized on-chain.

> **Do not trust `apps/keeper/wrangler.jsonc`'s comment on these three.**
> It describes them as "operator-managed vars (non-secret config — plain
> `vars`)", but the committed `vars` block contains only
> `TG_BOT_USERNAME`, and `apps/keeper/src/env.ts:76-80` states they are
> `secret_text`. The mechanism above is the one verified against the live
> deployment and recorded in
> [`docs/ops/OffChainRestore.md`](../ops/OffChainRestore.md) ("because
> this document previously guessed, and guessed wrong"). Correcting that
> comment, and the separate question of whether the flags should be
> committed so the arming state is reviewable, is #1465 — not settled
> here.

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
| 4 | Operator | Provision secrets per §4.3 + §4.4 — **two different mechanisms, see §4.5** (NOT BLOCKAID; that proxy does not exist, #1651) |
| 5 | Operator | `wrangler deploy` for each of `apps/{keeper,indexer,agent}`. This activates crons + binds `indexer.vaipakam.com`. |
| 6 | Operator | Update `apps/defi/.env.local` with `VITE_INDEXER_ORIGIN` + `VITE_AGENT_ORIGIN`; `pnpm build && wrangler deploy` `vaipakam-defi`. |
| 7 | Both | Smoke-test `defi.vaipakam.com` end-to-end against `agent.vaipakam.com` + `indexer.vaipakam.com`, with `KEEPER_ENABLED=false` (no autonomous liquidation). NOT fully alert-only: `runDailyOracleSnapshot` signs on `KEEPER_PRIVATE_KEY` alone and will broadcast on staging regardless — if the window must be write-free, remove the keeper's trigger in the Cloudflare dashboard (*Settings → Trigger Events*) — editing `wrangler.jsonc` after step 5 has already deployed the active schedule changes nothing live. Allow for propagation before treating it as stopped; see `apps/keeper/README.md` (#1466). **If you take that path, restore the trigger at the end of this step** — step 8 only flips `KEEPER_ENABLED`, so a Worker left with no schedule would make step 9's observation window look quiet while every pass is in fact disabled. |
| 8 | Operator | Read back the keeper's cron and confirm it is the canonical `* * * * *` from `apps/keeper/wrangler.jsonc` — **not merely that some trigger exists**, since a hand-recreated daily schedule would pass a presence check while exercising the keeper far less than intended, leaving step 9's window just as falsely quiet. Only removed if step 7 took the write-free path. Then flip `KEEPER_ENABLED=true`; the flag alone arms nothing without a schedule to run on. |
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
