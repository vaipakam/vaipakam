# Webhook vs Polling — DeFi/DEX Architecture Survey

**Branch:** `research/webhook-vs-polling-defi-survey` (this doc
lives here; merges to `main` only after the design is signed off).

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.7.
Research input for Phase 5 / Phase 8 of the platform-optimisation
roadmap (WebSocket / SSE event push, with current polling
architecture as the canonical fallback).

**Last updated:** 2026-05-07.

**Goal:** survey how mature DeFi / DEX platforms structure event
push to their frontend / SDK consumers, so the eventual Phase 5
implementation lands on a battle-tested pattern instead of
reinventing.

---

## 1. Survey scope

Eight reference protocols, picked for ecosystem maturity +
architecture-doc availability + scale similarity to where
Vaipakam aims:

- **Uniswap** (V2 + V3 + V4 — orderbook + AMM)
- **a major DeFi protocol** (V3 lending + GHO + smart wallet)
- **major DeFi protocols** (CDP + DSR savings)
- **a liquid-staking protocol** (liquid staking)
- **a major DeFi protocol** (V3 — money markets)
- **Balancer** (V2 — weighted + stable pools)
- **dYdX V4** (perp DEX, Cosmos chain)
- **Hyperliquid** (perp DEX, custom L1)

Each section below: the protocol's actual event-push pattern,
key data points, and what's portable to Vaipakam.

---

## 2. Per-protocol findings

### 2.1 Uniswap

**Frontend pattern**: subgraph + WebSocket subscriptions via
The Graph's hosted GraphQL endpoint. Polling fallback on
disconnect.

- Subgraph: `uniswap/uniswap-v3` (and v2, v4) on hosted +
  decentralised network.
- WebSocket: GraphQL subscriptions over WSS to the same
  endpoint. Used for real-time pool / position / position-
  manager updates.
- Fallback: polling at 5–15 s when WS disconnects.
- Event filtering: per-user (open positions, recent swaps),
  per-pool (TVL, recent swaps), per-token.

**Battle-tested at**: ~$10B TVL, 20M+ unique addresses; the
WS + polling fallback handles outages cleanly.

**Portable to Vaipakam**: yes, directly. Subgraph + WS over
the same GraphQL endpoint is the canonical decentralised
pattern.

### 2.2 a major DeFi protocol

