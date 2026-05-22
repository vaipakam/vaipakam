# Analytical Getters — Design Note

**Status:** Signed off 2026-05-07 — all 12 open decisions accepted as recommended  
**Date:** 2026-05-07  
**Owner:** Vaipakam protocol team  
**Companion to:** [`EventSourcingAudit.md`](EventSourcingAudit.md)

## Sign-off summary

| ID | Decision | Locked-in answer |
|---|---|---|
| D1 | `getUserDashboardSnapshot` shape | Scalar snapshot + 3 paginated list calls |
| D2 | Pagination defaults | Frontend `limit=20`, contract hard-cap `100` |
| D3 | Lender / borrower split for loans + claimables | Separate paginated calls via `bool borrowerSide` |
| D4 | Active vs filled offer split | Separate via `bool filledOnly` |
| D5 | Treasury rolling-window backfill | None — "since governance migration" footnote on rolling-window cards |
| D6 | `windowDays` bounds | `1 ≤ windowDays ≤ 365` (revert with `InvalidWindow` / `WindowTooLong`) |
| D7 | Timelock function location | Confirm during implementation (read existing timelock + report) |
| D8 | Proposal `data` field shape | Raw `bytes`, frontend decodes per-target |
| D9 | §3.4 timing | **Ship now** alongside §3.1 / §3.2 / §3.3 — eliminates the last event-replay dependency on the analytical surface |
| D10 | §3.4 caller policy | Permissionless `captureDailyPriceSnapshot(assets[])`, first caller per day wins |
| D11 | §3.4 first-day UX | Render most recent snapshot + "data as of HH:MM UTC" footer |
| D12 | PublicDashboard bundling | Defer to Phase 2 — 180 s cadence on slow aggregates makes 5 HTTP calls acceptable |

---

## 1. Context

`EventSourcingAudit.md` codified the rule that the live indexer
ignores `informational/*` events and serves all current state via
direct chain reads (or D1/IndexedDB cache populated from
`state-change/*` events). That tightened cache-merge discipline —
but it also surfaced a different gap: many of our analytical pages
today still issue **N RPC calls per page-open** because no single
view function returns the full surface they need.

This note specs four bundled view functions that collapse those
multi-call dashboards into one (or, where pagination matters, a
small bounded number of) reads.

## 2. The verified hypothesis

The `Dashboard.tsx` + `PublicDashboard.tsx` audit (this is the
follow-up to §1.1 of the analytical-pages investigation, results
already in conversation) confirmed:

- **Bucket A** (one read, getter exists today): ~85 % of fields.
- **Bucket B** (one read, but needs a NEW getter): ~10 %.
- **Bucket C** (genuinely needs event replay): only **time-bucketed
  TVL / volume series** (3 fields total).

This doc specs the four Bucket-B getters that close the gap. The
Bucket-C surfaces stay event-backed — addressed separately by the
subgraph design ([`SubgraphSchemaDesign.md`](SubgraphSchemaDesign.md)).

## 3. Getter specifications

### 3.1 `MetricsFacet.getUserDashboardSnapshot(user)` — per-user bundle

**Today:** the user's Dashboard fires ~13 RPC calls on happy-path
load (indexer hit) and ~18 on indexer-fallback. That's ~10 hooks
each making 1–N reads (`useUserLoans`, `useLoanRisks`,
`useMyOffers`, `useClaimables`, `useStakingRewards`,
`useInteractionRewards`, `useVPFIDiscountConsent`, etc.).

**Proposal:** split into one always-small **scalar snapshot** +
three paginated list endpoints. The scalar snapshot is the
single read that fires on page-open; the paginated lists are
lazy-loaded below-fold or on tab-switch.

```solidity
struct DashboardScalars {
    // Reward / vault side — bounded, always returned in full.
    uint256 stakingRewardsPending;
    uint256 vaultVpfiBalance;
    uint8   vpfiTier;
    uint256 interactionRewardsPending;
    bool    interactionFinalizedPrefix;
    uint256 interactionWaitingForDay;
    bool    vpfiDiscountConsented;

    // Counts (used to drive pagination UI in the frontend).
    uint32 lenderLoanCount;
    uint32 borrowerLoanCount;
    uint32 activeOfferCount;
    uint32 filledOfferCount;
    uint32 lenderClaimableCount;
    uint32 borrowerClaimableCount;
}

struct LoanWithRisk {
    LibVaipakam.Loan loan;
    uint256 ltvBps;          // 0 if illiquid (no oracle)
    uint256 healthFactor;    // 1e18 scale; 0 if illiquid
}

function getUserDashboardSnapshot(address user)
    external view
    returns (DashboardScalars memory);

function getUserDashboardLoans(address user, bool borrowerSide, uint32 offset, uint32 limit)
    external view
    returns (LoanWithRisk[] memory);

function getUserDashboardOffers(address user, bool filledOnly, uint32 offset, uint32 limit)
    external view
    returns (LibVaipakam.Offer[] memory);

function getUserDashboardClaimables(address user, bool borrowerSide, uint32 offset, uint32 limit)
    external view
    returns (LibVaipakam.ClaimInfo[] memory);
```

