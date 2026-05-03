# Release Notes — 2026-05-03

Functional record of work delivered on 2026-05-03, written as
plain-English user-facing / operator-facing descriptions — no code.
Continues from
[`ReleaseNotes-2026-05-02.md`](./ReleaseNotes-2026-05-02.md).

Coverage at a glance: **Introducing Numeraire** — every
numeraire-denominated governance knob in the protocol now reads from
the SINGLE global `numeraireOracle` introduced under T-034, instead of
carrying its own per-knob USD-oracle slot. The notification fee's
pluggable USD oracle is retired; KYC tier thresholds are renamed away
from "USD"; the atomic batched setter `setNumeraire` is extended to
take EVERY numeraire-denominated value at once so a numeraire rotation
never leaves the storage in an inconsistent intermediate state.
Follow-up to the T-034 Periodic Interest Payment work that landed
across 2026-05-02 → 2026-05-03.

## Introducing Numeraire — single-source-of-truth reference currency

**The shape of the problem.** T-034 introduced a `numeraireOracle`
config slot so the periodic-interest principal threshold could be
denominated in something other than USD (the design doc anticipated
EUR / JPY / XAU as plausible future numeraires). Other governance
knobs in the protocol — the notification fee (T-032) and the KYC tier
thresholds (industrial-fork only) — were USD-denominated and carried
their own per-knob oracle infrastructure. That created a drift hazard:
governance flipping the global numeraire from USD to XAU would leave
notification fee + KYC tiers stranded in USD-units against a
new-numeraire threshold, OR governance would have to remember to
rotate three independent oracle slots in lockstep. Generalizing the
numeraire collapses every numeraire-denominated knob onto the SAME
global `numeraireOracle` and makes the rotation atomic.

**Three phases, one commit.**

**Phase 1 — Notification fee migration.** The per-loan-side
notification fee (`notificationFeeUsd` storage slot, charged in VPFI
on the first paid-tier notification) is renamed to `notificationFee`
and reinterpreted as numeraire-units (1e18-scaled). The library
constants (`NOTIFICATION_FEE_USD_DEFAULT/FLOOR/CEIL`) drop the `_USD`
suffix. The setter `setNotificationFeeUsd` becomes
`setNotificationFee`; the per-knob oracle setter
`setNotificationFeeUsdOracle` is **deleted** outright — the
notification fee's denomination now flows through the global
`numeraireOracle`, not a per-knob one. The bundled getter
`getNotificationFeeConfig` drops its `feeOracle` field (returns just
`(feeNumeraire1e18, feesAccrued)` now).

The pricing helper inside `LibNotificationFee` rewires from the old
two-path (per-knob VPFI/<denomination> oracle OR ETH/USD-via-Chainlink
fallback) to a clean two-step:
  1. `numeraire → USD` via the global `numeraireOracle`'s
     `numeraireToUsdRate1e18()`. Address(0) means USD-as-numeraire and
     skips the call entirely (post-deploy default behavior).
  2. `USD → VPFI` via the existing Chainlink ETH/USD feed × the fixed
     `VPFI_PER_ETH_FIXED_PHASE1 = 1e15` (1 VPFI = 0.001 ETH) Phase 1
     rate. Unchanged.

The retired per-knob oracle path was a Phase 2 / VPFI-listing seam
that never had to be cut over to in production; with the global
numeraire abstraction in place, the seam is redundant and the
single-source-of-truth wins.

**Phase 2 — KYC thresholds migration.** The two industrial-fork
KYC tier thresholds are renamed away from "USD" — constants from
`KYC_TIER{0,1}_THRESHOLD_USD` to `KYC_TIER{0,1}_THRESHOLD_NUMERAIRE`,
storage fields from `kycTier{0,1}ThresholdUSD` to
`kycTier{0,1}ThresholdNumeraire`, the bounds constants
`KYC_THRESHOLD_USD_MIN_FLOOR / _MAX_CEIL` to `_NUMERAIRE_MIN_FLOOR /
_MAX_CEIL`. The `ProfileFacet.updateKYCThresholds` setter param names
and `ParameterOutOfRange` revert tag literals follow.

The trick that keeps the change non-invasive: the comparison sites
(`OfferFacet`, `RiskFacet`, `DefaultedFacet`) all compute "value of
asset X in USD" via Chainlink — which quotes in USD as external
truth. Those sites are unchanged in this sweep. The migration
happens at the GETTER boundary: `LibVaipakam.getKycTier0Threshold()`
and `getKycTier1Threshold()` now read the numeraire-denominated
storage value AND convert it to USD-1e18 via the global numeraire
oracle before returning. Callers stay USD-typed; the numeraire
abstraction is purely an internal storage / governance-knob concern.

A new private helper `LibVaipakam._convertNumeraireToUsd` does the
single-step conversion (no-op when oracle is address(0); multiplies
by `numeraireToUsdRate1e18` / 1e18 otherwise). Used by both threshold
getters; ready to be reused if any other USD-typed boundary surfaces.

**Phase 3 — Atomic multi-arg `setNumeraire`.** The atomic batched
setter introduced under T-034 PR1 took two args:
`setNumeraire(newOracle, newThresholdInNewNumeraire)`. The numeraire
generalization extends it to take ALL numeraire-denominated values
together:
`setNumeraire(newOracle, threshold, notificationFee, kycTier0,
kycTier1)`. By construction, governance cannot rotate the numeraire
without also re-anchoring every value that's denominated in it. The
inconsistent-intermediate-state failure mode (numeraire = XAU,
threshold still in USD) becomes unreachable.

Each knob retains its per-knob bounded validator from the previous
work (`PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_FLOOR/CEIL`,
`MIN/MAX_NOTIFICATION_FEE_FLOOR/CEIL`,
`KYC_THRESHOLD_NUMERAIRE_MIN_FLOOR/MAX_CEIL`). KYC tier monotonicity
(`tier0 < tier1`) is checked when both values come in non-zero. Zero
on any field means "reset to library default" — same convention used
elsewhere in the config setters.

The per-knob "within-the-same-numeraire" setters
(`setMinPrincipalForFinerCadence`, `setNotificationFee`,
`updateKYCThresholds`) all stay; they're for routine tuning. The
batched `setNumeraire` is reserved for governance ROTATIONS of the
numeraire itself, gated by the `numeraireSwapEnabled` kill-switch
that defaults `false` post-deploy.