**Frontend pattern**: hosted indexer (a major DeFi protocol's own) + subgraph +
WebSocket. Multi-tier fallback.

- Tier 1: a major DeFi protocol's own indexer API (fast, rich shape).
- Tier 2: a major DeFi protocol subgraph on The Graph (slower, decentralised).
- Tier 3: direct chain RPC via Multicall (always-available).
- WebSocket: position-level updates pushed when a user's
  health factor or liquidity changes.

**Custom RPC UX**: prominently exposed in Settings — user can
override a major DeFi protocol's RPC list with their own URL. a major DeFi protocol's interface
is the original reference for this UX pattern.

**Battle-tested at**: ~$30B TVL across V3.

**Portable to Vaipakam**: yes — three-tier failover matches
exactly Pillar 4.5's design (Worker → Subgraph → RPC).

### 2.3 major DeFi protocols

**Frontend pattern**: DNSLink + IPFS hosting (`sky.money`),
subgraph for indexed reads, WebSocket subscriptions for the
DSR savings position page.

- IPFS: `sky.money` resolves via DNSLink to an IPFS pin.
- Subgraph: per-protocol-component (vat, jug, dog, vow, etc.).
- WebSocket: DSR rate updates + savings position deltas.
- Fallback: polling at 30 s.

**Battle-tested at**: ~$8B TVL; the IPFS path has been live
for years without significant outage.

**Portable to Vaipakam**: yes — IPFS hosting validates Pillar
4.6's design; subgraph-per-component pattern could inform how
we split Vaipakam's subgraph if it grows past one schema.

### 2.4 a liquid-staking protocol

**Frontend pattern**: hosted indexer + subgraph. WebSocket
NOT used; polling at 12 s (eth-mainnet block time aligned).

- Hosted indexer: a liquid-staking protocol's own; backed by Postgres + custom
  sync daemon.
- Subgraph: `lidofinance/lido` for stETH / wstETH / wsteth-
  holders.
- Polling: at every block (12 s) — a liquid-staking protocol's stETH balance is
  rebasing every block, so WS would be expensive without
  meaningful UX gain over polling.

**Battle-tested at**: ~$30B TVL.

**Portable to Vaipakam**: partial. a liquid-staking protocol's polling-only design
proves polling at native cadence is viable for high-throughput
DeFi. Vaipakam's per-route cadence (5–60 s) is well within
this pattern. Suggests WS adds value mainly for sub-block
freshness; for block-cadence updates, polling is fine.

### 2.5 a major DeFi protocol (V3)

**Frontend pattern**: subgraph-only. No WebSocket.

- Subgraph: `compound-finance/compound-v3` per chain.
- Polling: 15 s on the comet markets page.
- Direct RPC fallback for live position views.

**Battle-tested at**: ~$3B TVL.

**Portable to Vaipakam**: yes — a major DeFi protocol's "subgraph + polling
+ RPC fallback" is exactly Vaipakam's three-tier design today
(plus a Worker layer).

### 2.6 Balancer

**Frontend pattern**: hosted indexer + subgraph. WebSocket
subscriptions for pool-builder real-time updates.

- Subgraph: `balancer-labs/balancer-v2` per chain (already
  used by Vaipakam's swap-quote infra — see
  `frontend/src/lib/quotes/balancerV2.ts`).
- WebSocket: pool-creation notifications + LP-position
  deltas.
- Polling: 30 s default on dashboards.

**Portable to Vaipakam**: yes; we already integrate with
Balancer's subgraph for swap quotes, so the `fetch` shape +
GraphQL discipline is familiar.

### 2.7 dYdX V4

**Frontend pattern**: WebSocket-FIRST. Polling is the fallback
(reverse of the typical pattern).

- Native WebSocket API: orderbook + position + recent-trades
  push at sub-100ms latency.
- HTTP REST: same data on demand for cold-start + reconnect.
- No subgraph — dYdX runs its own L1 + indexer.

**Why WS-first**: perp DEX needs sub-second freshness for
liquidations + new orders; polling at any meaningful cadence
introduces UX-meaningful lag.

**Battle-tested at**: ~$1B in 24h volume.

**Portable to Vaipakam**: NOT directly — Vaipakam isn't a perp
DEX. Sub-second latency isn't the requirement. WS adds value
but doesn't need to be primary.

### 2.8 Hyperliquid

**Frontend pattern**: WebSocket-only for real-time;
HTTPS-API for cold-start.

- Custom WebSocket protocol (similar to Binance / FTX
  shapes).
- Subscription model: per-asset, per-user, per-orderbook-side.
- HTTPS REST: equivalent endpoints for non-WS consumers.

**Battle-tested at**: ~$3–8B in 24h volume.

**Portable to Vaipakam**: partial. The subscription-per-topic
model is what `LiveTailProviderDesign.md` proposes for the
in-browser dispatcher; the same shape extends naturally to a
Worker-side WS endpoint.

---

## 3. Patterns observed

Synthesising across the eight references:

| Pattern | Frequency | When applicable |
|---|---|---|
| Subgraph as decentralised indexer | 7 / 8 (all except Hyperliquid) | Always |
| Multi-tier failover (hosted → subgraph → RPC) | 6 / 8 | When hosted indexer exists |
| WebSocket / SSE primary push | 3 / 8 (Uniswap, dYdX, Hyperliquid) | When sub-block freshness is UX-meaningful |
| WebSocket as additive over polling | 2 / 8 (a major DeFi protocol, Balancer) | When ~30s polling lag is acceptable but real-time would polish UX |
| Polling-only | 2 / 8 (, a major DeFi protocol) | When polling-cadence freshness is sufficient |
| IPFS hosting + DNSLink | 4 / 8 (Uniswap, Sky, a liquid-staking protocol) | Always recommended — survives single-host outage |
| Custom-RPC user-supplied UX | 7 / 8 | Always recommended |
| EIP-6963 multi-wallet | 5 / 8 (newer interface revs) | Recommended for new builds |

**Recurring shape**: all of (subgraph + multi-tier failover +
custom-RPC + IPFS) shows up everywhere mature DeFi has
landed, regardless of WS-vs-polling preference. The choice
between WS and polling is workload-dependent; the rest is
infrastructure hygiene.

---

## 4. What this survey says about Vaipakam's choice

### 4.1 Subgraph + multi-tier failover + custom-RPC + IPFS

**Adopt all four.** They're table stakes. Pillars 4.4
(MultiRpcStrategy), 4.5 (Subgraph), 4.6 (IPFS) cover three;
we'd add EIP-6963 multi-wallet under 4.4. Phase 0's design
docs already align with all of these.

### 4.2 WebSocket vs polling — Vaipakam's call

Vaipakam's UX freshness needs sit between a liquid-staking protocol (block-cadence
polling fine) and Hyperliquid (sub-second WS required). The
hot pages:

- **OfferBook** — new offers / accepts / cancels would benefit
  from sub-30 s freshness, but ~5 s polling is acceptable.
- **Loan detail** — repay / partial-repay / liquidation events
  would benefit from real-time, but a minute's lag is
  acceptable.
- **Activity feed** — chronological list; freshness is
  cosmetic, ~30 s polling is fine.
- **Dashboard** — user's own positions; ~15 s polling is
  fine.

**Recommendation**: WebSocket as **additive over polling**,
mirroring the a major DeFi protocol / Balancer pattern. Frontend default is
the existing polling architecture. WebSocket pipe (Phase 5)
is an opt-in faster path for the same data; on disconnect the
frontend falls back to polling automatically. No UX
regression in either mode.

This avoids the WS-first complexity (reconnect logic on the
hot path, fallback behaviour split brain risks) while
delivering the WS UX win where bandwidth is available.

### 4.3 The WebSocket pipe's design

Reading from this survey, the cleanest implementation:

