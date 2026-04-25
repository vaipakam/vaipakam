# Oracle policy

Operational playbook for Vaipakam's price-oracle and liquidity-classification
surface. Covers what's configured, what governance can change, what happens
under each failure mode, and how to verify the configured state matches the
policy below. Companion to `GovernanceRunbook.md`; both are pre-mainnet
CI gates.

## Goal

Every price read the protocol consumes must satisfy ALL of:

1. A live Chainlink aggregator returned it.
2. Its age is under a bound — two-tier by default, per-feed overrideable.
3. Its value is above a configured floor — zero by default, per-feed overrideable.
4. The Soft 2-of-N quorum check passes against the configured secondary
   sources (Tellor / API3 / DIA). See "Secondary sources — Soft 2-of-N
   quorum" below.

If any of the four fails, `getAssetPrice` reverts. No silent fall-through
to a single source, no stale-data-as-fresh masking. The facets downstream
(RiskFacet, LoanFacet, DefaultedFacet, RefinanceFacet) all expect a
reverting read and treat its absence as "cannot price this position
right now".

Liquidity classification (`OracleFacet.checkLiquidity`) follows a parallel
1-of-N OR rule across three Uniswap-V3-fork DEX factories — see
"Liquidity classification — 3-V3-clone OR-logic" further down.

## Primary source — Chainlink

Every supported asset must resolve to a Chainlink aggregator, either
directly via Feed Registry `(asset, USD)` or via the `(asset, ETH)` ×
`(ETH, USD)` fallback route. Assets without either route are classified
Illiquid and cannot back a loan.

**Two-tier staleness defaults (global):**

| Tier | Cap | Applies to |
|---|---|---|
| Volatile | 2 hours | Any feed whose answer does not sit near a peg ($1 USD, registered fiat/commodity references) |
| Stable (peg-aware) | 25 hours | 8-decimal feeds whose answer is within 3% of $1 USD OR any registered `stableFeedBySymbol` reference (EUR, JPY, XAU, etc.) |

The 25h ceiling exists because stablecoin aggregators and fiat/commodity
reference feeds publish on 24-hour heartbeats by design — forcing a
2-hour window on them would fail-closed under normal operation.

**L2 sequencer circuit breaker.** On L2 chains, `getAssetPrice` reads
the Chainlink sequencer-uptime feed first and reverts if the sequencer
is down OR is inside its 1-hour post-recovery grace window. Prevents
stale-price execution on an L2 resumption edge.

## Per-feed overrides (Phase 3.1)

Governance can tighten or relax either bound on a specific feed via
`OracleAdminFacet.setFeedOverride(feed, maxStaleness, minValidAnswer)`:

- `maxStaleness` in seconds. Zero clears the override (both fields
  reset) and the global two-tier ceiling resumes.
- `minValidAnswer` in the aggregator's own decimals. When set, any
  reading below the floor reverts — protects against compromised
  aggregators returning ~zero values during incidents.

When an override is active, the stable-peg relaxation (25h ceiling
when the answer is near $1) is bypassed. Operators who set an
override are taking explicit responsibility for the freshness budget
on that feed.

## Secondary sources — Soft 2-of-N quorum (Phase 7b.2)

Three secondary oracles are wired alongside Chainlink:

| Source | Lookup keying | Staleness convention | Decimals returned |
|---|---|---|---|
| **Tellor** | `keccak256(abi.encode("SpotPrice", abi.encode(symbol, "usd")))` | Reporter-driven, dispute-bounded. `getDataBefore(queryId, block.timestamp)` returns latest. | 18 |
| **API3** | `keccak256(abi.encodePacked(bytes32("<SYMBOL>/USD")))` | First-party publisher, sub-minute updates typical. | 18 |
| **DIA** | string `"<SYMBOL>/USD"` passed to `getValue(string)` | Daily updates; configurable per feed at the DIA side. | 8 |

All three keys are derived **on-chain** from `IERC20.symbol()` of the
asset being priced. **No per-asset governance config** — the operator
only sets the chain-level oracle address per source, plus the
chain-level deviation tolerance + staleness ceiling. New collateral
assets are picked up automatically as long as the asset's ERC-20
symbol matches the upstream oracle's naming convention.

### Symbol-derivation fragility

The on-chain `asset.symbol()` read can fail to map cleanly to an
upstream symbol convention. Cases the policy accepts as silently
unavailable rather than reverting:

