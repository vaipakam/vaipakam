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

---

## 2. Event inventory — categories

Total event count enumerated from `contracts/src/`: **187
unique signatures**. Grouped by audit category:

| Category | Count | Hot-path? | Default decision |
|---|---|---|---|
| Offer lifecycle (created / accepted / cancelled / matched / partial-fill / closed) | 8 | YES | Extend on gaps |
| Loan lifecycle (initiated / repaid / defaulted / settled / partial-repaid / sold / obligation-transferred) | 12 | YES | Extend on gaps |
| Position-NFT lifecycle (mint / transfer / burn / status-update) | 5 | Partial — Transfer + status are hot | Mixed |
| Settlement breakdown (lender / borrower / treasury / late-fee splits) | 6 | Subgraph + analytics | Extend on gaps |
| Liquidation (HF + time-based + fallback) | 8 | YES | Extend on gaps |
| Collateral mutation (added / forfeited / transferred) | 4 | YES | Extend on gaps |
| VPFI token (purchase / deposit / withdraw / discount-tier) | 7 | YES on user view | Extend on gaps |
| Reward (cross-chain report / aggregate / broadcast / claim) | 14 | Partial | Mixed |
| Activity-feed events (claim / sale / lifecycle markers) | 10 | YES on Activity page | Extend on gaps |
| Cross-chain VPFI buy (request / processed / refunded / receiver) | 9 | Partial — diagnostic surface | Skip mostly |
| LayerZero plumbing (peer / DVN / endpoint config) | 12 | NO | Skip |
| Admin / role / pause / TOS | 22 | NO | Skip |
| Treasury (set / transfer / fee accrual) | 8 | Partial | Mixed |
| Oracle / price / liquidity (set / updated / fallback) | 14 | Partial — diagnostic | Skip mostly |
| Reward OApp / cross-chain message events | 10 | NO | Skip |
| Asset-config / governance-config (BPS, caps, thresholds) | 16 | NO | Skip |
| Sanctions / KYC / country-pair (governance-side) | 5 | NO (KYC off in retail) | Skip |
| Misc (escrow lifecycle, periodic interest, refinance, preclose, etc.) | 22 | YES on relevant paths | Mixed |

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

**Gap (~35 fields):** lendingAsset, collateralAsset,
durationDays, interestRateBps, startTimestamp, dueTimestamp,
graceDays, periodicInterestCadence, allowsPartialRepay,
liqThresholdBps, lenderTokenId, borrowerTokenId,
maxLtvBpsAtInit, healthFactorAtInit, plus settlement metadata.

**Decision:** **Extend via a `LoanInitiatedDetails` companion
event** — same pattern as `OfferCreatedDetails`. Bare
`LoanInitiated` keeps its narrow shape for legacy consumers;
companion carries the rest. Companion's indexed:
`(loanId, lender, borrower)`; non-indexed: the remaining fields.

**Cost:** ~150 k gas. Material but `initiateLoan` is already a
~600 k gas call in the Vaipakam Diamond pattern.

**Frontend impact:** loan-row construction from event stream
without `getLoanDetails` round-trip — saves one Multicall3 call
per loan seen.

### 3.7 `LoanRepaid(uint256 indexed loanId, address indexed repayer, uint256 interestPaid, uint256 principalPaid)`

**Storage mutations:** `s.loans[loanId]` updated:
`outstandingPrincipal`, `accruedInterest`, `totalInterestPaid`,
`lastRepaidAt`, `status` (if fully repaid → Settled).

**Today:** loanId + repayer + interestPaid + principalPaid.

**Gap (4 fields):** new `outstandingPrincipal`, new
`accruedInterest`, new `lastRepaidAt`, new `status`.

**Decision:** **Extend in-place.** ~25 k extra gas. Hot path.

**Special case — `accruedInterest`:** this is a derived value
recomputed on next read. The event's emitted accruedInterest is
the value AS OF EMIT TIME; consumers must recompute on display.
Document this in the consumer-side decoder.

### 3.8 `LoanDefaulted(uint256 indexed loanId, bool reason)`

**Storage mutations:** `s.loans[loanId].status` → Defaulted;
collateral disposition flow begins (separate events for the
fallback / direct-transfer path).