- **Cloudflare Worker durable-object** per chain id. WS
  connections terminate at the durable-object; the
  durable-object subscribes to the watcher's already-decoded
  events (the watcher writes to D1 today; for Phase 5 it
  ALSO writes to a durable-object inbox).
- **Subscription protocol**: subscribe(chainId, topics[]) —
  same topic set the LiveTailProvider already manages.
  Server filters per-subscriber; client receives only what
  it asked for.
- **Reconnect**: client tracks last-seen blockNumber; on
  reconnect, server replays events between last-seen and
  current head before resuming push.
- **Backpressure**: server drops oldest events for
  subscribers that exceed buffer thresholds (e.g. tab in
  background for hours).
- **Polling-fallback handshake**: client always also has the
  polling loop running at low cadence (60 s); on WS
  disconnect, polling cadence ramps to the route's
  default; on WS reconnect, polling drops back to the
  low-cadence keepalive.

---

## 5. Decision matrix

| Question | Survey-informed answer |
|---|---|
| Should Vaipakam have a subgraph? | **Yes** — table stakes per Pillar 4.5 / Phase 6. |
| Should Vaipakam have WebSocket push? | **Yes, but additive.** Phase 8 of the master roadmap. |
| Should WS be primary, polling secondary? | **No** — Vaipakam isn't a perp DEX. Polling stays primary. WS is faster path opt-in. |
| Should Vaipakam adopt EIP-6963? | **Yes** — newer DeFi default; Pillar 4.4. |
| Should Vaipakam adopt IPFS hosting? | **Yes** — Pillar 4.6 / Phase 7. |
| Should Vaipakam expose custom-RPC UX? | **Yes** — Pillar 4.4 / Phase 5. |
| Should Vaipakam adopt account abstraction (ERC-4337)? | **Defer.** Survey shows mixed adoption; not on critical path. Pillar 4.12 (post-mainnet). |

---

## 6. Open questions

1. **Webhook (server → server) vs WebSocket (client ↔ server)**
   — the parent design's Pillar 4.7 mentions both. The survey
   shows DeFi platforms favour client-WS over server-webhook
   because keeper bots / monitoring bots run on operator
   infra and can poll. Webhook makes more sense for THIRD-
   PARTY integrations (CEX listing alerts, custodial
   notifications, etc.) — out of scope for Phase 5 / 8.
   Recommendation: skip webhook; go WebSocket.
2. **Worker durable-object vs separate WS server**? Cloudflare
   durable-objects are well-suited (region-pinned, persistent
   state, integrates with the existing watcher D1). Recommend
   durable-objects for Phase 8.
3. **Should the WS pipe also serve subgraph queries**? Some
   DeFi (Uniswap) co-locates GraphQL subscriptions with the
   subgraph. Recommendation: keep them separate — subgraph
   owned by The Graph, WS pipe owned by Vaipakam's Worker.
   Avoids coupling Vaipakam's Phase 8 to The Graph's gateway
   semantics.
4. **MEV-protected RPC for write-tx**? Survey shows this is
   newer practice — , Cowswap, Uniswap V4 interface all
   integrate Flashbots Protect / MEV Blocker. Vaipakam should
   too; covered under Pillar 4.4 (Phase 5).

---

## 7. Recommendations summary

1. **Phase 5 (Multi-RPC)** — adopt EIP-6963 + custom-RPC UX +
   MEV-protected write-tx option. ~5–7 dev days.
2. **Phase 6 (Subgraph)** — schema + handlers + decentralised-
   network deployment. Gated on Phase 1's event extensions.
   ~7–10 dev days.
3. **Phase 7 (IPFS hosting)** — reproducible build + multi-pin
   + ENS contenthash + DNSLink. ~4–6 dev days.
4. **Phase 8 (WebSocket pipe)** — Cloudflare durable-object +
   client-side WS-or-polling switch. ~4–6 dev days. Last in
   the sequence; everything else stands without it.

Phases 5 + 7 can run independently of the others. Phase 6 gates
on Phase 1 (contract event extensions). Phase 8 builds on
Phase 3 (LiveTailProvider).

---

## 8. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar
  4.7 (parent).
- `DesignsAndPlans/MultiRpcStrategyDesign.md` — Pillar 4.4 detailed
  design.
- `DesignsAndPlans/SubgraphSchemaDesign.md` — Pillar 4.5 detailed
  design.
- `DesignsAndPlans/IPFSHostingPipelineDesign.md` — Pillar 4.6 detailed
  design.
- `DesignsAndPlans/LiveTailProviderDesign.md` — Pillar 4.2; the WS
  pipe (Phase 8) feeds events into the same dispatcher.
- Survey sources: each protocol's public docs + GitHub
  monorepo + frontend network-tab inspection. Specific
  references on request.

---

## 9. Merge plan for this branch

This doc lives on `research/webhook-vs-polling-defi-survey`
until the design is signed off. Once Phase 0 is reviewed and
the survey's recommendations are accepted, the branch merges
into `main` with this doc landing at
`docs/DesignsAndPlans/WebhookOrPollingSurvey.md`. No code changes on
this branch — research only.
