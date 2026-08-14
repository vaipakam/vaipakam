# @vaipakam/indexer

**Vaipakam chain → D1 indexer + public read-API. Cloudflare Worker. No signing keys — but NOT read-only** (writes D1; publishes signed Seaport listings to OpenSea).

[![Workspaces typecheck](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vaipakam/vaipakam/actions/workflows/ci.yml)

## What is this

The **read-API Worker** of the Vaipakam off-chain stack. Stage 3 PR3 of the Worker split (see [Stage3WorkerSplitPlan.md](../../docs/DesignsAndPlans/Stage3WorkerSplitPlan.md)). Two responsibilities:

- **Cron-driven event scan** — pulls Offer / Loan / VPFI / NFT lifecycle events from every chain into D1, round-robin per chain. Includes a cancelled-offer retention prune.
- **HTTP-fronted read-API** (open CORS, T-041):
  - `/offers/{stats,active,recent,by-creator/:addr,:offerId}`
  - `/loans/{active,recent,stats,timeseries,by-lender/:addr,by-borrower/:addr,:loanId}`
  - `/activity`
  - `/claimables/:addr`
  - `/config/:chainId` — the governance-knob display snapshot

The connected app (`apps/defi`) reads from this Worker via `VITE_INDEXER_ORIGIN`.

The marketing site (`apps/www`) reads exactly one route: `/config/:chainId`, for the fee and tier figures quoted in its documentation (#1612). `apps/www` remains **on-chain-read-free** — it carries no wallet, no viem and no ABI, and this snapshot is precisely how it states current figures without any of that. Treat that route as having a marketing-site consumer when changing its shape, its CORS policy, or its availability: `apps/www` bounds the request at 4 s and falls back to bundled defaults, so an outage degrades rather than breaks it, but a silent change to the bundle's field ORDER would publish wrong numbers under a "live" badge.

**Non-goals:** no signing keys, and no *on-chain* writes. If a request needs to write state on-chain, route it through the connected app + a wallet signature, not through this Worker.

This is narrower than "reads only", which this file used to claim and which is false: the Worker writes the shared D1 database (including via three POST endpoints) and publishes borrower-signed Seaport orders to OpenSea with the project's API key. Note also that holding no signing key is **not** an isolation boundary — the D1 binding is database-scoped, so this Worker can write tables the signing Worker reads (see #1722).

**Indexer event-coverage guardrail.** `EVENT_ABI` is derived from the compiled `DIAMOND_ABI_VIEM` (never hand-typed). The `apps/indexer/scripts/check-event-coverage.mjs` script (wired into `pnpm typecheck` and exposed as `check-event-coverage`) fails CI if any contract event tagged `@custom:event-category state-change/{loan,offer}-mutation` lacks a handler in `chainIndexer.ts` AND isn't in the deliberately-not-handled allowlist. The May-2026 "every loan stuck active" bug (indexer missing preclose / offset / refinance terminal events) can't recur silently.

## How to run

```bash
pnpm --filter @vaipakam/indexer dev       # local wrangler dev against testnet
pnpm --filter @vaipakam/indexer run deploy    # wrangler deploy; uses `wrangler login` on the operator's machine
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
| `RPC_*` (eleven) | Per-chain RPC URLs — **carry provider API keys**, so they are leakable, billable credentials, not just endpoints. Eleven, not the full chain set: `RPC_POLYGON` is bound by the agent but not here. |
| `OPENSEA_API_KEY` | Authenticated **outbound publication** of signed Seaport listings. A write credential upstream, not a read key. |
| `ALCHEMY_WEBHOOK_SIGNING_KEY_84532` | HMAC verification of inbound Base-Sepolia chain-event webhooks. |
| `ALCHEMY_WEBHOOK_SIGNING_KEY_421614` | Same, Arbitrum Sepolia. |
| `ALCHEMY_WEBHOOK_SIGNING_KEY_97` | Same, BNB testnet (configured ahead of BNB going live). |

**Fifteen bindings in total.** This table used to list only `RPC_*` and
close with "No signing keys ever — read-only by design", which
undercounted the credential surface by four and asserted a read-only
property the Worker does not have.

No **on-chain signing** key — that part is true, and it is the only part
that was. It is not an isolation boundary: the D1 binding is
database-scoped, so this Worker can write tables the signing Worker
reads (#1722).

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
