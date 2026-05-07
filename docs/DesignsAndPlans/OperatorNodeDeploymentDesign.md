# Operator Node Deployment — Self-Hosted Infrastructure Design

**Status:** Partially active. Captures the deployment plan for the
`vaipakam-keeper-bot` and adjacent self-hosted operator services. The
`rewardCloser` daemon (Phase A) and the local Postgres mirror indexer
(Phase B) are pre-mainnet ops needs; the custom LayerZero DVN
(Phase C/D) and observability layer (Phase E) remain deferred. The
2026-05-07 platform-decentralisation pivot (see
`DecentralizedPlatformArchitecture.md`) brings additional
responsibilities for this node — captured in the Phase 0.5 addendum
section below — that move the local-indexer Postgres + a new HTTP
API + a self-hosted WebSocket twin onto the critical path for the
"no third-party dependency" end-state.

**Last updated:** 2026-05-07.

## Context

The reference keeper bot (`vaipakam-keeper-bot`, sibling repo) was
deliberately built as a standalone Node.js process (per its
`package.json` description) so third-party operators can clone it out
of the monorepo and run it on whatever infra they prefer. The
protocol team also needs to run a copy as one of the keeper-pool
operators.

The bot is structurally incompatible with Cloudflare Workers: it
needs a long-running `setInterval` loop, persistent in-memory
per-chain dedupe state, and >30s wall-clock for batch ops
(multicall, multi-tx liquidation submissions). Workers VPC doesn't
help — that's a networking add-on for reaching private RPC
endpoints, not a runtime model change. Cloudflare Containers (beta
in 2026) would fit but is paid-tier only.

The cheapest viable target is **Oracle Cloud Always Free ARM
Ampere A1**: 4 OCPUs + 24 GB RAM split across up to 4 instances,
200 GB block storage, 10 TB egress/month, no time limit, $0 forever.

The catch: Oracle reclaims Always Free instances when **all three**
are below 20% over a rolling 7-day window — CPU 95th percentile,
network, and (A1-only) memory. A bare keeper bot at idle uses
~100 MB RAM out of 6-24 GB → trips the memory floor. The fix is to
co-host other operator-side services that keep memory loaded AND
deliver real platform value.

## Target instance shape

Single 1 OCPU + 6 GB RAM instance from the 4 OCPU / 24 GB Always
Free pool. Leaves 3 OCPUs / 18 GB headroom for future expansion or
a second hot-standby instance in another availability domain (AD).

## Workload stack — recommended

A "platform operator node" running:

### 1. Keeper bot (existing — `vaipakam-keeper-bot`)

Already merged. Per-tick loop:

- HF-based liquidation sweep (`RiskFacet.triggerLiquidation`)
- Range Orders matching (`OfferMatchFacet.matchOffers`, after the
  Phase 1 detector landed in `vaipakam-keeper-bot@f555d9a`)

RAM footprint: ~200 MB.

### 2. Reward closer daemon (new — to be added to `vaipakam-keeper-bot`)

Every reporter chain (Sepolia, Arb Sepolia, OP Sepolia, BNB Testnet,
Polygon Amoy, plus their mainnet equivalents) must call
`RewardReporterFacet.closeDay(day)` once per UTC day to flush
accrued interest. On canonical Base, the operator must follow with
`RewardAggregatorFacet.finalizeDay(day)` then `broadcastGlobal(day)`
to compute global proportions and fan them back out.

Today this is operator-driven — there's no automation. If a day is
missed, users can't claim rewards for that day until someone
manually runs it.

**Plan:** add `src/detectors/rewardCloser.ts` to `vaipakam-keeper-bot`
that mirrors the `offerMatcher.ts` pattern. Reuses per-chain
RPC clients + KEEPER_PRIVATE_KEY. Polls block timestamps to
detect UTC day rollover, submits the appropriate close /
finalize / broadcast tx.

RAM footprint: ~150 MB.

### 3. Self-hosted LayerZero DVN

Per `CLAUDE.md` Cross-Chain Security: every Vaipakam OApp uses 3
required + 2 optional DVNs. Today the protocol team relies entirely
on third-party operators (LayerZero Labs, Google Cloud, BitGo, etc.).
Adding a custom DVN run by the protocol team itself is a meaningful
defense-in-depth improvement: every other DVN can be subverted by
its own corporate operator, but our own can't be without us
explicitly signing off.

**Plan:**

1. Deploy a `Vaipakam`-branded DVN smart contract on each Phase 1
   chain (mainnet: Ethereum / Base / Arbitrum / Optimism /
   Polygon zkEVM / BNB Chain) following LayerZero V2's custom-DVN
   reference (`@layerzerolabs/lz-evm-dvn`).