- The asset's `symbol()` reverts (non-standard token).
- The asset returns `bytes32` instead of `string` (legacy MakerDAO-
  style tokens) — handled with a fallback path that strips trailing
  zeros and converts to string.
- The derived key has no reporter on the upstream oracle (very
  long-tail tokens).
- The upstream returned a stale or zero value.

Each "unavailable" path counts as no information from that source —
neither agreement nor disagreement.

### Quorum rule (Soft 2-of-N, Interpretation B)

For each price read:

1. Run all three secondary probes. Each returns one of:
   - **Unavailable** — silent skip (oracle not configured, symbol
     unreadable, no reporter, stale, or read reverted).
   - **Agree** — value within `secondaryOracleMaxDeviationBps` of
     Chainlink.
   - **Disagree** — value outside the deviation band.
2. Decision:
   - **All three Unavailable** → accept Chainlink price (graceful
     fallback; preserves operability on chains / assets with sparse
     secondary coverage).
   - **At least one Agree** (regardless of any Disagree alongside)
     → accept Chainlink price (quorum hit: Chainlink + the agreeing
     secondary form the 2-source majority).
   - **Some Disagree AND no Agree** → revert
     `OraclePriceDivergence`.

Effect: a single secondary source compromise can no longer push a
disagreeing price through the gate; an attacker would have to
compromise (or DoS at the same time) Chainlink AND every secondary
that has data for the asset. A real Chainlink + Tellor + API3 + DIA
agreement is what the protocol relies on whenever the data exists.

### Configuration

| Parameter | Setter | Type | Default |
|---|---|---|---|
| Tellor oracle address | `setTellorOracle(address)` | per-chain | zero (disabled) |
| API3 ServerV1 address | `setApi3ServerV1(address)` | per-chain | zero (disabled) |
| DIA Oracle V2 address | `setDIAOracleV2(address)` | per-chain | zero (disabled) |
| Deviation tolerance | `setSecondaryOracleMaxDeviationBps(uint16)` | per-chain | 500 (5%) |
| Staleness ceiling | `setSecondaryOracleMaxStaleness(uint40)` | per-chain | 3600 (1h) |

All setters are ADMIN_ROLE-gated through `OracleAdminFacet` and
timelock-gated after the Safe-Timelock handover.

### Why Pyth was removed (Phase 7b.2)

The Phase 3.2 Pyth integration required a per-asset `priceId` mapping
in diamond storage — every new collateral asset needed a governance
write to install its priceId before pricing worked. This conflicted
with the no-per-asset-config policy locked in for Phase 7b and was
removed in favor of the symbol-derived alternatives. The two-tx
`useWriteWithPythUpdate` UX flow no longer exists — every secondary
source above is a pure read, no on-chain price-update transactions
are required.

## Liquidity classification — 3-V3-clone OR-logic (Phase 7b.1)

`OracleFacet.checkLiquidity` runs a parallel 1-of-N OR across three
Uniswap-V3-fork DEX factories: **UniswapV3, PancakeSwap V3, and
SushiSwap V3**. All three forks share the identical
`getPool(token0, token1, fee)` factory ABI and
`slot0()` / `liquidity()` pool views, so the same depth-probe code
runs against all three with only the factory address differing.

### Decision rule

An asset is classified Liquid iff:

1. The Chainlink price feed for the asset is fresh (per the price
   policy above), AND
2. **At least one** of the three V3 factories exposes an asset/WETH
   pool whose `liquidity() × ETH/USD` meets the
   `MIN_LIQUIDITY_USD` floor.

The probe iterates fee tiers `[3000, 500, 2500, 10000, 100]` against
each factory — the 2500 entry covers PancakeV3's hallmark mid-tier;
the rest cover UniV3's standard set plus stable-pair tiers.

Threat model addressed: a single venue's outage (factory paused, pool
drained, MEV builder censorship of one DEX) no longer flips the asset
to Illiquid as long as one other clone still meets the floor. **Zero
per-asset governance config** — pool discovery is on-chain via
`factory.getPool`.

### Configuration

| Parameter | Setter | Type | Default |
|---|---|---|---|
| Uniswap V3 factory | `setUniswapV3Factory(address)` | per-chain | zero (disabled) |
| PancakeSwap V3 factory | `setPancakeswapV3Factory(address)` | per-chain | zero (disabled) |
| SushiSwap V3 factory | `setSushiswapV3Factory(address)` | per-chain | zero (disabled) |
| Min liquidity floor | `MIN_LIQUIDITY_USD` constant | global | 1_000_000 × 1e6 ($1M USDC-scaled) |

