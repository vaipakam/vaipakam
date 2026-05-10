# Event Sourcing Audit — Vaipakam Solidity Events

**Status:** Draft 2026-05-07. Sub-design under
`DesignsAndPlans/DecentralizedPlatformArchitecture.md` Pillar 4.1
("Self-sufficient on-chain events"). Phase 1 of the platform-
optimisation roadmap reads this doc to decide which events to
extend before the next mainnet rehearsal.

**Last updated:** 2026-05-07.

**Goal:** classify every external-emitted Solidity event as
**self-sufficient** (consumers can update a cached row entirely
from event payload) or **delta-only** (consumers must follow up
with a `getOfferDetails` / `getLoanDetails` view-call to
reconstruct full state). For delta-only events, decide per-event
whether to extend the payload (gas tax) or accept the follow-up
view-call (RPC tax).

---

## 1. Audit methodology

For each event, four questions decide the outcome:

1. **Hot-path?** Is this event consumed by a frontend list-hook
   subscriber, the watcher's row-hydration logic, OR a subgraph
   schema field that's rendered to a user? Hot-path events live
   on the read critical path; their gas-cost extensions are
   worth paying because they save N RPC calls per event seen
   across every consumer.
2. **What storage fields change** when this event fires? Anything
   the consumer's cached row needs to keep current.
3. **What's emitted today?** Topic-indexed fields + non-indexed
   ABI-encoded `data` fields.
4. **Storage-field gap?** The set of fields in (2) that aren't
   in (3). If the gap is empty, the event is already
   self-sufficient — no work. If it's non-empty, decide
   extend / skip per gas-cost rules below.

### 1.1 Gas-cost rule of thumb

- **One uint256 added** to a non-indexed event payload ≈ +6 800
  gas (32 bytes of `data` + ABI-encoding overhead).
- **One uint8 added** ≈ +6 800 gas (still padded to 32 bytes
  in encoded calldata).
- **One address added** ≈ +6 800 gas.
- **One bool added** ≈ +6 800 gas.
- **An indexed field** ≈ +600 gas vs an extra unindexed slot
  (4 topics max — usually already saturated for hot-path events).
- A 5-field extension to a hot-path event costs ~34 k extra gas
  per emit. On `acceptOffer` (hot path) emitting once per offer,
  ~34 k is ~10–25 % of total tx gas — material but not
  prohibitive.

### 1.2 Extend / skip decision rules

| Condition | Decision |
|---|---|
| Gap is empty | Already self-sufficient. **No change.** |
| Hot-path AND gap > 0 | **Extend** with the missing fields; the saved RPC calls dominate. Cap at +50 k gas per event. |
| Cold-path (admin / config) AND gap > 0 | **Skip.** The follow-up `getDetails` call is rare; gas tax not justified. Document the gap so consumers know to re-fetch. |
| Hot-path BUT extending blows the +50 k cap | **Partial extend** — emit the most-frequently-read subset of missing fields, accept follow-up for the rare-read tail. |
| Field is **derived** (computed from elapsed time, e.g. accrued interest) | Cannot be event-sourced. Consumer must read live. **Document.** |

### 1.3 Special cases

- **Topic budget**: max 4 topics (1 signature + 3 indexed). When
  extending an event, indexed topics that already saturate
  must NOT be moved to non-indexed (would break filter shapes
  used by indexers). Add to non-indexed `data` only.
- **`OfferCanceledDetails` precedent**: this event was added
  alongside `OfferCanceled` precisely to give cancelled-offer
  consumers a self-sufficient payload while keeping
  `OfferCanceled`'s narrow shape for legacy consumers. The same
  pattern (a `*Details` companion event) is available for any
  hot-path event whose extension would break a published
  topic-filter shape.

### 1.4 What NOT to emit (no-redundant-metadata rule)

Fields already carried in the event-log envelope or the
transaction receipt MUST NOT be added to event payloads —
consumers extract them from the log/tx without paying gas at
emit time. Adding them as payload fields is a ~6 800-gas tax for
zero new information.

The rule covers:

- **Block timestamp.** Extracted from `eth_getBlockByHash(blockHash)`
  on every log envelope. Watcher's `chainIndexer.ts` already
  populates `block_timestamp` on every D1 row this way. Means
  fields like `defaultedAt`, `lastRepaidAt`, `cancelledAt`,
  `acceptedAt`, `settledAt` etc. are **redundant** when their
  intended value is "the block in which this event fired".
- **Block number / hash / transaction hash / transaction index /
  log index.** All in the log envelope already.
- **Sender (`msg.sender`).** Carried in the transaction envelope
  (`tx.from`). Don't re-emit unless the sender is NOT the
  semantically-meaningful actor (rare — e.g., a relayer / keeper
  acting on behalf of a different user; in that case emit the
  meaningful actor as a distinct field).
- **Pure derivations of other emitted fields.** If the consumer
  can compute it from already-emitted fields, don't emit it.
  Example: `totalDebt = principal + accruedInterest + lateFee`
  with all three emitted — total is redundant.

**Future-block timestamps are NOT redundant** — `dueTimestamp`,
`graceEndsAt`, `nextInterestPaymentAt` etc. point to blocks that
DON'T exist yet and can't be inferred from the emit envelope. Keep
those in payloads.

### 1.5 Two-category event model — state-change vs informational

Every Vaipakam event falls into one of two categories. The
category determines payload discipline AND who consumes it:

| Category | Emitted when | Topics (indexed) | Non-indexed `data` | Consumed by |
|---|---|---|---|---|
| **state-change** | After a storage mutation that consumers' cached rows must reflect | Primary key(s) of the mutated entity (offerId / loanId / tokenId) | The fields whose storage values just changed, with their **new** values | Indexer + cache merge — cached row updates from this event alone, no follow-up view-call needed |
| **informational** | At notable flow steps that no consumer-cache field reflects | Primary key (loanId / offerId) — **only**; rich payload would duplicate on-chain storage | Empty in the common case (primary-key-only); a few config events carry the new value if reading it back is awkward | The live indexer **MAY safely ignore them entirely**; archive / forensics tools + tests still see them in the log stream. Anyone needing the values reads the on-chain storage by primary key on demand. |

#### Naming + structural rules

