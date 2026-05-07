# Subgraph Schema Design — Decentralised Indexer Redundancy

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.5.
Phase 6 of the platform-optimisation roadmap implements this.

**Last updated:** 2026-05-07.

**Goal:** publish a Vaipakam subgraph mirroring the watcher's
D1 schema, so the frontend has a battle-tested decentralised
fallback indexer when the Cloudflare Worker is unreachable.
Every read path becomes a three-tier failover: Worker (fastest)
→ Subgraph (decentralised, slightly slower) → direct chain RPC
(bottom).

---

## 1. Why a subgraph

Today, the Cloudflare Worker → D1 pipeline is the only
indexer source. Outage = no indexer-backed view. The user's
fallback path is direct RPC reads, which work but are slower
per page.

The Graph (and equivalents — Goldsky, Envio, Substreams) is
the de-facto standard for decentralised indexing in DeFi.
Every major protocol — Uniswap, Aave, Compound, Lido,
Balancer, Curve, Sky — has subgraphs. The infrastructure is
mature, the GraphQL shape is familiar, and at least one
deployment is hosted by The Graph's decentralised network so
no single operator's outage breaks the read.

For Vaipakam:

- **Redundancy** — second indexer source independent of
  Cloudflare.
- **Decentralisation** — at mainnet, signal GRT to the
  decentralised network so multiple indexer operators serve
  the same subgraph.
- **Discoverability** — third-party tools (Zerion, DefiLlama,
  Token Terminal) commonly consume subgraphs to surface
  protocols. A Vaipakam subgraph gets us in those tools'
  graphs at low marginal cost.

---

## 2. Schema design

The subgraph entities mirror D1's `offers`, `loans`,
`activity_events`, and `indexer_cursor` tables. GraphQL
schema in `subgraph.graphql`:

```graphql
type Offer @entity {
  id: ID!                          # `${chainId}-${offerId}`
  chainId: Int!
  offerId: BigInt!
  status: OfferStatus!
  creator: Bytes!
  offerType: OfferType!
  lendingAsset: Bytes!
  amountMin: BigInt!
  amountMax: BigInt!
  amountFilled: BigInt!
  interestRateBpsMin: Int!
  interestRateBpsMax: Int!
  durationDays: Int!
  collateralAsset: Bytes!
  collateralAmount: BigInt!
  periodicInterestCadence: Int!
  allowsPartialRepay: Boolean!
  keeperAccessEnabled: Boolean!
  createdAt: BigInt!               # block timestamp
  createdAtBlock: BigInt!
  updatedAtBlock: BigInt!          # for live-tail reconciliation
  acceptedLoanId: BigInt           # set on accept
  cancelledAt: BigInt              # set on cancel
}

enum OfferStatus { Active Filled Cancelled Expired Closed }
enum OfferType  { Lender Borrower }

type Loan @entity {
  id: ID!                          # `${chainId}-${loanId}`
  chainId: Int!
  loanId: BigInt!
  status: LoanStatus!
  lender: Bytes!
  borrower: Bytes!
  lendingAsset: Bytes!
  principal: BigInt!
  outstandingPrincipal: BigInt!
  interestRateBps: Int!
  durationDays: Int!
  graceDays: Int!
  collateralAsset: Bytes!
  collateralAmount: BigInt!
  liqThresholdBps: Int!
  maxLtvBpsAtInit: Int!
  startTimestamp: BigInt!
  dueTimestamp: BigInt!
  lastRepaidAt: BigInt
  lenderTokenId: BigInt!
  borrowerTokenId: BigInt!
  lenderClaimed: Boolean!
  borrowerClaimed: Boolean!
  matcher: Bytes                   # range-orders matcher
  fromOffer: Offer!                # reverse relation
  events: [ActivityEvent!]! @derivedFrom(field: "loan")
  createdAtBlock: BigInt!
  updatedAtBlock: BigInt!
}

enum LoanStatus { Active Settled Defaulted Liquidated SettledViaDefault }

type ActivityEvent @entity(immutable: true) {
  id: ID!                          # `${chainId}-${blockNumber}-${logIndex}`
  chainId: Int!
  eventType: EventType!
  blockNumber: BigInt!
  blockTimestamp: BigInt!
  transactionHash: Bytes!
  loan: Loan
  offer: Offer
  actor: Bytes
  amount: BigInt
  payload: Bytes                   # ABI-encoded for type-specific decoders
}

enum EventType {
  OfferCreated
  OfferAccepted
  OfferCancelled
  OfferMatched
  LoanInitiated
  LoanRepaid
  PartialRepaid
  LoanDefaulted
  LoanSettled
  LenderFundsClaimed
  BorrowerFundsClaimed
  CollateralAdded
  LoanSold
  LoanObligationTransferred
  LiquidationFallback
  VPFIPurchased
  VPFIDeposited
  VPFIWithdrawn
  BorrowerLifRebateClaimed
  StakingRewardsClaimed
  InteractionRewardsClaimed
}

type ProtocolMetric @entity {
  id: ID!                          # `${chainId}`
  chainId: Int!
  totalOffersCreated: Int!
  totalLoansInitiated: Int!
  activeLoansCount: Int!
  totalPrincipalLent: BigInt!
  totalInterestPaid: BigInt!
  lastIndexedBlock: BigInt!
  lastIndexedAt: BigInt!
}
```