2. Run the DVN reference daemon on the Oracle Cloud node, watching
   each source chain's `PacketSent` events, computing the packet
   hash, calling `verify(packetHeader, payloadHash, _confirmations)`
   on the destination ULN.
3. Add the DVN address to `DVN_REQUIRED_*` env vars and re-run
   `ConfigureLZConfig.s.sol` against every (OApp, chain) pair.

RAM footprint: ~300-500 MB per chain watched. Six chains = ~3 GB.
This is the workload that meaningfully bumps memory above the 20%
reclamation floor.

Setup effort: Moderate. Each chain DVN needs a separate registration
ceremony with LayerZero. Gas costs for verification: 30-100k per
message — testnet free, mainnet ~$0.01-0.05 per message.

**Phase order:**

- Phase A — testnet rehearsal (Base Sepolia ↔ Sepolia first; verify
  the operator workflow + ConfigureLZConfig integration).
- Phase B — mainnet rollout chain-by-chain alongside the
  governance handover.

### 4. Local mirror indexer + Postgres

A separate indexer daemon scanning the diamond's events
(`OfferCreated`, `LoanInitiated`, `LoanRepaid`, `LoanDefaulted`,
etc.) and writing into a local Postgres. Same data the hf-watcher's
Cloudflare D1 holds, mirrored on the operator's box.

**Why duplicate the watcher:**

- **Latency** — Cloudflare cron min interval is 1 minute. A
  persistent process can poll every block (2s on Base) and surface
  `previewMatch` candidates to the keeper bot via local SQL faster
  than `getActiveOffersPaginated` round-trips.
- **Redundancy** — if Cloudflare D1 has an outage, keeper liveness
  shouldn't depend on a third-party SaaS.
- **Observability foundation** — Postgres backs Grafana dashboards,
  Prometheus exporters, ad-hoc analytics queries.

**Plan:** port the schema from `ops/hf-watcher/migrations/` to
Postgres-flavored DDL. Lift `chainIndexer.ts` to use a Postgres
driver instead of the D1 prepared-statement API. Run as a separate
systemd service.

RAM footprint: Postgres ~400 MB resident, indexer ~200 MB. Combined
~600 MB.

### 5. Mempool / MEV watchdog (optional polish)

Subscribes to public `eth_subscribe('newPendingTransactions')` on
each chain, filters for txs touching the diamond, pattern-matches
sandwich / frontrun attempts. Pushes alerts to a Telegram channel
(reuses the watcher's TG_BOT_TOKEN secret pattern).

**Future hook:** could trigger pre-flighted liquidations when an
attacker's frontrun is in flight. Not blocking on launch.

RAM footprint: ~150 MB. Persistent websockets to each chain's RPC.

### 6. Telegram alerts daemon

Tails the indexer's `activity_events` table, filters for
operator-relevant events (failed liquidations, paused-asset
attempts, sanctions hits, large-position-at-risk pre-warnings),
pushes to a private operator chat.

RAM footprint: ~100 MB.

### 7. Grafana + Prometheus exporters

Dashboards over the local Postgres + custom exporters for:

- Active loans count per chain, HF distribution, liquidation
  events / day.
- Treasury balance per chain, fee accrual rate.
- DVN message verification latency p50/p95/p99.
- Keeper-bot tx success rate, gas spend, MEV-loss attribution.

RAM footprint: ~600 MB combined.

## Phase 0.5 addendum — integration with the platform decentralisation architecture

The 2026-05-07 architecture pivot (anchor:
`DesignsAndPlans/DecentralizedPlatformArchitecture.md`) targets a
"no third-party dependency" posture: every read path on the
frontend has at least three sources, every server-dependent call has
a chain-RPC fallback, and the protocol team's own infrastructure
provides redundancy at every layer alongside hosted alternatives.
That posture upgrades this operator node from "deferred-but-nice-to-
have" to "load-bearing for decentralisation". Four new services land
on this same instance, mapped one-to-one to platform pillars:

### 8. Postgres indexer HTTP API (Pillar 4.5 — subgraph redundancy tier)

The local Postgres mirror indexer (item 4 above) already holds a
copy of the watcher's D1 schema. A small Express / Fastify
sidecar exposes the same row shape over HTTP at e.g.
`indexer.vaipakam.com` — turning it into a third tier in the
frontend's failover chain (Cloudflare Worker → The Graph subgraph
→ Operator-hosted indexer → Direct chain RPC). When Cloudflare D1
is unreachable AND the subgraph is rate-limited / lagging, the
operator-hosted indexer keeps the page alive without any
third-party dependency.

API shape mirrors the worker's existing `/offers/*`, `/loans/*`,
`/activity/*` endpoints so the frontend's `subgraphClient`
adapter pattern (see `DesignsAndPlans/SubgraphSchemaDesign.md`) handles
this source identically — no special-case wiring per source.