**Group B intentionally not touched.** Internal computation variables
named `valueUSD` / `bonusUSD` / `usdValue1e18` (in `OfferFacet` KYC
check, `RiskFacet` liquidator-bonus tier check, `DefaultedFacet` KYC
check) were considered for inclusion in the sweep and explicitly left
alone. Reason: those variables compute "value of asset X in USD" via
Chainlink, which IS the external pricing truth. Renaming them to
`valueNumeraire` would create a misleading abstraction whose actual
content is exactly the USD value Chainlink returned. The numeraire
abstraction matters at the **governance boundary** — where humans
interact with the protocol's reference currency. Inside the math,
USD-as-internal-unit is the most faithful reflection of the oracle
truth. Phase 1+2 already gives the governance-boundary abstraction;
Group B would be ~200 sites of mechanical rename + new conversion-
at-comparison logic, all to obscure something that's actually
clarifying.

## Verification

- `forge build` clean (src + scripts).
- Four affected test suites green:
  - `PeriodicInterestCadenceTest` 34/34 — exercises `setNumeraire`
    in 5-arg form; was the only test calling it.
  - `PeriodicInterestSettleTest` 14/14.
  - `NotificationFeeTest` 14/14 — covers the renamed
    `setNotificationFee` plus its bounds, plus the dropped
    per-knob-oracle path's tests REMOVED entirely (no longer a
    surface to test).
  - `ProfileFacetTest` 50/50 — exercises the renamed KYC threshold
    setter and the boundary-conversion getter.
- HelperTest selector list 38 → 37 (one drop, one rename); script
  `_getConfigSelectors` 26 → 25 same shape.
- ABIs re-synced from `contracts@<HEAD>`. Frontend `tsc -b --noEmit`
  clean. The single Alerts.tsx comment reference to
  `cfgNotificationFeeUsd` updated to `cfgNotificationFee` for
  doc-consistency.

## Operator deploy notes

1. **Storage layout change is pre-launch only.** The retired
   `notificationFeeUsdOracle` slot is removed from `ProtocolConfig`;
   the renamed fields (`notificationFee`, `kycTier{0,1}ThresholdNumeraire`)
   carry the same byte layout as before so values that were already
   set under USD-units are preserved verbatim — but their
   INTERPRETATION is now numeraire-units. Since the post-deploy
   default `numeraireOracle == address(0)` means USD-as-numeraire,
   THE BEHAVIOR IS UNCHANGED on every deploy until governance
   actually rotates the numeraire. Operators don't need to do
   anything specific at the redeploy.

2. **Three-step rotation when governance moves to a non-USD
   numeraire.** Single Safe batch:
   - `setNumeraireSwapEnabled(true)` (the independent kill-switch).
   - `setNumeraire(newOracle, threshold, notificationFee, kycTier0,
     kycTier1)` — every value in the new numeraire's units.
   - Optionally `setNumeraireSwapEnabled(false)` after to re-lock
     the swap surface until the next planned rotation.

3. **Per-knob within-same-numeraire updates** — governance can
   tune individual knobs freely without unlocking
   `numeraireSwapEnabled` via:
   - `setMinPrincipalForFinerCadence(uint256)`
   - `setNotificationFee(uint256)`
   - `updateKYCThresholds(uint256, uint256)` (industrial fork only;
     KYC is OFF on retail per CLAUDE.md).

4. **Frontend ABI sync** — `bash contracts/script/exportFrontendAbis.sh`
   already run; the regenerated JSONs in
   `frontend/src/contracts/abis/` reflect the renamed setter +
   dropped per-knob oracle setter + 5-arg `setNumeraire`. Skipping
   this step on a redeploy would surface the standard "exceeds max
   transaction gas limit" failure mode flagged in CLAUDE.md.

## Notes for follow-up

The numeraire generalization is **complete** — Phase 1+2+3 covered
every numeraire-denominated knob with a storage backing. Group B
(internal USD-computation variables) is intentionally left alone per
the rationale above; revisit only if a future audit finds the variable
naming confusing. The governance-tunable boundary is now uniform
across the protocol: every numeraire-denominated knob speaks
numeraire-units in storage, every comparison site speaks USD via
Chainlink, and the boundary-conversion happens in exactly two places
(the KYC threshold getters + the notification-fee VPFI conversion).

## Generalizing Numeraire to the oracle layer (B1) + T-033 Pyth cross-check rename

A second pass on the same day pushed the numeraire abstraction up
ONE level — from "convert at the consumer/governance-knob boundary"
(numeraire generalization Phase 1+2 earlier today) to "convert at the
oracle layer." `OracleFacet.getAssetPrice` now returns
numeraire-quoted prices natively, so every comparison site speaks the
same currency as the threshold/fee storage with no intermediate USD
detour. The two-place boundary conversion noted above (KYC threshold
getters + notification-fee VPFI) is **gone** — collapsed into the
existing oracle layer.

**Why a second pass on the same day:** the architectural rationale
came up in design discussion right after the first sweep landed —
specifically, the realization that HF/LTV math is RATIO-based and
cancels the unit, so changing `getAssetPrice` to return numeraire
instead of USD requires no changes to ~30 consumer sites. Only the
~5 absolute-value comparison sites (KYC checks) actually depend on
the unit, and those naturally compare numeraire-vs-numeraire after
the change. Accepted the pivot mid-flight rather than letting the
two architectures (boundary-convert vs oracle-convert) coexist.

**T-033 Pyth cross-check rename.** Bundled in the same PR because
the existing T-033 surface used the word "numeraire" in a different
sense than T-034's. T-033's `pythNumeraireFeedId` referred to "the
reference asset for cross-oracle DIVERGENCE detection" (specifically
ETH/USD). T-034's `numeraireOracle` referred to "the protocol's
reference currency for governance knobs." Both used "numeraire"; in
the post-numeraire-generalization world the overload became actively
confusing.

Renames:
- `s.pythNumeraireFeedId` → `s.pythCrossCheckFeedId`
- `s.pythNumeraireMaxDeviationBps` → `s.pythCrossCheckMaxDeviationBps`
- `_validatePythNumeraire` → `_validatePythCrossCheck`
- `OracleNumeraireDivergence` error → `OracleCrossCheckDivergence`
- All matching setters in `OracleAdminFacet`

T-034's `numeraire` keeps its name everywhere — it really IS the
protocol's reference currency.

**B1 — numeraire flows from the oracle.** The renamed feed slots
+ the new symbol slot capture every input that defines the
protocol's reference currency:

  - `s.ethUsdFeed` → `s.ethNumeraireFeed`. The Chainlink ETH/<numeraire>
    AggregatorV3 address. ETH/USD on USD-as-numeraire deploys;
    rotates to ETH/EUR / ETH/XAU / etc. when governance flips.
  - `s.usdChainlinkDenominator` → `s.numeraireChainlinkDenominator`.
    Chainlink Feed Registry constant for Path 2 (direct asset/<numeraire>
    lookup). `Denominations.USD` by default; `Denominations.EUR` /
    etc. on rotation.
  - **NEW** `s.numeraireSymbol` (`bytes32` lowercase ASCII). Drives
    Tellor / API3 / DIA query construction so the symbol-derived
    secondary oracles query asset/<numeraire> instead of the
    hardcoded asset/USD. Empty default falls through to `"usd"` in
    the helpers, preserving today's behaviour out of the box.
  - `s.pythCrossCheckFeedId` (renamed under T-033 above). Pyth
    ETH/<numeraire> feed id for the cross-validation gate.

