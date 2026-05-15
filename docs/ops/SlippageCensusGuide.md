# Slippage Census — Operator Guide

This guide explains how to run the per-chain slippage census required
by [`MarketRateWidgetAndDepthTieredLTV.md`](DesignsAndPlans/MarketRateWidgetAndDepthTieredLTV.md)
§4.4 step 6 — the gate before flipping `depthTieredLtvEnabled` on any
chain. The census tool is
[`contracts/script/SlippageCensus.s.sol`](../contracts/script/SlippageCensus.s.sol);
this doc covers what to run, when to run it, how to interpret the
output, and what the audit + risk committee will expect.

## What the census measures

For each asset on the list, the script queries the deployed Diamond's
on-chain views and reports three numbers:

| Column                 | What it means                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`checkLiquidity`**   | The post-§4.4-step-3 binary base gate: `Liquid` iff at least one route (PAA × V3-or-V2 venue × fee ≤ 0.3%) clears `cfgFloorSizePad` at ≤ `cfgLiquiditySlippageBps`.     |
| **`onChainTier`**      | `0..3` per `OracleFacet.getLiquidityTier`. The on-chain ceiling. `0` = the asset couldn't even clear the floor — the route-search machinery agrees with `Illiquid`.    |
| **`effectiveTier`**    | `min(onChainTier, keeperTier)` per `getEffectiveLiquidityTier`. This is the tier `LoanFacet._checkInitialLtvAndHf` actually consults when `depthTieredLtvEnabled` is on. The `keeperTier` defaults to `1` until the off-chain liquidity-confidence relay promotes it; so on a freshly-deployed chain `effectiveTier <= 1` for every asset until the relay has been running. |

The on-chain ceiling and the effective tier diverge on purpose: a deep
asset can sit at `onChainTier=3` while `effectiveTier=1` because the
relay hasn't yet accumulated enough aggregator-confirmed slippage
evidence to promote. That's the no-keeper baseline — exactly equivalent
to today's HF≥1.5 init gate. Flipping `depthTieredLtvEnabled` without
the relay running first would leave every asset effectively pinned at
Tier 1, which is safe but defeats the whole point of the upgrade.

## When to run it

Three checkpoints, all before the chain goes live with the new init
gate:

1. **Post-deploy snapshot** — run immediately after the new contracts
   (§4.4 step 4) are diamond-cut into the chain's Diamond. The
   `onChainTier` column shows what the new check sees natively at that
   moment. Expectation: stablecoins and blue-chip ERC20s on
   `onChainTier=3`; long-tail tokens mostly `0..1`. Any blue-chip
   landing below `2` is a red flag — investigate the per-venue route
   search before continuing.

2. **Post-relay-bake snapshot** — re-run after the apps/keeper
   liquidity-confidence relay (§4.4 step 5) has been running for at
   least the `LIQ_CONFIDENCE_MIN_WINDOW_DAYS` window with
   `LIQ_CONFIDENCE_MIN_CHECKS` confirmations accumulated. The
   `effectiveTier` column should now reflect aggregator-confirmed
   promotions. Compare against snapshot 1 to see which assets the
   relay has actually promoted.

3. **Pre-flip rehearsal** — run one more time right before
   `setDepthTieredLtvEnabled(true)` on this chain. Snapshot is the
   audit artifact: it documents the exact pre-flip state of the
   protocol and lets a reviewer reproduce.

Repeat per chain. The output is grep-able + CSV-friendly so a single
run can be appended to a per-chain census log indefinitely.

## How to run

The tool is invoked via `forge script` against the chain's RPC. The
asset list is resolved in this priority order:

1. **`CENSUS_ASSETS` env var (operator override)** — comma-separated
   list. Use this for one-off audits / pre-flip rehearsals against a
   narrowed list, or when CI needs an explicit fixture.
2. **`contracts/script/SlippageCensus.assets.json` (per-chain default)** —
   looked up by `chain_<block.chainid>_assets`. This is what a routine
   `forge script` invocation reads when `CENSUS_ASSETS` is unset, so
   operators don't copy-paste addresses every run.

