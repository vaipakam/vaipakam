# Stage 3 — Operator Worker split (`ops/hf-watcher` → `apps/{agent,indexer,keeper}`)

**Status:** approved 2026-05-08, plan-only (PR1); execution PRs 2-5 follow
**Companion doc:** [`LabsExtractionPlan.md`](./LabsExtractionPlan.md) — Stage 4
covers the customer-facing apps split (defi + labs); this doc covers the
operator-facing Worker split.

## 1. Why this doc exists

The source-tree refactor's Stage 3 splits the existing
`ops/hf-watcher/` Cloudflare Worker — currently a 22-file / ~6 800 LOC
monolith handling **five distinct responsibilities** on a single
Worker — into three focused Workers under `apps/{agent, indexer, keeper}`.

The split unblocks four follow-on changes that are awkward today:

1. **Independent deploy cadences.** Liquidation logic should ship as
   soon as it lands; analytics-pipeline tweaks shouldn't drag the
   liquidator with them. Today every change goes out as one
   `wrangler deploy`.
2. **Resource isolation.** The HF watcher's cron runs every 5 min and
   does heavy RPC fan-out per chain. The indexer's chain-event scan is
   also heavy. The agent's notification/Frame surface is read-mostly
   and HTTP-fronted. Putting them on separate Workers gives each its
   own CPU / memory / sub-request budget and prevents one's spike from
   throttling another.
3. **Failure blast radius.** Today a bug in `chainIndexer.ts` (which
   does the heaviest D1 writes) can wedge the same scheduled tick that
   was supposed to trigger a liquidation. Co-located concerns share
   failure modes; splitting them gives each a clean isolation
   boundary.
4. **Future scope** — the matcher (see §7) — needs its own deploy
   cadence and economics independent of HF / indexing.

## 2. Current state — `ops/hf-watcher/src/`

22 source files / 6 800 LOC, five concerns:

| # | Concern | Files | LOC |
| ---: | --- | --- | ---: |
| 1 | Cron — HF watcher + liquidation | `watcher.ts`, `keeper.ts` | 357 |
| 2 | Cron — proactive notifications + cross-chain monitoring | `periodicPreNotify.ts`, `dailyOracleSnapshot.ts`, `buyWatchdog.ts`, `push.ts`, `telegram.ts`, `i18n.ts` | 1 072 |
| 3 | Chain → D1 indexer + read-API HTTP | `chainIndexer.ts`, `cancelledOfferRetention.ts`, `loanRoutes.ts`, `offerRoutes.ts` | 2 637 |
| 4 | Operator services (quote / scan proxies) | `quoteProxy.ts`, `scanProxy.ts`, `serverQuotes.ts` | 916 |
| 5 | Public Farcaster Frame | `frames.ts` | 446 |

Plus shared infrastructure that every concern reuses:

| Component | Files | LOC |
| --- | --- | ---: |
| Diamond ABI bundle | `diamondAbi.ts`, `abis/` | ≈400 |
| Chain deployment registry | `deployments.ts`, `deployments.json`, `_deployments_source.json` | 72 |
| D1 helpers (thresholds, link codes, query helpers) | `db.ts` | 229 |
| Diagnostic record helpers | `diagRecord.ts` | 385 |
| Typed `Env` shape (D1 + KV + cron bindings) | `env.ts` | 169 |

Worker entry: [`ops/hf-watcher/src/index.ts`](../../ops/hf-watcher/src/index.ts) (495 LOC) wires all five concerns into one `scheduled()` cron + one `fetch()` HTTP handler.

## 3. Target structure

Three Workers, one folder per Worker under `apps/`:

```
apps/keeper/    HF watcher loop + on-chain liquidation triggers
                (cron-driven; small footprint).

apps/indexer/   Chain → D1 sync + HTTP read-API serving the
                connected app's "read from indexer first, fall
                back to chain" data path.

apps/agent/     Everything else — proactive notifications,
                cross-chain monitoring, operator services
                (quote / scan proxies), public Farcaster Frames,
                telegram bot.
```

Each Worker gets its own:
- `wrangler.jsonc` — independent deploy + bindings (D1, KV, secrets, cron triggers)
- `package.json` — its own dependency graph (no transitive bloat from sibling concerns)
- `src/index.ts` — focused entry (`scheduled()` + `fetch()` for the routes that matter to it)

## 4. File-by-file classification

