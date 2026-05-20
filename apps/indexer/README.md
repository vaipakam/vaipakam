# @vaipakam/indexer

**Vaipakam chain → D1 indexer + public read-API. Cloudflare Worker. Read-only — no signing keys.**

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **read-API Worker** of the Vaipakam off-chain stack. Stage 3 PR3 of the Worker split (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)). Two responsibilities:

- **Cron-driven event scan** — pulls Offer / Loan / VPFI / NFT lifecycle events from every chain into D1, round-robin per chain. Includes a cancelled-offer retention prune.
- **HTTP-fronted read-API** (open CORS, T-041):
  - `/offers/{stats,active,recent,by-creator/:addr,:offerId}`
  - `/loans/{active,recent,stats,timeseries,by-lender/:addr,by-borrower/:addr,:loanId}`
  - `/activity`
  - `/claimables/:addr`

The connected app (`apps/defi`) reads from this Worker via `VITE_INDEXER_ORIGIN`. The marketing site (`apps/www`) doesn't talk to it — `apps/www` is on-chain-read-free.

**Non-goals:** no signing keys, no user-facing writes. Reads only. If a request needs to write state on-chain, route it through the connected app + a wallet signature, not through this Worker. The indexer's role is to be the queryable view layer, not an action surface.

**Indexer event-coverage guardrail.** `EVENT_ABI` is derived from the compiled `DIAMOND_ABI_VIEM` (never hand-typed). The `apps/indexer/scripts/check-event-coverage.mjs` script (wired into `pnpm typecheck` and exposed as `check-event-coverage`) fails CI if any contract event tagged `@custom:event-category state-change/{loan,offer}-mutation` lacks a handler in `chainIndexer.ts` AND isn't in the deliberately-not-handled allowlist. The May-2026 "every loan stuck active" bug (indexer missing preclose / offset / refinance terminal events) can't recur silently.

## How to run

```bash
pnpm --filter @vaipakam/indexer dev       # local wrangler dev against testnet
pnpm --filter @vaipakam/indexer deploy    # wrangler deploy; uses `wrangler login` on the operator's machine
```

## How to test

```bash
pnpm --filter @vaipakam/indexer typecheck
pnpm --filter @vaipakam/indexer exec tsc -p . --noEmit
pnpm --filter @vaipakam/indexer check-event-coverage
```

## Architecture

- Stage 3 Worker split: [`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md).
- Event-routing audit: [`scripts/check-event-coverage.mjs`](scripts/check-event-coverage.mjs).
- Public read-API contract: T-041 (see release notes).

## Configuration

Worker secrets:

| Secret | Purpose |
|---|---|
| `RPC_*` | Per-chain RPC URLs (carry API keys). |

D1 binding: `DB` (Cloudflare D1 instance per environment).

No signing keys ever — read-only by design.

## Related

- `apps/defi` — primary consumer (frontend reads loan / offer data from here).
- `apps/agent` — proactive-notifications Worker; reads from this indexer for stats.
- `apps/keeper` — signing Worker; doesn't read from this surface (uses RPC direct).
- `packages/contracts` — ABI / deployment source.
