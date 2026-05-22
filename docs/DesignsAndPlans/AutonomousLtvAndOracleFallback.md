# Autonomous LTV + Oracle-Quorum Fallback — Design

**Status**: design ratified 2026-05-14. Implementation across 6 phases on
branch `feat/market-rate-widget-and-tiered-ltv`. Pairs with the existing
[MarketRateWidgetAndDepthTieredLTV.md](MarketRateWidgetAndDepthTieredLTV.md)
design — that doc covers the **per-asset tier resolution** (Layer 1 of
the autonomy stack below); this doc covers the **tier-LTV mapping**
(Layer 2) and the **failed-swap fallback** (a separate but adjacent
borrower-protection upgrade).

## 1. Goal

Vaipakam runs as an autonomous P2P lending protocol — no continuous
governance tuning is required for normal operation. The only governance
levers retained are the *emergency multisig kill-switches* for crises
(`pauseAsset` remove-only, `depthTieredLtvEnabled = false`, the 30-min
`autoPause` window). Every per-asset risk parameter is derived from
real-time on-chain data.

The product positioning that follows from this:

> *"Vaipakam's risk parameters are real-time-data-derived: depth-tier
> from on-chain pool liquidity, tier→LTV mapping from peer-protocol
> consensus on-chain, failed-swap fallback from the multi-oracle
> quorum. Three layers of autonomous machinery, three layers of
> sanity-bound safety, no continuous-governance dependency. The
> emergency multisig retains a kill-switch for the unforeseeable; it
> never sets a parameter."*

## 2. The three autonomous layers

| Layer | What it computes | On-chain data source | Already done? |
|---|---|---|---|
| **1** | **Per-asset depth tier** (0..3) | Pool slippage simulation across `effectivePaaAssets × {Uni/Sushi/Pancake V3+V2 forks} × fee ≤ 0.3%` | ✓ (`OracleFacet.getLiquidityTier`) |
| **2** | **Tier → max-init-LTV** | Peer-protocol LTV configs (Aave V3 PoolDataProvider, Compound V3 Comet, Morpho-Blue marketParams) | NEW (this doc, Phase 3-5) |
| **3** | **Liquidation execution** | Aggregator quotes (off-chain) routed through on-chain failover / split / partial entry points | ✓ (`RiskFacet.triggerLiquidation` / `triggerLiquidationSplit` / `triggerPartialLiquidation`) |

Adjacent borrower-protection upgrade (Phase 2 below): the **failed-swap
fallback** is upgraded from full-collateral-transfer to oracle-quorum
equivalent-value settlement, refunding the borrower the surplus that
today's behaviour leaks to the lender.

## 3. Peer comparison — how the majors handle tier-LTV setting

| Protocol | Per-asset LTV / liqThreshold | Update mechanism | Risk-team in the loop |
|---|---|---|---|
| **Aave V3** | Governance-set per asset (e.g. WBTC ~73/78%, WETH ~80.5/83%, USDC ~75/78%, long-tail ~50/55%) | AaveDAO proposal → Snapshot → on-chain vote → executor | Chaos Labs + Gauntlet model the parameters; DAO votes |
| **Compound V3 (Comet)** | Governance-set per market; per-asset within-market | Compound governance vote per market change | Gauntlet drives risk recommendations |
| **Morpho-Blue** | Fixed at market creation (immutable per market) | New market = new immutable market | Curators (Steakhouse / Block Analitica / MEV Capital / Aera) per vault |
| **MakerDAO / Sky** | Collateralization-ratio per ilk, governance-set (typically 150%+) | MIP-style governance | Risk teams contribute via forum |
| **Liquity v1** | Fixed 110% globally, no per-asset, never changes | None (immutable at deploy) | None |
| **Vaipakam** (this doc) | Tier-LTV mapping derived from peer-consensus on-chain, bounded per tier, refreshable permissionlessly | Permissionless `refreshTierLtvCache()` re-reads peers; emergency multisig retains pause / disable | None continuous; risk team consulted at deploy + audit only |