Env vars:

| Env var               | Required? | Description                                                                                                                         |
| --------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DIAMOND_ADDRESS`     | yes       | The deployed Vaipakam diamond on the chain.                                                                                         |
| `CENSUS_ASSETS`       | no        | Comma-separated list of asset addresses (0x-prefixed, no whitespace). When set, overrides the per-chain default JSON.               |
| `CENSUS_LABEL`        | no        | A free-form tag written to each row — useful for timestamping / contextualising the snapshot.                                       |
| `CENSUS_ASSETS_JSON`  | no        | Override path to the default-list JSON. Defaults to `script/SlippageCensus.assets.json`.                                            |

```bash
# Routine run — uses the per-chain default list from
# contracts/script/SlippageCensus.assets.json (no asset addresses
# pasted into the command line):
DIAMOND_ADDRESS=0x... \
CENSUS_LABEL=2026-05-14-base-post-deploy \
  forge script \
    contracts/script/SlippageCensus.s.sol:SlippageCensus \
    --rpc-url $RPC_BASE \
    -vvv

# Operator-override run — narrow asset list for a one-off audit:
DIAMOND_ADDRESS=0x... \
CENSUS_ASSETS=0xUSDC...,0xUSDT...,0xWBTC...,0xLINK... \
CENSUS_LABEL=2026-05-14-base-pre-flip-rehearsal \
  forge script \
    contracts/script/SlippageCensus.s.sol:SlippageCensus \
    --rpc-url $RPC_BASE \
    -vvv
```

The output goes to stdout. Filter to CSV via:

```bash
... | grep ^CENSUS, > census-base-sepolia-2026-05-14.csv
```

The first `CENSUS,...` line is a header row, so the resulting CSV
opens cleanly in a spreadsheet.

## Per-chain default asset lists

These are the starter lists, mirrored from
[`contracts/script/SlippageCensus.assets.json`](../contracts/script/SlippageCensus.assets.json)
— the JSON is the canonical source the census script reads when
`CENSUS_ASSETS` is unset. Keep this doc and the JSON in sync; the
script does not consult this doc. Add to both per chain as new assets
land on the protocol; do NOT remove items even if they classify
Illiquid — the per-row `Illiquid` is itself the data the audit needs
(it confirms the gate is doing its job).

The addresses come from each chain's canonical / bridged token list.
Verify each address against a block explorer + the chain's bridge
contracts list before pasting; an attacker-deployed mock token that
returns the right symbol would otherwise be census-able just like the
real one (the tool intentionally doesn't validate provenance — that's
operator responsibility).

### Ethereum mainnet (chainId 1)

- USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- USDT: `0xdAC17F958D2ee523a2206206994597C13D831ec7`
- WBTC: `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599`
- DAI:  `0x6B175474E89094C44Da98b954EedeAC495271d0F`
- LINK: `0x514910771AF9Ca656af840dff83E8264EcF986CA`
- AAVE: `0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9`
- UNI:  `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984`
- PEPE: `0x6982508145454Ce325dDbE47a25d4ec3d2311933`
- SHIB: `0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE`

### Base mainnet (chainId 8453)

- USDC (native): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- USDbC (bridged): `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`
- cbETH: `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22`
- cbBTC: `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`
- WETH:  `0x4200000000000000000000000000000000000006`

### Arbitrum (chainId 42161)

- USDC.e (bridged): `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`
- USDC (native):    `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- USDT:             `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`
- WBTC:             `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f`
- ARB:              `0x912CE59144191C1204E64559FE8253a0e49E6548`
- LINK:             `0xf97f4df75117a78c1A5a0DBb814Af92458539FB4`

### Optimism (chainId 10)

- USDC (native): `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`
- USDC.e:        `0x7F5c764cBc14f9669B88837ca1490cCa17c31607`
- USDT:          `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58`
- WBTC:          `0x68f180fcCe6836688e9084f035309E29Bf0A2095`
- OP:            `0x4200000000000000000000000000000000000042`

