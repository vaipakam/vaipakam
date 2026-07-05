# Bulk Wallet-Dashboard Read Views (#1025)

**Status:** Design — pending implementation
**Module:** contracts (with an apps/alpha02 consumer switch to follow)
**Priority:** P3 — pre-mainnet nicety, batched with pre-audit-hardening
**Origin:** RPC-efficiency review after #1016 chain-authoritative own-positions
discovery (user-approved 2026-07-05).

---

## 1. Problem

`apps/alpha02`'s #1016 own-positions discovery is **chain-authoritative**:
a wallet's open created offers, held offer-NFTs, and held loan positions are
enumerated directly from the Diamond in a handful of cheap paginated reads,
then each id is hydrated one-by-one:

- `readOwnOfferRowsLive` enumerates offer ids (union of
  `getUserOffersPaginated` created + `getUserPositionOffersPaginated`
  held-via-NFT), then for **each id** issues `getOffer` **+** `getOfferState`
  — two `eth_call`s per offer.
- `readOwnLoanRowsLive` enumerates held loan ids via
  `getUserPositionLoansPaginated`, then for **each id** issues
  `getLoanDetails` — one `eth_call` per loan, returning the full 48-field
  `Loan` struct.

So a positions refresh costs roughly:

```
~3 (enumeration pages) + 2 × (lifetime created + held offers) + (held loans)
```

metered `eth_call`s, each carrying a fat single-record payload
(`getOffer` = the full 38-field `Offer`; `getLoanDetails` = the full 48-field
`Loan`).