The symbol-derived secondary queries are now active:

  - `_checkTellor`: `keccak256(abi.encode("SpotPrice", abi.encode(symbol, numeraireSymbol)))`
  - `_checkApi3`: dAPI name = `<UPPER_SYMBOL>/<UPPER_NUMERAIRE>` packed into bytes32
  - `_checkDIA`: key = `<UPPER_SYMBOL>/<UPPER_NUMERAIRE>`

Two new private helpers in `OracleFacet` (`_numeraireLowerSymbol()` /
`_numeraireUpperSymbol()`) handle the bytes32-to-string conversion
and the empty-default-to-"usd" fallback.

**INumeraireOracle abstraction retired entirely.** The Phase 1+2
work introduced an `INumeraireOracle` interface for boundary
conversion. With the oracle-layer numeraire in B1, the interface
becomes redundant — every consumer that used to call
`numeraireToUsdRate1e18()` for boundary-conversion now reads
numeraire-quoted prices directly from `getAssetPrice`. Concrete
removals:

  - `contracts/src/interfaces/INumeraireOracle.sol` — **deleted**.
  - `s.protocolCfg.numeraireOracle` storage slot — **dropped**.
  - `LibVaipakam._convertNumeraireToUsd` private helper —
    **dropped**. KYC threshold getters return raw numeraire-units;
    comparison sites compare numeraire-vs-numeraire because both
    sides speak the same currency post-B1.
  - `LibNotificationFee.vpfiAmountForFee` simplified from two-step
    (numeraire→USD via INumeraireOracle, then USD→VPFI via ETH/USD)
    to single-step (numeraire fee → VPFI via numeraire-quoted ETH).
  - `OfferFacet._principalToNumeraire1e18` simplified from two-step
    (asset amount → USD → numeraire) to single-step (asset amount ×
    numeraire-quoted price).
  - `IVaipakamErrors.NumeraireOracleInvalid` — dropped.
  - `ConfigFacet.getNumeraireOracle` getter — dropped.

**`setNumeraire` restructured to 8-arg atomic rotation.** The
previous Phase-3 5-arg shape (from the prior numeraire generalization
on the same day) was extended to cover the feed-side slots:

```
setNumeraire(
  ethNumeraireFeed,            // Chainlink ETH/<numeraire>
  numeraireChainlinkDenominator, // Chainlink Feed Registry constant
  numeraireSymbol,             // bytes32 lowercase ASCII
  pythCrossCheckFeedId,        // Pyth ETH/<numeraire> feed id
  newThreshold,                // numeraire-units
  newNotificationFee,          // numeraire-units
  newKycTier0,                 // numeraire-units
  newKycTier1                  // numeraire-units
)
```

Single Safe transaction. By construction, governance cannot rotate
the numeraire without simultaneously re-anchoring every value
denominated in it AND every oracle-side input that produces
numeraire-quoted prices. The three feed-side inputs reject zero
(load-bearing — missing them would brick `_primaryPrice` / secondary
queries); `pythCrossCheckFeedId` accepts zero (disables the Pyth
gate). Each value carries its per-knob bounded validator; KYC tier
monotonicity is enforced when both tier values come in non-zero.

New event shape: `NumeraireUpdated(oldEthFeed, newEthFeed,
numeraireSymbol)` — the symbol is indexed for off-chain monitors so
they can identify rotations by target currency.

Per-knob within-the-same-numeraire setters retained for routine
tuning: `setMinPrincipalForFinerCadence`, `setNotificationFee`,
`updateKYCThresholds`. Use these when governance just wants to
re-tune a value within the active currency, not rotate.

New individual getters for the protocol-console knob cards:
`getNumeraireSymbol()` (bytes32) and `getEthNumeraireFeed()`
(address).

## What stays USD-internal — by design

The cross-oracle integrity checks are deliberately NOT
numeraire-aware:

- `_enforceSecondaryQuorum` (Tellor / API3 / DIA cross-validation)
  operates on raw asset/<numeraire> readings — but those
  secondaries return prices in the configured numeraire too (the
  symbol-derived query paths above). Divergence math is unit-
  consistent within whatever numeraire is configured.
- `_validatePythCrossCheck` (T-033 — renamed from
  `_validatePythNumeraire` in this PR) operates on Chainlink
  ETH/<numeraire> vs Pyth ETH/<numeraire> divergence. Same
  unit-consistency property.
- `_readAggregatorStrict` stable-peg check is USD-internal only
  for assets explicitly registered as stables (USDC, USDT, etc.).
  This stays USD-bound because the peg semantic is "is this
  stablecoin actually pegged to $1?" — a USD-specific question.
  Non-USD numeraire deploys won't hit this path for USD-pegged
  stables (Path 2 lookup in the new denominator returns no feed
  for `<symbol>/EUR`, falls through to Path 3).

## Group B variable renames — deferred (cosmetic)

The Pattern 1 sites (`valueUSD`, `bonusUSD`, `usdValue1e18`,
`_calculateTransactionValueUSD`) were considered for inclusion but
explicitly left alone — their content is currently USD because the
default numeraire is USD; the names are accurate today. Once a real
numeraire rotation lands (governance flips to EUR), the names will
become misleading and warrant a rename pass — but that's a
cosmetic follow-up that doesn't change behaviour.

## T-047 — PredominantlyAvailableDenominator (planned follow-up)

The B1 architecture has a known security tradeoff: secondary oracle
coverage in non-USD numeraires (Tellor / API3 / DIA) is sparse, so
after a non-USD rotation most assets degrade to "Chainlink-only"
cross-validation (graceful fallback per Phase 7b.2; not a revert,
just a security degradation).

**T-047** adds an admin-configurable
`predominantlyAvailableDenominator` (USDT-equivalent today) that
the secondary quorum falls back to so the divergence-detection
security stays intact regardless of which numeraire governance
picks. USDT-quoted feeds are nearly as dense as USD-quoted feeds
across all secondary sources (USDT≈USD), so this restores the
pre-rotation security posture without adding per-asset config.

Captured in `docs/ToDo.md` as T-047. Deferred to a future PR after
the numeraire rotation is actually on the table.

## Verification

- `forge build` clean (src + scripts).
- 5 affected test suites all passing:
  - `PeriodicInterestCadenceTest` — **33/33** (rewrote 5
    setNumeraire tests for the 8-arg shape; dropped
    `MockNumeraireOracle` / `RevertingNumeraireOracle` mocks).
  - `PeriodicInterestSettleTest` — **14/14**.
  - `NotificationFeeTest` — **14/14**.
  - `ProfileFacetTest` — **50/50**.
  - `OracleNumeraireGuardTest` — **10/10** (mechanical Pyth-
    cross-check renames sweep).
