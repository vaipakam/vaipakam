# Decentralized Platform Architecture — Industry-Standard, IPFS-Hostable, Serverless-Capable

**Status:** Drafted 2026-05-07. Anchor design doc for the
architecture-optimisation work in the pre-mainnet window. Each
phase listed here gets its own detailed sub-design as it lands.

**Last updated:** 2026-05-07.

**Scope owners:** all of frontend, watcher, contracts, operator
infrastructure. This doc captures the cross-cutting strategy; the
per-phase designs (`EventSourcingAudit.md`,
`LiveTailProviderDesign.md`, `CacheStoreDesign.md`, etc.) carry
the implementation details.

---

## 1. Context — why now

The 2026-05-06 mainnet rehearsal landed cleanly across all three
testnet chains, and today's smoke matrix is fully green
(PartialFlows + PositiveFlows × 3 chains all 100 %). With the
contracts proven and the deploy pipeline hardened, the natural
next investment is **the read-side architecture and the
decentralisation posture**.

Two factors drove the timing call:

1. **Mainnet-deploy timing is flexible.** The user confirmed
   2026-05-07 that there's no urgency to cut over; the calendar
   window in front of us can be spent on architecture rather than
   on deferring it.
2. **The read-side has accumulated tactical patches.** The
   diagnostics drawer + IndexerStatusBadge work yesterday + today
   surfaced the inconsistency between what the page can render
   (the chain `safe` head, via RPC live-tail) and what the
   indexer cursor reports. The honest cleanup is a real
   architectural lift, not more relabelling.
3. **IPFS hosting is an explicit design goal.** The user wants
   the frontend bundle to live on IPFS so the platform survives
   any centralised-host outage. That mandates a no-server
   fallback path on every read — every code path that reaches
   for a Cloudflare Worker, a hosted indexer, or any
   infrastructure beyond chain RPC must have a direct-RPC
   fallback that's not just technically possible but actually
   pleasant to use.

This doc captures the target state, the architectural pillars
that get us there, and a phased roadmap that keeps the current
architecture working as a fallback at every step.

---

## 2. Vision — what "industry-standard, IPFS-hostable,
serverless-capable" means concretely

Three independent qualities, deliberately decoupled:

### 2.1 Industry-standard, battle-tested

The platform's architecture matches what mature DeFi protocols
(Uniswap, Aave, Sky/MakerDAO, Lido, Compound, Balancer, dYdX,
Hyperliquid) actually run in production. Every architectural
choice has at least one production reference at peer-protocol
scale; no novel patterns where a battle-tested one exists.

This is a **conservative posture**. We adopt patterns AFTER
they've proven their reliability across multiple incidents
elsewhere; we don't innovate on infrastructure unless the
existing ecosystem genuinely lacks a solution to a Vaipakam-
specific need.

### 2.2 IPFS-hostable

The frontend bundle (HTML, JS, CSS, assets) is pinned to IPFS
with a content-addressed (immutable) CID per release. Users
reach the site via:

- ENS (`vaipakam.eth` resolves to the latest CID via
  `setContenthash`).
- DNSLink (a `_dnslink` TXT record on `vaipakam.com` points to
  the same CID).
- Direct gateway access (`ipfs.io/ipfs/<CID>`,
  `cloudflare-ipfs.com/ipfs/<CID>`, `4everland.io/ipfs/<CID>`).
- Local IPFS node (`ipfs://<CID>` resolved by Brave / IPFS
  Companion / a self-hosted Kubo daemon).

A pin-only architecture means **no SSR, no API-from-host
coupling**: the bundle is a pure static client. Every dynamic
behaviour happens in the browser or on chain. The IPFS-hosted
release is the canonical artefact; the Cloudflare Pages /
Workers deployment is one of several equivalent edges that serve
the same content.

### 2.3 Serverless-capable

Every read path the frontend needs has at least three sources,
ordered by preference:

1. **Hosted indexer** (Cloudflare Worker → D1) — fastest, richest
   shape, but operator-dependent.
2. **Hosted subgraph** (The Graph / Goldsky / Envio) — battle-
   tested, decentralised over multiple indexer operators, but
   higher latency and limited to GraphQL shape.
3. **Direct chain RPC** (Multicall3 + `eth_getLogs` + view
   functions) — always available; bounded by RPC quota and
   block-range chunk caps; the canonical fallback.

The frontend defaults to source 1, falls back to source 2 on
error, and falls back to source 3 on any source 2 error. A
"serverless mode" toggle (or the implicit case where sources 1
and 2 are both unreachable) renders the page entirely from
source 3 with no UX regression beyond the higher per-page-load
RPC quota.