Setting any factory to zero disables that leg of the OR; the check
collapses to whichever factories are configured.

## Frontend 0x-based pre-flight (Phase 7b.1, UX-only)

Before submitting `acceptOffer` / `createOffer` for ERC-20 collateral
pairs, the frontend posts the (collateral, principal, amount) tuple
to the existing `/quote/0x` Cloudflare Worker proxy and renders an
inline banner classifying the route as Liquid / Thin / No-route.
**This is purely a UX guard** — the on-chain attack surface remains
the V3-clone OR-logic. Anyone calling the diamond directly via
Etherscan bypasses the preflight and falls back on the contract gate.

## Chain matrix — recommended defaults

| Chain | Chainlink | UniV3 | PancakeV3 | SushiV3 | Tellor | API3 | DIA |
|---|---|---|---|---|---|---|---|
| Ethereum L1 | All majors | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Base | Major assets | ✓ | ✓ | (V2 only) | ✓ | ✓ | ✓ |
| Arbitrum | Major assets | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Optimism | Major assets | ✓ | (limited) | ✓ | ✓ | ✓ | ✓ |
| Polygon zkEVM | Limited | ✗ | ✓ | ✓ | (verify) | ✓ | (verify) |
| BNB Chain | Major assets | ✗ | ✓ | ✓ | (verify) | ✓ | ✓ |

Testnet chains: the recommended posture is "Chainlink only, all
secondaries left at zero" — exercises the primary path without
gating every testnet action on upstream oracle coverage.

## Verification

Pre-mainnet, every `(chain, asset)` pair in use must satisfy the
following via on-chain readback:

- `OracleFacet.getAssetPrice(asset)` returns a non-zero price (smoke).
- `OracleAdminFacet.getFeedOverride(feed)` matches the target override
  for feeds the policy tightens (high-value collateral).
- At least 2 of the 3 secondary oracles are configured (non-zero
  `getTellorOracle()` / `getApi3ServerV1()` / `getDIAOracleV2()`)
  on every chain that hosts loans. With < 2 secondaries configured
  the Soft 2-of-N quorum collapses to Chainlink-only (graceful
  fallback semantics) — operationally fine but loses the cross-
  provider redundancy that's the whole point of Phase 7b.2.
- `getSecondaryOracleMaxDeviationBps()` returns a reasonable value
  (500 = 5% default; tighten on stables to 100 = 1%).
- At least 2 of the 3 V3-clone factories are configured on every
  chain that hosts loans.

A Foundry test at `test/OraclePolicyReadback.t.sol` (to be written as
a follow-up alongside `GovernanceHandover.t.sol`) should drive these
readbacks against a forked target chain as a CI gate.

## What this policy does NOT cover

- **Multi-source simultaneous outage of every secondary.** If
  Tellor + API3 + DIA all fail to return data for the same asset
  in the same block, the Soft 2-of-N rule degrades to Chainlink-
  only by design (the "graceful fallback" branch). This is
  deliberate — over-eager fail-closed semantics would brick
  pricing on chains with sparse secondary coverage. Monitor
  off-chain for chronic secondary outages.
- **Multi-sig compromise of the Safe or Timelock.** Oracle-layer
  defences do not protect against governance-signer compromise. That
  risk is addressed by the Safe + Timelock + Guardian model
  documented in `GovernanceRunbook.md`.
- **A long-tail asset without either Chainlink coverage or any
  V3-clone pool.** Such assets are classified Illiquid and cannot
  back a loan. The Liquid / Illiquid split is the oracle layer's
  escape hatch for coverage gaps.
- **Symbol collision across chains** (e.g. `USDC` on Ethereum vs
  `USDC.e` on Arbitrum returning `USDC`). The symbol-derivation
  approach reads `IERC20.symbol()` and uses it verbatim — it does
  NOT resolve to a chain-specific canonical asset. If a wrapped
  variant returns the same symbol as the canonical, the upstream
  oracle's price for the canonical is what gets compared against,
  which is usually correct but can drift on bridged-asset incidents.
  Operators should track this in the Audit Intake / monitoring
  surface.