- `HelperTest.getConfigFacetSelectors`: 37 → 38 (replaced
  `getNumeraireOracle` with `getNumeraireSymbol` +
  `getEthNumeraireFeed`).
- ABIs re-synced from `contracts@<HEAD>`. Frontend `tsc -b
  --noEmit` clean. Watcher `tsc -p . --noEmit` clean (no Pyth /
  numeraire surface in the watcher; cross-check is contract-
  internal).
- Frontend Protocol Console knob catalog updated — `numeraireOracle`
  knob dropped; `numeraireSymbol` + `ethNumeraireFeed` knobs added,
  both with the new 8-arg `setNumeraire` setter spec.
- `usePeriodicInterestConfig` hook updated for the new tuple
  shape (`bytes32 numeraireSymbol` instead of `address numeraireOracle`).

## Operator deploy notes

1. **Storage layout change is pre-launch only.** `s.protocolCfg.numeraireOracle`
   slot was removed; `s.numeraireSymbol` slot added. Other renames
   are slot-shape-preserving. Default behaviour unchanged.
2. **Governance rotation now requires four feed-side knobs.**
   Before B1, governance only needed an `INumeraireOracle` impl. Now
   they need:
   - A Chainlink ETH/<numeraire> AggregatorV3 (e.g. mainnet ETH/EUR).
   - A Chainlink Feed Registry denominator constant for the
     numeraire (e.g. `Denominations.EUR`).
   - The lowercase ASCII symbol as bytes32 (e.g. `bytes32("eur")`).
   - A Pyth ETH/<numeraire> feed id (or `bytes32(0)` to disable
     the Pyth cross-check during the rotation window).
   Plus the four numeraire-denominated value knobs (threshold,
   notification fee, KYC tier 0, KYC tier 1). All eight in one
   `setNumeraire` Safe transaction.
3. **Frontend ABI sync** — already run; the regenerated JSONs
   reflect the new 8-arg setter + new getters.
4. **Watcher** — no changes required (the Pyth cross-check is
   contract-internal; no watcher state references the renamed
   slots).

---

## Platform-currency-agnostic sweep — code, ABI, and frontend follow the numeraire abstraction (full sweep)

The B1 + Pyth rename pushed the numeraire abstraction up to the
oracle layer. After it landed there were still ~150 identifiers
across the codebase named `*USD` / `*Usd` / `*USD18` that no
longer described what the value actually was. Internally those
amounts came from `OracleFacet.getAssetPrice`, which now returns
numeraire-quoted truth — so a variable called `valueUSD` holding an
EUR-quoted figure on a XAU-rotated deploy was misleading code, not
broken code. This sweep aligns names with reality so the
codebase reads clearly under any numeraire choice.

### Pattern 1 — KYC absolute-valuation variables (already landed earlier in the day)

- `OfferFacet._calculateTransactionValueUSD` → `_calculateTransactionValueNumeraire`; locals `valueUSD` → `valueNumeraire`.
- `DefaultedFacet` `valueUSD` local → `valueNumeraire`.
- `RiskFacet.triggerLiquidation` `bonusUSD` → `bonusNumeraire`.
- `LibCompliance.calculateValueUSD` → `calculateValueNumeraire`; locals.
- `ProfileFacet.meetsKYCRequirement(address, valueUSD)` param → `valueNumeraire` (selector unchanged — types-only).

### Pattern 2 — RiskFacet HF/LTV ratio variables

- `_computeUsdValues` → `_computeNumeraireValues`; both return values renamed (`borrowValueUSD` / `collateralValueUSD` / `borrowedValueUSD` → `*Numeraire`).
- All call sites at `calculateLTV` / `calculateHealthFactor` / `isCollateralValueCollapsed` updated.
- NatSpec on each function clarifies the unit cancels in the ratio so HF and LTV are unit-agnostic.

### Fee-ledger (storage + Metrics return-tuple)

- `LibVaipakam.FeeEvent.usdValue` storage field → `numeraireValue`.
- `LibVaipakam.Storage.cumulativeFeesUSD` → `cumulativeFeesNumeraire`.
- `LibFacet.accrueTreasuryFee` local + comment updated.
- `MetricsFacet.getTreasuryMetrics` 4-tuple returns `treasuryBalanceUSD / totalFeesCollectedUSD / feesLast24hUSD / feesLast7dUSD` → `*Numeraire`. Selector unchanged (returns are positional in ABI).
- `MetricsFacet.getRevenueStats` return `totalRevenueUSD` → `totalRevenueNumeraire`.

### MetricsFacet protocol-wide aggregators

- `getProtocolTVL` returns `tvlInUSD` → `tvlInNumeraire` (other return fields already neutral).
- `getProtocolStats` returns `totalVolumeLentUSD` / `totalInterestEarnedUSD` → `*Numeraire`.
- **Selector rename**: `getTotalInterestEarnedUSD()` → `getTotalInterestEarnedNumeraire()` — single function-name change in this PR; selector hash differs. Frontend's `OnchainBadge` label updated to match.
- `getLoanSummary.totalActiveLoanValueUSD` → `*Numeraire`.
- `getEscrowStats.totalRentalVolumeUSD` → `*Numeraire`.
- `getUserSummary` returns `totalCollateralUSD / totalBorrowedUSD / availableToClaimUSD` → `*Numeraire`.
- `getProtocolHealth` returns `totalCollateralUSD / totalDebtUSD` → `*Numeraire`.
- Locals `principalUsd` / `pUsd` → `principalNumeraire` / `pNumeraire`.
- Private constant `USD_SCALE = 1e18` → `NUMERAIRE_SCALE`.

### Reward accrual — USD18 → Numeraire18

The interaction-reward system tracked per-user / per-day interest in
"USD scaled to 1e18" units. Renamed the entire ledger to
`Numeraire18`:

