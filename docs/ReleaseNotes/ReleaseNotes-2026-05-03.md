# Release Notes — 2026-05-03

Functional record of work delivered on 2026-05-03, written as
plain-English user-facing / operator-facing descriptions — no code.
Continues from
[`ReleaseNotes-2026-05-02.md`](./ReleaseNotes-2026-05-02.md).

Coverage at a glance: **USD-Sweep** — every numeraire-denominated
governance knob in the protocol now reads from the SINGLE global
`numeraireOracle` introduced under T-034, instead of carrying its own
per-knob USD-oracle slot. The notification fee's pluggable USD oracle
is retired; KYC tier thresholds are renamed away from "USD"; the
atomic batched setter `setNumeraire` is extended to take EVERY
numeraire-denominated value at once so a numeraire rotation never
leaves the storage in an inconsistent intermediate state. Follow-up
to the T-034 Periodic Interest Payment work that landed across
2026-05-02 → 2026-05-03.

## USD-Sweep — single-source-of-truth numeraire

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
rotate three independent oracle slots in lockstep. The USD-Sweep
collapses every numeraire-denominated knob onto the SAME global
`numeraireOracle` and makes the rotation atomic.

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
`setNumeraire(newOracle, newThresholdInNewNumeraire)`. The USD-Sweep
extends it to take ALL numeraire-denominated values together:
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

The USD-Sweep is **complete** — Phase 1+2+3 covered every
numeraire-denominated knob with a storage backing. Group B (internal
USD-computation variables) is intentionally left alone per the
rationale above; revisit only if a future audit finds the variable
naming confusing. The governance-tunable boundary is now uniform
across the protocol: every numeraire-denominated knob speaks
numeraire-units in storage, every comparison site speaks USD via
Chainlink, and the boundary-conversion happens in exactly two places
(the KYC threshold getters + the notification-fee VPFI conversion).

## USD-Sweep B1 + T-033 Pyth cross-check rename — numeraire moves up to the oracle layer

A second pass on the same day pushed the numeraire abstraction up
ONE level — from "convert at the consumer/governance-knob boundary"
(USD-Sweep Phase 1+2 earlier today) to "convert at the oracle
layer." `OracleFacet.getAssetPrice` now returns numeraire-quoted
prices natively, so every comparison site speaks the same currency
as the threshold/fee storage with no intermediate USD detour. The
two-place boundary conversion noted above (KYC threshold getters +
notification-fee VPFI) is **gone** — collapsed into the existing
oracle layer.

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
the post-USD-Sweep world the overload became actively confusing.

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
previous USD-Sweep-Phase-3 5-arg shape was extended to cover the
feed-side slots:

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
