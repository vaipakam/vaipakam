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
4. **The matcher** (see §7) — was to have its own deploy cadence and
   economics independent of HF / indexing. It has since SHIPPED on
   `apps/keeper`, but **this requirement was abandoned in the process, not
   met**: `runMatcher` is invoked from the same `scheduled()` handler and
   the same `* * * * *` trigger as the HF passes, so it has neither an
   independent deployment nor an independent schedule. The coupling is
   real — a matcher fault shares a tick with liquidation — and is recorded
   here rather than presented as satisfied.

## 2. Current state — `ops/hf-watcher/src/`

22 source files / 6 800 LOC, five concerns.

**This inventory is a snapshot of the monolith as it stood at split
time and is left unedited on purpose** — it is the sizing evidence the
split decision rested on. Two of the files it names have since been
deleted: `buyWatchdog.ts` (#687-A) and `scanProxy.ts` (PR #41). Do not
read this table as a description of any current Worker — and note that
the destination mapping in §4 is not one either; it records where each
file was routed at split time, annotated with what changed since.

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
| `dailyOracleSnapshot.ts` | `apps/keeper` | Signs `OracleFacet.captureDailyPriceSnapshot`. Co-located with `keeper.ts` because it's the second `KEEPER_PRIVATE_KEY` consumer — staging plan §2 says the signing key lives on exactly one Worker. (Initially planned for agent; moved in the architectural-rebalance commit before Stage 3 cutover.) |
| `chainIndexer.ts` | `apps/indexer` | Big, well-isolated |
| `cancelledOfferRetention.ts` | `apps/indexer` | D1 cleanup pass |
| `loanRoutes.ts` | `apps/indexer` | `GET /loans/*` HTTP |
| `offerRoutes.ts` | `apps/indexer` | `GET /offers/*` HTTP |
| `periodicPreNotify.ts` | `apps/agent` | Push before interest payment |
| `buyWatchdog.ts` | `apps/agent` | Cross-chain VPFI reconciliation — **deleted since (#687-A)** |
| `push.ts` | `apps/agent` | Push channel client — **also copied to `apps/keeper`** |
| `telegram.ts` | `apps/agent` | Telegram bot client — **also copied to `apps/keeper`** |
| `i18n.ts` | `apps/agent` | Notification copy bundle — **also copied to `apps/keeper`** |
| `quoteProxy.ts` | `apps/agent` | `/quote/0x` + `/quote/1inch` |
| `scanProxy.ts` | `apps/agent` | Blockaid scan — **deleted since (PR #41)** |
| `serverQuotes.ts` | `apps/agent` | Server-side quote bundling — **now at `apps/keeper/src/serverQuotes.ts`** |
| `frames.ts` | `apps/agent` | Public Farcaster Frame |
| `index.ts` | (split into 3 entry files, one per Worker) | Each Worker rebuilds its own `scheduled()` + `fetch()` from the subset that lives there |

**This table is the Stage-3 migration classification — where each
monolith file was routed at split time. It is NOT a current map of any
Worker's surface, and must not be read as one.** Every original row is
kept; what changed afterwards is annotated in place:

- **`buyWatchdog.ts`** — deleted with the #687-A VPFI purchase excision.
  What went with it is the watchdog for the **retired fixed-rate
  cross-chain BUY flow**, and nothing else. Cross-chain VPFI
  reconciliation very much still exists on `apps/keeper`:
  `remitAck.ts` walks Base-side remittance reservations, checks each
  Pending one against the destination mirror's delivery state, and sends
  the finalizing ack from the mirror; `rewardBudgetRemit.ts` and
  `commitmentReport.ts` are scheduled alongside it. An earlier version
  of this bullet said "no cross-chain VPFI reconciliation pass exists on
  any Worker", which would have led a reader to believe an active
  reconciliation path had been removed.
- **`scanProxy.ts`** — deleted in PR #41. The pre-sign transaction
  preview began as Blockaid, briefly became a GoPlus proxy, and is now a
  frontend-only viem `eth_call` (`apps/app/src/contracts/useTxSimulation.ts`;
  it was `apps/defi/src/hooks/useTxSimulation.ts` until #1854).
  `apps/agent` has no scan
  proxy and no `/scan/blockaid` route.
- **`push.ts` / `telegram.ts` / `i18n.ts`** — landed on `apps/agent` as
  planned, but copies also exist under `apps/keeper/src/`, and
  `apps/keeper/src/watcher.ts` imports the keeper-local ones for its
  HF-band alerts. **The signing Worker therefore has notification
  capability this table's single destination column cannot express** —
  which is precisely why the table must not be used to bound what a
  Worker can do.
- **`serverQuotes.ts`** — now lives at `apps/keeper/src/serverQuotes.ts`,
  serving liquidation orchestration. Whether it was routed there during
  the split or moved later is not recorded; the row states where it is
  now rather than asserting the original classification was wrong.

To audit what a Worker actually does, read its `src/index.ts` and
`wrangler.jsonc` — not this table.

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
  Worker uses (e.g. per-user HF bands are keeper-only, the Telegram link
  rows are agent-only, the loan rows are indexer-only). This example named
  `thresholds` / `link_codes` / `loan_index_*`, none of which exists under
  any migration — the real tables are `user_thresholds`, `telegram_links`
  and `loans`. The point the example makes still stands; the names were
  wrong, here and in both Workers' `wrangler.jsonc` (fixed alongside). The shared subset is
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

## 7. `apps/keeper` is the offer matcher too — SHIPPED

> **Status correction (#1720 round 15).** This section was written as
> future scope and stayed that way after the matcher shipped.
> `apps/keeper/src/index.ts:141-146` schedules `runMatcher` on every tick of
> the `* * * * *` cron. The matcher PASS is live; do not re-implement or
> re-schedule it.
>
> Two things this banner previously overstated, both corrected:
> the cross-Worker `offers` read is **NOT** shipped (`matcher.ts:41-43`
> keeps discovery on-chain and names the D1 read a future optimisation),
> and the matcher does **NOT** have the independent deploy cadence §1
> asked for — it runs in the same `scheduled()` handler, on the same cron,
> as the HF passes.

Per the user's locked Phase 1 plan ([`RangeOffersDesign.md`](./RangeOffersDesign.md)),
the matcher for **range orders + lender partial fills** is an
**off-chain bot** running in `apps/keeper`. It finds compatible
(lender, borrower) pairs satisfying the matching matrix in Range design §4
and submits `matchOffers(lenderId, borrowerId)` on-chain, earning the 1%
matcher fee from the LIF flow.

**Discovery is on-chain**, not from D1: `matcher.ts:41-43` counts, paginates
and calls `getOffer` per candidate, and the module imports no DB helper. The
original plan here said the bot "watches the indexer's offer table", and that
sentence survived the shipped implementation — leaving this section
specifying two mutually exclusive designs, one in the banner above and one in
its own prose. The cross-Worker `offers` read remains the future optimisation
tracked in §9 below; it is not what runs.

The matcher is the **third** `KEEPER_PRIVATE_KEY` consumer (after
HF liquidation and the daily oracle snapshot). All three are
co-located on `apps/keeper` per the staging plan §2 contract:
`KEEPER_PRIVATE_KEY` lives on exactly **one** Worker — the keeper.
Adding the matcher changes nothing about that: it is one more signed
workload under the existing key-holder.

**Do not read the liquidation / snapshot / matcher trio as the keeper's
signing inventory** — they are the three this document happened to
discuss. The live keeper signs from **eight** modules across at least
thirteen Diamond calls plus two on the FlashLoanLiquidator; the
current list, and the two ways earlier attempts to enumerate it went
wrong, are in staging plan §2. Calling these three "all" the signing
tasks is the exact undercount that §2 withdraws.

This paragraph used to quote an older version of that §2 contract —
"keeper carries `KEEPER_PRIVATE_KEY` + per-chain RPC URLs; agent
holds NEITHER. A buggy agent produces stale data; a buggy keeper
loses funds" — and **both halves of the quote are withdrawn**; see
the staging plan §2, which is the live text:

- *"agent holds NEITHER"* — agent **binds more `RPC_*` secrets** than
  the keeper (12 to 10), and it holds `PUSH_CHANNEL_PK`, a real
  Ethereum key. Only the on-chain **transaction** key is
  keeper-exclusive.

  Say *binds*, not *reads*: the two entries agent has and keeper
  lacks are `RPC_POLYGON` and `RPC_POLYGON_AMOY`, and there is no
  Polygon record in `deployments.json`, so `getChainConfigs` drops
  them at the `getDeployment` gate (`apps/agent/src/env.ts:515-516`;
  the keeper's equivalent is `apps/keeper/src/env.ts:341-342`). Both Workers
  therefore reach the same set — and it is far smaller than either count:
  `deployments.json` holds only 97 / 84532 / 421614, and both
  `getChainConfigs` implementations discard any RPC binding without a
  deployment record, so at most THREE chains are reachable today. The extra
  bindings are provisioned-ahead-of-need secrets — they widen the
  **secret** surface a leak would expose without widening the
  **runtime chain** surface.
- *"a buggy agent produces stale data"* — the agent deletes
  diagnostics and support records, notifies real users, publishes
  listings, and shares a **database**-scoped D1 binding with the
  keeper, so it can corrupt state the signing Worker acts on
  (#1722). Not signing on-chain rules out moving funds *directly*
  and nothing more.

Co-locating the signing tasks is still right — the reason is
single-custody of the transaction key, not a blast-radius gap that
does not exist as stated.

Implication for this Stage 3 plan, **as it was written**: `apps/keeper`
was sized for "HF watch + liquidate + daily snapshot" and architected
for "+ offer match" later. Two of the three consequences below are DISCHARGED; the third is NOT.
They are kept as the record of what the sizing anticipated, with current
status marked per item — read the items, not this sentence:

- Cron triggers loose enough for a matcher pass — **done**, and tighter
  than planned: `apps/keeper/wrangler.jsonc` was set to `* * * * *`, not
  the `*/5 * * * *` this section assumed. **It runs neither today** —
  that file now commits `"crons": []` under #1896, so the matcher pass
  described here does not execute until the hold lifts.
- The keeper-side `db.ts` subset reading the indexer's `offers` table
  (cross-Worker D1 read, same database, different bindings) — **STILL
  OUTSTANDING.** `matcher.ts:41-43` states discovery is on-chain (count +
  paginate + `getOffer`) and names the D1 candidate read as a future
  optimisation; the module imports no DB helper. An earlier revision of this
  bullet marked it discharged and told maintainers not to re-plan it, which
  would have retired a real optimisation that was never built. The `offers`
  query in `dailyOracleSnapshot.ts` is unrelated and does not implement
  matcher discovery.
- `apps/keeper` scope described as "HF watch + liquidate + offer match"
  — **done**; that is its current surface, not its eventual one.

## 8. Two keepers — first-party Worker vs. public reference bot

Worth keeping in mind: there are two distinct keeper deployments,
and Stage 3 is about the FIRST-party one.

| Surface | Repo | Purpose |
| --- | --- | --- |
| **`apps/keeper`** (this Stage 3 work) | This monorepo | Vaipakam's own first-party keeper Worker on Cloudflare. Runs as a single privileged operator with project-funded gas. Hosts the offer matcher (§7) — shipped, running on the keeper cron — alongside the HF watcher + liquidation triggers and the daily oracle snapshot. |
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
- **`apps/keeper` hosts the offer matcher**, see §7. Recorded here as a
  future PR; it has since shipped and runs on the keeper's cron.
- **Migration is parallel-deploy then cutover** — every PR2-4 ships
  a new Worker that runs alongside `ops/hf-watcher`; PR5 cuts the
  frontend over and deletes the old Worker. No flag flip required.