### Polygon zkEVM (chainId 1101)

- USDC (bridged): `0xA8CE8aee21bC2A48a5EF670afCc9274C7bbbC035`
- USDT (bridged): `0x1E4a5963aBFD975d8c9021ce480b42188849D41d`
- WETH (canonical): `0x4F9A0e7FD2Bf6067db6994CF12E4495Df938E6e9`
- WBTC (bridged): `0xEA034fb02eB1808C2cc3adbC15f447B93CbE08e1`

### BNB Chain (chainId 56)

- USDC: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- USDT: `0x55d398326f99059fF775485246999027B3197955`
- BTCB: `0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c`
- ETH (bridged WETH9): `0x2170Ed0880ac9A755fd29B2688956BD959F933F8`
- CAKE: `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82`

Testnets reuse a small subset (the per-chain test deploys' mock USDC +
WETH); see `contracts/deployments/<chain-slug>/addresses.json` for the
actual addresses on the testnet you're running against.

## Interpreting the output

A single row looks like:

```
CENSUS,2026-05-14-base,8453,0xA0b8...eB48,USDC,Liquid,3,3
```

Reading left to right:

- `CENSUS` — the line prefix.
- `2026-05-14-base` — the operator-supplied `CENSUS_LABEL`.
- `8453` — the chain ID.
- `0xA0b8...eB48` — the asset address (full address, abbreviated here).
- `USDC` — the asset's `symbol()` (best-effort, `?` on a non-conformant token).
- `Liquid` — `checkLiquidity` returns `Liquid` (the post-step-3 base gate passed).
- `3` — `onChainTier` is `3` (the route search cleared the $5M test size at ≤ 2% slippage).
- `3` — `effectiveTier` is `3` (the keeper relay has promoted this asset to the on-chain ceiling).

Three rows worth flagging as anomalies:

1. **`Liquid` + `onChainTier=0`** — the base gate passed but the tier
   resolution returned 0. Should be impossible (`getLiquidityTier`'s
   internal `_checkLiquidity` early-exit covers this). If you see it,
   investigate before flipping the switch — the on-chain views
   disagree, which means a routing edge case slipped through.

2. **`Liquid` + `onChainTier=N` + `effectiveTier < N`** — the keeper
   relay hasn't promoted this asset to its on-chain ceiling yet.
   Either expected (early in the bake) or a sign the relay isn't
   running. Cross-check the relay's keeper-side logs.

3. **`Illiquid` + `onChainTier=0` + `effectiveTier=0`** — both gates
   agree the asset isn't tradable at the floor size. This is the
   correct outcome for a thin / mislabeled / manipulated asset. The
   widget will route the user to the manual Create Offer flow; loan
   creation against this asset as collateral is blocked until depth
   improves on at least one configured venue.

A row with one or more `?` columns means the underlying contract call
reverted — the `try/catch` around each view keeps the census moving
but flags the asset for follow-up. Common causes: the asset has no
Chainlink price oracle on this chain, the asset is `address(0)`, or
the asset contract isn't actually deployed at the supplied address.

## What the audit consumes

The audit package gets three artifacts per chain:

1. **Post-deploy CSV** (snapshot 1 above).
2. **Post-bake CSV** (snapshot 2). Diff against snapshot 1 to show
   which assets the relay promoted, and how long the promotion took.
3. **Pre-flip CSV** (snapshot 3). The authoritative "this is what the
   chain looked like at the moment we flipped `depthTieredLtvEnabled`".

Plus the corresponding keeper relay logs covering the bake window. The
risk committee signs off chain-by-chain on the proposed
`tierMaxInitLtvBps` values + the flip itself; nothing about the flip
is automated.

## Pitfalls

- **Don't run against the wrong Diamond.** The script accepts the
  Diamond address verbatim from the env var — there's no sanity check
  that it points at the canonical retail deploy on this chain. If your
  `DIAMOND_ADDRESS` is a stale testnet diamond or an unrelated
  proxy, the output is meaningless.
