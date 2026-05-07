# Cloudflare Staging Deploy Plan

**Status:** Draft, awaiting Cloudflare resource IDs
**Date:** 2026-05-07
**Owner:** Vaipakam protocol team

## 1. Goal

Stand up parallel Worker deployments alongside the existing
production set so this branch's changes can be validated end-to-
end (frontend + indexer + keeper actions) **without touching prod
data**. If the validation goes well, the new workers replace the
existing ones via DNS swap; if not, prod stays unaffected.

## 2. Final naming + responsibility split

| Worker | Domain | What it does |
|---|---|---|
| **vaipakam-labs** (existing or new) | `labs.vaipakam.com` | Marketing site, docs, "Launch App" button |
| **vaipakam-defi** (NEW staging — this branch) | `defi.vaipakam.com` | The dApp itself — wallet connect, offer book, dashboard, etc. |
| **vaipakam-agent** (NEW staging — replaces hf-watcher's read lanes) | `agent.vaipakam.com` | Indexer (chainIndexer.ts), HF alerts, pre-notify, frame rendering, public status page, quote proxy, buy watchdog |
| **vaipakam-keeper** (NEW staging — splits the action lanes) | (no public domain — internal Worker) | Active write-to-chain — HF auto-liquidation, offer auto-matching, daily oracle snapshot, future periodic-interest-settle |

The split between `vaipakam-agent` and `vaipakam-keeper` follows
the **read/index vs write/act** axis. Strict least-privilege:
keeper carries `KEEPER_PRIVATE_KEY` + per-chain RPC URLs; agent
holds NEITHER. A buggy agent produces stale data; a buggy keeper
loses funds — different blast radius justifies different deploy
cadence + reviewer sign-off.

## 3. Cloudflare provisioning (manual — operator action)

### 3.1 Vaipakam-DeFi (frontend)
1. Create Worker: `vaipakam-defi` (Cloudflare dashboard → Workers
   & Pages → Create).
2. Bind static assets: enable **Workers Static Assets**, point at
   `frontend/dist/`.
3. Custom domain: `defi.vaipakam.com` (DNS A/AAAA → Workers
   route in Cloudflare zone).
4. Env vars (Settings → Variables and Secrets):
   - `VITE_DEFAULT_CHAIN_ID=84532` (Base Sepolia testnet)
   - `VITE_BASE_SEPOLIA_RPC_URL=<your provider key>`
   - `VITE_<CHAIN>_RPC_URL=...` for each tracked chain
   - `VITE_WALLETCONNECT_PROJECT_ID=...`
   - `VITE_HF_WATCHER_ORIGIN=https://agent.vaipakam.com`
     (NOTE — points at the new agent worker, NOT the prod
     hf-watcher. Validates the full agent path.)
   - `VITE_BUILD_HASH=<commit hash>` stamped at deploy time.
5. NO secrets here — the frontend bundle is static.

### 3.2 Vaipakam-Agent (read/index lane)
1. Create Worker: `vaipakam-agent`.
2. Custom domain: `agent.vaipakam.com`.
3. Create new D1 database: `vaipakam-alerts-db-v2`. Capture the
   D1 database ID — needed for `wrangler.jsonc` below.
4. Run all schema migrations against the new D1:
   `wrangler d1 migrations apply vaipakam-alerts-db-v2 --remote`
   (with the new wrangler config — see §4 below).
5. Set Worker secrets (Settings → Variables and Secrets →
   Encrypted):
   - `RPC_BASE_SEPOLIA=<provider URL with API key>`
   - `RPC_OP_SEPOLIA=...`
   - `RPC_ARB_SEPOLIA=...`
   - (etc. for every chain)
   - `TG_BOT_TOKEN=<staging bot token, NOT prod>`
   - `PUSH_CHANNEL_PK=<staging key, NOT prod>`
   - `ZEROEX_API_KEY=...`
   - `ONEINCH_API_KEY=...`
   - `BLOCKAID_API_KEY=...`
   - `KEEPER_PRIVATE_KEY` — **NOT SET** (agent doesn't write).
6. Cron triggers: same `* * * * *` schedule as prod hf-watcher
   for the indexer + alerts (the keeper has its own worker).

### 3.3 Vaipakam-Keeper (write/act lane)
1. Create Worker: `vaipakam-keeper`.
2. NO public domain (internal Worker, accessible only via the
   prod operator's deploy/log surface).
3. Reuse the same D1 database bound from `vaipakam-agent` (the
   keeper reads loans/offers/etc. populated by the agent's
   indexer; both workers SHARE the read state but only one
   writes to chain).
4. Set Worker secrets:
   - `KEEPER_PRIVATE_KEY=<staging keeper key, NOT prod>`
   - `KEEPER_ENABLED=false` (initially — flip to `true` after
     validation; flipping is a separate manual step gated on
     trust).
   - `RPC_*` per chain (same shape as agent).
5. Cron triggers: `*/5 * * * *` (every 5 min for HF watch) +
   `0 0 * * *` (00:00 UTC daily for oracle snapshot). Less
   frequent than the agent because keeper actions are the
   write path.

## 4. Wrangler config changes (in-repo — author action)

The current monorepo has ONE `ops/hf-watcher/wrangler.jsonc`. The
split needs:

```
ops/
  agent/
    wrangler.jsonc                # the new agent worker
    src/                          # carved out — read/index lanes
  keeper/
    wrangler.jsonc                # the new keeper worker
    src/                          # carved out — write lanes
  hf-watcher/                     # unchanged — keeps prod alive
    wrangler.jsonc
    src/
```

Splitting the source tree happens in a follow-up PR; for the
INITIAL staging deploy we can use ENV-VAR-gated mode flags inside
the existing `hf-watcher` codebase:

```
ops/hf-watcher/
  wrangler.jsonc          # prod (existing)
  wrangler.staging.jsonc  # NEW — points at vaipakam-agent + new D1
  wrangler.keeper.jsonc   # NEW — points at vaipakam-keeper
```

Each staging config:
- Points at the new D1 ID
- Sets a `WORKER_LANE` env var: `'agent'` or `'keeper'`
- Source-side: `index.ts:scheduled` checks `WORKER_LANE` and skips
  passes that don't belong to the lane (e.g. agent skips
  `runHFKeeper`, keeper skips `runChainIndexer`).

This lane-flag approach is cheap (~30 LoC) and lets us ship the
staging deploy on the existing source tree before the source
split lands.

## 5. Rollout sequence

| Step | Owner | What happens |
|---|---|---|
| 1 | Operator | Provision Cloudflare resources per §3.1–3.3 |
| 2 | Operator | Send Worker IDs + D1 ID + custom-domain status |
| 3 | Author | Land `wrangler.staging.jsonc` + `wrangler.keeper.jsonc` + `WORKER_LANE` gating in source |
| 4 | Operator | `wrangler deploy --config wrangler.staging.jsonc` (agent) and `wrangler.keeper.jsonc` (keeper) |
| 5 | Author | Build + deploy `frontend` to `vaipakam-defi` (`npm run build && wrangler deploy`) |
| 6 | Both | Validate `defi.vaipakam.com` end-to-end against `agent.vaipakam.com`'s D1 + RPC, with `KEEPER_ENABLED=false` |
| 7 | Operator | Flip `KEEPER_ENABLED=true` on `vaipakam-keeper` after the validation window |
| 8 | Both | Run for N days observing for divergence vs prod |
| 9 | Both | If green: DNS-swap `app.vaipakam.com → vaipakam-defi`; rename `hf-watcher` Cloudflare worker to retiree status; promote `vaipakam-agent`+`vaipakam-keeper` to prod |
| | | If issues: revert, no prod impact |

## 6. Open questions for sign-off

1. **`labs.vaipakam.com` already exists?** If yes, no Worker
   change needed for §3.1 — the "Launch App" button just gets a
   target update. If no, separate provisioning step.
2. **Frontend ENV target** — staging points at testnet diamonds
   (Base Sepolia / OP Sepolia / Arb Sepolia) or at mainnet?
   Recommend testnet to keep validation cheap; mainnet target
   reserved for the cutover commit.
3. **Bot/push-channel secrets** — fresh staging tokens or share
   prod? Recommend FRESH staging — a dev-time Push send to prod
   subscribers would be embarrassing.
4. **D1 cost** — running two D1 instances (`-prod` + `-v2`) doubles
   the Workers Free Tier rows quota. If the budget is tight,
   schedule a prune of the `-v2` DB once a week or limit retention
   on the agent's `activity_events` table.

## 7. Estimated effort

| Stage | Effort |
|---|---|
| §3 Cloudflare provisioning | 1–2 hr operator |
| §4 wrangler-config split + lane gating | 2–3 hr author |
| §5 staged validation | 1–N days observation |
| Source-tree split (follow-up PR) | 1 day author |

---

**Awaiting:** §3 provisioning IDs from operator, then §4 author
work.