**Today:** loanId + bool reason flag.

**Gap (2 fields):** new `status`, `defaultedAt` timestamp.

**Decision:** **Extend in-place.** ~13 k extra gas.

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

**Today:** comprehensive settlement breakdown.

**Decision:** **Already self-sufficient.** No change.

### 3.14 `LiquidationFallback(uint256 indexed loanId, address fallbackRecipient, uint256 amount)` + `LiquidationFallbackSplit(...)`

**Today:** the split companion carries the three-way collateral
allocation.

**Decision:** **Already self-sufficient.** No change.

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

If every "Extend" recommendation in §3 lands:

| Metric | Estimate |
|---|---|
| Solidity LOC change | ~150–200 lines across 6 facets (OfferFacet, LoanFacet, RepayFacet, ClaimFacet, RefinanceFacet, EarlyWithdrawalFacet, VPFIDiscountFacet) |
| New companion events | 2 (`OfferCreatedDetails`, `LoanInitiatedDetails`) |
| In-place event extensions | ~12 events |
| Aggregate gas cost (hot-path call avg) | +20–35 k per event-emitting tx |
| Aggregate RPC saving | ~80 % reduction in `getOfferDetails` / `getLoanDetails` follow-up calls in the watcher + frontend (paid by the operator's RPC quota, not by users) |
| New tests | ~30–40 unit tests covering the new event payload assertions |
| Audit re-pass scope | Focused diff on the touched facets; budget 1 week of audit calendar |

**Net trade**: users pay ~25 k extra gas at event emit time (≈
$0.05–$0.20 per call at typical Base / Arb / OP gas prices);
operators recover ~80 % of read-side RPC quota; subgraph + watcher
+ frontend all simplify (no more "stub row + refresh later"
pattern, no more `is_stub` boolean, no race window).

The trade is industry-standard — Aave, Compound, Sky all pay
this gas tax to enable clean event-sourced consumers.

---

## 6. Open questions for sign-off

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
     handles this volume (Aave alone emits 4–5 events per
     `borrow`). Vaipakam's volume is well below stress
     thresholds.

---

## 7. Implementation plan (Phase 1)

Once the open questions are signed off:

1. **Day 1–2**: implement the 12 in-place extensions across 6
   facets. Each extension is a Solidity change + a test
   asserting the new event payload shape.
2. **Day 3**: implement the 2 companion events
   (`OfferCreatedDetails`, `LoanInitiatedDetails`) + emit them
   alongside the bare events.
3. **Day 4**: regression suite (the existing 1386-test pass
   must stay green).
4. **Day 5**: audit firm gets the diff. ~1 week of audit
   calendar.
5. **Day 6+ (post-audit)**: ABI re-export to frontend +
   watcher + keeper-bot via `exportFrontendAbis.sh` /
   `exportWatcherAbis.sh` / `exportAbis.sh`.
6. **Phase 2**: watcher's `chainIndexer.ts` + frontend's
   live-tail consume the extended events; drop the redundant
   `getDetails` follow-ups.

Total contract-side calendar: ~2 weeks (1 week dev + 1 week
audit). Phase 2 (watcher + frontend) runs in parallel with
audit since the new event shapes are settled in code from day 4.

---

## 8. Cross-references

- `DesignsAndPlans/DecentralizedPlatformArchitecture.md` —
  Pillar 4.1 (this audit's parent); pillar 4.2 (LiveTailProvider)
  and pillar 4.3 (IndexedDB cache) consume the extended event
  surface.
- `internal/LiveTailProviderDesign.md` — consumes the extended
  events for topic-routed dispatch.
- `internal/CacheStoreDesign.md` — uses extended event payloads
  to update cached rows in place.
- `internal/SubgraphSchemaDesign.md` — schema benefits from
  self-sufficient events (handler logic simpler).
- `contracts/src/facets/OfferFacet.sol` — primary site for
  offer-lifecycle extensions.
- `contracts/src/facets/LoanFacet.sol` — primary site for
  loan-lifecycle extensions.
- `contracts/src/libraries/LibVaipakam.sol` — the storage struct
  shapes the events are mirroring.