**First-load path:**

1. `getUserDashboardSnapshot(user)` → 1 call. Renders the headline
   cards (rewards pending, VPFI tier, claimable counts).
2. Above-fold lists (Active Loans, Active Offers): 2 paginated
   calls with `limit=20`.
3. Below-fold tabs (Filled Offers, Claimables history): lazy-fetch
   on tab-click.

**Net:** 3 RPC reads on happy path, vs. 13 today. ~75 % reduction.

**Scaling:** `limit` is hard-capped at 100 server-side to bound
gas. The frontend shows a "load more" pager beyond that. Protocol-
wide median is < 2 active loans/user; power users at 10–20; we
have no realistic case for unpaginated reads to hit gas limits.

**Storage cost:** zero new storage. All fields are reads from
existing `s.loans / s.offers / s.lenderClaims / s.borrowerClaims /
s.userVpfiTier / s.borrowerLifRebate / s.interactionRewards`. The
view function just iterates and packs.

**Files touched:** new functions in
[`contracts/src/facets/MetricsFacet.sol`](../../contracts/src/facets/MetricsFacet.sol);
new structs in
[`contracts/src/libraries/LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol);
new hook `frontend/src/hooks/useDashboardSnapshot.ts` replacing
the per-section hooks; refactor of
[`Dashboard.tsx`](../../frontend/src/pages/Dashboard.tsx).

---

### 3.2 `MetricsFacet.getRevenueStats(uint256 windowDays)` — rolling treasury windows

**Today:** the public dashboard's "fees last 24 h / 7 d" cards are
served by `useTreasuryMetrics`, which reads
`MetricsFacet.getTreasuryMetrics()` returning a 4-tuple. The 24 h /
7 d slots are computed by walking event history (or a stale
storage snapshot) — not a clean current-state read.

**Proposal:** add a running-counter-based view. Every treasury
accrual call (`LibFacet.recordTreasuryAccrual`) writes into a
ring buffer `s.treasuryAccrualByDay[asset][dayIndex]`. The view
function sums the last `N` days for any window.

```solidity
function getRevenueStats(address asset, uint16 windowDays)
    external view
    returns (uint256 totalAccrued, uint256 dayCount);
```

**Storage cost:** one new `mapping(address => mapping(uint256 =>
uint256)) treasuryAccrualByDay` slot per asset per day. With a
365-day rolling window per asset and N supported assets, worst-
case storage per accruing-asset is O(365). Storage GC: zero out
day slots > 365 days old at the next write to that asset (one
SSTORE-to-zero refund per overwrite, amortized).

**Gas cost on accrual:** +5 k per accrual (one SLOAD + one SSTORE
to update the day's running total). Acceptable; treasury accrual
is not a hot path.

**Why O(1) on read:** sums up to 365 SLOADs in the worst case,
but typical windows are 1 / 7 / 30 days. Frontend caches results
under `useTreasuryMetrics`.

**Migration:** the new mapping is empty at deploy. Backfill is
**not** required — pre-deploy revenue history is preserved by the
existing `MetricsFacet.getTreasuryMetrics()` aggregate; the new
window getter starts populating from deploy-day + 1 onwards. UI
shows "since governance migration" footnote on the rolling-window
cards for the first 30 days.

**Files touched:**
[`MetricsFacet.sol`](../../contracts/src/facets/MetricsFacet.sol),
[`LibFacet.sol`](../../contracts/src/libraries/LibFacet.sol)
(`recordTreasuryAccrual`),
[`LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol)
(new mapping in `Storage`).

---

### 3.3 `Timelock.getPendingProposals()` — governance queue snapshot

**Today:** the AdminDashboard surfaces "pending governance
changes" via subgraph indexing of `ProposalScheduled` /
`ProposalExecuted` / `ProposalCancelled` events. That's an
event-replay path for what is fundamentally current state
(`s.timelockProposals[id]` is a known mapping).

**Proposal:** add a paginated current-state view.

```solidity
struct PendingProposal {
    bytes32 id;
    address target;
    uint256 value;
    bytes   data;
    uint64  scheduledAt;
    uint64  eta;        // earliest execution timestamp
    bool    cancellable;
}

function getPendingProposals(uint32 offset, uint32 limit)
    external view
    returns (PendingProposal[] memory, uint32 totalPending);
```

