# Operator Node Deployment — Self-Hosted Infrastructure Design

**Status:** Deferred. Captures the deployment plan for the
`vaipakam-keeper-bot` and adjacent self-hosted operator services. We
will return to this after closing out the immediate testnet-burn-in
work and the mainnet pre-flight tasks.

**Last updated:** 2026-05-05.

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

## Memory budget summary (6 GB instance)

| Process              | RSS estimate              |
| -------------------- | ------------------------- |
| keeper-bot           | ~200 MB                   |
| reward-closer (new)  | ~150 MB                   |
| LZ DVN (6 chains)    | ~2.5 GB                   |
| local indexer        | ~200 MB                   |
| Postgres             | ~400 MB                   |
| Telegram alerts      | ~100 MB                   |
| Grafana + Prometheus | ~600 MB                   |
| **Total resident**   | **~4.2 GB / 6 GB (~70%)** |

Comfortably above the 20% memory reclamation floor. CPU averages
5-15% with occasional bursts on liquidation / DVN message arrival —
well above the 20% CPU floor too. Network ~10-50 GB/month, far
below the 10 TB cap.

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
