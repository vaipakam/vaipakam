# @vaipakam/indexer

**Vaipakam chain → D1 indexer + public read-API. Cloudflare Worker. No ON-CHAIN transaction key — but NOT keyless and NOT read-only** (writes D1; publishes borrower-authorised, on-chain-bound Seaport listings to OpenSea).

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

The connected app (`apps/app`) reads from this Worker via `VITE_INDEXER_ORIGIN`.

The marketing site (`apps/www`) reads exactly one route: `/config/:chainId`, for the fee and tier figures quoted in its documentation (#1612). `apps/www` remains **on-chain-read-free** — it carries no wallet, no viem and no ABI, and this snapshot is precisely how it states current figures without any of that. Treat that route as having a marketing-site consumer when changing its shape, its CORS policy, or its availability: `apps/www` bounds the request at 4 s and falls back to bundled defaults, so an outage degrades rather than breaks it, but a silent change to the bundle's field ORDER would publish wrong numbers under a "live" badge.

**Non-goals:** no on-chain transaction key, and no *on-chain* writes. (Not "no signing keys": the three `ALCHEMY_WEBHOOK_SIGNING_KEY_*` entries are **HMAC** secrets. HMAC is symmetric, so holding one permits **forging** a valid webhook signature, not merely verifying — they are signing material.) If a request needs to write state on-chain, route it through the connected app + a wallet signature, not through this Worker.

This is narrower than "reads only", which this file used to claim and which is false: the Worker writes the shared D1 database (including via three POST endpoints) and publishes borrower-authorised Seaport orders to OpenSea with the project's API key (empty `0x` signature — the vault's ERC-1271 check validates an order hash the borrower bound on-chain, so the Worker cannot manufacture a listing). Note also that holding no signing key is **not** an isolation boundary — the D1 binding is database-scoped, so this Worker can write tables the signing Worker reads (see #1722).

**Indexer event-coverage guardrail.** `EVENT_ABI` is derived from the compiled `DIAMOND_ABI_VIEM` (never hand-typed). The `apps/indexer/scripts/check-event-coverage.mjs` script (wired into `pnpm typecheck` and exposed as `check-event-coverage`) fails CI if any contract event tagged `@custom:event-category state-change/{loan,offer}-mutation` lacks a handler in `chainIndexer.ts` AND isn't in the deliberately-not-handled allowlist. The May-2026 "every loan stuck active" bug (indexer missing preclose / offset / refinance terminal events) can't recur silently.

## How to run

```bash
pnpm --filter @vaipakam/indexer dev       # local wrangler dev against testnet
pnpm --filter @vaipakam/indexer run deploy    # applies D1 migrations, then wrangler deploy; uses `wrangler login` on the operator's machine
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
| `RPC_*` (eleven) | Per-chain RPC URLs — **carry provider API keys**, so they are leakable, billable credentials, not just endpoints. Eleven BOUND, which is not the same as eleven reached: `getChainConfigs` needs BOTH an RPC value and a `getDeployment` hit, and `deployments.json` holds only 97 / 84532 / 421614 — so at most **three** are reachable today; the rest are provisioned ahead of their deployments. Nor is it the full bound set — the agent additionally binds `RPC_POLYGON` (twelve); the keeper binds neither Polygon entry (ten). Count from `wrangler.jsonc`'s `secrets_store_secrets` block: the `Env` interface also declares `RPC_ZKEVM`, which no Worker binds. |
| `OPENSEA_API_KEY` | Authenticated **outbound publication** of borrower-authorised, on-chain-bound Seaport listings. A write credential upstream, not a read key. |
| `ALCHEMY_WEBHOOK_SIGNING_KEY_84532` | HMAC secret for inbound Base-Sepolia chain-event webhooks. **Symmetric — holding it permits forging a delivery, not just verifying one.** |
| `ALCHEMY_WEBHOOK_SIGNING_KEY_421614` | Same, Arbitrum Sepolia. |
| `ALCHEMY_WEBHOOK_SIGNING_KEY_97` | Same, BNB testnet — **live**, not ahead-of-rollout. Chain 97 is in `.active-chains` and the deployments bundle, and `CHAIN_INGEST_VIA_DO` is on, so this key gates a real ingest path and needs the same monitoring and rotation as the other two. |

**Fifteen bindings in total.** This table used to list only `RPC_*` and
close with "No signing keys ever — read-only by design", which
undercounted the credential surface by four and asserted a read-only
property the Worker does not have.

No **on-chain signing** key — that part is true, and it is the only part
that was. It is not an isolation boundary: the D1 binding is
database-scoped, so this Worker can write tables the signing Worker
reads (#1722).

### D1 — owns the canonical schema for `vaipakam-warm` (staging)

The `DB` binding in `wrangler.jsonc` points at the **`vaipakam-warm`** D1 database (id `e5e927cf-56c3-42c7-9820-179a235cc84f`), the **staging** database the Cloudflare staging deploy uses — see [`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](../../docs/DesignsAndPlans/CloudflareStagingDeployPlan.md) §3 for the staging-vs-primary split. This Worker is the **schema owner**: `apps/indexer/migrations/` is the single source of truth for every table the live db holds, even ones only the sibling Workers write to (`apps/keeper` and `apps/agent` both bind to the same database id; neither has its own `migrations/` directory).

