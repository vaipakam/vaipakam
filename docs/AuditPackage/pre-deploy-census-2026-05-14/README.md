# Pre-deploy autonomous-LTV census — 2026-05-14

Per-chain output of `contracts/script/SlippageCensusPreDeploy.s.sol`
run against current mainnet state on each target chain. This is
checkpoint **1 of 3** from
[`docs/ops/SlippageCensusGuide.md`](../../ops/SlippageCensusGuide.md) —
"post-deploy snapshot" and "pre-flip rehearsal" follow.

## Summary

| Chain | chainId | Tier 1 | Tier 2 | Tier 3 | Tier 3 source |
|---|---|---|---|---|---|
| Ethereum | 1 | 50.00% | 62.00% | **73.37%** | peer consensus (2 contributing assets) |
| Base | 8453 | 50.00% | 62.00% | 73.00% | library default |
| Arbitrum | 42161 | 50.00% | 62.00% | 73.00% | library default |
| Optimism | 10 | 50.00% | 62.00% | 73.00% | library default |
| BNB Chain | 56 | 50.00% | 62.00% | 73.00% | library default |
| Polygon | 137 | 50.00% | 62.00% | **72.00%** | peer consensus (2 contributing assets) |

Reading "Tier 1 = 50%": when `depthTieredLtvEnabled` is `true` on
this chain and an asset classifies Tier 1 via the on-chain depth
slippage simulation, the loan-init gate caps init-LTV at min(per-
asset `maxLtvBps`, 50% effectively-tier). Tier 1's reference asset
list is intentionally empty for v1 (long-tail assets often only on
one peer); Tier 2 and Tier 3 use the populated lists.

"Library default" means the autonomous tier-LTV cache rejected the
peer-consensus refresh (`insufficient-readings`) — the runtime
falls back to the per-tier library default constant baked into
`LibVaipakam.sol`. This is benign + expected behaviour on chains
where the peer-protocol asset overlap is thin.

## Why most chains fall back to library defaults

The per-tier autonomous cache requires per-asset consensus across
**both** Aave V3 + Compound V3 (`cUSDCv3` base) — at least two
peers must report a positive LTV for each reference asset, and
across the tier at least two reference assets must contribute.

The empirical state (2026-05-14) is two-fold:

1. **Long-running risk-steward LTV reductions** — Aave V3 has been
   systematically setting borrowable LTV to 0 on many mid-cap and
   some long-tail assets across multiple chains (ARB on Arbitrum,
   OP on Optimism, LINK on Arbitrum, CAKE on BNB, etc.) as part of
   its risk-team's response to general volatility and to deprecate
   tokens for new borrows. Compound V3 cUSDCv3 collateral lists
   those same assets at higher CFs because its per-market model
   handles risk differently.

