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
pnpm --filter @vaipakam/keeper deploy   # via .github/workflows/deploy-workers.yml in CI
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
| `ZEROEX_API_KEY` / `ONEINCH_API_KEY` | Liquidation swap aggregator credentials. |
| `TG_BOT_TOKEN` / `PUSH_CHANNEL_PK` | Alert dispatcher credentials. |

See [`CLAUDE.md` § "Deployments sync"](../../CLAUDE.md) for the full secret list and rotation cadence.

## Related

- `apps/agent` — the proactive-notifications / Frame / Telegram-bot Worker (no signing key).
- `apps/indexer` — the chain-to-D1 indexer (read-only).
- `vaipakam/vaipakam-keeper-bot` (sibling repo) — public reference keeper bot for third-party operators.
- `packages/contracts` — ABI / deployment source.