1. **One state-change event per storage transition.** If a
   function takes two distinct paths whose terminal storage
   states differ, those are two distinct state-change events
   with different names — not one event with a payload field
   that disambiguates the path. The event's NAME carries the
   transition; the PAYLOAD carries the new values.

   *Example*: `markDefaulted` has two terminal paths today —
   swap-failure leaves `loan.status = FallbackPending`,
   swap-success leaves `loan.status = Defaulted`. Both currently
   emit `LoanDefaulted`, which is a misnomer in the swap-failure
   case. Under this rule:
   - swap-failure path emits `LoanFallbackPending` (state-change
     event for the `Active → FallbackPending` transition)
   - swap-success path emits `LoanDefaulted` (state-change event
     for the `Active/FallbackPending → Defaulted` transition)

2. **State-change event names match the verb of the storage
   mutation.** `LoanDefaulted` (status=Defaulted), `LoanRepaid`
   (status=Settled or status=Active with reduced principal),
   `OfferAccepted` (offer.amountFilled+=, offer.status maybe
   flipped to Filled), `LoanFallbackPending`
   (status=FallbackPending). The reader can predict the storage
   transition from the event name.

3. **Informational events do NOT mirror the changed-field set.**
   That's the state-change event's job. Informational events
   describe HOW the flow unfolded, with values that aren't part
   of the consumer's cached row.

   *Example*: `LiquidationFallback(loanId, lender,
   collateralAmount)` and `LiquidationFallbackSplit(loanId,
   lenderCol, treasuryCol, borrowerCol)` are informational —
   they describe the collateral allocation that the fallback
   produced. The actual storage change (status flip) is
   captured by the corresponding state-change event
   (`LoanFallbackPending` per rule 1).

4. **Indexed primary keys**: state-change events MUST index the
   primary key of the mutated entity so consumers can subscribe
   per-entity. Informational events SHOULD index the primary key
   too (cheap; aids debugging) but MAY skip if no entity is the
   subject (e.g., global config changes).

5. **One emit per state transition per entity.** Even if the
   transition is reached through multiple control-flow branches,
   factor the emit so it fires exactly once per transition. Two
   identical emit sites for the SAME storage state-end are a
   signal to refactor — pull the emit into a shared post-
   transition path.

#### Cache-merge contract

The IndexedDB cache (see `DesignsAndPlans/CacheStoreDesign.md`) and the
subgraph (see `DesignsAndPlans/SubgraphSchemaDesign.md`) BOTH consume
state-change events directly. The contract:

- Receive event → look up cached row by primary key.
- Merge non-indexed payload fields into the row, replacing the
  named fields' values.
- Set `row.updatedAtBlock = event.blockNumber`.
- If the row didn't exist (and the event is a creation event):
  construct the row from the event's payload (which IS the full
  initial state per state-change-event discipline) and INSERT.
- If the row didn't exist and the event is a non-creation
  state-change: lazy-fetch via `getOfferDetails` /
  `getLoanDetails` view-call and merge.

**Informational events: the indexer ignores them.** This rule is
strict — the live indexer's dispatch table maps every
`informational/*` event to a no-op handler. Two reinforcing
reasons:

1. **The state-change companion already covers the timeline.**
   Every informational event in our codebase fires in the SAME
   transaction as a state-change event for the same primary key
   (e.g. `LiquidationFallback` + `LoanFallbackPending`). The
   state-change handler creates the activity-log entry and merges
   the cached row. A second activity row from the informational
   event would duplicate that.
2. **Rich values live in on-chain storage.** Informational events
   carry only the primary key (per the table above). Anything a
   consumer might want — collateral split, settlement breakdown,
   refinance terms — is in `s.fallbackSnapshot[loanId]`,
   `s.settlementBreakdown[loanId]`, etc., and is reachable via
   one `eth_call` when (and only when) a UI surface actually
   renders it. Pre-caching that data in D1 / IndexedDB would
   speculatively duplicate storage that most users never read.