**The honest pattern**: 4 of the 5 majors use governance for per-asset
LTV. The one that doesn't (Liquity) makes the LTV immutable and
conservative at deploy. Vaipakam splits the difference — the
methodology is set in code (formula + bounds), the values flow from
real-time on-chain peer-consensus reads, no continuous human in the
loop.

## 4. Per-tier LTV bounds (the safety boxes)

The tier-LTV cache is hard-bounded per tier. A peer-consensus reading
that lands outside the box for its tier is *rejected*, not clamped —
out-of-band data is signal something's wrong with peer protocols, not
a value to use:

| Tier | Floor | Ceiling | Library default (cache-stale fallback) |
|---|---|---|---|
| Tier 1 | 37% | 55% | 50% |
| Tier 2 | 55% | 69% | 62% |
| Tier 3 | 69% | 82% | 73% (assumes 0pp haircut) or 73% (5pp haircut → 70%) |

Behavioural properties of the bound design:

- **Lower bound** prevents denial-of-service to borrowers. A compromised
  peer governance pushing 5% LTV across the board cannot push our
  Tier-3 below 69%.
- **Upper bound** prevents fund-loss-by-loosening. A compromised peer
  pushing 99% LTV cannot push our Tier-3 above 82%.
- **Floor below the previous cap, ceiling above the previous cap** at
  each tier — preserves the depth-tier-monotonic property (a Tier-3
  asset is at least as good as a Tier-2 asset).
- **Bounds = consensus reject** — instead of silently clipping to the
  band, the refresh function REJECTS values outside the band and
  leaves the previous cache (or library default if cache stale). This
  surfaces peer-data anomalies via the refresh-rejected event rather
  than silently using a clipped value.

Library defaults sit roughly at the midpoint of each tier's box, so
the cache-stale fallback (used when no refresh happens for > 14 days)
is neutral.

## 5. Peer-LTV cache mechanism

### 5.1 Peer protocols we read

| Protocol | Interface | Returns | Status |
|---|---|---|---|
| **Aave V3** | `IPoolDataProvider.getReserveConfigurationData(asset)` | `(decimals, ltv, liquidationThreshold, liquidationBonus, reserveFactor, ...)` | Public view, well-known per-chain address |
| **Compound V3** | `Comet.getAssetInfoByAddress(asset)` | `AssetInfo { offset, asset, priceFeed, scale, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }` | Per-base-Comet; multiple Comets per chain (USDC base, USDT base, ETH base, ...) |
| **Morpho-Blue** | `IMorpho.idToMarketParams(marketId)` + per-market `borrowableLltv` | Per-market `(loanToken, collateralToken, oracle, irm, lltv)` | Per-curator; aggregate across vaults' curated markets |

All three interfaces are **public on-chain views**. No off-chain RPC
dependency; no shared trust-server. The "shared attack surface" with
peer protocols is real (compromised Aave governance → compromised peer
data) but mitigated by:

1. **Per-tier bounds** (§4) — peer data clipped/rejected if outside box.
2. **Multi-peer consensus** — require ≥ 2 peers to report within a
   reasonable band per asset; reject the asset's contribution otherwise.
3. **Multi-asset aggregation** — within a tier, aggregate across a
   reference asset list; one bad peer reading on one asset can't shift
   the tier's median materially.

### 5.2 Reference asset list per tier

The cache reads peer LTVs for a *fixed reference asset list per tier*.
The list is library-constant (immutable at deploy); changing it
requires a governance proposal + redeploy. This is the one
"constitutional" call retained in code — what are our reference assets?

| Tier | Reference assets (per chain, resolved via deployment addresses) |
|---|---|
| Tier 3 (blue-chip) | WBTC, WETH, USDC, USDT, DAI |
| Tier 2 (mid-cap) | LINK, AAVE, UNI, COMP, MKR |
| Tier 1 (entry) | A small list of well-attested mid/long-tail assets — set conservatively at deploy |

For each `(tier, reference_asset, peer_protocol)` tuple, the cache
queries the peer's LTV for that asset (when listed on the peer; missing
from a peer = that peer contributes 0 readings for that asset).