**Storage cost:** zero new storage if the timelock already tracks
proposals in storage (verify in implementation phase). If not, one
`bytes32[] activeProposalIds` array maintained alongside the
existing mapping.

**Why this matters under decentralisation:** when we move to
IPFS-hosted frontend (Pillar 4 of
[`DecentralizedPlatformArchitecture.md`](../DesignsAndPlans/DecentralizedPlatformArchitecture.md)),
operating without a subgraph means the AdminDashboard MUST be able
to render governance state from chain alone. This getter is on
the IPFS-fallback critical path.

**Files touched:** new function in
`contracts/src/governance/Timelock.sol` (or whatever the timelock
facet is named — confirm during implementation); frontend
`useTimelockProposals` hook.

---

### 3.4 (Optional) `OracleFacet.getHistoricalAssetPrice(asset, dayIndex)` — TVL-time-series moves Bucket C → A

**Today:** the TVL-over-time charts (24 h / 7 d / 30 d / 90 d /
All) require event-replay because:

- TVL at block N requires re-pricing every then-active loan's
  collateral at the asset price as-of block N.
- Today's `OracleFacet.getAssetPrice` returns only the current
  Chainlink answer — no historical lookup.

So `useHistoricalData` reaches into the watcher D1
`/loans/timeseries` endpoint, which in turn reconstructs from
`LoanInitiated` / `LoanRepaid` / etc. event streams.

**Proposal:** snapshot the Chainlink answer once per UTC day,
indexed by day-since-epoch. The TVL chart can then be
reconstructed from current-state reads alone:

```solidity
struct AssetPriceSnapshot {
    int256  price;
    uint8   feedDecimals;
    uint64  capturedAt;   // block timestamp of the snapshot tx
}

function getHistoricalAssetPrice(address asset, uint32 dayIndex)
    external view
    returns (AssetPriceSnapshot memory);

function captureDailyPriceSnapshot(address[] calldata assets)
    external;          // permissionless; one tx per UTC day
```

A keeper (the same hf-watcher Worker, or any caller — it's
permissionless) calls `captureDailyPriceSnapshot(assets)` once per
day. The first caller per day per asset wins; subsequent calls
revert with `AlreadySnapshotted`.

**Storage cost:** O(days × assets). With ~10 supported assets and
365 days/year, that's ~3 650 slots/year. At ~32 bytes per
`AssetPriceSnapshot` packed (price + decimals + timestamp fit in
one slot), cost is bounded.

**Gas cost on capture:** one SLOAD per asset for the
already-snapshotted check, one SSTORE per asset for the new
snapshot, plus one Chainlink read each. Permissionless = no
trusted-keeper assumption.

**This is the move that eliminates Bucket C entirely** for TVL
charts — the only remaining event-replay surface would be the
**daily loan origination volume** chart, which is intrinsically
about counting events (number of `LoanInitiated` per day). Even
that could be moved to a `s.loanOriginationByDay[dayIndex]` ring
buffer if we choose to add it later.

**Status:** flagged optional because it adds protocol storage
cost + a daily keeper transaction. Phase-2 candidate.

**Files touched:**
[`OracleFacet.sol`](../../contracts/src/facets/OracleFacet.sol),
[`LibVaipakam.sol`](../../contracts/src/libraries/LibVaipakam.sol)
(new `assetPriceSnapshots` mapping); hf-watcher Worker gains a
nightly cron at 00:05 UTC.

---

## 4. Rollout sequencing

| # | Getter | Must-ship | Phase | Rough effort |
|---|---|---|---|---|
| 3.1 | `getUserDashboardSnapshot` + 3 paginated companions | Yes | After current event-sourcing pilot | 2–3 days |
| 3.2 | `getRevenueStats` | Yes | Same window | 1–2 days |
| 3.3 | `getPendingProposals` | Yes — IPFS-fallback critical path | Pillar 4 (frontend hosting) cutover | 1 day |
| 3.4 | `getHistoricalAssetPrice` + daily-snapshot keeper | **Yes (D9 brought it forward)** | Same window as 3.1/3.2/3.3 | 2–3 days + keeper plumbing |

3.1 / 3.2 / 3.3 should land as a single contract PR + matching
frontend PR + matching ABI re-export. They share the same
`MetricsFacet` / governance edits and a single regression run is
cheaper than three.

3.4 ships independently once we agree on the daily-snapshot
storage cost.

## 5. Open questions

1. **3.1 — pagination defaults.** Should `limit` default to 20 in
   the frontend or 50 in the contract? Trade-off: smaller default
   = lower gas per page, more clicks for power users. Proposal:
   default 20 in frontend, hard-cap 100 in contract. Confirm.