- `RewardEntry.perDayUSD18` → `perDayNumeraire18`.
- `Storage.lenderPerDayDeltaUSD18` / `borrowerPerDayDeltaUSD18` → `*Numeraire18`.
- `Storage.lenderOpenPerDayUSD18` / `borrowerOpenPerDayUSD18` → `*Numeraire18`.
- `Storage.userLenderInterestUSD18` / `userBorrowerInterestUSD18` → `*Numeraire18`.
- `Storage.totalLenderInterestUSD18` / `totalBorrowerInterestUSD18` → `*Numeraire18`.
- `Storage.cumLenderRPU18` / `cumBorrowerRPU18` → `cumLenderRPN18` / `cumBorrowerRPN18` (RPU = "Rewards Per USD" → RPN = "Rewards Per Numeraire").
- `Storage.chainDailyLenderInterestUSD18` / `chainDailyBorrowerInterestUSD18` → `*Numeraire18`.
- `Storage.knownGlobalLenderInterestUSD18` / `knownGlobalBorrowerInterestUSD18` → `*Numeraire18`.
- `LibInteractionRewards._interestToUSD18` → `_interestToNumeraire18`.
- `LibInteractionRewards._perDayInterestUSD18` → `_perDayInterestNumeraire18`.
- `capVPFIForPerDayUSD` helper → `capVPFIForPerDayNumeraire`.
- Cross-chain reward plumbing: `RewardReporterFacet.recordChainReportLocal` / `recordChainReportRemote` USD18 args → Numeraire18.
- **Selector renames**: `RewardReporterFacet.getLocalChainInterestUSD18()` → `getLocalChainInterestNumeraire18()`; `getKnownGlobalInterestUSD18()` → `getKnownGlobalInterestNumeraire18()`. Selector hashes differ.
- Event payloads (`ChainReportRecorded` / `ChainReportFinalized` / `KnownGlobalInterestUpdated`) renamed param fields USD18 → Numeraire18.

### Interface + error types

- `IRewardOApp` interface USD18 args renamed.
- `IVaipakamErrors` USD18 references in error names / NatSpec renamed.

### Tests + mocks

- `TestMutatorFacet` mock USD18 setters renamed to match storage.
- `HelperTest` selector list refreshed for the renamed reward-reporter views.
- `InteractionRewardsCoverageTest`, `InteractionRewardCapTest`, `RewardOAppDeliveryTest`, `CrossChainRewardPlumbingTest`, `MetricsFacetTest` all consume the renamed identifiers.
- `MockRewardOApp` aligns with the new IRewardOApp surface.

### Frontend consumers

- `useTreasuryMetrics` interface fields `treasuryBalanceUsd / totalFeesCollectedUsd / feesLast24hUsd / feesLast7dUsd` → `*Numeraire`. Public-Dashboard adapters updated.
- `useInteractionRewardEntries` field `perDayUSD18` → `perDayNumeraire18`.
- `InteractionRewardsClaim` row renderer reads `perDayNumeraire18`; local `totalContribUsd18` → `totalContribNumeraire18`.
- `PublicDashboard` `MetricCard.onchainFn` label "getTotalInterestEarnedUSD" updated to "getTotalInterestEarnedNumeraire".
- `useCombinedChainsStats` comment block describing `getProtocolStats` shape refreshed.

### Verification

- `forge build` clean (src + tests).
- Targeted suites green: ProfileFacet 50/50, KYCTierEnforcement 6/6, MetricsFacet 22/22, InteractionRewardsCoverage 21/21, RewardOAppDelivery 6/6, CrossChainRewardPlumbing 58/58, InteractionRewardCap 9/9, StakingAndInteractionRewards 10/10, StakingRewardsCoverage 7/7.
- Full no-invariants regression: 1534 passing / 45 pre-existing branch failures (all reproducible on the unrenamed tree — `LenderResolutionFailed`, `FunctionDoesNotExist`, `EscrowUpgradeRequired`, scenario-log mismatches, and a `liqThresholdBps == 0` HF expectation; none are rename-induced and none surface as `Member not found` / `Undeclared identifier`).
- `frontend/src/contracts/abis/` re-exported via `exportFrontendAbis.sh` (full Diamond surface).
- `vaipakam-keeper-bot/src/abis/` re-exported via `exportAbis.sh` (MetricsFacet, RiskFacet, LoanFacet, OfferFacet — keeper bot consumes the renamed `getTotalInterestEarnedNumeraire` selector via JSON; bot's TS code doesn't call it directly so no TS edits needed there).
- Frontend `tsc -b --noEmit` clean.

### What now anchors to ETH/Numeraire (post-this-sweep follow-up)

- **Notification-fee VPFI conversion** is anchored to **ETH/numeraire** end to end. After B1, `getAssetPrice(WETH)` returns ETH quoted in the active numeraire natively; the Phase-1 fixed peg `VPFI_PER_ETH_FIXED_PHASE1 = 1e15` (1 VPFI = 0.001 ETH) is unit-agnostic — it describes the VPFI-to-ETH ratio. So the math `vpfiAmount = feeNumeraire × 1e36 / (ethPriceNumeraire × peg)` is correct under any numeraire choice (USD, EUR, JPY, XAU). No USD-intermediate at any step. Stale NatSpec on `LibVaipakam.NOTIFICATION_FEE_DEFAULT` + `VPFI_PER_ETH_FIXED_PHASE1` + `Storage.notificationFee` + `LibNotificationFee` (header + event + helper) + `ConfigFacet.setNotificationFee` rewritten to describe the actual ETH/Numeraire anchor; test constants `ETH_USD_PRICE_8DEC` → `ETH_NUMERAIRE_PRICE_8DEC` and `DEFAULT_FEE_USD` → `DEFAULT_FEE_NUMERAIRE` for consistency. NotificationFeeTest 14/14 still green — no behavioural change.

### What still says "USD" — and why

The protocol is now currency-agnostic end to end. There is **no**
storage field, setter parameter, or comparison-site math that reads
or writes USD-units. The KYC tier thresholds — which were the last
remaining "intentional USD" claim in earlier drafts of this section —
are explicitly numeraire-typed at every layer:

- Storage: `s.kycTier0ThresholdNumeraire` /
  `s.kycTier1ThresholdNumeraire` (numeraire-units, 1e18-scaled).
- Defaults: `KYC_TIER0_THRESHOLD_NUMERAIRE = 1_000 * 1e18` /
  `KYC_TIER1_THRESHOLD_NUMERAIRE = 10_000 * 1e18` (numeraire-unit
  literals — they read as $1k / $10k only because the post-deploy
  default numeraire is USD).
- Setter: `ProfileFacet.updateKYCThresholds(uint256 tier0ThresholdNumeraire,
  uint256 tier1ThresholdNumeraire)` — params are numeraire-units.
- Retail deploy: `kycEnforcementEnabled = false` per CLAUDE.md and
  the deploy never calls the setter, so storage stays at zero and
  the getters fall through to the compile-time numeraire defaults.
- Comparison sites: numeraire-vs-numeraire end to end after B1
  (`getAssetPrice` returns numeraire-quoted; the getters return raw
  numeraire-units). No USD cast anywhere along the path.

The only USD-flavored thing remaining is **the post-deploy default
numeraire identity itself** (`numeraireSymbol = "usd"`,
`numeraireChainlinkDenominator = Denominations.USD`,
`ethNumeraireFeed` pointed at Chainlink ETH/USD). That's a deploy-time
governance choice, not a hard-coded type — `setNumeraire` rotates the
whole identity atomically to EUR / JPY / XAU at any time.