The informational events still exist in the ABI for archive
log-scanners (forensics, "show every fallback that fired in
2026-Q2"), test asserts, and any future consumer that wants
in-stream signaling without a chain read. The live indexer just
skips them.

#### Per-event marker — `@custom:event-category` natspec tag

Every external-emitted Solidity event MUST carry a
`@custom:event-category` natspec tag that the Solidity compiler
persists into the contract's compiled artifact metadata
(`devdoc.events`). This is **machine-readable** — consumers
(watcher D1 dispatcher, frontend cache-merge, subgraph handlers)
read it from `contracts/out/<Facet>.sol/<Facet>.json` at startup
and dispatch programmatically without hardcoded conditionals.

```solidity
/// @notice Lender claimed their share of loan settlement.
/// @dev Mutates s.loans[loanId].lenderClaimed (true); burns the
///      lender NFT once both sides have claimed.
/// @custom:event-category state-change/claim-mutation
event LenderFundsClaimed(...);

/// @notice A liquidation fallback split was computed.
/// @dev Describes HOW the collateral split unfolded; the actual
///      storage transition (Active → FallbackPending) is in
///      `LoanFallbackPending`.
/// @custom:event-category informational/liquidation
event LiquidationFallbackSplit(...);
```

The tag's value is a **two-level path** matching the taxonomy
in `§1.5.1` below.

#### §1.5.1 Taxonomy — exactly two levels (`top/leaf`)

15 leaf categories total: 7 state-change + 8 informational.
Two levels deep deliberately — depth 3+ duplicates info already
in the ABI (contract name) or in event-to-handler routing
(function name). Wildcard / glob queries against the leaf
prefix cover the realistic consumer needs.

| Leaf category | Used for | Examples |
|---|---|---|
| `state-change/loan-mutation` | Any storage mutation on `s.loans[loanId]` | `OfferAccepted`, `LoanInitiated`, `LoanInitiatedDetails`, `LoanRepaid`, `PartialRepaid`, `LoanFallbackPending`, `LoanDefaulted`, `LoanLiquidated`, `LoanSettled`, `LoanSold`, `LoanObligationTransferred`, `CollateralAdded` |
| `state-change/offer-mutation` | Storage mutation on `s.offers[offerId]` | `OfferCreated`, `OfferCreatedDetails`, `OfferCancelled`, `OfferCanceledDetails`, `OfferMatched`, `OfferClosed` |
| `state-change/escrow-mutation` | Storage mutation on user-escrow state (VPFI balance, escrow proxy lifecycle) | `VPFIPurchasedWithETH`, `VPFIDepositedToEscrow`, `VPFIWithdrawnFromEscrow`, `EscrowDeployed`, `EscrowUpgraded` |
| `state-change/nft-mutation` | Position-NFT lifecycle (mint / Transfer / status / burn) | `Transfer` (ERC-721), `NFTStatusUpdate`, `NFTMinted`, `NFTBurned` |
| `state-change/treasury-mutation` | Treasury balance mutations | `TreasuryFeeAccrued`, `TreasuryClaimed` |
| `state-change/claim-mutation` | Lender / borrower claim flag flips | `LenderFundsClaimed`, `BorrowerFundsClaimed` |
| `state-change/reward-claim` | User-VPFI reward claims | `StakingRewardsClaimed`, `InteractionRewardsClaimed`, `BorrowerLifRebateClaimed` |
| `informational/admin` | Role / pause / TOS / KYC-admin lifecycle | `AdminTransferred`, `RoleGranted`, `RoleRevoked`, `Paused`, `Unpaused`, `AutoPaused`, `KycAdminTransferred`, `TosUpdated` |
| `informational/config` | Governance-config setters (BPS, caps, thresholds, asset config, oracle / liquidity setters, BuyAdapter rate-limits, sanctions-oracle setter) | `MaxOfferDurationDaysSet`, `LiqThresholdBpsSet`, `BuyAdapter.RateLimitsSet`, `OracleAdapterSet`, etc. |
| `informational/liquidation` | Marks the fallback / liquidation flow path. Indexer ignores. Split values live in `s.fallbackSnapshot[loanId]`, accessible by `eth_call` if a consumer needs them; the storage transition is captured by the `state-change/loan-mutation` companion. | `LiquidationFallback`, `LiquidationFallbackSplit` |
| `informational/claim` | Marks claim-retry / fallback execution. Indexer ignores. Storage transition is in `state-change/claim-mutation`. | `ClaimRetryExecuted` |
| `informational/settlement` | Marks proper-close. Indexer ignores. Split values live in `s.settlementBreakdown[loanId]`, retrievable on demand; storage transitions are in `state-change/loan-mutation` (`LoanSettled`) and `state-change/claim-mutation`. | `LoanSettlementBreakdown` |
| `informational/lz-plumbing` | LayerZero V2 endpoint / peer / DVN / option config | `PeerSet`, `EndpointSet`, `BuyOptionsSet`, `BroadcastDestinationEidsSet`, `BridgedBuyReceiverUpdated` |
| `informational/reward-transport` | Cross-chain reward infra (broadcast / aggregation / day-finalize / chain-zeroing) | `BroadcastSent`, `BroadcastReceived`, `ChainInterestReported`, `ChainReportAggregated`, `DailyGlobalInterestFinalized`, `ChainContributionZeroed` |
| `informational/governance` | Protocol-config bundle / image-URI / TOS version updates | `CurrentTosUpdated`, `ProtocolConfigBundleUpdated`, `DefaultImageURIUpdated` |

The leaf list is closed — adding a new leaf requires updating
this section AND the lint-script's allow-list (see §1.6) in the
same PR. New events MUST tag with one of these 15 leaves; if
none fit, that's a signal to either reuse an existing leaf or
deliberately extend the taxonomy.

### 1.6 CI lint enforcement of `@custom:event-category`

A lint script at `contracts/script/lint-event-categories.js`
runs after `forge build` in CI and as a pre-commit hook. It
fails the build if any externally-emitted event lacks a valid
`@custom:event-category` tag.

#### What the script does

1. Walk `contracts/out/` for every `*.sol/*.json` artifact.
2. For each contract, parse `devdoc.events` (Solidity's natspec
   output for events) and extract every event's
   `custom:event-category` field.
3. Cross-reference against the contract's ABI to find any event
   that's externally emitted but has no tag — fail-fast with the
   event signature + contract name.
4. Validate every tag value matches the regex
   `^(state-change|informational)/[a-z-]+$` (exactly two levels,
   lowercase + hyphens at depth-2 leaf).
5. Validate the leaf is in the curated allow-list (the 15 above).
   New leaves require explicit list extension — prevents
   accidental proliferation.
6. Emit a consolidated `contracts/out/event-categories.json`
   mapping every event signature → category for downstream
   consumers (watcher / frontend / subgraph) to load directly.

#### Failure modes the lint catches

- New event added to a facet without a `@custom:event-category`
  tag → "MISSING tag on event `Foo(uint256,address)` in
  `BarFacet.sol`".
- Tag with malformed value (typo / wrong depth) → "INVALID tag
  value `state-change/loanMutation` (must use kebab-case at
  depth-2 leaf)".
- Tag value not in allow-list → "UNKNOWN leaf category
  `informational/something-new` — extend the allow-list in
  EventSourcingAudit.md §1.5.1 + this script if intentional".

#### How consumers use the generated JSON

```ts
// frontend/src/lib/cacheStore.ts — Phase 4
import EVENT_CATEGORIES from '../contracts/out/event-categories.json';

const categoryByTopic0 = new Map<Hex, string>();
for (const [signature, category] of Object.entries(EVENT_CATEGORIES)) {
  categoryByTopic0.set(keccak256(toBytes(signature)), category);
}

// Live-tail dispatch — only state-change events ever reach the
// row-merge layer. Anything else returns early.
function dispatch(log: Log) {
  const category = categoryByTopic0.get(log.topics[0]);
  if (!category?.startsWith('state-change/')) return; // ignore informational
  routeToCacheMerge(log, category);
}
```

```ts
// ops/hf-watcher/src/chainIndexer.ts — Phase 2
import EVENT_CATEGORIES from '../../contracts/out/event-categories.json';

// D1 row-merge dispatch — same shape. Informational events are
// dropped on the floor; the state-change companion firing in the
// same tx is what creates the activity_events row + merges the
// cached row. The lookup is one hashmap probe per log.
function dispatch(log: Log) {
  const category = categoryByTopic0.get(log.topics[0]);
  if (!category?.startsWith('state-change/')) return; // no-op
  routeToD1Merge(log, category);
}
```

The lint + generated JSON together replace the comment-only
convention proposed in earlier drafts of this audit. The
`@custom:` tag is the SINGLE source of truth, validated at
build time, consumed at runtime.

---

## 2. Event inventory — categories

Total event count enumerated from `contracts/src/`: **187
unique signatures**. Grouped by audit category:

| Category | Count | Default §1.5 category | Default §1.2 decision |
|---|---|---|---|
| Offer lifecycle (created / accepted / cancelled / matched / partial-fill / closed) | 8 | **state-change** | Extend on gaps |
| Loan lifecycle (initiated / repaid / defaulted / settled / partial-repaid / sold / obligation-transferred) | 12 | **state-change** (split LoanDefaulted into FallbackPending + Defaulted per §1.5 rule 1) | Extend on gaps; drop redundant timestamps per §1.4 |
| Position-NFT lifecycle (mint / transfer / burn / status-update) | 5 | **state-change** (ERC-721 Transfer + facet-emitted status events) | Already self-sufficient mostly |
| Settlement breakdown (lender / borrower / treasury / late-fee splits) | 6 | **informational** (the storage mutations are captured in LoanRepaid / LoanSettled; these describe HOW the split happened) | Stay lean |
| Liquidation fallback split events | 4 | **informational** (companion describes HOW the fallback unfolded; status mutation is in LoanFallbackPending) | Stay lean |
| Collateral mutation (added / forfeited / transferred) | 4 | **state-change** | Extend on gaps |
| VPFI token (purchase / deposit / withdraw / discount-tier) | 7 | **state-change** for the user-balance ones; **informational** for tier-changed | Extend on gaps |
| Reward — claim events (`*Claimed`) | 4 | **state-change** | Extend on gaps |
| Reward — cross-chain transport (`BroadcastSent` / `BroadcastReceived` / `ChainContributionZeroed` etc.) | 10 | **informational** (no consumer-cache impact; ops-side only) | Stay lean |
| Activity-feed events (claim / sale / lifecycle markers) | 10 | Mixed — most are state-change for the affected entity | Extend on gaps |
| Cross-chain VPFI buy — outcome events (`BuyResolvedSuccess`, `BuyRefunded`, `BuyTimedOutRefunded`) | 4 | **state-change** for the buyer's escrow row | Extend on gaps |
| Cross-chain VPFI buy — flow events (`BuyRequested`, `BuyOptionsSet`) | 5 | **informational** | Stay lean |
| LayerZero plumbing (peer / DVN / endpoint config) | 12 | **informational** | Stay lean |
| Admin / role / pause / TOS | 22 | **informational** | Stay lean |
| Treasury — fee accrual / claim | 4 | **state-change** for treasury-balance rows | Extend on gaps |
| Treasury — config (set / transfer) | 4 | **informational** | Stay lean |
| Oracle / price / liquidity setters | 14 | **informational** (governance config; rare changes) | Stay lean |
| Asset-config / governance-config (BPS, caps, thresholds) | 16 | **informational** | Stay lean |
| Sanctions / KYC / country-pair (governance-side) | 5 | **informational** (KYC off in retail) | Stay lean |
| Misc (escrow lifecycle, periodic interest, refinance, preclose) | 22 | Mixed — escrow + refinance + preclose mutations are state-change; periodic-interest scheduling is informational | Mixed |

Approximate splits across the 187: **~50 state-change**,
**~137 informational**. The state-change set is what
`DesignsAndPlans/CacheStoreDesign.md` and
`DesignsAndPlans/SubgraphSchemaDesign.md` consume to merge cached
rows. Informational events flow into the journey-log / ops
dashboard / explorer surfaces and are NEVER consumed for cache
state.

The hot-path categories (offer lifecycle, loan lifecycle,
position-NFT, liquidation, collateral, VPFI user-side, activity
feed, settlement, refinance, preclose, periodic interest) are
where the audit attention concentrates. Cold-path admin /
governance / config events are consumed only by ops dashboards
and re-reads on rare config changes; the gas tax for extending
them isn't justified.

---

## 3. Detailed analysis — hot-path events

This section walks through the top ~20 hot-path events with
their current shape, storage gaps, and per-event recommendation.

### 3.1 `OfferCreated(uint256 indexed offerId, address indexed creator, uint8 offerType)`

**Storage mutations on emit:** `s.offers[offerId]` populated with
~25 fields. Counter `s.nextOfferId` incremented.

**Today:** topic[1]=offerId, topic[2]=creator, data=offerType.
That's 3 fields on a 25-field struct.

**Gap (22 fields):** lendingAsset, amountMin, amountMax,
interestRateBpsMin, interestRateBpsMax, durationDays,
collateralAsset, collateralAmount, periodicInterestCadence,
allowsPartialRepay, keeperAccessEnabled, plus ~12 more
operational fields.

**Decision:** **Extend, but via a `OfferCreatedDetails`
companion event** (precedent: `OfferCanceledDetails`). Reasons:
(a) the bare `OfferCreated` shape is used by many indexers and
breaking it forces a coordinated indexer migration; (b) the
companion event can be filtered separately by analytical
indexers that don't care about the full payload. Companion's
indexed: `(offerId, creator, lendingAsset)` — adds asset-filter
support; non-indexed: every remaining offer field.

**Estimated extension cost:** ~80 k gas per `createOffer` call.
Across the offer's full lifecycle this is paid once. Saves the
watcher's inline `getOfferDetails` round-trip (Phase 2 work).

**Frontend impact:** `useMyOffers`, `useIndexedActiveOffers` can
build cached rows entirely from the companion event when
consuming the live tail.

### 3.2 `OfferAccepted(uint256 indexed offerId, address indexed acceptor, uint256 loanId)`

**Storage mutations:** `s.offers[offerId].amountFilled` bumped;
`s.offers[offerId].status` flipped to Filled if fully consumed;
`s.loans[loanId]` is a NEW entry populated by the same call but
through `LoanInitiated` (handled separately).

**Today:** topic[1]=offerId, topic[2]=acceptor, data=loanId.

**Gap (3 fields):** new `amountFilled`, new `status` enum, the
`matchAmount` (= the per-fill amount when partial).

**Decision:** **Extend in-place** (no companion needed — small
gap, no published indexer dependency on the narrow shape).
New shape: `OfferAccepted(offerId, acceptor, loanId,
matchAmount, newAmountFilled, newStatus)`. Indexed unchanged
(offerId + acceptor); non-indexed gains 3 fields.

**Cost:** ~20 k extra gas. Acceptable — `acceptOffer` is a
several-hundred-k-gas call already.

**Frontend impact:** offer-row updates from event alone (no
re-fetch); subgraph's offer entity stays consistent with chain
state without a follow-up view.

### 3.3 `OfferCanceled(uint256 indexed offerId, address indexed creator)` + `OfferCanceledDetails(...)`

**Storage mutations:** `s.offers[offerId].status` set to
Cancelled; refund to creator's escrow (separate Transfer event).

**Today:** the `Details` companion already carries a 12-field
self-sufficient payload (added in the partial-fill range-orders
work). Bare `OfferCanceled` is kept for legacy filter consumers.

**Decision:** **Already self-sufficient.** No change.

### 3.4 `OfferMatched(uint256 indexed lenderOfferId, uint256 indexed borrowerOfferId, uint256 indexed loanId, ...)`

**Storage mutations:** both lender and borrower offers'
`amountFilled` + `status` updated; new `s.loans[loanId]`
populated.

**Today (Range Orders Phase 1):** topic[1..3] = the three IDs;
non-indexed = matcher address, matchAmount, matchRateBps,
lenderRemainingPostMatch, lifMatcherFee.

**Gap:** the borrower side's post-match `amountFilled` /
`status`; the new loan's full struct (handled by the parallel
`LoanInitiated`).