| `ops/hf-watcher/src/<file>` | Lands in | Notes |
| --- | --- | --- |
| `watcher.ts` | `apps/keeper` | HF check loop |
| `keeper.ts` | `apps/keeper` | Liquidation trigger |
| `chainIndexer.ts` | `apps/indexer` | Big, well-isolated |
| `cancelledOfferRetention.ts` | `apps/indexer` | D1 cleanup pass |
| `loanRoutes.ts` | `apps/indexer` | `GET /loans/*` HTTP |
| `offerRoutes.ts` | `apps/indexer` | `GET /offers/*` HTTP |
| `periodicPreNotify.ts` | `apps/agent` | Push before interest payment |
| `dailyOracleSnapshot.ts` | `apps/agent` | Daily price snapshot cron |
| `buyWatchdog.ts` | `apps/agent` | Cross-chain VPFI reconciliation |
| `push.ts` | `apps/agent` | Push channel client |
| `telegram.ts` | `apps/agent` | Telegram bot client |
| `i18n.ts` | `apps/agent` | Notification copy bundle |
| `quoteProxy.ts` | `apps/agent` | `/quote/0x` + `/quote/1inch` |
| `scanProxy.ts` | `apps/agent` | Blockaid scan |
| `serverQuotes.ts` | `apps/agent` | Server-side quote bundling |
| `frames.ts` | `apps/agent` | Public Farcaster Frame |
| `index.ts` | (split into 3 entry files, one per Worker) | Each Worker rebuilds its own `scheduled()` + `fetch()` from the subset that lives there |

## 5. Shared infrastructure approach

Three options were considered:

- **(α) Duplicate** the shared files into each app. Simplest but lets
  ABIs / deployments drift across the three Workers.
- **(β) New shared package** `@vaipakam/cf-shared` (or a split between
  `@vaipakam/contracts` and `@vaipakam/db`). Cleanest separation but
  adds a fourth-or-fifth workspace package whose only consumers are
  the three Workers.
- **(γ) Reuse the existing `@vaipakam/contracts` package for ABIs +
  deployments**, duplicate the small `db.ts` / `diagRecord.ts` /
  `env.ts` into each app since each Worker has its own typed `Env`
  shape (different D1 / KV / cron bindings per Worker).

**Decision: (γ).** `@vaipakam/contracts` already publishes the ABI
bundle and `deployments.json` for both frontend apps; reusing it for
the Workers eliminates the three highest-drift files (`diamondAbi.ts`,
`deployments.ts`, `deployments.json`) from the per-Worker code. The
remaining three files (`db.ts`, `diagRecord.ts`, `env.ts`) total
≈785 LOC and:

- `db.ts` — most helpers are read/write against tables only ONE
  Worker uses (e.g. `thresholds` is keeper-only, `link_codes` is
  agent-only, `loan_index_*` is indexer-only). The shared subset is
  small (one or two helpers); duplicating preserves the natural
  per-Worker scope without a fragile shared-table contract.
- `diagRecord.ts` — diagnostic record schema is shared in CONCEPT but
  each Worker writes its own per-area subset. Splitting per Worker
  pairs the schema definitions with the code that produces them.
- `env.ts` — every Worker has different cron triggers, D1 bindings,
  KV namespaces, and secrets. A typed shared `Env` would be a union
  type that's wrong for every individual Worker; per-Worker copies
  are the right shape.

If a fourth Worker is added later (e.g. an external-API gateway) and
the per-Worker copies start drifting on a shared concept (like a
common HTTP error wrapper), promote that subset to a small shared
package then. Don't pre-build the abstraction.

## 6. Migration sequencing — five PRs

Each PR ends in a working state (every existing endpoint + cron pass
still served somewhere).

### Stage 3 PR1 — plan + shared-lib reference policy

This document. No code moves. Captures the classification + the
`@vaipakam/contracts` reference policy so the next sessions have
a self-contained blueprint.

### Stage 3 PR2 — `apps/keeper`

Move `watcher.ts` + `keeper.ts` into `apps/keeper/src/`. Add the
duplicated subset of `db.ts` / `diagRecord.ts` / `env.ts` it needs.
Wire up `apps/keeper/wrangler.jsonc` with its own cron trigger
(`*/5 * * * *` for the HF check) and D1 / RPC bindings. Replace
the in-Worker imports of `./diamondAbi` etc. with
`@vaipakam/contracts` package imports. Standalone Worker boots
(`pnpm wrangler dev`) and the cron passes. `ops/hf-watcher`
continues to run the same code in parallel — duplication is
intentional during the transition.

### Stage 3 PR3 — `apps/indexer`

Same shape: `chainIndexer.ts`, `cancelledOfferRetention.ts`,
`loanRoutes.ts`, `offerRoutes.ts`. Independent cron (chain-event
scan is its own pass) and HTTP routes. The frontend continues to
call `ops/hf-watcher` for `/loans` / `/offers` reads during the
transition; PR5 flips the cutover.