**Phase-3 research extension**: replace the hardcoded reference asset
list with autonomous discovery via Aave's
`PoolDataProvider.getAllReservesTokens()` → classify each into our
tier via `getLiquidityTier(asset)` → aggregate. Higher gas, full
autonomy. Out of scope for v1.

### 5.3 Aggregation algorithm

```
for each tier T ∈ {1, 2, 3}:
    readings = []
    for each reference_asset A in TIER_REFERENCE_ASSETS[T]:
        peer_ltvs = []
        for each peer P in {AAVE, COMPOUND, MORPHO}:
            ltv = P.read_ltv(A) if A is listed on P else None
            if ltv != None: peer_ltvs.append(ltv)
        if len(peer_ltvs) >= 2:                        # multi-peer consensus
            asset_median = median(peer_ltvs)
            if abs(max(peer_ltvs) - min(peer_ltvs)) <= PEER_DIVERGENCE_TOLERANCE:
                readings.append(asset_median)
    if len(readings) >= TIER_MIN_READINGS:             # multi-asset stability
        tier_median = median(readings)
        candidate = max(0, tier_median - TIER_HAIRCUT_BPS[T])
        if TIER_FLOOR_BPS[T] <= candidate <= TIER_CEIL_BPS[T]:
            cache.tier_ltv[T] = candidate
            emit TierLtvCacheUpdated(T, candidate, ...)
        else:
            emit TierLtvCacheRefreshRejected(T, candidate, "out-of-band")
    else:
        emit TierLtvCacheRefreshRejected(T, 0, "insufficient-readings")
cache.last_refreshed_at = block.timestamp
```

Constants (`LibVaipakam`):

- `TIER_HAIRCUT_BPS` = `[0, 0, 500]` (Tier-1, Tier-2: 0pp; Tier-3: 5pp)
- `TIER_FLOOR_BPS` = `[3700, 5500, 6900]`
- `TIER_CEIL_BPS` = `[5500, 6900, 8200]`
- `TIER_MIN_READINGS` = `2` (need ≥ 2 reference assets per tier reporting)
- `PEER_DIVERGENCE_TOLERANCE` = `1500` bps (15pp — Aave / Compound / Morpho diverge on long-tail; this catches genuine anomalies without rejecting the natural spread)

### 5.4 Cache TTL + read path

- **`tierLtvCache.lastRefreshedAt`** — unix timestamp of last successful refresh.
- **Soft TTL** = 7 days. Loan init reads cache cleanly; informational
  event `TierLtvCacheSoftStale` emits when the cache is in [7, 14] day
  range so monitors can prompt a refresh.
- **Hard TTL** = 14 days. After 14 days, loan init falls back to
  `TIER_DEFAULT_LTV_BPS[T]` (library defaults from §4) instead of cache.
  Emits `TierLtvCacheHardStale`. Loans continue to work; just at the
  conservative midpoint.
- **Refresh function** is **permissionless** (`refreshTierLtvCache()`).
  Anyone can call. Gas cost ~150-300k depending on which peers are
  deployed on the current chain.
- **MEV / economic incentive**: a fresh cache that LOWERS our LTV
  doesn't benefit any specific party. A fresh cache that RAISES our
  LTV (within band) makes borrowers happier. Honest operators / botted
  refreshes are sufficient; we don't need a paid keeper for refreshes.

### 5.5 Storage layout (incremental)

New fields on `LibVaipakam.Storage`:

```solidity
struct TierLtvCacheEntry {
    uint16 ltvBps;            // 0 ⇒ never-refreshed
    uint64 lastRefreshedAt;   // unix seconds; 0 ⇒ never-refreshed
}
mapping(uint8 tier => TierLtvCacheEntry) tierLtvCache;
```

Single `mapping` with three slots (one per tier). Total new storage:
~3 slots. No `ProtocolConfig` change needed; the cache lives in its
own top-level Storage field.

### 5.6 Per-chain peer-protocol addresses

A new section in `contracts/script/SlippageCensus.chains.json`:

```json
{
  "chain_1_peers": {
    "aave_v3_pool_data_provider": "0x...",
    "compound_v3_comets": ["0xc3d6...", "0x..."],
    "morpho_blue": "0xBBBB..."
  },
  "chain_8453_peers": { ... },
  ...
}
```