Client-side multicall batching (wagmi/viem Multicall3, already live per #1026)
collapses the **metering** of these calls, but it does not reduce **calldata**,
does not reduce the number of logical reads, and returns fat per-record structs
whose shape does not match what the list actually renders. The deeper,
mainnet-grade fix — the pattern Aave's `UiPoolDataProvider` and Uniswap's lens
contracts use — is a **purpose-built bulk view** whose one call returns a
dashboard-shaped, lean projection for a whole id array.

## 2. Goals / non-goals

**Goals**

- G1. A single `eth_call` that hydrates an arbitrary array of offer ids into
  lean, dashboard-shaped DTOs, **each already carrying its canonical
  `OfferState`** — collapsing the current `2×offers` reads into one.
- G2. A symmetric single-call bulk view for loan ids — collapsing the current
  `1×loans` fat reads into one lean call.
- G3. Reuse the existing lean-DTO machinery (`LibMetricsTypes.OfferSummary` /
  `LoanSummary`, the `toOfferSummary` / `toLoanSummary` converters, the
  `OfferState` derivation, the `LoanWithRisk` wrapper idiom) — do not invent a
  parallel projection layer.
- G4. Keep the per-id hydration path intact as a **revert-probe fallback** for
  older deploys that predate the bulk view (same pattern as the existing
  `getUserPositionLoansPaginated` → legacy `getUserPositionLoans` fallback in
  `liveLoanRow.ts`).

**Non-goals**

- N1. No change to the keeper-bot surface (`MetricsFacet.getActiveLoansCount`
  / `getActiveLoansPaginated`, `RiskFacet.calculateHealthFactor` /
  `triggerLiquidation`, `LoanFacet.getLoanDetails`) — untouched.
- N2. No new indexer requirement — these are read views the connected app
  calls directly against the user's RPC; the indexer stays the fast-path D1
  mirror it is today (#768).
- N3. Not a quota remediation. Per #1026's live measurement (27/27 `/positions`
  `eth_call`s already route through Multicall3, ~0.9 metered calls/sec per
  active viewer) this is a round-trip / calldata / response-shape improvement,
  not a rate-limit fire.

## 3. What already exists (reuse inventory)

Scouted 2026-07-05. The pieces to compose already exist; the gap is a
**batch-by-id entry point** and a DTO that **pairs a summary with its
state**.

| Primitive | Location | Note |
| --- | --- | --- |
| `OfferSummary` (19-field flat lean DTO) | `LibMetricsTypes.sol:18-38` | Drops rental/listing/snapshot/range-max/consent/liquidity fields vs the 38-field storage `Offer`. |
| `toOfferSummary(Offer storage)` | `LibMetricsTypes.sol:163-177` | Straight field copy. |
| `LoanSummary` (19-field flat lean DTO) | `LibMetricsTypes.sol:40-64` | Carries `status`, `lenderTokenId`, `borrowerTokenId`. Drops the 48-field `Loan`'s accrual/discount/fee-snapshot bookkeeping. |
| `toLoanSummary(Loan storage)` | `LibMetricsTypes.sol:179-194` | Straight field copy. |
| `enum OfferState { Open, Accepted, Cancelled, ConsumedBySale }` | `MetricsFacet.sol:1166` | **Private to MetricsFacet today.** |
| `_offerStateOf(Storage, offerId)` | `MetricsFacet.sol:1557` | The single terminal-precedence derivation (Accepted > Cancelled > ConsumedBySale > Open). Private. |
| `getOfferState(offerId) → OfferState` | `MetricsFacet.sol:1533` | Public single-id wrapper. |
| `LoanWithRisk { LoanSummary loan; uint256 ltvBps; uint256 healthFactor; }` | `MetricsDashboardFacet.sol:95-99` | **Proven precedent** for a wrapper struct nesting a lean summary + extra fields, returned in an array (`getUserDashboardLoans`). |
| `getUserPositionOffersPaginated` / `getUserPositionLoansPaginated` | `MetricsFacet.sol:1380 / 1325` | By-**current-NFT-holder** enumeration (catches secondary-market transfers `userOfferIds`/`userLoanIds` miss). These already feed the frontend's id arrays. |

**Key gap:** no view takes an arbitrary `uint256[] ids`. No DTO combines
`OfferSummary` + the derived `OfferState`. `getUserDashboardOffers` /
`getUserDashboardLoans` exist but enumerate **by creation-keyed index**
(`userOfferIds` / `userLoanIds`), so they **miss transferred-in positions** —
which is exactly why #1016 switched the frontend to the by-holder
`getUserPosition*Paginated` enumeration. A batch-by-id view fed by the
frontend's already-enumerated (by-holder) id set is therefore the correct
primitive; a by-owner aggregate would silently drop transfers.

## 4. The render-field delta (what the DTO must carry)

The bulk view must let the frontend **replace** the per-id `getOffer` /
`getLoanDetails` path, so it must carry every field the row renderer reads —
otherwise the switch silently blanks fields.

**Offer row (`IndexedOffer`, populated by `readOfferRowLive`)** needs 29
on-chain fields + the derived state. `OfferSummary` supplies 19 of them and is
**missing 10** the row renders:

```
creator, principalLiquidity, collateralLiquidity, quantity,
positionTokenId, prepayAsset, useFullTermInterest,
creatorRiskAndTermsConsent, allowsPartialRepay, fillMode
```

plus the derived `OfferState status`.

**Loan row (`PositionLoan`, populated by `readLoanRowLive`)** — `LoanSummary`
already carries `status`, both position `tokenId`s (role is derived by
comparing the held tokenId against `lenderTokenId` / `borrowerTokenId`, both
present), and every rendered numeric/asset field. It is **missing only** the
counterparty display addresses `lender` and `borrower`.

## 5. Design

### 5.1 New DTOs (added to `LibMetricsTypes.sol`, flat, lean)

```solidity
// OfferSummary's 19 fields + the 10 render fields it omits + the derived state.
// Flat (no nesting beyond the enum) → shallow ABI-coder stack, per the #603 rule.
struct OfferView {
    // --- OfferSummary render set ---
    uint256 id;
    LibVaipakam.OfferType offerType;
    bool accepted;
    uint64 createdAt;
    uint64 expiresAt;
    address lendingAsset;
    LibVaipakam.AssetType assetType;
    uint256 amount;
    uint256 amountMax;
    uint256 interestRateBps;
    uint256 interestRateBpsMax;
    uint256 durationDays;
    uint256 tokenId;
    uint256 amountFilled;
    address collateralAsset;
    LibVaipakam.AssetType collateralAssetType;
    uint256 collateralAmount;
    uint256 collateralTokenId;
    uint256 collateralQuantity;
    // --- fields OfferSummary omits but the dashboard row renders ---
    address creator;
    LibVaipakam.LiquidityStatus principalLiquidity;
    LibVaipakam.LiquidityStatus collateralLiquidity;
    uint256 quantity;
    uint256 positionTokenId;
    address prepayAsset;
    bool useFullTermInterest;
    bool creatorRiskAndTermsConsent;
    bool allowsPartialRepay;
    LibVaipakam.FillMode fillMode;
    // --- the reason this view exists ---
    LibMetricsTypes.OfferState state;
}

// LoanSummary + the two counterparty display addresses. Mirrors the proven
// LoanWithRisk wrapper shape (LoanSummary nested + scalar tail).
struct LoanView {
    LibMetricsTypes.LoanSummary loan;
    address lender;
    address borrower;
}
```

**Why `OfferView` is flat, not `{ OfferSummary summary; ...extras; OfferState state; }`:**
`OfferSummary` lacks 10 of the render fields, so a wrapper would still need a
sibling extras block — a wrapper buys nothing and adds a nesting level. A flat
30-field struct keeps the ABI coder shallow. `LoanView` **does** nest
`LoanSummary` because `LoanSummary` is field-complete for loans (only the two
addresses are added) and the `LoanWithRisk` precedent proves that exact
one-level nesting compiles and ships.

**viaIR budget note (load-bearing).** Per the #603 lean-DTO rule and the
`viair_stack_too_deep` lever: returning **an array of a fat struct** inflates
the ABI coder's peak stack and can trip the whole-unit viaIR ceiling; lean flat
DTOs *fix* it, and **sub-structing ABI-boundary types worsens** it. `OfferView`
is 30 flat fields — larger than the proven `OfferSummary` (19) but flat. This
is the one build-verification risk in the design. Mitigation ladder if
`FacetSizeLimitTest` or a viaIR stack error trips at implementation:
  1. Confirm it's the ABI coder (not facet bytecode) — a 30-field flat return
     is well within precedent for single structs; the risk is only the *array*.
  2. If tripped: drop the two rarely-list-rendered booleans
     (`useFullTermInterest`, `creatorRiskAndTermsConsent`) from the array DTO
     and let the detail view fetch them per-id — the list doesn't need them.
  3. Last resort: split into `getOffersWithState` (OfferSummary + state, 20
     flat) + a parallel `getOfferBadges(uint256[])` for the 10 extras. Only if
     (2) is insufficient.

### 5.2 New views (added to `MetricsDashboardFacet`)

```solidity
function getOffersWithState(uint256[] calldata offerIds)
    external view returns (LibMetricsTypes.OfferView[] memory views);

function getLoansBatch(uint256[] calldata loanIds)
    external view returns (LibMetricsTypes.LoanView[] memory views);
```

- Both iterate the caller-supplied id array, load `s.offers[id]` /
  `s.loans[id]` once, project via the (extended) converters, and — for offers —
  stamp `state` via the shared derivation (§5.3).
- **Strictly positional — `views[i]` ⟷ `ids[i]`, duplicates preserved.** The
  views map each input id to exactly one output element **in order**, and do
  **not** dedupe. This is load-bearing for **dual-role loan holders**: when a
  wallet owns both the lender and borrower position NFTs for the same loan, the
  frontend's holder enumeration intentionally returns that `loanId` **twice**
  (paired with two different `heldTokenId`s) and `readOwnLoanRowsLive` produces
  two role-specific rows. `getLoansBatch` must echo a duplicate `loanId` as two
  identical elements so the consumer can zip each back to its `heldTokenId` and
  keep both role rows. A "clever" dedupe (contract-side or in the consumer
  mapper) would collapse one role and hide one side from Positions / Claimables
  — explicitly forbidden, and guarded by a duplicate-id test (§7).
- **Unknown / never-existed id:** return a zero-value element in place (do
  **not** revert the whole batch). `getLoanDetails` already does not revert on
  unknown id; the frontend's existing `lender == 0 && borrower == 0 → null`
  guard filters these, and the offer path filters on `state == Cancelled`
  where `o.id == 0` (matching `_offerStateOf`'s existing "never-existed →
  Cancelled" contract). Batch-level all-or-nothing would let one stale id
  blank a whole refresh — element-level zeroing is the safe choice.
- **Bounded batches — chunk client-side, cap server-side.** A `view` over
  `eth_call` is still subject to RPC gas / time / response-size limits, and
  `getOffersWithState` returns a 30-field element per id. `readOwnOfferRowsLive`
  accumulates **every** created id + every held-offer id into one `Set` before
  hydration, capped only at `WALK_CAP = 2000` — so a heavy or griefed-inventory
  wallet could feed thousands of ids into one call and fail the whole refresh,
  which is the very large-inventory failure mode this design exists to fix.
  Therefore:
  - **Consumer chunks** the id set into `PAGE`-sized slices (reuse the existing
    `PAGE = 200`) and issues `⌈N/PAGE⌉` batch calls, concatenating results.
    This still collapses the current `2×N` per-id reads into `⌈N/PAGE⌉` calls
    (e.g. 400 offers: 800 reads → 2 calls) — the win survives chunking.
  - **Contract caps** the input length defensively: revert
    `BatchTooLarge(uint256 got, uint256 max)` when
    `ids.length > MAX_BATCH_IDS` (start `MAX_BATCH_IDS = 250`, a headroom over
    `PAGE`). A hard cap bounds worst-case response size regardless of caller,
    and the revert is an honest, probeable signal (not a truncated/partial
    result) the consumer can react to. Document both the cap and the
    "chunk by `PAGE`" contract in the NatSpec.

**Home facet — `MetricsDashboardFacet`, not a new facet.** It already owns the
dashboard aggregate surface (`getUserDashboardLoans`, `getUserDashboardOffers`,
`LoanWithRisk`) and is 533 lines vs MetricsFacet's 1921 (likely near EIP-170),
so it has the semantic fit and the bytecode headroom. This also avoids the full
facet-addition checklist — we only add the two selectors to the existing
`_getMetricsDashboardSelectors()` in `DeployDiamond.s.sol` +
`SelectorCoverageTest.t.sol` and to the public
`getMetricsDashboardFacetSelectors()` in `HelperTest.sol`, no
`DiamondFacetNames` /
`DeployDiamondIntegration` / barrel churn. **Fallback:** if `FacetSizeLimitTest`
shows `MetricsDashboardFacet` over 24,576 bytes after the addition, split these
two views into a new dedicated `DashboardViewFacet` and take the full
facet-addition checklist then.

### 5.3 DRY the `OfferState` derivation (hoist to the library)

`getOffersWithState` must derive `OfferState` for each id. The derivation
(`_offerStateOf`, terminal precedence Accepted > Cancelled > ConsumedBySale >
Open) is **private to `MetricsFacet`**. Two facets computing the same terminal
precedence from two copies is a divergence bug waiting to happen.

**Move** `enum OfferState` and the derivation into `LibMetricsTypes` as:

```solidity
enum OfferState { Open, Accepted, Cancelled, ConsumedBySale }
function deriveOfferState(LibVaipakam.Storage storage s, uint256 offerId)
    internal view returns (OfferState);
```

`MetricsFacet` keeps `getOfferState` as a thin wrapper over
`LibMetricsTypes.deriveOfferState` and re-references `LibMetricsTypes.OfferState`
at its internal call sites (`getUserOffersByStatePaginated`,
`getOffersByStatePaginated`). **Wire-compatible, not JSON-identical:** a Solidity
enum is `uint8` on the ABI boundary, so the **selector and calldata/return
encoding are byte-identical** — no consumer decode breaks. But the exported ABI
JSON's `internalType` string **does** change for every signature that mentions
the enum (`getOfferState` return, and the `OfferState` inputs on the two
state-paginated views) from `enum MetricsFacet.OfferState` to
`enum LibMetricsTypes.OfferState`. The committed package ABI records the former,
so the implementation PR's `exportFrontendAbis.sh` re-export will show
`internalType`-only churn on `MetricsFacet.json` (in addition to the new
`MetricsDashboardFacet.json` selectors). That diff is cosmetic (no runtime
effect) but must ship with the PR — call it out in the rollout so a reviewer
isn't surprised by the extra JSON churn. One derivation, both facets, zero
drift.

### 5.4 Consumer switch (apps/alpha02 — follow-up PR, not this contracts PR)

- `readOwnOfferRowsLive`: after enumerating the id `Set`, **chunk it into
  `PAGE`-sized slices** and issue one `getOffersWithState(slice)` per chunk,
  concatenating `OfferView[]` → `IndexedOffer[]` (the `OFFER_STATE` enum array +
  client-side GTT `'expired'` overlay stays). Revert-probe fallback → today's
  per-id `getOffer` + `getOfferState` loop.
- `readOwnLoanRowsLive`: after enumerating `{loanId, heldTokenId}` pairs,
  **chunk the `loanId` list (order preserved, duplicates kept)** and issue one
  `getLoansBatch(slice)` per chunk, then **zip `LoanView[]` back to the original
  pair list positionally** so each element maps to its `heldTokenId` (role from
  `heldTokenId` vs `lenderTokenId`/`borrowerTokenId`, both in `LoanSummary`).
  Do **not** dedupe the loanId list before the call — dual-role holders depend
  on the duplicate (§5.2). Revert-probe fallback → today's per-id
  `getLoanDetails` loop.
- Fallback probe must **distinguish selector-absent from `BatchTooLarge`.**
  With the §5.2 cap in place, a batch-view revert no longer implies "old deploy
  lacks the selector" — it could be `BatchTooLarge` from cap/`PAGE` drift.
  Treating that as legacy and silently falling back to per-id hydration would
  hide the cap violation and **recreate the exact large-inventory failure mode
  the cap exists to prevent.** So the consumer narrows the probe: only a
  **function-not-found / zero-data** revert (`ContractFunctionZeroDataError`,
  the old-deploy signature) routes to the per-id path; a decoded
  `BatchTooLarge` (or any other named contract revert) is surfaced as an error,
  not swallowed. The `PAGE ≤ MAX_BATCH_IDS` invariant means a correctly
  configured client never trips `BatchTooLarge`; if it does, that's a config
  bug to see, not to paper over. A transport error → `null` (whole source
  degraded, existing banner), as today.
- **Frontend ABI re-export ships with the CONTRACTS PR** — the PR that adds the
  selectors runs `exportFrontendAbis.sh` (re-exports `MetricsDashboardFacet.json`
  new selectors + the `MetricsFacet.json` `internalType` churn from §5.3; the
  barrel already includes both) so the committed package ABI never lags the
  deployed surface. The consumer PR only *imports* that already-exported
  surface — it does not defer the export.

## 6. Alternatives considered

- **A. `getUserDashboard(address, offset, limit)` mega-aggregate** (the issue's
  "optional" second bullet) — one call returning created offers + held offer
  NFTs + held loans. **Deferred, not chosen for v1.** Reasons: (a) paging three
  heterogeneous lists under one `offset/limit` is semantically muddy (whose
  cursor?); (b) a by-address aggregate must re-implement the by-holder
  enumeration to avoid the transfer-blindness of `getUserDashboardOffers`,
  duplicating `getUserPosition*Paginated`; (c) the frontend **already**
  enumerates the id sets cheaply, so two batch-by-id calls fed by those sets
  save the same round trips with far less contract surface and compose directly
  with the existing #1016 flow. The mega-aggregate is a marginal
  round-trip saving over the two-batch approach and can be a later follow-up if
  measurement justifies it. **Recommendation: ship the two batch-by-id views;
  file the aggregate as a deferred follow-up.**
- **B. Wrapper `OfferWithState { OfferSummary; OfferState }`** — rejected:
  `OfferSummary` omits 10 render fields, so a wrapper still needs a sibling
  extras block and adds a nesting level for nothing (§5.1).
- **C. Extend `OfferSummary` itself** to carry the 10 extras — rejected: it
  bloats the two existing `OfferSummary[]` consumers
  (`getUserAllOffersWithDetails`, `getUserDashboardOffers`) that don't render
  those fields, making the "lean" DTO fat for everyone. A purpose-built
  `OfferView` keeps `OfferSummary` lean.
- **D. Client-only multicall (Multicall3)** — already live (#1026) and kept; it
  fixes metering but not calldata, logical-read count, or response shape. This
  design is the complementary deeper fix, not a replacement.

## 7. Deploy-sanity & test plan

**Deploy-sanity (per CLAUDE.md):**
- Add `getOffersWithState` + `getLoansBatch` selectors to the production cut
  helper `_getMetricsDashboardSelectors()` in `DeployDiamond.s.sol` **and** the
  public test helper `getMetricsDashboardFacetSelectors()` in `HelperTest.sol`
  (note the different names — the production helper has the leading underscore
  and no `Facet`, the test helper is the reverse). `SelectorCoverageTest.t.sol`
  covers `MetricsDashboardFacet` already via its own
  `_getMetricsDashboardSelectors()` at `_populateRoutedSet()` → add the two
  selectors there too. No new facet name in `DiamondFacetNames`.
- `FacetSizeLimitTest` — confirms `MetricsDashboardFacet` stays ≤ 24,576 bytes
  after the addition (the §5.2 fallback trigger).

**Unit tests (`test/MetricsDashboardFacetTest.t.sol` or a new
`test/BulkDashboardViewsTest.t.sol`):**
1. `getOffersWithState` over a mixed array (Open, Accepted, Cancelled,
   ConsumedBySale, never-existed) → each element's `state` matches
   `getOfferState(id)` exactly (parity guard for the hoisted derivation).
2. `getOffersWithState` field parity — each `OfferView` field equals the
   corresponding `getOffer(id)` field for a populated offer (no field dropped
   or transposed).
3. Never-existed offer id → zero-value element with `state == Cancelled`
   (matches `_offerStateOf`'s `o.id == 0` contract), batch does not revert.
4. `getLoansBatch` field parity — `LoanView.loan` equals
   `toLoanSummary(getLoanDetails(id))`; `lender`/`borrower` match.
5. Unknown loan id → zero-value element (`lender == 0 && borrower == 0`),
   batch does not revert.
6. Empty id array → empty array, no revert.
7. `getOfferState` ABI/behaviour unchanged after the derivation hoist
   (regression guard on the refactor).
8. Large array (e.g. `MAX_BATCH_IDS` ids) compiles and returns without a
   viaIR/stack failure (the §5.1 build risk, exercised).
9. **Over-cap** — `ids.length == MAX_BATCH_IDS + 1` reverts
   `BatchTooLarge(got, max)` on both views (the §5.2 server-side cap); exactly
   `MAX_BATCH_IDS` succeeds (boundary).
10. **Duplicate loanId / dual-role holder** — `getLoansBatch([L, L])` (same
    loan id twice) returns two identical `LoanView`s positionally, proving the
    view does not dedupe and the pair-alignment contract holds (§5.2 / §5.4).
    Symmetric duplicate-offerId case for `getOffersWithState`.

**Verification order:** `FOUNDRY_PROFILE=quick forge build` inner loop →
**`forge build --skip test`** for the ABI shape / re-export (per CLAUDE.md — a
bare test-inclusive `forge build` can trip the known viaIR whole-unit stack
ceiling; `--skip test` compiles `src/`+`script/`, all `forge inspect` needs) →
targeted `forge test --match-path test/BulkDashboardViewsTest.t.sol` +
`--match-path test/deploy/*` (selectors/size changed) — per the per-PR targeted
rule, not the full regression. All forge commands take the
`nice -n -10 ionice -c 2 -n 0` high-priority prefix.

## 8. Rollout

1. **This PR (design):** this document only.
2. **Contracts PR:** DTOs + two views (with the `MAX_BATCH_IDS` cap +
   `BatchTooLarge` error) + derivation hoist + deploy-sanity selectors + tests +
   frontend ABI re-export + release-note fragment + FunctionalSpec update. The
   re-export touches **both** `MetricsDashboardFacet.json` (new selectors) and
   `MetricsFacet.json` (`internalType`-only churn from the enum hoist, §5.3) —
   expect that second, cosmetic diff.
3. **Consumer PR (apps/alpha02):** switch `readOwnOfferRowsLive` /
   `readOwnLoanRowsLive` to the batch views with the revert-probe fallback.
4. **Deferred follow-up:** the `getUserDashboard` mega-aggregate (Alternative
   A), only if measurement justifies it over the two-batch approach.

Because the platform is pre-live, the ABI break is cheap and the atomic
consumer switch is not a per-PR gate — but the frontend ABI re-export ships
with the contracts PR for consistency.