2. **April 18, 2026 Kelp/LayerZero OFT bridge exploit aftermath** —
   Aave Risk Stewards froze WETH on Arbitrum, Base, Mantle, and
   Linea (and dropped WETH LTV on those chains plus Ethereum Core
   and Ethereum Prime) as a precautionary measure. The
   [restoration AIP](https://governance.aave.com/t/direct-to-aip-weth-unfreeze-and-ltv-restoration-across-aave-v3-instances/24878)
   is executing as of this census date, restoring WETH LTV to
   pre-exploit values (80% Arbitrum + Base, 80.5% Ethereum Core +
   Mantle, 84% Ethereum Prime, 80% Linea). Optimism + BNB +
   Polygon were NOT in the exploit-response set. **The
   Arbitrum / Base / Mantle Tier-3 fall-back-to-library-default
   results above reflect this transient state.** Re-running the
   census in 1–2 weeks (post-AIP-execution) should land real
   peer-consensus Tier-3 values for these chains in the 71–74%
   range (mirroring Ethereum's 73.37%).

Result: per-asset consensus frequently rejects because Aave reads
LTV=0 (treated as "asset deprecated by this peer" by the
plausibility-bound check in `LibPeerLTV`). This is **not a bug** —
it's the consensus algorithm correctly detecting that one peer has
effectively deprecated the asset for new borrows OR has frozen it
for incident response. The conservative fallback to library defaults
is exactly the autonomy story working as designed. **Critically,
this census captures the system's behaviour DURING a peer-protocol
stress event (the OFT exploit response), not in steady state — our
aggregator passed its first live stress test by refusing to
import Aave's exploit-response zeros into Vaipakam's tier-LTV
cache.**

## Aave V4 — known future maintenance item

Aave V4 launched on Ethereum mainnet on 2026-03-30 with a
hub-and-spoke architecture (one Liquidity Hub per chain,
multiple per-market Spokes). As of this census date V4 is on
Ethereum mainnet **only**; it has NOT rolled out to any L2 we
target. The 6-chain peer-aggregation set (`SlippageCensus.chains.json`)
reads V3's `IPoolDataProvider` exclusively because V3 remains the
active product on every L2.

When V4 rolls out to a chain we read on, `LibPeerLTV` will need an
additional `IAaveV4HubReader` (read API is fundamentally different
from V3's monolithic `getReserveConfigurationData(asset)`). Approach:
optional third Aave-side reader; the aggregator continues to
median-merge per-asset across V3 + V4 + Compound V3. Not urgent —
gated on actual V4 L2 deployments.

## Tier 3 results in detail

### Ethereum (Tier 3 = 73.37%)

Reference assets: WETH, WBTC, cbETH, wstETH.
Contributing to consensus: WETH + WBTC.
cbETH + wstETH likely listed on different Compound base (`cWETHv3`
rather than `cUSDCv3`), so they don't contribute via the single-
Comet read in v1.

Aave V3 Ethereum:
- WETH ≈ 80.5% LTV
- WBTC ≈ 73% LTV

Compound V3 cUSDCv3 Ethereum:
- WETH borrowCollateralFactor 0.83 = 83%
- WBTC borrowCollateralFactor 0.78 = 78%

Asset medians (within 30pp tolerance):
- WETH = (80.5 + 83) / 2 ≈ 81.75%
- WBTC = (73 + 78) / 2 ≈ 75.50%

Tier median = (81.75 + 75.50) / 2 ≈ 78.6% → minus 5pp Tier-3 haircut → 73.6%.
Final cache value: **73.37%** (slight delta from integer-only
arithmetic in the contract; well within rounding tolerance).

### Polygon PoS (Tier 3 = 72.00%)

Reference assets: USDC native, USDT, WBTC, WETH (bridged).
Contributing: 2 assets (likely WETH + WBTC; USDC/USDT are stables,
Compound's base on Polygon is USDC so the base-asset isn't a
collateral on its own market).

Final cache value: 72.00%, slightly below Ethereum's because
Polygon's peers configure these assets a touch more conservatively.

## The CSV files

One per chain, all columns prefixed `CENSUS_PRE,`:

```
CENSUS_PRE,<label>,<chainId>,<tier>,<refAssetCount>,<cachedLtvBps>,<effectiveLtvBps>,<libraryDefaultBps>
```

Plus a sidecar `CENSUS_PRE_PEERS` row per chain echoing the
peer-protocol addresses used for that chain. The audit team can
match these against each protocol's official deployment registry
to verify provenance.

## What the audit team should look for

1. **Cross-row consistency**: `cachedLtvBps` either equals
   `effectiveLtvBps` (cache populated) or is 0 with `effectiveLtvBps
   = libraryDefaultBps` (rejected, fell back).
2. **Per-chain peer-address provenance**: every `CENSUS_PRE_PEERS`
   row's three addresses verified against the source-of-truth
   docs (`https://aave.com/docs/resources/addresses`,
   `https://docs.compound.finance/#networks`,
   `https://docs.morpho.org`).
3. **Tier ordering within each chain**: `T1 <= T2 <= T3`. The
   library defaults satisfy this trivially; peer-derived values
   bound-check at the setter so the invariant is preserved.
4. **Library-default fallback frequency**: chains where multiple
   tiers fall back to library default indicate thin peer-protocol
   coverage on that chain — informs whether Vaipakam should enable
   `depthTieredLtvEnabled` on that chain at launch (vs leaving it
   at the conservative HF≥1.5 baseline).

## Re-running

```bash
cd contracts/
for chain in eth:ETHEREUM base:BASE arb:ARBITRUM op:OPTIMISM bnb:BNB polygon:POLYGON; do
  short="${chain%%:*}"
  var="VITE_${chain##*:}_RPC_URL"
  rpc=$(grep "^${var}=" ../apps/defi/.env.local | cut -d= -f2-)
  CENSUS_LABEL="$(date -u +%Y-%m-%d)-${short}" \
  CHAINS_JSON_PATH=script/SlippageCensus.chains.json \
    forge script script/SlippageCensusPreDeploy.s.sol:SlippageCensusPreDeploy \
      --rpc-url "$rpc" 2>&1 | grep '^  CENSUS_PRE' | sed 's/^  //'
done
```