Addresses verified against each peer's official docs at deploy time;
zero-address entries skip that peer on that chain (so the refresh
function works on chains where a peer isn't deployed).

The diamond stores per-peer addresses in a new section of its Storage,
populated at deploy via `OracleAdminFacet.setPeerProtocolAddresses(...)`.

## 6. Oracle-quorum failed-swap fallback

The borrower-friendliness upgrade. Independent of the peer-LTV work,
but ships together.

### 6.1 Current behaviour (problem statement)

When `triggerLiquidation`'s swap fails (every adapter reverts, or the
swap exceeds 6% slippage), the diamond falls back to
`_fullCollateralTransferFallback`:

- **Full** collateral transfers to the lender's claim.
- Borrower receives nothing back. The lender receives collateral worth
  *more* than the debt — a windfall paid for by the borrower's surplus.

This is materially borrower-hostile. It was acceptable when the
fallback path was rare and reserved for genuinely-illiquid collateral;
the upgrade reframes it to fair-value-equivalent for all liquid cases.

### 6.2 New behaviour

Failed swap path:

```
on swap failure (all adapters reverted OR slippage > 6% ceiling):
    if (oracle_quorum.fresh(collateral_asset)            # Phase-7b 2-of-N
        AND oracle_quorum.fresh(principal_asset)):
        collateral_price = oracle_quorum.read(collateral_asset)
        principal_price  = oracle_quorum.read(principal_asset)
        debt_value_usd   = current_borrow_balance * principal_price
        lender_owed_units = debt_value_usd / collateral_price
        if lender_owed_units >= total_collateral:
            # collateral can't cover debt; lender takes everything,
            # borrower is wiped (same as today's "deep-distress" case)
            transfer total_collateral → lender claim
        else:
            transfer lender_owed_units → lender claim
            transfer (total_collateral - lender_owed_units) → borrower claim
        emit FailedSwapOracleFallback(loanId, lender_owed_units, surplus)
    else:
        # current behaviour preserved for truly illiquid assets where
        # the oracle can't price the collateral either
        transfer total_collateral → lender claim     # existing path
        emit FailedSwapFullCollateralFallback(loanId)
```

### 6.3 Properties + edge cases

- **Lender bears post-settlement price risk**: they receive ASSET, not
  principal-asset. Same shape as today's full-collateral-transfer — the
  proposal just changes the AMOUNT to fair-value-equivalent.
- **Optional follow-up swap**: existing `ClaimFacet.claimAsLenderWithRetry`
  lets the lender attempt to convert collateral to principal at their
  own slippage tolerance. Reusable on the new path with no changes.
- **Borrower surplus immediately claimable**: lands in borrower's vault
  via `LibVaipakam.recordVaultDeposit`, claimable through normal
  withdrawal flow.
- **Oracle staleness** — the existing `OracleFacet.getAssetPrice` already
  enforces freshness (4h for blue chips, 2h ETH/USD, 24h for stable
  feeds with depeg protection). Same primitives reused; no new
  staleness logic.
- **Oracle quorum** — uses the Phase-7b 2-of-N soft-decision rule
  (Chainlink primary + Tellor + API3 + DIA secondary). If primary +
  one secondary agree within band, fallback proceeds. Else: revert to
  full-collateral-transfer.

### 6.4 Touch points

| File | Change |
|---|---|
| `RiskFacet._fullCollateralTransferFallback` | Inline the oracle-quorum branch before the existing full-transfer; emit one of two events depending on which path executed. |
| `RiskFacet.triggerLiquidationSplit` | Same fallback semantics (split-route currently has no soft fallback; the upgrade adds one with oracle-quorum guard). |
| `LibFallback` | New helper `tryOracleQuorumFallback(loan, currentBorrow) → (success, lenderOwed, borrowerSurplus)`. |
| New events | `FailedSwapOracleFallback`, retain `FailedSwapFullCollateralFallback` (renamed from current). |
| New tests | Split-route failure with oracle fresh → oracle path. Split-route failure with oracle stale → full-transfer path. Liquid asset failed-swap → oracle path. Truly illiquid → full-transfer path. |