---

## 3. Current-state assessment

Where Vaipakam stands today against the three vision qualities:

| Quality | Status | Gaps |
|---|---|---|
| Industry-standard | **Strong on contracts** (EIP-2535, OZ Upgradeable, LayerZero V2 with 3+2 DVN, Chainlink + Tellor + API3 + DIA quorum, Multicall3-aware view shapes). **Weak on read-side** (per-hook scanners, no shared cache, no event-sourced state). | The shared `LiveTailProvider`, IndexedDB cache layer, and event-driven state model are all canonical patterns in mature DeFi but not yet in Vaipakam. |
| IPFS-hostable | **Not yet** — frontend is deployed only to Cloudflare Workers Static Assets at `vaipakam.com`. Bundle is static (no SSR), so the migration is mechanical, but ENS contenthash wiring, gateway smoke-tests, and reproducible-build discipline aren't in place. | No IPFS pin pipeline; no ENS contenthash automation; no per-release CID provenance recorded. |
| Serverless-capable | **Partially** — `useLogIndex` (legacy) reads directly from chain via `eth_getLogs`, but the indexer-driven hooks (`useIndexedActiveOffers`, `useMyOffers`, `useIndexedLoans`, `useIndexedActivity`, `useIndexedClaimables`) hard-fail the user-facing rendering when the worker is unreachable. There's no second-tier subgraph fallback. | Subgraph deployment doesn't exist; per-hook chain-RPC fallback paths aren't wired; multi-RPC failover with health checks isn't implemented. |

The contracts side is in a strong position. The frontend +
indexer architecture is where the work concentrates.

---

## 4. Architectural pillars (twelve)

Each pillar names a concrete architectural concern, the current
state, the target state, and the rough effort to move from one
to the other. The order is dependency-aware: earlier pillars
unblock later ones. Effort estimates are dev-days for a single
developer.

### 4.1 Self-sufficient on-chain events

**Concern:** can the frontend / watcher rebuild a row's full
state from event payloads alone, or does it need a follow-up
`getOfferDetails` / `getLoanDetails` view-call after every event?

**Today:** events emit deltas — most lifecycle events
(`OfferAccepted`, `LoanRepaid`, `LoanDefaulted`,
`CollateralAdded`, etc.) carry a few fields. Watchers and
frontend hooks always do a follow-up `getDetails` view-call to
hydrate the full struct. That's one extra RPC per row per
event.

**Target:** events emit enough payload that consumers can update
their cached row entirely from the event. Follow-up
`getDetails` only on cache miss (i.e. the consumer has never
seen this id before).

**Concrete steps:**

- Audit every external/public Solidity event. List
  currently-emitted fields vs storage fields the event mutates.
- Per-event recommendation: extend OR keep deltas-only (gas-
  cost-aware — extending a hot-path event by 5 fields is
  ~50–80 k gas every call; extending a once-per-loan terminal
  event is fine).
- Land the extensions before the next mainnet rehearsal so the
  audit re-pass can cover them in the same ceremony.

**Effort:** 4–6 dev-days for audit + design + Solidity + tests.

**Reference:** Aave's event surface (their `Borrow`,
`Repay`, `LiquidationCall`, `ReserveUsedAsCollateralEnabled`
events all carry the post-mutation reserve state). Compound's
`AccrueInterest` carries the new rate and total borrows — a
consumer can rebuild market state from event stream alone.

### 4.2 Shared `LiveTailProvider` (single AppLayout-level scanner)

**Concern:** every list hook today runs its own `eth_getLogs`
scanner. On busy pages five scans hit the RPC for the same
block range with different topic subsets. Wasteful and
inconsistent (different hooks see different watermarks).

**Today:** five independent scanners (`useIndexedActiveOffers`,
`useMyOffers`, `useIndexedLoans`, `useIndexedActivity`,
`useIndexedClaimables`) plus the legacy `useLogIndex` wrapper.

**Target:** a single `LiveTailProvider` mounted in `AppLayout`
that:
- ORs together the topic union of all currently-subscribed
  hooks into one `eth_getLogs` per cadence tick.
- Dispatches matched events to subscribers by topic via a
  small in-memory router.
- Honours per-route cadence (5 s on OfferBook, 30 s on
  Dashboard, 60 s on Analytics, etc.) via a `useLocation` →
  cadence map.
- Pauses on tab-hidden, throttles on idle, resumes on focus.
- Exposes a single watermark for the diagnostics surface.