**Decision:** **Extend** to add borrower-side post-match state,
since `OfferMatched` is the canonical event for the matched
pair — consumers should not need to read the borrower offer
separately. ~15 k extra gas. Borrower offer's `amountFilled` is
typically `amountMax` (single-fill in Phase 1), but the field
becomes load-bearing in Phase 2 (borrower partial fills).

### 3.5 `OfferClosed(uint256 indexed offerId, uint8 reason)`

**Today:** offerId + reason enum.

**Gap:** none for the close action itself; the offer's final
state is fully captured by the prior Accepted/Cancelled events.

**Decision:** **Already self-sufficient.** No change.

### 3.6 `LoanInitiated(uint256 indexed loanId, uint256 indexed offerId, address indexed lender, address borrower, uint256 principal, uint256 collateralAmount)`

**Storage mutations:** `s.loans[loanId]` populated with ~40
fields. Counter `s.nextLoanId` incremented. Position NFTs
minted (separate Transfer events).

**Today:** topic[1..3] = loanId/offerId/lender; non-indexed =
borrower, principal, collateralAmount.

**Category (§1.5):** state-change. Both `LoanInitiated` (bare)
and the proposed `LoanInitiatedDetails` (companion) are
state-change events for the new `s.loans[loanId]` row.

**Gap (~34 fields, after §1.4 timestamp drop):** lendingAsset,
collateralAsset, durationDays, interestRateBps, **dueTimestamp**
(future block — keep per §1.4), graceDays,
periodicInterestCadence, allowsPartialRepay, liqThresholdBps,
lenderTokenId, borrowerTokenId, maxLtvBpsAtInit,
healthFactorAtInit, plus settlement metadata. **`startTimestamp`
is DROPPED** under §1.4 — it equals `block.timestamp` at emit and
the consumer derives it from the event's blockNumber.