RAM footprint: ~50 MB (Express / Fastify is light; reads from
existing Postgres connection pool).

Phase order: lands as part of Phase B (local indexer + Postgres);
~half a day of incremental work on top of the indexer daemon.

### 9. Self-hosted WebSocket pipe (Pillar 4.7 / Phase 8b — operator-node WS twin)

The platform-architecture roadmap's Phase 8 (WebSocket / SSE
event push) has TWO deliverables: 8a is the Cloudflare Worker
durable-object endpoint; 8b is its self-hosted twin on this
operator node. Same protocol (subscribe by chainId + topics,
server filters, reconnect-with-replay), distinct origin. Sources
events from the local Postgres mirror, NOT from Cloudflare D1 —
fully independent of any hosted service.

Frontend's WS-failover order (per `DesignsAndPlans/WebhookOrPollingSurvey.md`):

```
Cloudflare WS (8a)  →  Operator-hosted WS (8b, this node)  →  Polling fallback
```

Implementation: small Node WS server (`ws` library) reading change
notifications from Postgres `LISTEN/NOTIFY`, fanning out to
subscribed clients. ~150–200 MB resident.

Phase order: builds on Phase B's Postgres + Phase 8a's WS
protocol. Calendar-wise lands after 8a so the protocol's been
proven in production first.

### 10. Testnet-only chain RPC nodes (Pillar 4.4 — multi-RPC failover)

The operator node can run its own chain RPC for the testnet trio
(Base / Arb / OP Sepolia) — adding a self-hosted endpoint to the
multi-RPC failover list (Pillar 4.4) that's independent of
dRPC / Alchemy / Infura. Each testnet sync footprint is ~30–50 GB
disk, ~1–2 GB RAM combined for op-geth + arb-nitro syncing the
three testnets to safe head.

**Mainnet RPC nodes don't fit the 6 GB / 200 GB Always Free
instance** — Base / Arb / OP mainnet rollups need ~500–800 GB
disk each, 4+ GB RAM each. Mainnet RPC sovereignty would require
a separate beefier instance (or a paid-tier provider remains
acceptable per Pillar 4.4 — not every layer needs sovereign
hosting). For testnets the cost is in the noise; for mainnets,
defer to the multi-RPC strategy's paid-primary + community-
fallback layering.

Phase order: optional Phase 0.5b — only when operators want to
prove out the self-hosted RPC path on testnet before the broader
mainnet decision is made.

### 11. Public status page (Pillar 4.11 — observability + transparency)

A small static page + minimal Express health-check API at
`status.vaipakam.com`. Renders per-chain indexer cursor age,
watcher health, RPC provider availability, last finalised block
per chain. Refreshes every 30 s. Same data the user-facing
DiagnosticsDrawer surfaces, but published publicly so users can
check platform health without connecting a wallet.

Hosting on this operator node decouples the status page from
Cloudflare Pages / Workers — survives any centralised-host
outage. Same decentralisation logic as Pillar 4.6 (IPFS hosting):
the page that says "Cloudflare is down" can't itself live on
Cloudflare.

RAM footprint: ~50 MB (Express + a static-asset serving
goroutine equivalent).

Phase order: optional Phase 0.5c — lands alongside or after
Phase E (observability layer); needs the local Postgres + a
small public reverse-proxy already running.

## Memory budget summary (6 GB instance)