### Stage 3 PR4 — `apps/agent`

The largest move — every notification / monitoring / proxy /
Frame surface (10 files / ~3 000 LOC). Wires up the multi-cron
schedule (`runPeriodicPreNotify` daily / `runDailyOracleSnapshot`
00:00 UTC / `runBuyWatchdog` every 5 min etc.). Frontend continues
to point at `ops/hf-watcher` for `/quote/*` etc. through the
transition.

### Stage 3 PR5 — decommission `ops/hf-watcher`

After PR2 / PR3 / PR4 have all been validated in production:

- Update the frontend's `wrangler` config / env vars to point at
  the three new Worker URLs (one each for keeper / indexer / agent
  routes).
- Drop the `vaipakam-hf-watcher` Cloudflare Worker.
- Delete `ops/hf-watcher/` from the repo.
- One-time DNS / route swap on Cloudflare so existing webhook
  consumers (Telegram, push channel) hit the new agent Worker.

## 7. Future scope — `apps/keeper` becomes the offer matcher too

Per the user's locked Phase 1 plan ([`RangeOffersDesign.md`](./RangeOffersDesign.md)),
the matcher for **range orders + lender partial fills** is an
**off-chain bot** running in `apps/keeper`. The bot watches the
indexer's offer table for compatible (lender, borrower) pairs that
satisfy the matching matrix in Range design §4 and submits
`matchOffers(lenderId, borrowerId)` on-chain, earning the 1%
matcher fee from the LIF flow.

Implication for this Stage 3 plan: **`apps/keeper` is sized for
"HF watch + liquidate" today but architected for "HF watch +
liquidate + offer match" tomorrow.** Practical consequences:

- Wrangler cron triggers should be loose enough to add a matcher
  pass alongside the HF check (`*/5 * * * *` already covers it;
  a faster matcher-only schedule is a future tweak).
- The duplicated `db.ts` subset for keeper should anticipate
  reading the indexer's `offers` table (cross-Worker D1 read —
  same database, different Worker bindings). Not implemented in
  PR2; the matcher PR adds it later.
- `apps/keeper` package description should mention "HF watch +
  liquidate + offer match" as the eventual scope so the next
  reader knows the surface is sized to grow.

## 8. Two keepers — first-party Worker vs. public reference bot

Worth keeping in mind: there are two distinct keeper deployments,
and Stage 3 is about the FIRST-party one.

| Surface | Repo | Purpose |
| --- | --- | --- |
| **`apps/keeper`** (this Stage 3 work) | This monorepo | Vaipakam's own first-party keeper Worker on Cloudflare. Runs as a single privileged operator with project-funded gas. Will eventually host the offer matcher (§7). Currently runs the HF watcher + liquidation triggers. |
| **`vaipakam-keeper-bot`** | Sibling repo at `~/Codes/Vaipakam/vaipakam-keeper-bot` (per [`CLAUDE.md`](../../CLAUDE.md)) | Public reference implementation of a keeper bot for third-party operators to run themselves. Read-only ABI surface, OSS-licensed, designed for community liquidators. |

They share the contract surface (same `RiskFacet.calculateHealthFactor`
+ `triggerLiquidation` selectors) but have different operational
semantics, deploy targets, and trust assumptions. Don't conflate them.
The keeper-bot ABI sync described in `CLAUDE.md` ("Keeper-bot ABI
sync (Phase 9.A)") applies to the public reference, not to
`apps/keeper`.

## 9. Decisions recorded

- **Three Workers, not five.** Notifications + proxies + Frames go
  together as `apps/agent`; we don't fragment further than the
  natural cron-vs-HTTP-vs-keeper boundaries.
- **`@vaipakam/contracts` for ABIs + deployments**, duplicate the
  rest. No new shared package introduced for `db.ts` / `diagRecord.ts`
  / `env.ts` — see §5.
- **Watcher + keeper on the same Worker.** The HF watcher loop calls
  the keeper's `triggerLiquidation` synchronously when HF crosses
  the threshold; making them separate Workers would require an
  inter-Worker message bus. Keep co-located.
- **Public Farcaster Frame goes to `apps/agent`**, not `apps/indexer`.
  The Frame is "outbound to a third-party social platform" semantically;
  agent is the right home alongside Telegram + push.
- **Quote proxies go to `apps/agent`.** They're operator services,
  not data-read APIs. Indexer hosts data; agent hosts services.
- **`apps/keeper` will host the offer matcher in a future PR**, see §7.
- **Migration is parallel-deploy then cutover** — every PR2-4 ships
  a new Worker that runs alongside `ops/hf-watcher`; PR5 cuts the
  frontend over and deletes the old Worker. No flag flip required.