**Concrete steps:**

- Design doc: API contract (subscribe / unsubscribe / watermark
  read), dispatcher shape, cadence map, fallback behaviour when
  the subscriber list is empty.
- Provider implementation + unit tests.
- Phased migration: each list hook flag-gates `LIVE_TAIL_PROVIDER_ENABLED`,
  uses the provider when on, falls back to its existing scanner
  when off.

**Effort:** 5–7 dev-days for provider + per-hook migration +
regression. Each phase is 0.5–1.5 days, releasable independently.

**Reference:** Uniswap V3's `useV3PoolEvents` hook used a
similar shared-scanner pattern in their interface app. Hyperliquid's
SDK likewise centralises event subscriptions.

### 4.3 IndexedDB cache layer

**Concern:** the frontend has no client-side cache for
fully-hydrated rows. Every page load re-fetches from the
indexer; offline rendering is impossible; first-paint blocks
on a network round-trip.

**Today:** `lib/logIndex.ts` writes a localStorage cache for the
event-derived loan/offer ID index, but not for the
fully-decoded rows. localStorage is sync-blocking and capped at
~5 MB.

**Target:** an IndexedDB store with bounded, versioned tables:

- `myOffers(chainId, offerId, ...row...)` — connected wallet's
  own.
- `myLoans(chainId, loanId, ...row...)` — connected wallet's
  own.
- `topOffers(chainId, offerId, ...row..., sortKey)` — top N
  by rate, paginated.
- `recentActivity(chainId, eventId, ...event...)` — bounded
  ring (~500 events).
- `metadata(chainId, key, value)` — per-chain knobs (last
  scanned block, schema version).

**Concrete steps:**

- Design doc: schema, indexes, eviction rules, version-bump
  triggers, the merge contract for events arriving from both
  Worker and frontend live-tail.
- Cache-aware list hooks: read from IndexedDB on mount, merge
  events into rows in place, lazy-fetch via `getDetails` only
  on cache miss.
- Cache invalidation on chain switch and on schema-version
  bump.

**Effort:** 3–5 dev-days. Builds on pillars 4.1 and 4.2.

**Reference:** Aave's frontend uses a similar IndexedDB-backed
cache via Apollo Client + persistent local state. Sky's SES
project caches the DSR and savings positions in IndexedDB.

### 4.4 Multi-RPC strategy with health-aware failover

**Concern:** any single RPC provider is a single point of
failure. Free-tier RPCs throttle aggressively under read load.
Today the chain RPC URL is one env var per chain — one
provider, no fallback.

**Today:** `frontend/.env.local` has a `VITE_<CHAIN>_RPC_URL`
per chain. Single provider per chain. No health-check, no
failover, no per-call retry on rate-limit.

**Target:** a `MultiRpcProvider` per chain that:
- Holds a primary + N fallback RPC URLs (3–5 per chain).
- Routes each call to the first healthy provider.
- Tracks per-provider health (last success time, error rate,
  latency p95, recent rate-limit responses).
- Exponential backoff on a provider after rate-limit;
  short-circuits to the next one.
- Allows the user to inject their own RPC URL via UI (industry
  standard — Aave's settings panel, Uniswap's interface
  preferences, etc.).
- Prefers the wallet's injected provider (`window.ethereum` via
  EIP-6963) when the user has one and it covers the chain.
- Falls back to a community-curated list of public RPCs
  (chainlist.org-style).
- Optionally tries a MEV-protected RPC (Flashbots Protect, MEV
  Blocker) for write transactions on supported chains.

**Concrete steps:**

- Design doc: provider list per chain, health-check protocol,
  failover policy, user-supplied-RPC UX.
- `lib/rpc/multiProvider.ts` implementation + unit tests.
- Migrate `useDiamondPublicClient` and `useDiamondContract` to
  consume the multi-provider.
- Settings page: per-chain RPC override UI.

**Effort:** 5–7 dev-days. Independent of pillars 4.1–4.3 — can
ship in parallel.

**Reference:** Uniswap's interface uses a multi-provider pattern
with at minimum 3 RPCs per chain plus the wallet provider. Aave
exposes the user-supplied-RPC setting prominently. Hyperliquid
documents their public RPC URL list publicly.