- **Doc comments mentioning "USD by post-deploy default"** are
  intentional — they label the default deploy's numeraire identity
  for the reader without implying the math is USD-anchored.

### Operator notes — none new

This sweep is identifier-renames only. No setter / getter selector breaks beyond the four already documented:

- `getTotalInterestEarnedUSD()` → `getTotalInterestEarnedNumeraire()`
- `getLocalChainInterestUSD18()` → `getLocalChainInterestNumeraire18()`
- `getKnownGlobalInterestUSD18()` → `getKnownGlobalInterestNumeraire18()`
- (B1 already renamed `getNumeraireOracle()` → `getNumeraireSymbol()` + `getEthNumeraireFeed()`.)

Frontend ABI sync covers all four. Pre-mainnet operators who script
selector calldata against these views need to refresh their scripts.

---

## T-048 — Predominantly Available Denominator (PAD): structural bias toward Chainlink's verified-rated feed set

**The shape of the problem.** After the numeraire generalization
(B1) landed, an industrial-fork deploy with `numeraire ≠ USD` faced
a coverage gap: Chainlink's Feed Registry has near-universal
`asset/USD` coverage, but `asset/EUR` (or JPY, XAU, etc.) is sparse.
Worse, where non-USD direct feeds DO exist on Chainlink, they
frequently land in the 🟡 (monitored) or 🔴 (specialized)
verification tier rather than 🟢 (verified), with looser deviation
thresholds, slower heartbeats, and smaller publisher sets than the
🟢-rated USD equivalents. Routing pricing through those feeds
silently is a real risk class.

**Constraint:** Chainlink's feed-rating metadata is **off-chain**.
We can't query `feed.rating()` and auto-prefer 🟢 feeds. So the
choice is either operator-curation (per-asset whitelist of
known-good feeds — error-prone; one missed verification produces a
silent 🟡 read) or **structural avoidance** — route every priced
asset through the universally-🟢 USD feed set and accept the small
FX-multiply cost when the active numeraire isn't USD.

T-048 picks structural avoidance.

### Architecture — PAD-pivot

**PAD = Predominantly Available Denominator.** A
governance-tunable Chainlink Feed Registry denomination constant
(`Denominations.USD` by post-deploy default). The protocol stores
PAD-quoted prices internally and converts to the active numeraire
only when the two differ.

**`OracleFacet._primaryPrice` flow**:

```
if PAD == numeraire:                       # retail (USD-as-numeraire)
    return registry.read(asset, padDenom)  # single read, no FX
                                           # math identical to pre-T-048

# Industrial-fork (PAD ≠ numeraire):

if assetNumeraireDirectFeedOverride[asset] != address(0):
    return read(override)                  # operator-vouched 🟢 direct feed

padPrice = _padPriceWithFallback(asset)    # asset/PAD via Feed Registry
                                           # falls back to asset/ETH × ETH/PAD
fxRate = _padNumeraireRate()               # direct PAD/<numeraire> feed if set
                                           # else derived: ETH/<numeraire> ÷ ETH/PAD
return padPrice × fxRate
```

The numeraire-direct tier (asset/<numeraire> via Feed Registry) was
DROPPED entirely. Why: without on-chain rating metadata we can't
auto-prefer top-rated feeds, and silently falling through to
whatever direct feed Chainlink lists invites the 🟡 / 🔴 risk class.
Routing through PAD biases toward verified feeds by construction.

**Per-asset override** lives as the explicit opt-in: if an operator
finds a specific 🟢-rated direct asset/<numeraire> feed and wants to
use it, they call `setAssetNumeraireDirectFeedOverride(asset, feed)`
and that asset routes through the override on every read. The
operator vouches for the feed quality; the protocol does not
cross-check it against Pyth (the Pyth gate is configured for
ETH/<numeraire>, not asset/<numeraire>).

### Storage extension

Five new slots (4 scalar + 1 mapping), all governance-tunable:

- **`s.predominantDenominator`** — Chainlink Feed Registry
  denomination constant for PAD queries. `Denominations.USD`
  (`0x0000…0000348`) by post-deploy default.
- **`s.predominantDenominatorSymbol`** — bytes32 lowercase ASCII
  symbol for symbol-derived secondary oracles when querying
  asset/PAD pairs. Empty bytes32 reads as `"usd"` per
  `LibVaipakam.effectivePadSymbol()`.
- **`s.ethPadFeed`** — Chainlink ETH/<PAD> AggregatorV3.
  REQUIRED on every chain post-T-048 — load-bearing for (a) WETH
  pricing and (b) the derived PAD/<numeraire> rate when no direct
  feed is set.
- **`s.padNumeraireRateFeed`** — optional Chainlink PAD/<numeraire>
  direct FX feed (e.g. USD/EUR on Ethereum mainnet). Zero is valid;
  the protocol derives the rate from existing infrastructure when
  unset.
- **`s.assetNumeraireDirectFeedOverride[asset]`** — per-asset
  Chainlink AggregatorV3 override. Zero (default) → use PAD pivot.

### Setters + events

- **`setPredominantDenominator(newDenominator, newSymbol, newEthPadFeed, newPadNumeraireRateFeed)`** — atomic 4-arg rotation; the four slots can never be in a half-rotated state. Reverts `ParameterOutOfRange` on zero `newDenominator` or zero `newEthPadFeed` (both load-bearing). Emits `PredominantDenominatorUpdated`.
- **`setAssetNumeraireDirectFeedOverride(asset, feed)`** — set / clear per-asset override. `asset == address(0)` reverts `InvalidAsset`. Emits `AssetNumeraireDirectFeedOverrideSet`.

### Pre-T-048 deploy compatibility

When `s.predominantDenominator == address(0)` (a deploy that hasn't
yet run `setPredominantDenominator`), `_primaryPrice` falls back to
the legacy numeraire-direct path. Existing deploys keep working
unchanged until the operator opts in. The `LibVaipakam.isPadEqualToNumeraire()`
helper returns `false` on zero PAD, so the retail short-circuit
correctly skips and the legacy path activates.

### What this does NOT change

- Retail USD-as-numeraire deploys: behavior identical to today. PAD
  reads collapse to the single Feed Registry asset/USD query that
  was the existing tier-1 path. Zero added gas, zero new failure
  modes.
- HF / LTV / collateral-coverage ratio math: unit-cancelled, so
  numeraire identity doesn't enter the comparison. Already
  established post-B1.
- Pyth cross-check: continues to validate the ETH-anchor read used
  in the PAD-pivot path. The override path skips the Pyth gate
  (operator vouches).

### New error types

- `PadNumeraireRateUnavailable` — neither direct nor derived FX rate
  is reachable on a `numeraire ≠ PAD` deploy. Configuration error
  caught at first priced read.