The shape is DELIBERATELY close to D1's row shape so the
frontend's `subgraphClient` adapter can present the same row
shape upstream consumers (`useMyOffers`, `useIndexedLoans`,
etc.) already expect.

---

## 3. Event handlers (AssemblyScript)

The Phase 1 contract event extensions (see
`EventSourcingAudit.md`) make the subgraph handlers simple —
event payloads carry the full state, so the handler just
reads from `event.params` and writes to the entity.

Handler shape per event:

```typescript
// src/mappings/offer.ts
export function handleOfferCreated(event: OfferCreated): void {
  let id = entityId(event.address, event.params.offerId);   // chainId from manifest
  let offer = new Offer(id);
  offer.chainId = CHAIN_ID;
  offer.offerId = event.params.offerId;
  offer.status = "Active";
  offer.creator = event.params.creator;
  offer.offerType = decodeOfferType(event.params.offerType);
  offer.createdAt = event.block.timestamp;
  offer.createdAtBlock = event.block.number;
  offer.updatedAtBlock = event.block.number;
  // The companion OfferCreatedDetails event (see Phase 1) fires
  // in the same tx; AS handler order is deterministic, so we fill
  // the detail fields when that handler fires below.
  offer.save();
}

export function handleOfferCreatedDetails(event: OfferCreatedDetails): void {
  let id = entityId(event.address, event.params.offerId);
  let offer = Offer.load(id);
  if (offer == null) return;     // shouldn't happen; defensive
  offer.lendingAsset = event.params.lendingAsset;
  offer.amountMin = event.params.amountMin;
  offer.amountMax = event.params.amountMax;
  offer.amountFilled = BigInt.zero();
  offer.interestRateBpsMin = event.params.interestRateBpsMin.toI32();
  offer.interestRateBpsMax = event.params.interestRateBpsMax.toI32();
  offer.durationDays = event.params.durationDays.toI32();
  offer.collateralAsset = event.params.collateralAsset;
  offer.collateralAmount = event.params.collateralAmount;
  offer.periodicInterestCadence = event.params.periodicInterestCadence.toI32();
  offer.allowsPartialRepay = event.params.allowsPartialRepay;
  offer.keeperAccessEnabled = event.params.keeperAccessEnabled;
  offer.save();
}

export function handleOfferAccepted(event: OfferAccepted): void {
  let id = entityId(event.address, event.params.offerId);
  let offer = Offer.load(id);
  if (offer == null) return;
  offer.amountFilled = event.params.newAmountFilled;       // from extension
  offer.status = decodeOfferStatus(event.params.newStatus);
  offer.acceptedLoanId = event.params.loanId;
  offer.updatedAtBlock = event.block.number;
  offer.save();
  // Activity event log
  let act = new ActivityEvent(activityId(event));
  act.chainId = CHAIN_ID;
  act.eventType = "OfferAccepted";
  act.blockNumber = event.block.number;
  act.blockTimestamp = event.block.timestamp;
  act.transactionHash = event.transaction.hash;
  act.offer = id;
  act.actor = event.params.acceptor;
  act.amount = event.params.matchAmount;
  act.save();
}

// LoanInitiated + LoanInitiatedDetails follow the same pattern —
// bare event creates the entity, Details event fills the rest.
```

Total handler LOC: ~600–800 across 15–20 events. Each handler
is mechanical given Phase 1's self-sufficient event payloads.

---

## 4. Subgraph manifest

`subgraph.yaml` declares one data source per chain — initially
testnet (Base / Arb / OP Sepolia), mainnet versions added per
chain as Phase 1 contract event extensions land per-chain.