## 7. Implementation plan (6 phases)

| # | Phase | Surface | Est. effort | Status |
|---|---|---|---|---|
| 1 | **This design doc** | `docs/DesignsAndPlans/AutonomousLtvAndOracleFallback.md` | 30 min | DONE (`a1b7de8`) |
| 2 | **Oracle-quorum failed-swap fallback** | `RiskFacet`, `LibFallback`, new tests | half-day | DONE (`d0dded2`) |
| 3 | **`LibPeerLTV` + per-chain peer addresses** | New library; `IPoolDataProvider` + `IComet` + `IMorpho` minimal interfaces; per-chain peer-address storage; setter on `OracleAdminFacet` | day | DONE (`58c2b6b`) |
| 4 | **`refreshTierLtvCache` + storage + per-tier bounds** | `OracleFacet.refreshTierLtvCache()` (permissionless); `tierLtvCache` storage; bound-enforcement; events | day | DONE (`455385e`) |
| 5 | **`LoanFacet._checkInitialLtvAndHf` integration** | Read from cache; cache-stale fallback to library defaults; legacy `cfgTierMaxInitLtvBps` setters retained as dead-code (soft-deprecated; removal is a follow-up sweep) | half-day | DONE (`3677dda`) |
| 6 | **Mainnet-fork census variant** | `SlippageCensusPreDeploy.s.sol` + `SlippageCensus.chains.json`; fork mainnet via `--fork-url`, diamond-cut minimal Diamond (DiamondCut + OracleFacet + OracleAdminFacet selectors only), configure peers + tier reference assets, run refresh against real peer state, report per-tier cache values for the audit-package CSV | day | DONE (this commit) |

Total: ~4 working days. Single regression after each phase to avoid
the post-step-3 5-failure surprise.

## 8. Out of scope (Phase 3 research items, not built in v1)

- **On-chain volatility-derived tier-LTV** — use TWAP-tick variance over
  N days as a per-asset volatility signal. Compute LTV haircut from
  realized volatility (more volatile → larger haircut). Manipulation
  attack surface real (flash-loan-induced TWAP shift); requires
  manipulation-resistant statistic. Documented here for future research.
- **Autonomous reference-asset-list discovery** — replace the hardcoded
  `TIER_REFERENCE_ASSETS` constant with on-chain enumeration via
  Aave's `PoolDataProvider.getAllReservesTokens()` + auto-bucketing via
  `getLiquidityTier`. Higher gas; richer reference set. Phase 3.
- **Cross-chain LTV consensus** — require N chains' peer-LTV caches to
  agree before applying. Adds cross-chain message dependency
  (LayerZero or equivalent). Substantial architectural change.
- **Per-asset tier-LTV override** — a future governance mechanism to
  override the tier-LTV for SPECIFIC assets (e.g. a Tier-3 asset that
  has high realized volatility despite being deep). Today's design
  treats all assets in a tier uniformly; per-asset override would
  break that. Not necessarily a Phase-3 item; might never be needed.

## 9. Audit-package additions

The audit package now expands to cover:

1. The peer-protocol address verification: every `(chainId, peer,
   address)` triple is verified against the peer's official docs.
2. The bound-enforcement logic: every refresh path is exercised in
   tests with peer-data pushing values to / above / below the bounds.
3. The oracle-quorum fallback decision tree: failed-swap + fresh
   oracle quorum + stale oracle quorum.
4. The economic analysis: under what market conditions does the cache
   produce a value that lands outside its bound? (Answer: only under a
   peer governance attack or peer parameter typo; both are bounded by
   the box.)
5. Confirmation that the cache value never under-reads vs the
   library defaults at deploy — i.e., the v1 launch state has cache
   = library default until first refresh, no behaviour change vs the
   pre-cache state.

## 10. Resume / sequencing

This doc is the spec. Each subsequent phase commits against it; if a
design decision changes during implementation, this doc is updated and
the changing commit cites the doc revision. The mainnet-fork census
variant (Phase 6) is the validation step before any chain flips
`depthTieredLtvEnabled` on.