**Decision:** **Extend via a `LoanInitiatedDetails` companion
event** — same pattern as `OfferCreatedDetails`. Bare
`LoanInitiated` keeps its narrow shape for legacy consumers;
companion carries the rest. Companion's indexed:
`(loanId, lender, borrower)`; non-indexed: the remaining fields.

**Cost:** ~145 k gas (saved ~7 k by dropping `startTimestamp`
per §1.4). Material but `initiateLoan` is already a ~600 k gas
call in the Vaipakam Diamond pattern.

**Frontend impact:** loan-row construction from event stream
without `getLoanDetails` round-trip — saves one Multicall3 call
per loan seen.

### 3.7 `LoanRepaid(uint256 indexed loanId, address indexed repayer, uint256 interestPaid, uint256 principalPaid)`

**Category (§1.5):** state-change.

**Storage mutations:** `s.loans[loanId]` updated:
`outstandingPrincipal`, `accruedInterest`, `totalInterestPaid`,
`lastRepaidAt`, `status` (if fully repaid → Settled).

**Today:** loanId + repayer + interestPaid + principalPaid.

**Gap (3 fields, after §1.4 timestamp drop):** new
`outstandingPrincipal`, new `accruedInterest`, new `status`.
**`lastRepaidAt` is DROPPED** under §1.4 — it equals
`block.timestamp` at emit and the consumer derives it from the
event's blockNumber.

**Decision:** **Extend in-place.** ~20 k extra gas (saved ~7 k
by dropping `lastRepaidAt`). Hot path.

**Special case — `accruedInterest`:** this is a derived value
recomputed on next read. The event's emitted accruedInterest is
the value AS OF EMIT TIME; consumers must recompute on display.
Document this in the consumer-side decoder.

### 3.8 `LoanDefaulted` — split into `LoanFallbackPending` + `LoanDefaulted` per §1.5 rule 1

**Pre-existing semantic ambiguity.** The current
`LoanDefaulted(uint256 indexed loanId, bool fallbackConsentFromBoth)`
fires from TWO emit sites in `DefaultedFacet.markDefaulted`,
representing two distinct terminal storage states:

- `DefaultedFacet.sol:247` — swap-failure path. `_fullCollateralTransferFallback`
  transitions `loan.status` to **`FallbackPending`** (NOT
  `Defaulted`). The loan can still be cured via `addCollateral` /
  `repayLoan` until the lender claims.
- `DefaultedFacet.sol:505` — swap-success / illiquid path.
  `LibLifecycle.transitionFromAny` transitions `loan.status` to
  **`Defaulted`**. Terminal.

Today both emit `LoanDefaulted`, which is a misnomer in the
swap-failure case.

