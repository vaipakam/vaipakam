# @vaipakam/agent

**Proactive notifications + operator-side service Worker. Holds aggregator + push + bot credentials. NO signing key — by design.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **proactive-notifications + public-Frame + operator-services Worker**. Stage 3 PR4 of the Worker split (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)). Four responsibilities:

- **Proactive notifications** — periodic interest pre-notify; Push + Telegram dispatchers (`PUSH_CHANNEL_PK` + `TG_BOT_TOKEN`).
<!-- #1651: a "Cross-chain monitoring — buy-watchdog reconciliation across the CCIP buy flow" bullet stood here. #687-A removed that surface and its watchdog, and this Worker has no other cross-chain-monitoring concern, so the responsibility is gone rather than renamed. -->
- **Public Farcaster Frame** — `/frames/active-loans` GET + POST + image rendering.
- **Operator services** — server-side aggregator quote proxies at `/quote/{0x,1inch}`. (#1651: a Blockaid scan proxy at `/scan/blockaid` was listed here; ET-001 dropped it — `index.ts` documents that no transaction-scan proxy exists and the pre-sign preview is a frontend `eth_call`.)
- **Frontend-facing endpoints** — Telegram-bot webhook `/tg/webhook`; diagnostics record capture `/diag/record`; settings endpoints `/thresholds PUT` + `/link/telegram POST`; support-ticket capture `/support/ticket POST` (#1040 phase 1 — D1 row + ops-Telegram notify via `TG_OPS_BOT_TOKEN`/`TG_OPS_CHAT_ID`, plain `wrangler secret put` secrets; while unset the notify skips and tickets still land in D1).

**This Worker holds no ON-CHAIN transaction key.** The Stage 3 architectural-rebalance moved `KEEPER_PRIVATE_KEY` (and the daily oracle snapshot signer it powered) to `apps/keeper`, so this Worker **can't move funds** — that part of the staging plan §2 contract holds.

Two things it used to say alongside that are **withdrawn**:

- **"holds no ON-CHAIN transaction key (it does hold `PUSH_CHANNEL_PK`, a real Ethereum key used to sign Push notifications)"** — `PUSH_CHANNEL_PK` is an Ethereum private key, instantiated as an ethers `Wallet` in `src/push.ts` to sign Push notifications as the channel. No on-chain authority, but real signing material a secret reviewer must not skip.
- **"a compromised agent produces stale data"** — it deletes diagnostics and support records on a schedule (`pruneOldSupportTickets` enforces the 12-month deletion promise), writes `loans`, sends Push/Telegram to real users, and publishes listings via `/opensea/listing`. A defect or compromise here means data loss, mis-sent notifications, and irreversible upstream publication — and, via the shared database-scoped D1 binding, corruption of state the signing Worker acts on (#1722). Not stale data.

**Non-goals:** no autonomous on-chain submissions (those belong to `apps/keeper`); no chain-event indexing into D1 (that belongs to `apps/indexer`); no ON-CHAIN submissions (it does expose user-facing writes: `PUT /thresholds`, `POST /link/telegram`, `POST /support/ticket`, and the diagnostics endpoints all mutate D1 or external state, so they carry real auth + rate-limit requirements) (writes happen via the connected app + a wallet signature).

## How to run

```bash
pnpm --filter @vaipakam/agent dev       # local wrangler dev
pnpm --filter @vaipakam/agent run deploy    # wrangler deploy; uses `wrangler login` on the operator's machine
```

## How to test

```bash
pnpm --filter @vaipakam/agent typecheck
pnpm --filter @vaipakam/agent exec tsc -p . --noEmit
```

## Architecture

- Stage 3 Worker split: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Staging plan §2 least-privilege contract — the load-bearing reason this Worker holds no signing key.
- ADR-0004 (CCIP migration) — cross-chain context. (#1651: previously cited for the buy-watchdog responsibility, removed with #687-A.)

## Configuration

Worker `wrangler.jsonc:vars`:

- `FRONTEND_ORIGIN`, `TG_BOT_USERNAME`, `DIAG_*` knobs.

Worker secrets (via `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `RPC_*` | Per-chain RPC URLs (carry API keys). |
| `TG_BOT_TOKEN` | Telegram bot credential (user-facing bot). |
| `TG_OPS_BOT_TOKEN` | Ops-internal bot credential — instant new-support-ticket alert (#1040 phase 1). While unset the alert skips (warn-logged) and tickets still land in D1; the nightly ops report's open-ticket count is the backstop. |
| `TG_OPS_CHAT_ID` | Operator chat the ops bot posts to. Same skip-while-unset behaviour. |
| `PUSH_CHANNEL_PK` | Push channel signing key (not a chain key — a push protocol identity). |
| `ZEROEX_API_KEY` / `ONEINCH_API_KEY` | Aggregator quote proxy credentials. |

No `KEEPER_PRIVATE_KEY` here — that's `apps/keeper` exclusively.

### D1 — shared `vaipakam-archive` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-archive`** D1 database (id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. The same db is **shared** with `apps/indexer` and `apps/keeper`.

Agent writes: `user_thresholds`, `notify_state`, `telegram_links`, `loans`, `diag_errors`, `diag_legal_holds`, `diag_legal_hold_audit`, `support_tickets` (#1040 phase 1 — `POST /support/ticket`).
Agent reads-only: (none — every table the agent reads, it also writes.)

**There is no `apps/agent/migrations/` directory by design.** The canonical schema for every table this Worker touches lives in [`apps/indexer/migrations/`](../indexer/migrations/) — the indexer owns the schema, the other two Workers share the database. Schema changes for tables only agent writes still land as a new `apps/indexer/migrations/NNNN_*.sql` file; applying it via `wrangler d1 migrations apply vaipakam-archive --remote` from inside `apps/indexer/` updates the live staging db for all three consumers.

## Related

- `apps/keeper` — sibling signing Worker; this one defers all on-chain submissions to it.
- `apps/indexer` — sibling read-API Worker; this Worker reads from there for stats it doesn't compute locally.
- `apps/defi` — primary consumer of `/quote/*`, `/diag/record`, `/thresholds`, `/link/telegram`.
- `packages/contracts` — ABI / deployment source.