- **Don't truncate the asset list.** A short list misses the long-tail
  flagging that the audit cares about; "no Illiquid rows" usually
  means the operator forgot to add the long-tail tokens, not that
  every asset is healthy.
- **Don't run against an unforked mainnet before the contracts are
  deployed.** The script calls `OracleFacet` views on the supplied
  Diamond; if the Diamond isn't there yet, every row returns `?`.
  For pre-deploy capacity planning, run the **mainnet-fork variant**
  documented below.

## Pre-deploy variant (mainnet-fork census)

For pre-deploy capacity planning — "what would the autonomous tier-LTV
cache settle to on this chain RIGHT NOW, given current Aave / Compound
configs at this block?" — use
[`contracts/script/SlippageCensusPreDeploy.s.sol`](../contracts/script/SlippageCensusPreDeploy.s.sol)
instead. It forks the chain via `--fork-url`, deploys a minimal
Diamond into the fork (no real funds, no real deployment — fork state
is discarded when the script exits), wires the peer-protocol addresses
+ per-tier reference assets from
[`contracts/script/SlippageCensus.chains.json`](../contracts/script/SlippageCensus.chains.json),
calls `refreshTierLtvCache()` to populate the cache from the LIVE
peer state at the fork block, and reports per-tier cache values.

Env vars:

| Env var               | Required? | Description                                                                       |
| --------------------- | --------- | --------------------------------------------------------------------------------- |
| `CHAINS_JSON_PATH`    | no        | Override path to the chains JSON. Defaults to `script/SlippageCensus.chains.json`. |
| `CENSUS_LABEL`        | no        | Free-form tag written to each output row.                                         |

```bash
# Example: Ethereum mainnet pre-deploy census against the latest
# block. No DIAMOND_ADDRESS needed — the script deploys its own.
CENSUS_LABEL=2026-05-14-eth-pre-deploy \
  forge script \
    contracts/script/SlippageCensusPreDeploy.s.sol:SlippageCensusPreDeploy \
    --rpc-url $RPC_ETH \
    -vvv

# Pipe to CSV:
... | grep ^CENSUS_PRE, > census-pre-eth-2026-05-14.csv
... | grep ^CENSUS_PRE_PEERS, > census-pre-eth-2026-05-14-peers.csv
```

Output rows (`CENSUS_PRE,` prefix):

```
CENSUS_PRE,<label>,<chainId>,<tier>,<refAssetCount>,<cachedLtvBps>,<effectiveLtvBps>,<libraryDefaultBps>
```

A separate `CENSUS_PRE_PEERS,` row echoes the per-chain peer addresses
the script used, for the audit-package per-chain verification step.

What to look for in the output:

- **`cachedLtvBps > 0`** — the refresh accepted the per-tier
  consensus reading. `effectiveLtvBps` will equal `cachedLtvBps`.
- **`cachedLtvBps = 0` but `effectiveLtvBps > 0`** — the refresh
  rejected the candidate (out-of-band, insufficient readings, or no
  reference assets); the loan-init gate would fall back to the
  library default. Investigate via the `TierLtvCacheRefreshRejected`
  event the refresh emitted to determine which rejection reason
  applied.
- **`effectiveLtvBps == libraryDefaultBps`** for every tier — the
  cache is either rejected or empty; on a fresh deploy, this is
  the expected pre-refresh state.

Pitfalls (in addition to the post-deploy variant's):

- **The peer addresses in `SlippageCensus.chains.json` must be
  verified against each peer's official docs before the audit
  consumes the output.** Out-of-date peer addresses produce
  "no readings" (the per-asset consensus check fails when no peer
  reports) — not garbage data, but a wasted refresh.
- **The mainnet-fork variant produces a SNAPSHOT** at the fork's
  block. If you need a multi-block / time-averaged view, re-run
  against several recent blocks via `--fork-block-number`.
- **The script does not `--broadcast`**. It's pure-simulation
  against a fork; broadcasting these txs to a real chain would
  leak a half-configured Diamond with no governance owner-recovery
  path.
