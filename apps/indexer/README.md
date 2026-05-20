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

No signing keys ever — read-only by design.

### D1 — owns the canonical schema for `vaipakam-archive` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-archive`** D1 database (id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. This Worker is the **schema owner**: `apps/indexer/migrations/` is the single source of truth for every table the live db holds, even ones only the sibling Workers write to (`apps/keeper` and `apps/agent` both bind to the same database id; neither has its own `migrations/` directory).

Apply migrations from inside this directory:

```bash
wrangler d1 migrations apply vaipakam-archive --local    # local dev
wrangler d1 migrations apply vaipakam-archive --remote   # the staging d1
```

Any schema change — even for a table only keeper or agent writes — lands as a new `apps/indexer/migrations/NNNN_<slug>.sql` file. See [`CLAUDE.md` § "Cloudflare D1 schema discipline"](../../CLAUDE.md) for the convention.

## Related

- `apps/defi` — primary consumer (frontend reads loan / offer data from here).
- `apps/agent` — proactive-notifications Worker; reads from this indexer for stats.
- `apps/keeper` — signing Worker; doesn't read from this surface (uses RPC direct).
- `packages/contracts` — ABI / deployment source.