Apply migrations from inside this directory:

```bash
wrangler d1 migrations apply vaipakam-warm --local    # local dev
wrangler d1 migrations apply vaipakam-warm --remote   # the staging d1
```

Any schema change — even for a table only keeper or agent writes — lands as a new `apps/indexer/migrations/NNNN_<slug>.sql` file. See [`CLAUDE.md` § "Cloudflare D1 schema discipline"](../../CLAUDE.md) for the convention.

### Migrations before code — the deploy order and the schema gate (#2214)

**`pnpm run deploy` applies pending migrations to `vaipakam-warm` (the `migrate` script), then publishes — and publishes only if the apply succeeded.** It runs `scripts/migrate-then-deploy.mjs`, and the deploy scripts' Worker phases call the package scripts, so the order is defined once. **The keeper and agent bind the same database**, so their `deploy` scripts run the same wrapper: whichever Worker an operator publishes first, the schema lands before any code that uses it. A run that publishes nothing (`--dry-run`, `--help`) applies nothing either — pnpm appends `run` arguments to the end of a script, so a plain `migrate && wrangler deploy` would have migrated the remote database on a dry run. (They used to publish first and migrate second, which left new code running against the old schema for the length of the gap — unboundedly, if the migration step failed. #1149 was that window: every scan failed `no such column` and the cursor held until someone read the logs.)

**This Worker also auto-deploys on every merge to `main` through Cloudflare Workers Builds, and that route's deploy command is dashboard configuration this repository cannot see or pin.** If it runs plain `wrangler deploy`, it publishes without migrating. For that route — and any other that skips the package script — the Worker carries a **schema gate** (`src/schemaGate.ts`):

- `src/requiredMigrations.ts` lists EVERY file in `migrations/`; `scripts/check-schema-gate.mjs` (part of `typecheck`) fails CI unless the list equals the directory exactly. The whole set rather than the newest file, because a migration filling a numbering gap sorts below the newest (#2409 r1).
- Until all of them are recorded in `d1_migrations`, every cron tick and every chain pass (DO alarm or legacy inline) **declines** with a log line naming the missing migrations and the command that applies them. No scan, no prune, no sweep, no cursor movement.
- On the first tick after the migration is applied, ingest resumes by itself — no redeploy, no cursor repair. The app's existing freshness surface shows the pause as stale data in the meantime.
- **The gate does not cover the HTTP read API.** A route reading a column the database does not have yet still fails until the migration lands, so a feature adding such a read must tolerate the older schema itself (or ship its read after its migration).

- **The keeper and agent carry no gate yet** — their package deploys migrate first, but their Workers Builds auto-deploy is unguarded. Tracked in #2410.

**Recommended Workers Builds setting (operator, Cloudflare dashboard → Worker → Settings → Builds):** deploy command `pnpm run deploy`, with a build token that carries **D1 Edit** on the account. That makes the auto-deploy migrate first too, and the gate becomes a backstop rather than the mechanism. Until it is set, a merge that adds a migration pauses scheduled ingest until someone runs the apply.

## Related

- `apps/app` — primary consumer (frontend reads loan / offer data from here).
- `apps/agent` — proactive-notifications Worker; reads from this indexer for stats.
- `apps/keeper` — signing Worker; doesn't read from this surface (uses RPC direct).
- `packages/contracts` — ABI / deployment source.