2. **3.2 — backfill of pre-deploy treasury history.** Is the
   "since governance migration" footnote acceptable, or do we
   want a one-shot script that reads historical
   `TreasuryFeeAccrued` events and writes the day-buckets? The
   one-shot script is feasible but adds a deploy step. Proposal:
   skip, accept the footnote.

3. **3.4 — first-day-with-no-snapshot UX.** If the keeper hasn't
   captured today yet (tx pending), should the chart render the
   most recent snapshot or null-out today's bucket? Proposal:
   render most recent + a "data as of HH:MM UTC" footer. Confirm.

4. **3.4 priority.** Confirm Phase-2 deferral. The TVL-chart
   Bucket-C dependency is the strongest IPFS-fallback motivator;
   if the IPFS cutover is closer than Phase-2, 3.4 becomes
   must-ship.

## 6. Page-by-page one-call verdict (watermark refetch audit)

The watermark-policy hook (`frontend/src/hooks/watermarkPolicy.ts`)
drives every page's "is my data stale?" decision. When the
watermark advances, each page's hooks decide whether to refetch.
The cost of a watermark advance is therefore `Σ (per-page-refetch
RPC cost)`. Tightening that cost requires every page to be
servable in **one call per refetch cycle** wherever possible.

| Page | Today's reads / refetch | Verdict | Action |
|---|---|---|---|
| **Dashboard** (per-user) | 1 indexer fetch + 2 multicalls (LTV batch + HF batch) | **Bundlable to 1 call** | Spec'd in §3.1 — `LoanWithRisk[]` returns loan + ltvBps + healthFactor inline |
| **Activity** (per-user feed) | 1 indexer fetch | **Already one call** | None |
| **VaultAssets** (per-user) | 1 indexer fetch (lender + borrower in parallel) | **Already one call** | None |
| **PublicDashboard** (protocol stats) | 5 sequential HTTP indexer calls (cool-tier 180 s refresh) | **Bundlable to 1 call** | New `MetricsFacet.getPublicDashboardSnapshot()` returning the 5 sub-results in one struct. Defer — 180 s cadence on slow-moving aggregates makes the spread acceptable |
| **OfferBook** | 1 indexer fetch (200 / page) + chunked `eth_getLogs` catch-up | **CANNOT compress further** | None — see below |

### 6.1 OfferBook is the structural exception

OfferBook is intrinsically multi-read because:

1. **Protocol-wide unbounded set.** The page lists every active
   offer across every asset (typically 100s, peak in the 1000s).
   No single user-keyed predicate narrows it.
2. **Client-side filter / sort.** Users pick rate / duration /
   asset / side ranges interactively. Server-side filtering would
   need a parameterised getter for every combination — not
   tractable. The page must hold the full active set in client
   memory to rank against any filter the user picks.
3. **Live-tail pattern is the right answer.** OfferBook today
   uses the indexer's paginated `getActiveOffers(offset, limit)`
   plus a chunked `eth_getLogs` catch-up since the indexer's last
   block. That's "1 atomic page + 1 catch-up read", not N reads
   per offer. Compressing further would require server-side
   sort/filter combinatorics that aren't worth the contract gas.

So OfferBook stays as-is. The pattern "watermark advances → refetch
last page + catch up via logs" is already the structural minimum;
no bundled getter improves it.

### 6.2 Net change to §4 rollout sequencing

Item 3.1 (`getUserDashboardSnapshot`) **already covers Dashboard's
gap** — the `LoanWithRisk` struct returning loan + LTV + HF inline
is exactly the bundling the audit identified. No new work needed.

Item 6 PublicDashboard bundling is added as an **optional Phase 2**
follow-up — the 180 s refresh cadence on slow-moving aggregates
makes it lower priority than the per-user / per-page items in §3.

### 6.3 Indexer-down fallback consideration

When the indexer is unreachable (`IndexerStatusBadge` red), every
page falls back to direct chain reads. The bundling in §3 gets
**more** valuable in that mode — Dashboard goes from 13 reads (or
18 on fallback) to 3 reads, and the fallback path benefits the
most because it can't rely on the indexer's pre-aggregated
responses. Same logic applies to all four §3 getters.

## 7. Verification

For each getter:

- New unit-test file under `contracts/test/` asserting the bundled
  shape returns identical values to the per-field reads.
- Frontend integration test using the live local-anvil deploy.
- ABI re-export to frontend + watcher per the standard sync flow
  (`bash contracts/script/exportFrontendAbis.sh`,
  `exportWatcherAbis.sh`).

---

**Awaiting sign-off** on:
- The 4 getter shapes (especially the 3.1 paginated split).
- The 3.4 Phase-2 deferral decision.
- The 3.2 no-backfill decision (footnote-only acceptable?).