**Operator-node twin (Phase 0.5 #10).** The protocol team's
Oracle Cloud operator instance can run its own chain RPC nodes
for the testnet trio (Base / Arb / OP Sepolia), feeding into
the multi-RPC failover list as a self-hosted endpoint. ~30–50 GB
disk per testnet, ~1.5–2 GB combined RAM. Mainnet RPC sovereignty
doesn't fit Always Free's storage budget; that layer relies on
paid-tier + community RPC failover instead. See
`OperatorNodeDeploymentDesign.md` Phase 0.5 #10 for memory
budget and instance-sizing options.

### 4.5 Subgraph as a redundant indexer

**Concern:** today the frontend's "indexer" is a single
Cloudflare Worker + D1 instance. If that's down, every
indexer-backed view fails. Battle-tested DeFi platforms always
have at least one alternate indexer source.

**Today:** Worker → D1 is the only indexer. Frontend has no
GraphQL client, no subgraph subscription.

**Target:** a Vaipakam subgraph published to The Graph's
decentralised network (or Goldsky / Envio as alternatives),
exposing the same row shapes the Worker does. Frontend's list
hooks try the worker first, fall back to the subgraph on
worker error, fall back to direct chain RPC on subgraph error.

**Concrete steps:**

- Author the `subgraph.yaml` schema mirroring D1's tables.
- Author event handlers in AssemblyScript (or Goldsky's TS) that
  decode the same events the watcher's `chainIndexer.ts` does.
- Deploy to The Graph hosted-network (free) for validation,
  then to the decentralised network (signal Vaipakam's GRT to
  bootstrap indexers) at mainnet cutover.
- Add a `subgraphClient` layer to the frontend, with the failover
  chain.

**Effort:** 7–10 dev-days for schema + handlers + deployment +
frontend integration.

**Reference:** Uniswap, Aave, Compound, Lido, Balancer — every
major DeFi has a subgraph as the canonical "decentralised
indexer". The Graph + GraphQL is the de facto standard.

**Operator-node twin (Phase 0.5 #8).** The local Postgres mirror
indexer on the protocol team's operator node can expose an HTTP
API (`indexer.vaipakam.com`) with the same row shape as the
worker's `/offers/*`, `/loans/*`, `/activity/*` endpoints. That
becomes a third tier in the failover chain — Cloudflare Worker
→ The Graph subgraph → Operator-hosted indexer → Direct chain
RPC. ~50 MB additional RAM (Express / Fastify sidecar reading
from the existing Postgres connection pool). See
`OperatorNodeDeploymentDesign.md` Phase 0.5 #8.

### 4.6 IPFS hosting + ENS / DNSLink wiring

**Concern:** Cloudflare Workers Static Assets is one
centralised host. If it goes down or the operator's account is
suspended, the frontend is unreachable.

**Today:** `vaipakam.com` → Cloudflare Workers Static Assets;
`api.vaipakam.com` → Cloudflare Worker; frontend bundle built
locally and `wrangler deploy`'d. No IPFS pin, no ENS contenthash.

**Target:**

- Frontend bundle pinned to IPFS via a multi-pin strategy
  (Pinata + Web3.Storage + 4everland or similar) per release.
- ENS contenthash on `vaipakam.eth` updated to the latest CID
  via a small CI script.
- `_dnslink.vaipakam.com` TXT record mirrors the CID for
  traditional URL access.
- Cloudflare Workers Static Assets continues to serve the same
  bundle from the same CID for traditional DNS users — but the
  IPFS pin is the canonical artefact.
- A multi-gateway fallback in the frontend itself: if the page
  is loaded from `vaipakam.com` and the host returns 5xx for an
  asset, the page can dynamically load that asset from
  `cf-ipfs.com/ipfs/<CID>/...` because the CID is known at build
  time.

**Concrete steps:**

- Reproducible build: pin Node version, lockfile-only installs,
  deterministic timestamps, build inside Docker so the CID is
  deterministic per source commit.
- IPFS pin pipeline (GitHub Actions or local script):
  `npm run build` → tar dist/ → upload to multiple pin services
  → record CID in `frontend/dist/_release.json`.
- ENS contenthash update via `setContenthash` from a hardware
  wallet; one signature per release.
- DNSLink TXT update via Cloudflare DNS API; same script.
- Frontend service-worker registers the CID at install time so
  subsequent loads work fully offline.

**Effort:** 4–6 dev-days for pipeline + reproducible-build
discipline + first-release ceremony.

**Reference:** Uniswap (`uniswap.eth` resolves to an IPFS CID),
Aave (`aave.eth`), Sky (`sky.money` via DNSLink + IPFS),
Compound (`compoundfinance.eth`). The operational pattern is
mature and well-documented.

### 4.7 WebSocket / SSE event push (optional, additive)

**Concern:** polling at 30 s introduces 30 s lag between
on-chain event and visible-on-page state. For high-frequency
surfaces (OfferBook with many active offers) faster push would
be a meaningful UX win.

**Today:** polling only.

**Target:** a Cloudflare Worker durable-object endpoint that
holds open WebSocket connections, pushes the watcher's
already-decoded events to subscribed clients per-chain. Frontend
subscribes when available; on disconnect (mobile network,
hibernation, server restart), polls until reconnect.

**Concrete steps:**

- Worker durable-object code (one per chainId).
- Subscribe / unsubscribe protocol (chainId + topic union).
- Frontend `useLiveTailProvider` consumes WebSocket when
  available, falls back to polling automatically.
- Reconnection logic with exponential backoff.

**Effort:** 4–6 dev-days. Pure additive layer; current
architecture continues to work as the fallback.

**Reference:** dYdX / Hyperliquid run WebSocket APIs as primary
event channel. Uniswap V3 interface uses subgraph subscriptions
(also WebSocket-backed). 0x's RFQ orderbook is WebSocket.

**Operator-node twin (Phase 0.5 #9 / Phase 8b).** The
Cloudflare durable-object endpoint is the canonical primary
push path; a self-hosted twin runs on the protocol team's
operator node, sourcing events from the local Postgres mirror
via `LISTEN/NOTIFY` and fanning out to subscribed clients via
a small Node `ws` server. Frontend's WS-failover order:
Cloudflare WS (8a) → Operator-hosted WS (8b) → Polling
(canonical fallback). ~150–200 MB additional RAM. See
`OperatorNodeDeploymentDesign.md` Phase 0.5 #9.

### 4.8 Operator-side infrastructure (already designed)

**Concern:** keeper bot, reward-closer daemon, custom LZ DVN,
local mirror indexer, Postgres, Telegram alerts, Grafana.

**Today:** designed in `OperatorNodeDeploymentDesign.md`,
deferred until post-mainnet.

**Target:** that doc's Phase A–E sequence executed on Oracle
Cloud Always Free. Includes:
- `rewardCloser.ts` daemon in `vaipakam-keeper-bot` (real ops
  need; today operator-driven).
- Custom Vaipakam-branded LayerZero DVN (defense-in-depth
  beyond third-party DVN diversity).
- Local Postgres-mirrored indexer (latency win + Cloudflare-
  outage redundancy).
- Mempool / MEV watchdog, Telegram alerts daemon, Grafana
  dashboards (operator quality-of-life).

**Effort:** ~6–8 weeks calendar (1–2 weeks per phase), already
phase-sequenced in the operator-node doc.

**Reference:** see `OperatorNodeDeploymentDesign.md`.

### 4.9 Cross-chain security (already designed)

**Concern:** LayerZero V2's default 1-required / 0-optional DVN
shape is the configuration the April 2026 cross-chain bridge
exploit rode. Vaipakam needs operator-diverse DVN policy +
rate limits + pause levers.

**Today:** designed in `CLAUDE.md` "Cross-Chain Security" + the
contracts already enforce 3-required / 2-optional + 1-of-2
threshold; `ConfigureLZConfig.s.sol` wires it; `LZConfig.t.sol`
asserts every (OApp, eid) pair reflects the policy. BuyAdapter
rate limits enforced via the new `getRateLimits()` view + step
`[5d]` health check (today's Item 1).

**Target:** continue the policy as-is, plus add the custom
Vaipakam DVN from pillar 4.8 to push the operator-diversity
score to 4 corporate operators (LayerZero Labs + Google Cloud +
Polyhedra/Nethermind + Vaipakam itself) with a 1-of-2 threshold.

**Effort:** scoped in `OperatorNodeDeploymentDesign.md` Phase
C–D.

### 4.10 Governance + admin separation

**Concern:** today the deploy script's role-handover step `[6]`
is a 23-tx legacy ceremony; the new `transferAdmin` (Item 3
shipped today) makes it atomic. Mainnet needs multisig + timelock
+ operator separation.

**Today:** designed in `MainnetMultisigSetup.md`. Key roles
(`DEFAULT_ADMIN`, `PAUSER`, `KYC_ADMIN`) all transfer in lockstep
via `transferAdmin`; mainnet pattern moves `PAUSER` and
`KYC_ADMIN` to a dedicated ops Safe afterwards via
timelock-gated grants.

**Target:** Snapshot off-chain voting → on-chain Timelock
execution for protocol-config changes. Emergency single-sig
`pause()` retained on a dedicated emergency Safe (small,
well-known signer set, dedicated to defense). All other writes
go through the Timelock.

**Concrete steps:**

- Deploy `OZ TimelockController` per chain (24-hour delay
  initial; tunable via governance).
- Wire Snapshot proposal → transaction-payload export
  → Safe-gnosis-staged-execution.
- Reserve `PAUSER_ROLE` to the emergency Safe; everything else
  to the Timelock.

**Effort:** designed and partly land per `MainnetMultisigSetup.md`;
~3–5 days to wire Snapshot integration.

### 4.11 Observability + transparency

**Concern:** users need to see the platform's health without
having to grep the codebase or contact support.

**Today:** DiagnosticsDrawer + IndexerStatusBadge (shipped
today) cover the in-app surface; `journeyLog.ts` captures user-
visible failures and offers a Report-on-GitHub artefact;
verified contracts on every supported explorer.

**Target:** add three more transparency surfaces:

- **Public status page** at `status.vaipakam.com` (or static
  page on the IPFS bundle) — per-chain indexer cursor age,
  watcher health, RPC provider availability, last finalised
  block per chain. Static, refreshing every 30 s. Uses the same
  `/offers/stats` endpoint the frontend reads.
- **Forta agents** monitoring the diamond for sus patterns:
  rapid liquidation cascades, unusual offer-creation rates,
  concentrated borrower positions. Public and free for
  community to subscribe to.
- **OpenZeppelin Defender Sentinel** monitoring write-tx
  success rates, failed health-factor checks, oracle price
  divergence alerts.

**Effort:** 3–5 dev-days for the status page; Forta + Defender
are operator-side ceremonies (~1 day each).

**Reference:** Aave's `risk.aave.com`, Compound's `compound.finance/markets`,
Lido's `dashboard.lido.fi`. Public health pages are table stakes.

**Operator-node twin (Phase 0.5 #11).** The public status page
(`status.vaipakam.com`) is hosted on the protocol team's
operator node, NOT on Cloudflare — same logic as Pillar 4.6's
IPFS-hosting argument: the page that says "Cloudflare is
down" can't itself live on Cloudflare. Small Express + static-
asset surface, ~50 MB additional RAM. Reads aggregate state
from the local Postgres mirror + chain-RPC spot-checks. See
`OperatorNodeDeploymentDesign.md` Phase 0.5 #11.

### 4.12 Account abstraction + signature flows (future)

**Concern:** ERC-4337 wallets, sponsored gas, session keys —
all post-mainnet polish but worth designing for so we don't
build incompatible primitives.

**Today:** Permit2 already integrated (Phase 8b). Wallet
detection via `wagmi`'s connectors (covers MetaMask, Rabby,
Coinbase, WalletConnect, Frame).

**Target:**

- EIP-6963 multi-wallet detection (so users can pick between
  injected wallets without one stomping the other).
- ERC-4337 smart-account compatibility (Pimlico / Stackup /
  Biconomy bundlers + paymaster integration).
- Session keys for high-frequency keeper-bot-like operations
  performed by the user themselves (e.g. ranged-offer auto-
  refresh).

**Effort:** 2–3 weeks for ERC-4337 if we adopt it. Defer until
post-mainnet stable.

**Reference:** Aave Smart Wallet (Biconomy-backed),
Hyperliquid's session-key trading, Sky's smart-account
support.

---

## 5. Phased roadmap

Sequenced by dependency, not by calendar. Each phase is
flag-gated and independently rollback-able. Phases on the same
indentation level can run in parallel.

```
Phase 0 — Audit + design docs (2–3 days each, parallel-ish)
  ├── EventSourcingAudit.md
  ├── LiveTailProviderDesign.md
  ├── CacheStoreDesign.md
  ├── MultiRpcStrategyDesign.md
  ├── IPFSHostingPipelineDesign.md
  ├── SubgraphSchemaDesign.md
  └── WebhookOrPollingSurvey.md  (research/webhook-vs-polling-defi-survey branch)

Phase 0.5 — Operator-node integration addendum (no separate docs; updates two existing)
  ├── OperatorNodeDeploymentDesign.md gains "Phase 0.5 addendum" section
  │   covering 4 new operator-node responsibilities (Postgres HTTP API,
  │   self-hosted WS pipe, testnet RPC nodes, public status page)
  └── This anchor doc gains operator-node-twin paragraphs in Pillars
      4.4 / 4.5 / 4.7 / 4.11 — sovereign protocol-team infrastructure
      sits as a parallel path alongside hosted alternatives at every layer

Phase 1 — Contract event extensions (4–5 days)  [HARD MAINNET GATE]
  └── Solidity changes + audit re-pass

Phase 2 — Watcher decoder updates (2–3 days)  [parallel with Phase 3]
  └── ops/hf-watcher consumes extended events; drops redundant getDetails

Phase 3 — LiveTailProvider lift (5–7 days)  [parallel with Phase 2]
  └── Frontend consolidation; flag-gated migration

Phase 4 — IndexedDB cache layer (3–5 days)
  └── Builds on Phase 3

Phase 5 — Multi-RPC failover (5–7 days)  [independent; ship any time]
  └── User-supplied RPC + EIP-6963 + health-checked failover
       Operator-node twin: testnet self-hosted RPC nodes feeding into
       the failover list (Phase 0.5 #10).

Phase 6 — Subgraph deployment (7–10 days)  [independent; ship any time]
  └── Schema + handlers + deployment + frontend failover wiring
       Operator-node twin: Postgres HTTP API as third tier in the
       same failover chain (Phase 0.5 #8).

Phase 7 — IPFS hosting + ENS contenthash (4–6 days)
  └── Pin pipeline + reproducible build + ENS update + service worker
       Operator-node twin: Kubo daemon as a fourth pin provider
       (already in OperatorNodeDeploymentDesign.md).

Phase 8 — WebSocket push  [SPLIT 8a + 8b]
  ├── 8a (4–6 days) — Cloudflare Worker durable-object endpoint;
  │       canonical primary push path. Frontend tries 8a first.
  └── 8b (3–4 days) — Operator-node WS twin (Phase 0.5 #9).
          Self-hosted Node WS server reading Postgres LISTEN/NOTIFY,
          fanning out to subscribed clients. Independent of Cloudflare.
          Frontend falls through to 8b on 8a disconnect, then to
          polling on 8b disconnect.

Phase 9 — Status page + Forta + Defender (3–5 days)
  └── Public observability surfaces
       Operator-node twin: status.vaipakam.com hosted on the operator
       node decouples the status surface from Cloudflare (Phase 0.5
       #11) — same logic as Pillar 4.6 (the page that says
       "Cloudflare is down" can't itself live on Cloudflare).

Phase 10 — Account abstraction (2–3 weeks, deferred until post-mainnet)
  └── EIP-6963 + ERC-4337 + session keys
```

**Critical-path items**: Phase 0 → Phase 1 → mainnet rehearsal
re-cut. Phase 1 is the only mainnet-blocking item. Everything
else can land before OR after mainnet.

**Total pre-mainnet effort estimate**: ~6–8 calendar weeks for
Phases 0–8 if they're sequenced; ~4–5 weeks if Phases 5 and 6
run in parallel with Phases 2–4.

---

## 6. Risk-management strategy

Three principles applied at every phase:

### 6.1 Current architecture is the fallback at every step

- Phase 1 (contract event extensions) is the only
  non-reversible step. Designed in Phase 0 to keep gas-cost
  changes per event below 80 k; events that don't need
  extension are skipped.
- Phase 3 (LiveTailProvider lift) is gated behind
  `VITE_LIVE_TAIL_PROVIDER_ENABLED`. Per-hook scanners stay in
  place until each subscriber is migrated and verified.
- Phase 5 (multi-RPC) keeps the existing single-RPC env vars
  working as the primary on each chain; the failover list is
  additive.
- Phase 6 (subgraph) keeps the worker as the primary source;
  subgraph is the second-tier fallback.
- Phase 7 (IPFS) keeps `vaipakam.com` (Cloudflare-served) as the
  primary URL; IPFS is the alternate access path, not a
  replacement.
- Phase 8 (WebSocket) is a pure additive layer over polling.

A single `git revert` on any phase rolls back without affecting
any later phase that hasn't depended on it.

### 6.2 Audit re-pass scope is budgeted

Phase 1 is the only contract change. Budget ~1 week of audit
calendar between Phase 1 lands and the next mainnet rehearsal.
Phase 0's `EventSourcingAudit.md` includes the gas-cost +
storage-shape impact of every proposed extension, so the audit
firm has a focused diff to review.

### 6.3 Per-feature observability before turn-on

Every phase ships with a diagnostic surface BEFORE the feature
is enabled in default mode. Specifically:

- LiveTailProvider's watermark visible in the
  ChainDiagnosticsPanel (already shipped today).
- IndexedDB cache hit/miss counters accessible in advanced-mode
  drawer.
- Multi-RPC current-active-provider visible per chain.
- Subgraph query latency vs Worker query latency visible in
  the panel.
- WebSocket connection state visible (connected / reconnecting
  / fallback-polling).
- IPFS-served vs gateway-served vs CF-served origin visible
  ("you are reading from: ipfs://CID via cf-ipfs.com").

The pattern is: "any time the system has a fallback path, the
operator can see which path is actually serving them."

---

## 7. Open questions to resolve before phase kickoff

1. **Which subgraph network?** The Graph decentralised network
   (requires GRT signal, ~2-week-warm indexer participation
   ramp) vs Goldsky (paid, faster onboard) vs Envio (newer,
   cheaper, less battle-tested) vs hosted-only mirror. **Default
   recommendation: deploy to The Graph hosted-network for
   Phase 6 validation, plan decentralised migration for
   post-mainnet.**
2. **Which IPFS pin services?** Multi-pin redundancy is
   industry standard; the question is which 2–3 to use.
   **Default recommendation: Pinata (paid; reliable) +
   Web3.Storage (free tier; back-pinned by Filecoin) +
   4everland (community-friendly).**
3. **Reproducible-build target?** Docker-pinned Node + lockfile-
   only install + `SOURCE_DATE_EPOCH` for deterministic
   timestamps. **Default recommendation: yes; one-time setup
   pays off across every release.**
4. **Account abstraction on the critical path?** Adopting
   ERC-4337 is a meaningful UX upgrade but adds bundler /
   paymaster operational overhead. **Default recommendation:
   defer to post-mainnet stable; design now to not exclude it.**
5. **Per-chain RPC provider list?** Vaipakam needs at least
   3–5 fallbacks per chain. Mainnet candidates: Alchemy,
   Infura, QuickNode, Ankr, dRPC, Llamarpc, plus the chain's
   own public RPC. **Default recommendation: 1 paid (Alchemy
   or Infura) + 2 community public + the wallet-injected
   provider.**
6. **Worker durable-object durability?** Cloudflare durable
   objects have a per-region edge model; cross-region failover
   has subtle behaviour. **Default recommendation: deploy to
   the chain's nearest region (Base & OP → us-east, Arb →
   us-east, Ethereum mainnet → us-east, BNB / Polygon zkEVM →
   eu-west or asia-east depending on user distribution).**
7. **Status page hosting?** Static page on the IPFS bundle vs
   separate static-site origin. **Default recommendation:
   bundled with the main IPFS pin so it's available at the
   same CID; separate route within the bundle.**

---

## 8. Cross-references

- `docs/DesignsAndPlans/OperatorNodeDeploymentDesign.md` — pillar
  4.8 in detail (keeper bot, reward closer, custom DVN, local
  indexer, Postgres, Telegram, Grafana on Oracle Cloud Always
  Free).
- `docs/DesignsAndPlans/MEVProtection.md` — supporting design
  for pillar 4.4 (MEV-protected RPCs).
- `docs/DesignsAndPlans/RangeOffersDesign.md` — Phase 1
  implementation that motivated some of the read-side
  consolidation work.
- `docs/ops/MainnetMultisigSetup.md` — pillar 4.10 in detail.
- `docs/ops/DeploymentRunbook.md` — current deploy + verification
  flow that every phase change has to honour.
- `docs/ops/IncidentRunbook.md` — incident-response procedures
  that pillar 4.11's status page + Forta agents feed.
- `CLAUDE.md` "Cross-Chain Security" — pillar 4.9 policy.
- `frontend/src/lib/logIndex.ts` — the existing 23-topic-OR
  scanner that pillar 4.2's LiveTailProvider generalises.
- `ops/hf-watcher/src/chainIndexer.ts` — the source pattern for
  pillar 4.5's subgraph handlers (same decoder logic, different
  runtime).

---

## 9. Document discipline

This doc is the **anchor**. Each phase lands its own detailed
sub-design when work on that phase begins; each release notes
file references which pillars + phases shipped in that day's
work. The roadmap section is updated when a phase completes
(strikethrough the phase line + add the merge commit hash).
This keeps the strategic view and the tactical view in sync
without one stale-ing the other.

When the roadmap is fully executed, this doc gets a closing
section noting which phases shipped, which were skipped (and
why), and the consolidated end-state. At that point the
underlying pillars become "the architecture" rather than "the
target architecture", and new design docs are anchored to the
specific surface they touch rather than back to this strategy
doc.
