# @vaipakam/keeper

**Vaipakam's first-party autonomous keeper — Cloudflare Worker. Cron-driven, no HTTP surface, holds `KEEPER_PRIVATE_KEY`.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **signing Worker** of the Vaipakam off-chain stack. Stage 3 PR2 + architectural-rebalance commit (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)) split the original monolith and concentrated all on-chain-writing responsibility here. The signing key lives on exactly one Worker — this one. (Staging plan §2 least-privilege contract.)

Today this Worker does:

- **HF watcher loop** — periodic Health Factor scan across active loans on every chain it covers.
- **Autonomous on-chain liquidation submission** — when HF < 1.0, submits `triggerLiquidation` via the configured swap aggregator.
- **HF band-downgrade alerts** — fires Telegram + Push notifications when borrower HF crosses watcher-defined thresholds.
- **Daily oracle snapshot signer** — submits `OracleFacet.captureDailyPriceSnapshot` (moved here from agent in the rebalance).

Tomorrow (per [`RangeOffersDesign.md`](../../docs/DesignsAndPlans/RangeOffersDesign.md) §7 of the Stage 3 plan): adds the off-chain offer matcher for Range Orders + Lender Partial Fills, submitting `matchOffers(lenderId, borrowerId)` to earn the 1% LIF matcher fee.

**Non-goals:** no user-facing reads (those belong to `apps/indexer`); no notifications setup endpoints (those belong to `apps/agent`); no public Frame / Telegram bot surface (also `apps/agent`).

**Important:** this Worker is **distinct from the public reference keeper bot** at the sibling [`vaipakam-keeper-bot`](https://github.com/vaipakam/vaipakam-keeper-bot) repo. That one is for third-party operators who want to run their own keeper. This one is the project's own and the only privileged Worker.

## How to run

```bash
pnpm --filter @vaipakam/keeper dev      # local wrangler dev (no live txs)
pnpm --filter @vaipakam/keeper deploy   # wrangler deploy; uses `wrangler login` on the operator's machine
```

## How to test

```bash
pnpm --filter @vaipakam/keeper typecheck
pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit
```

## Architecture

- Worker split design: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Matcher roadmap: [`docs/DesignsAndPlans/RangeOffersDesign.md`](../../docs/DesignsAndPlans/RangeOffersDesign.md).
- ADR-0006 (Three-tier CI split): [`docs/adr/0006-three-tier-ci-split.md`](../../docs/adr/0006-three-tier-ci-split.md) — how this Worker's deploys gate.

## Configuration

Cloudflare Worker secrets (set via `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `KEEPER_PRIVATE_KEY` | The signing key. Holds funds; rotate per the AdminKeysAndPause runbook. |
| `RPC_*` | Per-chain RPC URLs (carry API keys). |
| `KEEPER_ENABLED` | Master kill-switch; set to `false` to disable autonomous actions. |
| `REWARD_REMIT_ENABLED` | Arms the #776 reward-budget remittance pass (in addition to `KEEPER_ENABLED`). Keep off until the keeper EOA is authorized on-chain via `setRewardRemittanceKeeper` (or is ADMIN). |
| `REWARD_REMIT_LOOKBACK_DAYS` | Recent-day window the remit pass re-scans for un-remitted budget each tick (default `45`). |
| `REWARD_REMIT_LANE_CAP` | Per-send VPFI ceiling (wei) — the `perRemittanceCap` + greedy batch bound. Must be ≤ the provisioned reward-budget CCIP lane bucket and ≥ the largest single-day slice (#918). Default `50000e18` (matches the on-chain lane default). |
| `ZEROEX_API_KEY` / `ONEINCH_API_KEY` | Liquidation swap aggregator credentials. |
| `TG_BOT_TOKEN` / `PUSH_CHANNEL_PK` | Alert dispatcher credentials. |

See [`CLAUDE.md` § "Deployments sync"](../../CLAUDE.md) for the full secret list and rotation cadence.

### D1 — shared `vaipakam-archive` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-archive`** D1 database (id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. The same db is **shared** with `apps/indexer` and `apps/agent`.

Keeper writes: `user_thresholds`, `notify_state`, `telegram_links`, `liquidity_confidence`, `oracle_snapshot_state`, `hf_band_state` + `notifications` (#1213 PR 2b — the liquidator pass files HF-band inbox rows into the same feed table the indexer's event/calendar producers use; migration 0041).
Keeper reads-only: `loans`, `offers`, `indexer_cursor` (the head-block stamp for HF-band rows).

**There is no `apps/keeper/migrations/` directory by design.** The canonical schema for every table this Worker touches lives in [`apps/indexer/migrations/`](../indexer/migrations/) — the indexer owns the schema, the other two Workers share the database. Schema changes for tables only keeper writes still land as a new `apps/indexer/migrations/NNNN_*.sql` file; applying it via `wrangler d1 migrations apply vaipakam-archive --remote` from inside `apps/indexer/` updates the live staging db for all three consumers.

## Related

- `apps/agent` — the proactive-notifications / Frame / Telegram-bot Worker (no signing key).
- `apps/indexer` — the chain-to-D1 indexer (read-only).
- `vaipakam/vaipakam-keeper-bot` (sibling repo) — public reference keeper bot for third-party operators.
- `packages/contracts` — ABI / deployment source.