| Process                                             | RSS estimate                |
| --------------------------------------------------- | --------------------------- |
| keeper-bot                                          | ~200 MB                     |
| reward-closer (new)                                 | ~150 MB                     |
| LZ DVN (6 chains)                                   | ~2.5 GB                     |
| local indexer                                       | ~200 MB                     |
| Postgres                                            | ~400 MB                     |
| Telegram alerts                                     | ~100 MB                     |
| Grafana + Prometheus                                | ~600 MB                     |
| **Subtotal (Phase A–E baseline)**                   | **~4.2 GB / 6 GB (~70%)**   |
| Postgres indexer HTTP API (Phase 0.5 #8)            | ~50 MB                      |
| Self-hosted WebSocket pipe (Phase 0.5 #9 / 8b)      | ~150–200 MB                 |
| Public status page (Phase 0.5 #11)                  | ~50 MB                      |
| **Total resident with Phase 0.5 (no testnet RPC)**  | **~4.4 GB / 6 GB (~73%)**   |
| Testnet RPC nodes (Phase 0.5 #10, optional)         | ~1.5–2 GB                   |
| **Total resident with Phase 0.5 + testnet RPC**     | **~6.4 GB — DOES NOT FIT**  |

Without testnet RPC: comfortably under the 6 GB limit, comfortably
above the 20% reclamation floor. CPU averages 5–15% with bursts on
liquidation / DVN message arrival — well above the 20% floor.
Network ~10–50 GB/month, far below the 10 TB cap.

With testnet RPC (Phase 0.5 #10): doesn't fit the 1 OCPU / 6 GB
instance. Two paths if RPC sovereignty matters:
(a) bump THIS instance to 2 OCPU / 12 GB (still inside Always
Free — the design's headroom of 3 OCPUs / 18 GB covers it);
(b) peel testnet RPCs onto a second 1 OCPU / 6 GB instance from
the same Always Free pool. Both stay $0 / month forever.

## Phasing — when we come back to this

Recommended phase order:

1. **Phase A — `rewardCloser.ts` detector in `vaipakam-keeper-bot`.**
   Smallest scope. Real ops need today (no manual daily cycle).
   Lands as a new detector, mirrors `offerMatcher.ts` shape. ~1
   week of focused work.

2. **Phase B — local indexer + Postgres on the Oracle Cloud node.**
   Solves the idle-reclamation memory floor cleanly even before
   the DVN work. Schema port + indexer daemon. ~1 week.

3. **Phase C — Custom LZ DVN on testnet (Base Sepolia ↔ Sepolia).**
   Validates the operator workflow before mainnet. Includes the
   ConfigureLZConfig integration so the DVN is actually consulted
   on every cross-chain message. ~2 weeks.

4. **Phase D — Mainnet DVN rollout chain-by-chain.** Sequenced with
   the governance handover (DeploymentRunbook §6). 1-2 weeks per
   chain.

5. **Phase E (optional polish) — Mempool watchdog + Telegram
   alerts + Grafana dashboards.** Quality-of-life ops layer once
   mainnet is live. No fixed timeline.

## What this design does NOT do

- **Doesn't replace the bot's standalone-Node.js runtime model.**
  Cloudflare Workers / Workers VPC are not viable per the
  architecture analysis above.
- **Doesn't define the on-chain contracts for the custom DVN.**
  Those follow LayerZero V2's published interface
  (`@layerzerolabs/lz-evm-dvn`); the protocol-side change is
  config-only (add the DVN address to `DVN_REQUIRED_*` and re-run
  `ConfigureLZConfig.s.sol`).
- **Doesn't pick the exact Postgres version / Grafana flavor.**
  Operator-grade infrastructure choices that are easy to revisit.

## Cross-references

- `vaipakam-keeper-bot/README.md` — existing bot architecture +
  setup.
- `contracts/CLAUDE.md` "Cross-Chain Security" — DVN policy
  (3-required + 2-optional, threshold 1-of-2, operator diversity).
- `contracts/script/ConfigureLZConfig.s.sol` — DVN address wiring
  on every (OApp, eid) pair.
- `docs/ops/DeploymentRunbook.md` §3 "Reward plumbing" — the
  closeDay / finalizeDay / broadcastGlobal cycle the rewardCloser
  daemon would automate.
- `ops/hf-watcher/src/chainIndexer.ts` — the source pattern for
  the local mirror indexer.

## Deployment Plan

- Planing to deploy all these in Oracle Cloud (ARM) `Ampere A1 (ARMv8)` free tier with `Provision the instance with 1 OCPU + 6 GB RAM` or more as required, so degin accordingly

## Webhook / WebSocket — answered by the platform survey

The original question on this page ("can we include a webhook so it
serves as an alternative to the indexer?") was answered in
`docs/DesignsAndPlans/WebhookOrPollingSurvey.md` after surveying eight
mature DeFi / DEX platforms. Summary:

- **Server-to-server webhooks** are NOT the right pattern for the
  user-facing frontend — DeFi platforms favour client-side
  WebSocket subscriptions over operator-pushed webhooks. Webhooks
  fit third-party integrations (CEX listing alerts, custodial
  notifications) which are out of Vaipakam's current scope.
- **Client-side WebSocket / SSE** is the right pattern, **additive
  over polling** — the WS pipe delivers sub-second freshness when
  the connection is healthy; the polling architecture stays as
  the canonical fallback on disconnect. Matches the Aave /
  Balancer pattern; avoids the dYdX / Hyperliquid "WS-first"
  complexity that Vaipakam's UX freshness needs don't justify.
- **The WS pipe has two deliverables** (Phase 8a + 8b): the
  Cloudflare Worker durable-object endpoint is the primary;
  this operator node hosts the self-hosted twin that activates
  on Cloudflare-WS disconnect (item 9 in the Phase 0.5 addendum
  above).

The indexer remains the polling-cadence canonical source; the WS
pipe is the speed-up, NOT a replacement. Phase 0.5 #9 covers the
operator-side implementation.