**Refactor under §1.5 rule 1 ("one state-change event per
storage transition")**:

| Emit site | Storage transition | New event | Payload (after §1.4 timestamp drop) |
|---|---|---|---|
| `DefaultedFacet.sol:247` (swap-failure) | `Active → FallbackPending` | **`LoanFallbackPending`** (NEW) | `(loanId indexed, lender indexed, fallbackConsentFromBoth, newStatus = FallbackPending)` |
| `DefaultedFacet.sol:505` (swap-success / illiquid) | `Active/FallbackPending → Defaulted` | **`LoanDefaulted`** (kept) | `(loanId indexed, fallbackConsentFromBoth, newStatus = Defaulted)` |

`defaultedAt` is DROPPED under §1.4 — block.timestamp is in the
log envelope.

**Decision:** **Split + extend.** ~13 k extra gas at the
swap-failure site (new event); ~7 k extra gas at the
swap-success site (one extra non-indexed field for `newStatus`).
Net consumer-facing benefit: cache merges directly from the
event payload AND the event NAME matches the actual storage
state — no payload disambiguation needed.

**Watcher / frontend impact:** `chainIndexer.ts` adds a new
event handler for `LoanFallbackPending`; the existing
`LoanDefaulted` handler narrows to "actual default only".
Cache merges become unambiguous.

**ABI break:** the new `LoanFallbackPending` topic-0 is a
new entry; existing `LoanDefaulted` topic-0 changes (one extra
non-indexed field). Both require the standard ABI re-export
sweep post-deploy.

**`LiquidationFallback` + `LiquidationFallbackSplit` (currently
emitted at the swap-failure site)** stay as **informational**
events under §1.5 — they describe HOW the fallback unfolded,
the actual storage transition is captured by the new
`LoanFallbackPending`. See §3.14 for the reclassification.

### 3.9 `LoanSettled(uint256 indexed loanId)`

**Today:** loanId only.

**Gap:** none — settlement just flips `status` to Settled, which
consumers can derive from this event firing.

**Decision:** **Already self-sufficient.** No change.

### 3.10 `PartialRepaid(uint256 indexed loanId, address indexed repayer, uint256 principalPaid, uint256 interestPaid)`

**Storage mutations:** same fields as `LoanRepaid` but always
keeps `status = Active`.

**Decision:** **Extend in-place** with new
`outstandingPrincipal` + new `accruedInterest`. ~13 k gas. Hot
path for active-loan rendering.

### 3.11 `LenderFundsClaimed(uint256 indexed loanId, address indexed claimant, address asset, uint256 amount)` + `BorrowerFundsClaimed(...)`

**Storage mutations:** `s.loans[loanId].lenderClaimed` (or
`borrowerClaimed`) bool flipped to true. NFT eventually burned
when both flipped.

**Today:** already carries claimant + asset + amount.

**Gap (1 field):** the `bothClaimed` boolean (= the new value of
`lenderClaimed` AND `borrowerClaimed` post-update).

**Decision:** **Extend in-place** with `newBothClaimed` boolean
so consumers know whether NFT burn is imminent without re-reading.
~6.8 k gas.

### 3.12 `CollateralAdded(uint256 indexed loanId, address indexed adder, uint256 newCollateralAmount, uint256 newHF, uint256 amountAdded, uint256 newLtv)`

**Today:** already carries 5 fields including post-update HF +
LTV.

**Decision:** **Already self-sufficient.** No change. Good
example of a well-designed event.

### 3.13 `LoanSettlementBreakdown(uint256 indexed loanId, uint256 lenderShare, uint256 treasuryShare, uint256 borrowerRebate, uint256 lateFee, uint256 principalReturned)`

**Category (§1.5): informational.** Reclassified from
"state-change-already-self-sufficient" to informational under
the §1.5 lens — the actual storage mutations on settlement
(loan.status → Settled, lender/borrower claim flags) are
captured by `LoanSettled` + `LenderFundsClaimed` /
`BorrowerFundsClaimed`. This event describes HOW the
settlement-time amounts split across lender / treasury /
borrower / late-fee — useful for analytics + ops dashboards but
NOT consumed in the cache-merge path.

**Today:** comprehensive settlement breakdown. No change to
payload shape.

**Decision:** **Keep payload as-is.** Add the
`/// @dev event-sourcing: informational` natspec marker. No
gas change, no consumer-side change.

### 3.14 `LiquidationFallback(uint256 indexed loanId)` + `LiquidationFallbackSplit(uint256 indexed loanId)`

**Category (§1.5): informational/liquidation.** Reclassified
under §1.5 — the actual storage transition at the swap-failure
site is `Active → FallbackPending`, captured by the new
`LoanFallbackPending` state-change event introduced in §3.8.

**Decision: SLIM to primary-key-only payload + tag
`@custom:event-category informational/liquidation`.** Both
events drop their entire data payload — collapse to
`(uint256 indexed loanId)`.

**Why slim is correct here:**

1. The lender, collateral amount, and three-way split are stored
   verbatim on-chain — `s.loans[loanId].lender` for the lender,
   `s.fallbackSnapshot[loanId].{lenderCollateral,
   treasuryCollateral, borrowerCollateral}` for the split. Any
   consumer that needs them reads by `loanId` on demand.
2. Per §1.5's cache-merge contract, **the live indexer ignores
   informational events entirely** — both watcher D1 and
   IndexedDB cache map `informational/*` to a no-op. So no
   consumer-side code path benefits from the rich payload.
3. The state-change companion `LoanFallbackPending(loanId,
   lender indexed, fallbackConsentFromBoth, newStatus)` fires in
   the same transaction — subscribers needing a per-lender
   filter use that event's indexed `lender` topic instead.
4. `s.fallbackSnapshot` values are immutable after fallback
   (only `retryAttempted` flips later), so an on-demand read at
   any future block returns the same split that was true at
   emit time.

**Gas saving:** ~2.5 k per fallback emit (drop 1 indexed +
3 non-indexed across the two events). Marginal but consistent
with the §1.4 + §1.5 policy.

**ABI break:** both topic-0 hashes change. Standard ABI re-export
sweep post-deploy. Consumers that today consume the rich payload
(none in our codebase — both watcher and frontend already filter
on `LoanFallbackPending`) would break, but we have no such
consumers.

**Pilot landed in DefaultedFacet** (2026-05-07) — tagged
+ slimmed events + slimmed emit sites + test asserts updated to
the new shape. RiskFacet still has the fat-shape clones; the
Phase 1 Day 1 sweep harmonises them.

### 3.15 `LoanSold(uint256 indexed loanId, address indexed originalLender, address indexed newLender, uint256 newPrincipal)`

**Storage mutations:** `s.loans[loanId].lender` updated; old
NFT burned + new NFT minted.

**Today:** carries 4 fields.

**Gap (~5 fields):** new lender NFT tokenId, refinance terms
(new rate, new duration, new dueTimestamp).

**Decision:** **Extend** with new lender tokenId + new
duration / rate / dueTimestamp. ~30 k gas. Hot path for the
EarlyWithdrawal / Refinance flow.

### 3.16 `LoanObligationTransferred(uint256 indexed loanId, address indexed originalBorrower, address indexed newBorrower, uint256 newCollateralAmount)`

**Storage mutations:** borrower swap; NFT burn + mint;
collateral may be topped up at the offset.

**Decision:** **Extend** with new borrower NFT tokenId + new
duration / rate / dueTimestamp + maybe new HF. ~30 k gas.
Symmetric to `LoanSold`.

### 3.17 `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` (ERC-721)

**Decision:** **Already self-sufficient** — ERC-721 standard,
consumers track ownership directly from the event stream.
No change needed (and extending would break ERC-721 standard
indexers).

### 3.18 `VPFIPurchasedWithETH(address indexed buyer, uint256 ethSpent, uint256 vpfiBought)`

**Storage mutations:** VPFI minted to buyer's escrow; ETH
forwarded to treasury / VPFI buy receiver.

**Today:** carries 3 fields.

**Gap (1 field):** post-buy escrow VPFI balance for the user
(useful for UI's "your VPFI balance is now X" feedback).

**Decision:** **Extend** with newEscrowBalance. ~6.8 k gas.
User-facing hot path.

### 3.19 `VPFIDepositedToEscrow(address indexed user, uint256 amount)` + `VPFIWithdrawnFromEscrow(address indexed user, uint256 amount)`

**Storage mutations:** escrow balance changes.

**Gap:** post-mutation escrow balance.

**Decision:** **Extend** with new escrow balance. ~6.8 k gas
each.

### 3.20 `BorrowerLifRebateClaimed(uint256 indexed loanId, address indexed borrower, uint256 vpfiAmount)`

**Storage mutations:** `s.borrowerLifRebate[loanId].claimed`
flipped; VPFI transferred to borrower.

**Today:** 3 fields.

**Gap:** post-claim borrower escrow VPFI balance.

**Decision:** **Extend** ~6.8 k gas.

---

## 4. Cold-path categories — skip-and-document

The following category-groups have no hot-path consumers. Their
events stay delta-only; consumers re-fetch via view-call when
needed (which is rare for these). The skip is documented per
category so future consumers know the pattern.

| Category | Skip rationale |
|---|---|
| Admin / role / pause (`AdminTransferred`, `RoleGranted`, `Paused`, `Unpaused`, `AutoPaused`, `TosUpdated`, etc.) | Consumed by ops dashboard only; events are infrequent. View-call from explorer / Defender Sentinel is fine. |
| LayerZero plumbing (`PeerSet`, `EndpointSet`, `BroadcastDestinationEidsSet`, etc.) | Cross-chain config rarely changes; consumed by deploy scripts only. |
| Asset-config (BPS / cap / threshold setters) | Governance-only; subgraph re-reads from view-call on event signal is fine. |
| Sanctions / KYC / country-pair | Off in retail deploy; industrial fork has its own audit pass. |
| Reward OApp infra (epoch rollover, day-finalize, broadcast-sent, etc.) | Operator daemon (rewardCloser.ts) is the only consumer; daemon already does its own state-tracking via cron. |
| Treasury setters | Once-per-chain config; rare. |
| Oracle / liquidity setters | Rare governance changes; subgraph re-reads on event signal. |
| Cross-chain VPFI buy infra (`BridgedBuyProcessed`, `BuyTimedOutRefunded`, etc.) | Diagnostic + operator surfaces; not in the user's hot path. Receiver-side event already carries enough for the user's claim flow. |

For each cold-path category, the audit recommendation is:
**document the gap explicitly in the per-event natspec
`@dev` block** with a marker like
`/// @dev event-sourcing: delta-only; consumers should re-read
{state-fields} via view-call on this event signal`.
That gives subgraph authors a clear contract: don't try to
build a self-sufficient row from this event; do a view-call
when you see it.

---

## 5. Aggregate impact estimate

Reflecting §1.4 (no-redundant-block-metadata) + §1.5
(state-change vs informational + LoanDefaulted split):

| Metric | Estimate |
|---|---|
| Solidity LOC change | ~170–220 lines across 7 facets (OfferFacet, LoanFacet, RepayFacet, DefaultedFacet, ClaimFacet, RefinanceFacet, EarlyWithdrawalFacet, VPFIDiscountFacet) — slight bump from the LoanDefaulted split |
| New companion events | 2 (`OfferCreatedDetails`, `LoanInitiatedDetails`) |
| New state-change events (split from existing) | 1 (`LoanFallbackPending`, splits from current `LoanDefaulted` swap-failure path) |
| In-place event extensions | ~12 events |
| Reclassifications (no payload change, just natspec marker) | 2 (`LoanSettlementBreakdown`, `LiquidationFallback` + `LiquidationFallbackSplit`) |
| §1.4 timestamp drops (gas savings) | ~3 redundant timestamp fields dropped × ~7 k gas each × 6 emit sites = ~125 k gas saved across the surface |
| Natspec annotation pass (§1.5) | ~187 events get a one-line `/// @dev event-sourcing: state-change\|informational` marker. Mechanical; no logic change |
| Aggregate gas cost (hot-path call avg, NET of §1.4 savings) | +18–28 k per event-emitting tx |
| Aggregate RPC saving | ~80 % reduction in `getOfferDetails` / `getLoanDetails` follow-up calls in the watcher + frontend (paid by the operator's RPC quota, not by users) |
| New tests | ~35–45 unit tests covering the new event payload assertions + the new `LoanFallbackPending` event + the `LoanDefaulted` narrowing |
| Audit re-pass scope | Focused diff on the touched facets + the natspec-only file diff; budget 1 week of audit calendar |

**Net trade**: users pay ~22 k extra gas at event emit time (≈
$0.04–$0.18 per call at typical Base / Arb / OP gas prices —
slightly cheaper than the pre-§1.4 estimate after dropping
redundant timestamps); operators recover ~80 % of read-side RPC
quota; subgraph + watcher + frontend all simplify (no more "stub
row + refresh later" pattern, no more `is_stub` boolean, no race
window). Cache-merge logic gains a clean state-change /
informational split — only state-change events trigger merges,
informational events flow into the journey log only.

The trade is industry-standard — , , Sky all pay
this gas tax to enable clean event-sourced consumers.

---

## 6. Sign-off (closed)

**Status: signed off 2026-05-07.** All five questions below
resolved per the recommendations. Locked-in answers:

| # | Question | Locked-in answer |
|---|---|---|
| Q1 | `OfferCreatedDetails` + `LoanInitiatedDetails` companion events vs in-place `OfferCreated` / `LoanInitiated` extension | **Companion-event pattern.** Matches the `OfferCanceledDetails` precedent; etherscan / blockscout decoders for the bare events keep working unchanged |
| Q2 | Extend `RewardReporterFacet` cross-chain reward events | **Skip.** Operator daemon is the sole consumer and already re-fetches per-chain on each cron |
| Q3 | Add `accruedInterest` to `LoanRepaid` despite being derivable | **Yes.** Emit AS-OF-EMIT-TIME value; consumer-side decoder must recompute for display freshness. Ensures the event-rendering matches what `getLoanDetails` returns at the same block |
| Q4 | Audit-tag every cold-path event with explicit `event-sourcing` marker | **Yes** — superseded by the `@custom:event-category` natspec mechanism + lint script in §1.5 + §1.6. Phase 1 Day 1 sweep tags every remaining event |
| Q5 | Indexer stability concern from doubled event volume from companion events | **No concern.** a major DeFi protocol alone emits 4–5 events per `borrow`; Vaipakam's volume is below stress thresholds |

### 6-historical (the original questions, kept for traceability)

1. **`OfferCreatedDetails` + `LoanInitiatedDetails` companion
   events are the right pattern, OR should bare `OfferCreated` /
   `LoanInitiated` be extended in-place (breaking published
   topic shapes)?**
   - Recommendation: companion pattern. Matches the
     `OfferCanceledDetails` precedent; lets external indexers
     (etherscan / blockscout / future third-party subgraphs)
     keep their existing decoders working unchanged.
2. **Do we extend events on the `RewardReporterFacet` event
   surface for cross-chain reward closures?**
   - Recommendation: skip. Operator daemon is the sole consumer
     and already re-fetches per-chain on each cron.
3. **Should we add `accruedInterest` to `LoanRepaid` extensions
   despite it being derived?**
   - Recommendation: yes, emit the AS-OF-EMIT-TIME accruedInterest
     value; consumer-side decoder documents that it must
     recompute for display freshness. Ensures the
     event-rendering matches what `getLoanDetails` would have
     returned at the same block.
4. **Should we audit-tag every cold-path event's natspec with
   the explicit `event-sourcing: delta-only` marker?**
   - Recommendation: yes, in a separate doc-comments-only PR
     post-Phase-1. Helps future subgraph authors understand the
     contract without re-reading this audit.
5. **Companion events double the topic-budget for the same
   logical change. Any concern about indexer stability under
   doubled event volume?**
   - Recommendation: no — every major DeFi indexer already
     handles this volume (a major DeFi protocol alone emits 4–5 events per
     `borrow`). Vaipakam's volume is well below stress
     thresholds.

---

## 7. Implementation plan (Phase 1)

Once the open questions are signed off, six steps in order:

1. **Day 1 — natspec annotation sweep across all 187 events.**
   Mechanical pass: each event gets one of two `@dev`
   markers (`event-sourcing: state-change` or
   `event-sourcing: informational`). No logic change, no
   payload change. This locks in §1.5 categorisation and
   gives every reviewer + every future contributor a clear
   "what kind of event is this" line. Also tags the
   redundant-timestamp drops per §1.4 in the relevant events'
   natspec so the gas savings are explicit.
2. **Day 2 — `LoanDefaulted` split.** Add new
   `LoanFallbackPending` event; narrow the existing
   `LoanDefaulted` to swap-success path only; update
   `DefaultedFacet.sol:247` to emit the new event; extend
   `DefaultedFacet.sol:505` with `newStatus` payload field.
   Update tests asserting the two distinct event signatures.
   Pattern-establishing for the §1.5 rule "one state-change
   event per storage transition".
3. **Day 3–4 — in-place extensions across 12 events.** Each
   extension is a Solidity change + a test asserting the new
   payload shape, applying §1.4 timestamp-drop discipline.
   Touched facets: OfferFacet, LoanFacet, RepayFacet,
   ClaimFacet, RefinanceFacet, EarlyWithdrawalFacet,
   VPFIDiscountFacet.
4. **Day 5 — companion events.** Implement
   `OfferCreatedDetails` + `LoanInitiatedDetails`; emit
   alongside the bare events at every `createOffer` /
   `initiateLoan` / `acceptOffer-on-borrower-side` site.
5. **Day 6 — regression suite.** Existing 1386-test pass
   must stay green. New event-shape assertions covered.
6. **Day 7 — audit handoff + ABI re-exports.** Audit firm gets
   the focused diff (~1 week of audit calendar from here).
   ABI re-exports run via `exportFrontendAbis.sh` /
   `exportWatcherAbis.sh` / `exportAbis.sh` against the
   touched facets' interfaces.
7. **Phase 2 (parallel with audit)**: watcher's
   `chainIndexer.ts` + frontend's live-tail consume the
   extended events; drop the redundant `getDetails`
   follow-ups; implement the cache-merge contract from
   `DesignsAndPlans/CacheStoreDesign.md`.

Total contract-side calendar: ~2 weeks (1 week dev + 1 week
audit). Phase 2 (watcher + frontend) runs in parallel with
audit since the new event shapes are settled in code from
day 5.

---

## 8. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` —
  Pillar 4.1 (this audit's parent); pillar 4.2 (LiveTailProvider)
  and pillar 4.3 (IndexedDB cache) consume the extended event
  surface.
- `DesignsAndPlans/LiveTailProviderDesign.md` — consumes the extended
  events for topic-routed dispatch.
- `DesignsAndPlans/CacheStoreDesign.md` — uses extended event payloads
  to update cached rows in place.
- `DesignsAndPlans/SubgraphSchemaDesign.md` — schema benefits from
  self-sufficient events (handler logic simpler).
- `contracts/src/facets/OfferFacet.sol` — primary site for
  offer-lifecycle extensions.
- `contracts/src/facets/LoanFacet.sol` — primary site for
  loan-lifecycle extensions.
- `contracts/src/libraries/LibVaipakam.sol` — the storage struct
  shapes the events are mirroring.
