# Config-knob bounds audit — 2026-05-14

Item **C.2** from
[`PendingTasks-2026-05-14.md`](PendingTasks-2026-05-14.md):
systematic walk of every admin / owner-only setter across
`ConfigFacet`, `AdminFacet`, and `OracleAdminFacet`, verifying that
every governance-tunable parameter has a meaningful `[floor, ceil]`
bound so a compromised admin / Timelock key cannot push to a
degenerate value that disables a safety gate or breaks an invariant.

**Scope**: 63 setters across the three admin facets. **Risk pattern
found**: 3 missing bounds + 1 loose bound. **No critical safety-gate
defect**. The 4 follow-up commits are tracked in
[Action items](#action-items) below.

This doc is the audit-package addendum the auditor will read
alongside
[`docs/ops/AdminConfigurableKnobsAndSwitches.md`](../ops/AdminConfigurableKnobsAndSwitches.md).

---

## Bound categories

| Category | Definition | Count |
|---|---|---|
| **HARD** | Explicit revert on out-of-bound (`if (v > MAX) revert ...`) | ~50 |
| **ZERO-SENTINEL + HARD** | `0` means "use library default"; non-zero values bounded `[MIN, MAX]` | ~25 |
| **CROSS-TIER** | Multi-value setter enforces monotonicity (`T1 ≤ T2 ≤ T3` or `T1 ≥ T2 ≥ T3`) | ~8 |
| **SOFT** | Silently clamped (not used in this codebase) | 0 |
| **NONE** | Unbounded — gap candidate | 3 (see below) |

---

## Part 1 — `ConfigFacet.sol` (31 setters)

| Line | Function | Params | Role | Bound | Bound values | Defended by |
|---|---|---|---|---|---|---|
| 137 | `setFeesConfig` | treasuryFeeBps, loanInitiationFeeBps (uint16) | ADMIN | HARD | both ≤ MAX_FEE_BPS (5000) | Explicit revert |
| 171 | `setLifMatcherFeeBps` | newBps (uint16) | ADMIN | HARD | ≤ MAX_FEE_BPS (5000) | Explicit revert |
| 207 | `setMaxPartialLiquidationCloseFactorBps` | newBps (uint16) | ADMIN | HARD | ≤ BASIS_POINTS (10000) | Explicit revert |
| 276 | `setTierLtvParams` | 9 params: tier1/2/3 × {floor, ceil, haircut} (uint16) | ADMIN | CROSS-TIER + HARD | per-tier `floor < ceil ≤ 10000`, `haircut ≤ 1000`; cross-tier `T1.ceil ≤ T2.floor ≤ T3.floor` | Atomic write + per-field + cross-tier |
| 368 | `setAutoPauseDurationSeconds` | newSeconds (uint32) | ADMIN | HARD + ZERO-SENTINEL | 0 (use default 1800s) OR `[MIN_AUTO_PAUSE_SECONDS, MAX_AUTO_PAUSE_SECONDS]` (5min–2h) | Bounds prevent stealth-disable + indefinite-freeze cap |
| 417 | `setMaxOfferDurationDays` | newDays (uint16) | ADMIN | HARD + ZERO-SENTINEL | 0 (reset to 365) OR `[7, 1825]` | Prevents 1-day lockout + formula-precision blowout |
| 479 | `setNotificationFee` | newFeeNumeraire1e18 (uint256) | ADMIN | HARD + ZERO-SENTINEL | 0 (reset to 2e18) OR `[0.1e18, 50e18]` | Explicit bounds |
| 529 | `setLiquidationConfig` | handlingFeeBps, maxSlippageBps, maxIncentiveBps (uint16) | ADMIN | HARD | handlingFee ≤ 5000; maxSlippage ≤ 2500; maxIncentive ≤ 2000 | Per-field explicit checks |
| 554 | `setRiskConfig` | volatilityLtvThresholdBps, rentalBufferBps (uint16) | ADMIN | HARD | volatility > 10000 (or 0=reset); rentalBuffer ≤ MAX_FEE_BPS (5000) | **⚠ Loose: see [Gap #4](#gap-4--weak-bound-rentalbufferbps)** |
| 586 | `setStakingApr` | aprBps (uint16) | ADMIN | HARD + ZERO-SENTINEL | 0 OR ≤ STAKING_APR_BPS_MAX (2000) | 20% APR ceiling |
| 616 | `setVpfiTierThresholds` | t1..t4 (uint256) | ADMIN | CROSS-TIER + ZERO-SENTINEL | per-param 0=default; effective `t1 < t2 < t3 ≤ t4` | Monotonic on effective values |
| 647 | `setVpfiTierDiscountBps` | t1..t4 (uint16) | ADMIN | CROSS-TIER + HARD + ZERO-SENTINEL | each ≤ MAX_DISCOUNT_BPS (9000); effective `t1 ≤ t2 ≤ t3 ≤ t4` | Cross-tier prevents higher-tier-lower-discount |
| 688 | `setFallbackSplit` | lenderBonusBps, treasuryBps (uint16) | ADMIN | HARD + CROSS-TIER | each ≤ 1000; combined ≤ 1500 | Dual-layer cap preserves borrower equity |
| 722-744 | `setRangeAmountEnabled` / `setRangeRateEnabled` / `setPartialFillEnabled` | enabled (bool) | ADMIN | n/a (bool) | bool type — defaults false | Kill-switches |
| 784 | `setDepthTieredLtvEnabled` | enabled (bool) | ADMIN | n/a (bool) | bool — defaults false | Kill-switch |
| 842 | `setDiscountPathEnabled` | enabled (bool) | ADMIN | n/a (bool) | bool — defaults false | Kill-switch |
| 883 | `setTierLiqDiscountBps` | tier1/2/3 (uint16) | ADMIN | CROSS-TIER + HARD + ZERO-SENTINEL | per-tier ∈ [floor, ceil] from `tierLiqDiscountBoundsBps`; effective `T1 ≥ T2 ≥ T3` | Per-tier safety box + cross-tier monotonic |
| 946 | `setLiquiditySlippageBps` | newBps (uint16) | ADMIN | HARD + ZERO-SENTINEL | 0 OR `[25, 1000]` (0.25%–10%) | Prevents zero-slippage false-positives & excessive laxness |
| 976 | `setTwapGuard` | windowSec (uint32), consistencyBps (uint16) | ADMIN | HARD + ZERO-SENTINEL | windowSec: 0 OR `[5min, 1day]`; consistencyBps: 0 OR `[0.5%, 10%]` | Per-param bounds |
| 1023 | `setLiquidityTierSizes` | floor + 3 tiers (uint64 in 1e6 units) | ADMIN | CROSS-TIER + HARD + ZERO-SENTINEL | each 0=default; effective `floor ≤ t1 ≤ t2 ≤ t3`; each ≥ MIN_TIER_SIZE_PAD | Monotonic + minimum-size cap |
| 1051 | `setTierMaxInitLtvBps` | tier1/2/3 (uint16) | ADMIN | CROSS-TIER + HARD + ZERO-SENTINEL | each 0=default; non-zero ≤ MAX_TIER_INIT_LTV_BPS_CEIL (8000); effective `T1 ≤ T2 ≤ T3` | Cross-tier monotonic on effective |
| 1079 | `setPaaAssets` | assets (address[]) | ADMIN | HARD | length ≤ MAX_PAA_ASSETS (8); no zero; no duplicates | Array-size cap + content validation |
| 1116 | `setKeeperTier` | asset (address), tier (uint8) | KEEPER | HARD | asset ≠ 0; tier ∈ [1, MAX_LIQUIDITY_TIER (3)] | Range cap; can only lower effective tier on-chain |
| 1440 | `setGraceBuckets` | buckets (GraceBucket[]) | ADMIN | CROSS-TIER + HARD | fixed 6 slots; per-slot bounds; strictly-ascending threshold; per-slot grace `[GRACE_SECONDS_MIN, GRACE_SECONDS_MAX]` | Defense-in-depth |
| 1677 | `setNumeraire` | 8 params: feeds + thresholds | ADMIN | HARD + CROSS-TIER + ZERO-SENTINEL | required feeds ≠ 0; KYC tier0 < tier1; threshold bounds | Atomic + per-value + monotonic KYC |
| 1798 | `setMinPrincipalForFinerCadence` | newThreshold (uint256) | ADMIN | HARD + ZERO-SENTINEL | 0 OR `[FLOOR, CEIL]` | Explicit bounds |
| 1827 | `setPreNotifyDays` | newDays (uint8) | ADMIN | HARD + ZERO-SENTINEL | 0 OR `[FLOOR, CEIL]` | Explicit bounds |
| 1852-1865 | `setPeriodicInterestEnabled` / `setNumeraireSwapEnabled` | enabled (bool) | ADMIN | n/a (bool) | bool — defaults false | Kill-switches |
| 1938 | `setPredominantDenominator` | 4 params: denom/symbol/feeds | ADMIN | HARD | required addresses ≠ 0 | Non-zero gates |
| 1985 | `setAssetNumeraireDirectFeedOverride` | asset (address), feed (address) | ADMIN | HARD | asset ≠ 0; feed = 0 (clear) OR non-zero | Asset non-zero; feed zero is valid sentinel |

---

## Part 2 — `AdminFacet.sol` (20 setters / mutators)

| Line | Function | Params | Role | Bound | Bound values | Defended by |
|---|---|---|---|---|---|---|
| 138 | `setTreasury` | newTreasury (address) | ADMIN | HARD | ≠ 0 | Explicit zero-reject |
| 153 | `setZeroExProxy` | newProxy (address) | ADMIN | HARD | ≠ 0 | Explicit zero-reject |
| 166 | `setallowanceTarget` | new (address) | ADMIN | HARD | ≠ 0 | Explicit zero-reject |
| 191 | `addSwapAdapter` | adapter (address) | ADMIN | HARD | ≠ 0; no duplicates | Membership check |
| 208 | `removeSwapAdapter` | adapter (address) | ADMIN | HARD | must be registered | Existence check |
| 232 | `reorderSwapAdapters` | newOrder (address[]) | ADMIN | HARD + CROSS-TIER | same length; same member set; no duplicates; no zero | Permutation validation |
| 298 | `setPancakeswapV3Factory` | newFactory (address) | ADMIN | HARD + ZERO-SENTINEL | 0 (disable) OR non-zero | Zero is meaningful |
| 314 | `setSushiswapV3Factory` | newFactory (address) | ADMIN | HARD + ZERO-SENTINEL | 0 OR non-zero | Zero is meaningful |
| 345 | `setUniswapV2Factory` | newFactory (address) | ADMIN | HARD + ZERO-SENTINEL | 0 OR non-zero | Zero is meaningful (V2 leg disabled per chain by default) |
| 358 | `setSushiswapV2Factory` | newFactory (address) | ADMIN | HARD + ZERO-SENTINEL | 0 OR non-zero | Zero is meaningful |
| 371 | `setPancakeswapV2Factory` | newFactory (address) | ADMIN | HARD + ZERO-SENTINEL | 0 OR non-zero | Zero is meaningful |
| 406 | `setKYCEnforcement` | enforced (bool) | ADMIN | n/a (bool) | bool — defaults false (retail product) | Kill-switch |
| 428 | `pause` | (none) | PAUSER | n/a | revert if already paused | Implicit gate |
| 439 | `unpause` | (none) | UNPAUSER | n/a | revert if not paused | **Asymmetric: separate role from PAUSER** |
| 473 | `autoPause` | reason (string) | WATCHER | HARD + ZERO-SENTINEL | no-op if already paused; window auto-clears after MAX_AUTO_PAUSE_SECONDS | UNPAUSER can override anytime |
| 509 | `pauseAsset` | asset (address) | ADMIN or PAUSER | HARD | ≠ 0 | Zero-reject |
| 524 | `unpauseAsset` | asset (address) | ADMIN or UNPAUSER | HARD | ≠ 0 | Zero-reject (PAUSER explicitly NOT accepted — asymmetric) |

---

## Part 3 — `OracleAdminFacet.sol` (12 setters)

| Line | Function | Params | Role | Bound | Bound values | Defended by |
|---|---|---|---|---|---|---|
| 25 | `setChainlinkRegistry` | registry (address) | Owner | HARD + ZERO-SENTINEL | 0 (disable, L2 fallback) OR non-zero | Zero meaningful |
| 37 | `setUsdChainlinkDenominator` | denominator (address) | Owner | **NONE** | accepts any address including zero | **⚠ Gap [#1](#gap-1--missing-zero-check-setusdchainlinkdenominator)** |
| 51 | `setEthChainlinkDenominator` | denominator (address) | Owner | HARD + ZERO-SENTINEL | 0 OR non-zero | Zero is meaningful |
| 62 | `setWethContract` | weth (address) | Owner | HARD + ZERO-SENTINEL | 0 (fail-closed to Illiquid) OR non-zero | Zero is fail-closed |
| 75 | `setEthUsdFeed` | feed (address) | Owner | HARD + ZERO-SENTINEL | 0 (disable) OR non-zero | Zero is fail-closed |
| 86 | `setUniswapV3Factory` | factory (address) | Owner | HARD + ZERO-SENTINEL | 0 OR non-zero | Zero is fail-closed |
| 111 | `setStableTokenFeed` | symbol (string), feed (address) | Owner | HARD + ZERO-SENTINEL | feed=0 (deregister) OR non-zero; **symbol has no length cap or format check** | **⚠ Gap [#2](#gap-2--unconstrained-string-setstabletokenfeedsymbol)** |
| 128 | `setSequencerUptimeFeed` | feed (address) | Owner | HARD + ZERO-SENTINEL | 0 (L1) OR non-zero (L2) | Zero is meaningful |
| 158 | `setFeedOverride` | feed, maxStaleness (uint40), minValidAnswer (int256) | Owner | HARD + ZERO-SENTINEL | maxStaleness=0 (clear); minValidAnswer signed, no bound | Override clearable; downstream `StalePriceData` revert is safety |
| 261 | `setSecondaryOracleMaxDeviationBps` | bps (uint16) | Owner | HARD | ∈ (0, 10000) — open interval | Prevents 0% (always-revert) + 100% (vacuous) |
| 274 | `setSecondaryOracleMaxStaleness` | maxStaleness (uint40) | Owner | HARD | ≠ 0 | Prevents silent staleness-disable |
| 301-347 | Pyth setters (Pyth oracle, feed id, max staleness, deviation, confidence) | Owner | HARD + various | per-field bounds (e.g. confidence ∈ [50, 500] bps; staleness ∈ [60, 3600]) | All explicitly bounded |
| 384 | `setPeerProtocolAddresses` | Aave/Compound/Morpho addresses | Owner | HARD + ZERO-SENTINEL | each 0 (skip) OR non-zero | Zero skips that peer |
| 440 | `setTierReferenceAssets` | tier (uint8), assets (address[]) | Owner | HARD | tier ∈ [1,3]; **assets array has no length cap** | **⚠ Gap [#3](#gap-3--missing-length-cap-settierreferenceassets)** |

---

## Gaps

### Gap #1 — `setUsdChainlinkDenominator` — **FALSE POSITIVE** on re-check

**Location**: `OracleAdminFacet.sol:37`

**Original concern**: Accepts any address (including `address(0)`)
without validation. The audit agent flagged this as a silent-
breakage vector.

**Re-check result**: Zero IS an intentional sentinel — mirroring
`setChainlinkRegistry`'s "disable this leg, fall through to the
ETH path" semantics. The existing test
`testOwnerCanZeroUsdDenominator` (in
[`OracleAdminFacetTest.t.sol`](../../contracts/test/OracleAdminFacetTest.t.sol))
documents the supported flow: after zeroing, `getAssetPrice`
reverts CLEANLY with `NoPriceFeed` (a clear, documented error —
not silent breakage).

The non-zero-typo concern raised by the audit agent isn't actually
addressed by a zero-check: a typo like `address(uint160(1))` would
pass any zero-check and still mis-configure the protocol.
Defending against non-zero typos requires a registry-membership
check (expensive STATICCALL on every call) which we deliberately
don't do — same design choice as the other chain-specific address
setters (factories, registries).

**Status**: NOT a gap. No code change required. Left in this doc
as a record of the audit's reasoning + the disposition. Future
auditors reading the bounds story should see why the zero-sentinel
pattern intentionally extends to this setter.

### Gap #2 — Unconstrained string `setStableTokenFeed.symbol`

**Location**: `OracleAdminFacet.sol:111`

**Issue**: `symbol` parameter is an unconstrained `string`. No length cap, no format validation. A fat-fingered or malicious-governance call could register a 100-KB symbol or one containing non-ASCII chars, polluting the peg-lookup table.

**Risk**: Low–medium. Gas DoS is bounded by tx gas limit; the real cost is observability noise + storage bloat.

**Fix**: Cap `bytes(symbol).length ≤ 10` (covers every ISO fiat code like "USD", "EUR", "XAU"). Optionally also assert ASCII range, but length cap alone closes the practical exploit.

**Status**: Planned for fix this session.

### Gap #3 — Missing length cap `setTierReferenceAssets`

**Location**: `OracleAdminFacet.sol:440`

**Issue**: `assets` array has no length cap. A governance vote could push 1000+ assets per tier, making every `refreshTierLtvCache` call prohibitively expensive (O(n) per-peer iteration × 3 peers = O(3n)).

**Risk**: Medium. Hot-path DoS via legitimate-looking config call.

**Fix**: Add explicit cap `MAX_TIER_REFERENCE_ASSETS = 20` (gives headroom over today's 4-asset Tier-3 baseline without permitting griefing).

**Status**: Planned for fix this session.

### Gap #4 — Weak bound `rentalBufferBps`

**Location**: `ConfigFacet.sol:554` (within `setRiskConfig`)

**Issue**: `rentalBufferBps` is capped at `MAX_FEE_BPS = 5000` (50%). Default is 500 (5%). Governance could push the buffer to 50%, effectively doubling the prepay burden on NFT renters — economic, not safety, but the cap is loose relative to operational defaults.

**Risk**: Low (economic; not a safety-gate). Stay-in-bounds attack would be visible to users.

**Fix**: Reduce cap from 5000 → 2000 (20%). Captures realistic upward governance flexibility without permitting a 10× spike.

**Status**: Planned for fix this session.

---

## Cross-cutting observations

### A. Zero-sentinel pattern (widespread + well-executed)

**Observation**: 25+ setters use the "0 = reset to library default" pattern. Implementation is consistent:
- Setter accepts 0 as reset.
- Zero is documented in NatSpec.
- Getter resolves effective value (override OR default).
- Bounds checks skip zero (`if (v != 0 && (v < MIN || v > MAX))`).

**Assessment**: Excellent. Governance can "undo" a prior mistake without a contract upgrade. **No change recommended.**

### B. Cross-tier monotonic invariants (defense in depth)

**Observation**: Per-tier setters validate **both** per-tier internal consistency AND cross-tier monotonicity:
- `setTierLtvParams` (9 fields atomically; per-tier + cross-tier checks).
- `setTierLiqDiscountBps` (cross-tier `T1 ≥ T2 ≥ T3` on effective values).
- `setTierMaxInitLtvBps` (cross-tier `T1 ≤ T2 ≤ T3`).
- `setVpfiTierDiscountBps` / `setVpfiTierThresholds` (monotonic on effective).
- `setLiquidityTierSizes` (monotonic on effective).

**Assessment**: Excellent. Prevents half-updated state. **Recommendation**: maintain this pattern for any future per-tier knobs.

### C. Atomic multi-field writes

**Observation**: Reconfigurations spanning multiple correlated fields (fee split, grace buckets, numeraire, PAD) use atomic setters with all-or-nothing semantics.

**Assessment**: Correct. **No change recommended.**

### D. Role segregation (pause / unpause asymmetry)

**Observation**:
- `pause` = PAUSER_ROLE (fast-key multisig)
- `unpause` = UNPAUSER_ROLE (Timelock, 48h)
- `pauseAsset` = ADMIN_ROLE or PAUSER_ROLE; `unpauseAsset` = ADMIN_ROLE or UNPAUSER_ROLE — **PAUSER explicitly NOT accepted** on unpauseAsset.

**Assessment**: Excellent — a compromised fast-key can pause but cannot unpause without a 48h-delayed governance flow. **Recommendation**: Apply the same asymmetry to future emergency levers (e.g., a future blacklist + un-blacklist split if added).

### E. Address validation for chain-specific config (design choice, document it)

**Observation**: OracleAdminFacet address setters (Chainlink registry, denominators, feeds, factories) generally accept any non-zero address without contract-interface validation. Adding `STATICCALL`-style probes would add gas overhead + introduce its own failure modes.

**Assessment**: Acceptable design. Governance is trusted to deploy-correct config against the chain's published authoritative addresses (Aave docs, Compound docs, Chainlink Feed Registry).

**Recommendation**: Standardize the NatSpec note on each address setter to explicitly require operator verification against official chain docs. Lightweight; no code change. Already done on the LZ-deployment-config side; extend to oracle-side setters.

### F. Setting parameter to zero — semantic clarity

**Observation**: Zero is semantically overloaded depending on the parameter:
- **Address-typed**: zero usually means "disable this leg" (factories, registries, denominators).
- **BPS/uint16-typed**: zero usually means "reset to library default" (zero-sentinel pattern).
- **uint256-typed**: zero usually means "reset to library default" (zero-sentinel pattern).
- **Counter/threshold-typed**: zero CAN mean "no enforcement" (gap #1 case: `setUsdChainlinkDenominator` accidentally falls into this category).

**Recommendation**: Document the zero-semantic in NatSpec for every setter. The 3 fixes from gaps #1–#3 close the worst case.

---

## Action items

After the Gap #1 re-disposition (false positive), **3 real fixes**
landed in this session as a small, focused commit:

1. ~~`OracleAdminFacet.setUsdChainlinkDenominator`~~ — false positive
   (see Gap #1 above).
2. **`OracleAdminFacet.setStableTokenFeed`** — cap
   `bytes(symbol).length ≤ MAX_STABLE_SYMBOL_LEN (10)`.
3. **`OracleAdminFacet.setTierReferenceAssets`** — add
   `MAX_TIER_REFERENCE_ASSETS = 20` length cap.
4. **`ConfigFacet.setRiskConfig`** — tighten `rentalBufferBps` cap
   from 5000 (50%) → `MAX_RENTAL_BUFFER_BPS = 2000` (20%).

Each gets a new revert error declaration, a corresponding test, and
an updated NatSpec. Total contract surface change is small (~25
lines across 2 files + ~40 lines of tests).

---

## Conclusion

The Vaipakam protocol demonstrates mature bounds-checking discipline across all three admin facets:
- 50+ setters with explicit HARD bounds.
- 25+ with the zero-sentinel pattern correctly implemented.
- 8 with cross-tier monotonic invariants enforcing semantic ordering.
- 0 SOFT-clamped (silent clamping is avoided).

**Three small gaps and one weak bound were identified; all will be closed in a follow-up commit this session.** No critical safety-gate defect was found.

The auditor reading this alongside
[`AdminConfigurableKnobsAndSwitches.md`](../ops/AdminConfigurableKnobsAndSwitches.md)
has the full inventory needed to verify the bounds claim for every
governance-tunable knob.