- `PadPivotFeedUnavailable(asset)` — no PAD-side feed (asset/PAD
  direct OR asset/ETH-pivot) resolves on the active chain. Specific
  to the PAD-pivot path so monitoring can distinguish "asset never
  had a feed" from "feed setup mid-rotation."
- `PadNumeraireRateFeedStale` — `padNumeraireRateFeed` is set but
  returns a non-positive answer or is stale beyond the
  secondary-oracle staleness budget.

### Verification

- New test suite [`OraclePadFallbackTest.t.sol`](contracts/test/OraclePadFallbackTest.t.sol) — 9/9 passing covering: retail short-circuit (PAD==numeraire==USD), pre-T-048 legacy fallback, industrial-fork with direct PAD/<numeraire> feed, industrial-fork with derived FX rate, per-asset override path (set + clear), WETH PAD-pivot, all-paths-fail revert, two setter validation reverts (zero denominator, zero ethPadFeed).
- `forge build` clean.
- Baseline regression on the pre-T-048 path — all green: OracleFacet 36/36, OracleNumeraireGuard 10/10, SecondaryQuorum 27/27, NotificationFee 14/14, PeriodicInterestCadence 33/33, PeriodicInterestSettle 14/14, ProfileFacet 50/50, ConfigFacet 26/26.
- Frontend `tsc -b --noEmit` clean. ABIs re-exported (frontend + keeper-bot).
- Protocol-console knob catalogue extended with 4 new entries: `predominantDenominator`, `predominantDenominatorSymbol`, `ethPadFeed`, `padNumeraireRateFeed`. Per-asset override is governance-curated per asset and not surfaced as a single scalar knob (would need a custom card similar to `GraceBucketsCard`; deferred as a follow-up).

### Operator deploy checklist (post-T-048)