```yaml
specVersion: 1.0.0
description: Vaipakam — P2P lending + borrowing + NFT rental
repository: https://github.com/vaipakam/vaipakam-subgraph
schema:
  file: ./schema.graphql

dataSources:
  - kind: ethereum/contract
    name: VaipakamDiamond
    network: base-sepolia
    source:
      address: "0x..."                # filled per-chain at deploy
      abi: VaipakamDiamond
      startBlock: 41100000             # close to deploy block
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      file: ./src/mappings/index.ts
      entities:
        - Offer
        - Loan
        - ActivityEvent
        - ProtocolMetric
      abis:
        - name: VaipakamDiamond
          file: ./abis/VaipakamDiamond.json
      eventHandlers:
        - event: OfferCreated(indexed uint256, indexed address, uint8)
          handler: handleOfferCreated
        - event: OfferCreatedDetails(...)
          handler: handleOfferCreatedDetails
        - event: OfferAccepted(...)
          handler: handleOfferAccepted
        # ~18 more event handlers
```

One subgraph deployment per chain. Chain ID is bound at deploy
time; entities all carry `chainId` so the frontend can query
across chains via separate subgraph instances.

---

## 5. Deployment plan

### 5.1 Hosted-network validation (testnet)

The Graph hosted-network (free for testnet subgraphs):

```
graph deploy --product hosted-service vaipakam/vaipakam-base-sepolia
```

Frontend's `subgraphClient` points at hosted-network endpoints
during testnet validation. ~1 day to deploy + smoke-test
queries from the frontend.

### 5.2 Decentralised network (mainnet)

For each mainnet chain:

```
graph deploy --product subgraph-studio vaipakam/vaipakam-base
graph publish vaipakam/vaipakam-base
```

Then signal GRT (via Subgraph Studio UI) so indexer operators
serve it. Initial signal: ~1000 GRT (~ a few hundred dollars
at typical GRT prices) per chain to bootstrap indexer
participation.

Decentralised-network endpoint becomes:
`https://gateway.thegraph.com/api/<api-key>/subgraphs/id/<deployment-id>`

### 5.3 Frontend integration

`frontend/src/lib/subgraphClient.ts` — small GraphQL client
(no Apollo / urql; just `fetch` + types). Same row shapes as
the worker's `/offers/*` and `/loans/*` REST responses, so the
list hooks switch source via a thin adapter without changing
their consumer-side shape.

Failover order in each list hook:

```
1. Cloudflare Worker → D1                    (fastest, primary)
2. Subgraph (decentralised network)          (decentralised fallback)
3. Direct chain RPC + Multicall3              (always-available bottom)
```

The hooks try (1); on any error, try (2); on any error, try
(3). All three return the same row shape via adapter.

---

## 6. Open questions

1. **Subgraph network choice** — Graph decentralised vs
   Goldsky vs Envio vs hosted-only?
   Recommendation: hosted-network (Graph) for Phase 6
   validation; decentralised-network at mainnet cutover.
   Goldsky / Envio as second-tier alternatives if Graph's
   onboarding ramp is too slow.
2. **Event extension dependency** — Phase 6 is much simpler if
   Phase 1 (event extensions) lands first. Should we gate
   Phase 6 on Phase 1?
   Recommendation: yes — defer subgraph deployment until
   Phase 1's events are deployed on at least one chain. Saves
   reworking handlers when event shapes change.
3. **Per-chain vs cross-chain subgraph** — the Graph supports
   one chain per subgraph natively; cross-chain merging is
   client-side?
   Recommendation: per-chain. Frontend already handles
   per-chain queries via the existing chainId-keyed worker
   API. Same pattern.
4. **Historical backfill cost** — initial sync of ~10M blocks
   per chain takes ~6–24 hours of indexer time?
   Recommendation: accept; it's a one-time cost per chain
   per deployment. The hosted-network handles the heavy
   lifting; we just wait for the indexer to catch up.
5. **API-key rotation** — Graph's gateway requires a paid
   API key for production rate limits.
   Recommendation: protocol team holds the API key; embed
   in the frontend at build time (it's a public read-only
   key, low security risk). Rotate every 90 days as a
   hygiene practice.

---

## 7. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar
  4.5 (parent).
- `DesignsAndPlans/EventSourcingAudit.md` — handler simplicity depends
  on Phase 1's self-sufficient events landing first.
- `DesignsAndPlans/CacheStoreDesign.md` — subgraph queries feed the
  same merge handler as worker / live-tail; consumer-side
  contract is identical.
- `ops/hf-watcher/src/chainIndexer.ts` — source decoder logic
  the AS handlers mirror (different runtime, same semantics).
- `ops/hf-watcher/migrations/` — D1 schema the subgraph
  schema mirrors.
- Industry refs: Uniswap V3 subgraph
  (`/subgraphs/name/uniswap/uniswap-v3`), Aave V3 subgraph,
  Compound subgraph; The Graph's docs on the AS mapping API.