Every chain's deploy script MUST call `setPredominantDenominator` with `Denominations.USD` + `bytes32("usd")` + `<chain's Chainlink ETH/USD feed>` + `address(0)` (no direct FX feed needed on retail) before opening offers. Pre-mainnet pre-flight should assert `getEthPadFeed() != address(0)` after deploy. For non-USD industrial-fork deploys: also configure `padNumeraireRateFeed` if the chain has a direct USD/<numeraire> Chainlink feed; otherwise the derived path activates automatically using `ethNumeraireFeed ÷ ethPadFeed`.

### What's next (deferred)

- Per-asset override admin UI card (similar to `GraceBucketsCard` shape — array-of-tuples). Operators currently set overrides via direct Safe call-data composition.
- Symbol-derived secondary-oracle queries on the asset/PAD path: today the Tellor / API3 / DIA queries still derive from `numeraireSymbol`. A follow-up could route asset/PAD secondary queries through `padSymbol` for richer cross-validation on the PAD leg. Deferred — the current Pyth ETH/<numeraire> cross-check already validates the load-bearing FX leg.

---

## Escrow hardening — reject direct user NFT transfers

Every per-user escrow proxy is now strict about how NFTs may arrive.
Previously the escrow's safe-transfer receiver hooks (`onERC721Received`,
`onERC1155Received`, `onERC1155BatchReceived`) accepted any caller — so
a user could `safeTransferFrom` an unrelated NFT into their own escrow
proxy from their wallet, an OpenSea purchase could target the escrow as
the destination, or a third party could push tokens with no record on
the protocol ledger. Anything that landed that way had no matching loan
/ offer / claim entry, and the only way out would have been an admin
sweep added after the fact.

The receiver hooks now reject any transfer whose `operator` (the
contract that initiated the safe-transfer call on the NFT) isn't the
Diamond or the escrow itself. Legitimate Diamond-mediated deposits
still pass through cleanly because facet code runs in the Diamond's
context, so the NFT contract sees `msg.sender == DIAMOND` as the
operator. Direct user calls, third-party push transfers, and accidental
marketplace sends now revert atomically — the NFT never moves, the
escrow stays consistent, no recovery flow needed.

ERC-20 has no equivalent on-chain hook (the standard's `transfer` /
`transferFrom` give the recipient zero opportunity to reject), so this
hardening covers ERC-721 and ERC-1155 only. The frontend will continue
to warn users not to send ERC-20 directly to their escrow address.

### Frontend / operator impact

- None for normal protocol use — every existing deposit flow goes
  through the Diamond and is unaffected.
- One existing test that seeded an escrow's ERC-1155 balance via the
  mock's `mint(...)` (which calls the receiver hook) was switched to
  `forceMint(...)` to bypass the now-strict hook. Production deploys
  do not exercise this path.

### Verification

- Five new tests in [`EscrowFactoryFacetTest.t.sol`](contracts/test/EscrowFactoryFacetTest.t.sol):
  the three hook variants reject non-Diamond operators, accept Diamond
  and self operators, and an end-to-end check that a user calling
  `safeTransferFrom` directly on an NFT contract — pointing at their
  own escrow — reverts with `UnauthorizedNFTSender`.
- Full no-invariants regression: 1594 passing / 0 failed / 5 skipped.
- `forge build` clean.

---

## Escrow Assets page (T-051)

A dedicated "Your Escrow" page now lives in the in-app sidebar under
the basic-mode nav, between Allowances and Data Rights, on every
locale. Users can see at a glance every token the protocol custodies
on their behalf for the active chain — and a clear, single-line
warning that the escrow address is internal protocol plumbing, not a
deposit destination.

### Layout

The page has three blocks:

1. **Escrow Address** — shows a redacted form of the per-user escrow
   proxy address (`0xabcd…1234`), styled non-selectable, links out
   to the chain's block explorer in a new tab so users can verify
   on-chain holdings independently. A small grey caption underneath
   reads "Internal protocol storage — funds enter and exit via the
   protocol only."
2. **Holdings** — one row per protocol-managed token, with the
   token's symbol (resolved live via the existing `AssetSymbol`
   component) and the current escrow balance. The table seeds in a
   loading state so it doesn't reflow when balances arrive. A
   refresh button at the top of the card re-fetches all balances.
3. **Direct-send warning** — a single line at the foot of the page:
   "Only tokens managed by the Vaipakam protocol are shown here. Do
   not send any tokens directly to your escrow address — they may
   not be recoverable."

There is intentionally **no** "stuck tokens" section, **no**
"unsolicited deposit" tally, and **no** recovery button anywhere on
the page. That UX is part of the recovery-design contract: the
recovery flow is reachable only via a deep-link from the Advanced
User Guide so naive users — who got dust-poisoned and don't know what
that means — can't accidentally trigger an action that risks locking
their escrow.

### Per-chain token discovery

The list of "protocol-managed tokens" is sourced from the chain's
entry in the consolidated `deployments.json`:

- VPFI token (the user's staked balance lives in their escrow).
- Canonical WETH (used as collateral / principal across most chains).
- Testnet mock ERC-20s (`mockERC20A`, `mockERC20B`) when present —
  surfaced so the page renders meaningfully on Sepolia / Anvil / dev
  chains. Mainnet deployments don't carry these fields, so the rows
  are inert there.

When new asset categories land in the deployment shape (e.g. an
on-chain enumerable list of `assetRiskParams`-configured assets, or
a chain-specific governance-curated whitelist), the list builder
extends naturally. For Phase 1 this hardcoded set is sufficient — it
covers ~99 % of real escrow holdings.

### Phase-1 limitation (resolved when T-054 PR-1 lands)

Until the per-(user, token) `protocolTrackedEscrowBalance` counter
ships in T-054, the table displays raw `IERC20.balanceOf(escrow)`
for each token. With the current usage patterns — every legitimate
deposit goes through the Diamond, every legitimate withdrawal goes
through the protocol — raw balance ≈ tracked balance, so the
displayed numbers are correct in practice. Once the counter ships,
the page swaps to `min(balanceOf, tracked)` so any unsolicited dust
is correctly hidden.

### Dashboard escrow-address redaction

The existing Dashboard's "Your Escrow" card was also updated to
match the new redaction policy: shows `0xabcd…1234` (six-and-four
characters) instead of the previous ten-and-eight, applies the same
non-selectable styling, blocks the basic-clipboard `onCopy` event,
opens the explorer link in a new tab, and carries the same caption.
The same redacted shape now appears on both surfaces so the
"escrow is internal storage" message is consistent.

### What this page is NOT

- **Not** a portfolio aggregator across chains. One chain at a time,
  matching the wallet's currently-selected chain.
- **Not** an indexer-driven view. Reads are direct on-chain
  `balanceOf` calls via the wallet's RPC. This means the page works
  without the cloud indexer being live, but it doesn't paginate or
  show historical inflow/outflow.
- **Not** a recovery surface. Users who genuinely sent tokens
  directly to their escrow (Phase-1 limitation: this is rare but
  possible) find the recovery flow only via the Advanced User Guide
  per the design lock-in. The Asset Viewer page does not link to
  recovery.

### Verification

- New page: [`frontend/src/pages/EscrowAssets.tsx`](frontend/src/pages/EscrowAssets.tsx).
- Wired into routing: [`frontend/src/App.tsx`](frontend/src/App.tsx) at `/app/escrow`.
- Sidebar entry: [`frontend/src/pages/AppLayout.tsx`](frontend/src/pages/AppLayout.tsx)
  under `BASIC_NAV` between Allowances and Data Rights, with the
  Vault icon.
- i18n: `appNav.escrow` + the `escrowAssets.*` group propagated
  across all 10 locales (en/ar/de/es/fr/hi/ja/ko/ta/zh).
- Dashboard escrow-address redaction: [`Dashboard.tsx`](frontend/src/pages/Dashboard.tsx)
  L317-358 reshaped.
- Frontend `tsc -b --force --noEmit` clean.

---

## Recovery design lock-in (T-054 spec)

The discussion that drove this release also produced a fully-locked
specification for the future stuck-token recovery flow, captured in
[`docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md`](docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md)
+ the post-deploy labeling runbook in
[`docs/ops/AnalyticsLabelRegistration.md`](docs/ops/AnalyticsLabelRegistration.md).

Headline decisions captured for implementation in **T-054** (PR-1
through PR-5 sequenced separately):

- **Counter-bounded recovery cap**: every protocol deposit /
  withdrawal increments / decrements a per-(user, token) running
  counter; recovery is capped at `max(0, balanceOf - tracked)`. This
  is the load-bearing safety property — even if every other check
  is bypassed, arithmetic forbids draining beyond the truly-
  unsolicited delta.
- **Single-sig recovery** (no source-side signature): the contract
  has no on-chain way to verify a declared source actually
  originated the transfer; requiring a second signature would be
  security theatre. Asymmetry-of-consequences does the work — an
  honest user's CEX-stuck deposit recovers cleanly; a sanctioned-
  fund launderer either self-incriminates (escrow gets banned) or
  has zero benefit (would have moved funds wallet-to-wallet without
  Vaipakam anyway).
- **Three terminal states**: Recover-clean (tokens to user EOA);
  Recover-sanctioned (tokens stay in escrow, escrow goes
  Locked-and-banned per existing sanctions semantics); Disown /
  ignore (tokens stay in escrow, escrow operates normally).
- **`disown(token)`** event-only function for compliance audit
  trail — emits a public on-chain assertion that the user has
  formally disowned the dust, useful for external audit and
  individual user disputes.
- **EIP-712 + "type CONFIRM"** combo for the recovery action — both
  layers, defence-in-depth: cryptographic record of explicit
  acknowledgment plus an in-the-moment human attestation.
- **Discoverability gating**: the recovery page is reachable ONLY
  via a deep-link from the Advanced User Guide; `noindex,nofollow`;
  no nav links, no buttons, no banners anywhere else. Naive users
  who got dust-poisoned never see the recovery page → can't
  accidentally self-incriminate.
- **VPFI integration**: `depositVPFIToEscrow` will be re-routed
  through `escrowDepositERC20` so the counter ticks for stakes; the
  staking checkpoint reads `min(balanceOf, tracked)` so unsolicited
  VPFI dust does NOT earn yield. Staking-rewards distribution is
  unchanged (already lands in user's EOA, never escrow).
- **No CEX hot-wallet whitelist**: single-sig + sanctions oracle on
  declared source handles the legitimate stuck-CEX-deposit case for
  free.
- **Forfeit semantics**: tokens that stay in escrow under any of the
  banned / disowned outcomes never move to treasury. They sit
  locked. If a sanctions list is later updated to remove the flagged
  address, the locked-and-banned escrow auto-unlocks.
- **EIP-712 NOT for offer creation / acceptance / matching**: the
  transaction signature already authenticates and a clear pre-tx
  review screen carries the consent UX. Reserved for cases where
  it's load-bearing (Permit2; possibly the recovery action).
- **Analytics-firm labeling**: per-user escrow proxies are already
  ERC1967, so the EIP-1967 implementation slot makes Etherscan's
  proxy → impl link automatic on every spawned proxy. A single
  public-name-tag submission for the implementation contract
  cascades to every per-user proxy. For per-instance auto-labeling,
  pattern registration with Chainalysis / TRM / Elliptic does the
  job. Full per-firm submission templates + chain-by-chain
  checklist live in the Analytics-Label runbook.

The PR sequence (PR-1 storage + counter, PR-2 VPFI routing + min-
clamp, PR-3 `recoverStuckERC20` + `disown` + EIP-712 verifier, PR-4
frontend `/recover` page + Advanced User Guide section, PR-5 post-
deploy labeling) is captured in [`docs/ToDo.md`](docs/ToDo.md) under
T-054. Implementation lands in subsequent releases.
