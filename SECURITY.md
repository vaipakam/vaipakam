# Security

This document describes the security-critical *contracts* the Vaipakam protocol makes with its users, integrators, and operators — specifically, what the protocol guarantees and what it deliberately refuses to do when its price feeds or the underlying L2 sequencer are degraded.

For incident response procedures (who pages whom, when to pause, how to reconcile a zeroed chain), see [`docs/ops/IncidentRunbook.md`](docs/ops/IncidentRunbook.md). This document is the *specification* the runbook operationalises.

For admin-key custody, role custody, and the timelock that mediates privileged calls, see [`docs/ops/AdminKeysAndPause.md`](docs/ops/AdminKeysAndPause.md).

---

## Reporting a vulnerability

Email `security@vaipakam.xyz` (PGP key in repo root `security.asc`). Do **not** open a public GitHub issue.

We aim to acknowledge within 24h and provide a remediation ETA within 72h. In-scope:

- any facet under [`contracts/src/facets/`](contracts/src/facets/)
- the escrow implementation and Diamond proxy under [`contracts/src/`](contracts/src/)
- the swap adapters under [`contracts/src/adapters/`](contracts/src/adapters/) (Phase 7a `LibSwap` failover)
- the LayerZero OApp / OFT surface under [`contracts/src/token/`](contracts/src/token/) (`VPFIOFTAdapter`, `VPFIMirror`, `VPFIBuyAdapter`, `VPFIBuyReceiver`, `VaipakamRewardOApp`)
- the cross-chain reward mesh (`RewardReporterFacet`, `RewardAggregatorFacet`)
- the subgraph state-machine guard under [`ops/subgraph/`](ops/subgraph/)
- the Permit2 integration path (`LibPermit2`)

Out-of-scope: testnet configuration drift, known issues tracked in audit reports, anything requiring compromise of the admin multi-sig, and the public reference keeper bot in the sibling [`vaipakam-keeper-bot`](https://github.com/vaipakam/vaipakam-keeper-bot) repo (which holds no Diamond role and only submits permissionless `triggerLiquidation` calls — see [`docs/ops/AdminKeysAndPause.md`](docs/ops/AdminKeysAndPause.md) for why no role is granted).

---

## Oracle stack — price resolution contract

Vaipakam treats **Chainlink as the primary price source** and validates every read against a **Soft 2-of-N secondary quorum** across Tellor + API3 + DIA (Phase 7b.2). Every liquidity gate also validates v3-style concentrated-liquidity AMM pool depth, but depth alone never authorises a loan — a usable Chainlink-led price must exist first and must clear the secondary quorum where coverage exists.

### Price resolution order

`OracleFacet.getAssetPrice(asset)` runs `_primaryPrice` first, then enforces the secondary quorum. `_primaryPrice` resolves in this order and stops at the first successful branch:

1. **WETH short-circuit** — returns the ETH/USD feed answer directly. No registry lookup.
2. **asset/USD via Chainlink Feed Registry** — preferred. The registry, USD denominator, and ETH/USD feed are configured per chain by `ORACLE_ADMIN_ROLE` via [`OracleAdminFacet.setChainlinkRegistry`](contracts/src/facets/OracleAdminFacet.sol), `setUsdChainlinkDenominator`, and `setEthUsdFeed`. Chains that don't expose a Chainlink Feed Registry skip this branch.
3. **asset/ETH × ETH/USD fallback** — multiplied in 1e18-scaled math, with the same staleness rule applied to both legs.

If every branch reverts or no branch is registered, the call reverts `NoPriceFeed`. There is no default, no "last known good", and no centralised backstop. A loan that depends on an un-priceable asset cannot be initiated or liquidated.

After the primary read returns, the protocol enforces the Phase 7b.2 secondary quorum (see below) **before** the price is handed back to the caller.

### Staleness thresholds

Defined in [`contracts/src/libraries/LibVaipakam.sol`](contracts/src/libraries/LibVaipakam.sol):

| Constant | Value | Applies to |
|---|---|---|
| `ORACLE_VOLATILE_STALENESS` | 2 h | ETH, BTC, non-stable ERC20s |
| `ORACLE_STABLE_STALENESS` | 25 h | Feeds whose symbols appear in `VPFI_STABLE_FEED_SYMBOLS` *and* whose answer is within `ORACLE_PEG_TOLERANCE_BPS` of $1 |
| `ORACLE_PEG_TOLERANCE_BPS` | 300 (3%) | Peg-check band used to qualify a feed for the 25h window |

A stable feed whose answer drifts outside the 3% band is **demoted** to the 2h window on that read — it does not retain the relaxed threshold just because it is tagged stable. This is the defence against a depeg being masked by a long heartbeat.

Any read past its applicable staleness window reverts `StalePrice`. Callers do not receive a degraded price.

### Per-feed overrides

`ORACLE_ADMIN_ROLE` may tighten staleness or set a minimum-valid-answer floor for a specific Chainlink aggregator via `OracleAdminFacet.setFeedOverride(feed, maxStaleness, minValidAnswer)`. A configured override takes precedence over the global volatile / stable defaults. Setting `maxStaleness = 0` clears the override. Overrides can only make a feed *stricter*, never more permissive.

---

## Secondary oracle quorum — Soft 2-of-N (Phase 7b.2)

Chainlink alone is not enough to manipulate prices into Vaipakam's liquidation gate. Phase 7b.2 added a **Soft 2-of-N decision rule** across three independent secondaries. To push a fake price through the gate, an attacker now must compromise **Chainlink plus every secondary that has data for the asset in the same block**.

### Sources

| Source | Interface | Lookup key | Configured via |
|---|---|---|---|
| **Tellor** | [`ITellor`](contracts/src/interfaces/ITellor.sol) | `keccak256(SpotPrice + symbol + "usd")` derived on-chain | `OracleAdminFacet.setTellorOracle` |
| **API3** | [`IApi3ServerV1`](contracts/src/interfaces/IApi3ServerV1.sol) | symbol-derived dAPI hash | `OracleAdminFacet.setApi3ServerV1` |
| **DIA** | [`IDIAOracleV2`](contracts/src/interfaces/IDIAOracleV2.sol) | `symbol/USD` string key | `OracleAdminFacet.setDIAOracleV2` |

Lookup keys are derived from `IERC20.symbol()` on-chain. Adding a new collateral asset requires **no per-asset secondary-oracle governance write** — this is deliberate. Pyth was retired in Phase 7b.2 because its per-asset `priceId` mapping conflicts with that no-config policy.

### Decision rule

For each read, the aggregator probes each secondary and classifies it:

- **Unavailable** — secondary not configured, no data for the symbol, or stale beyond `secondaryOracleMaxStaleness`
- **Agree** — secondary returned data within `secondaryOracleMaxDeviationBps` of the Chainlink price
- **Disagree** — secondary returned data outside the deviation band

Outcome:

- if **every** secondary is Unavailable → Chainlink-only is accepted (graceful fallback for sparse coverage)
- if **at least one** secondary Agrees → Chainlink + agreeing-secondary quorum is accepted
- if one or more secondaries Disagree and **none** Agree → revert `OraclePriceDivergence`

`secondaryOracleMaxDeviationBps` and `secondaryOracleMaxStaleness` are configured by `ORACLE_ADMIN_ROLE` via the corresponding setters. The defaults assume a tight band; any relaxation is a deliberate governance act.

This rule deliberately fails open on coverage gaps but fails closed on contradiction. `SecondaryQuorumTest.t.sol` enforces the semantics.

---

## Sequencer fallback — L2 liveness contract

On every L2 deployment (Base, Arbitrum, Optimism, Polygon zkEVM …) the Chainlink L2 Sequencer Uptime Feed is registered at deploy time via `OracleAdminFacet.setSequencerUptimeFeed`. The protocol treats this feed as authoritative for whether the underlying rollup can fairly process transactions.

### Circuit-breaker semantics

The sequencer check reads Chainlink's L2 sequencer uptime feed with `SEQUENCER_GRACE_PERIOD = 3600` (1 h). A sequencer is considered healthy iff:

1. The feed's latest `answer` is `0` (sequencer up), **and**
2. `block.timestamp - startedAt >= SEQUENCER_GRACE_PERIOD` (at least 1h has passed since it came back up).

Otherwise the sequencer is considered **unhealthy**. Two code paths consume this signal with different failure modes:

#### Path A — `_requireSequencerHealthy()` (reverting)

Invoked by `OracleFacet.getAssetPrice` and by external callers that must have a price to proceed. On an unhealthy sequencer it reverts one of:

- `SequencerDown` — feed answer is nonzero.
- `SequencerGracePeriod` — feed just came back but has not cleared the 1h grace window.

Consequence: no price → no new loan initiation, no HF read, no LTV check. [`RiskFacet.triggerLiquidation`](contracts/src/facets/RiskFacet.sol) and [`DefaultedFacet.triggerDefault`](contracts/src/facets/DefaultedFacet.sol) additionally call `sequencerHealthy()` *before* attempting any price-dependent work and revert `SequencerUnhealthy` if it returns false — this blocks both liquidation paths during the outage.

#### Path B — `_sequencerHealthy()` / `checkLiquidity` (fail-closed, non-reverting)

Invoked by classification helpers that must return an answer even when the sequencer is down. On an unhealthy sequencer these return "illiquid" / "unhealthy" deterministically — they never throw and they never return a permissive result.

Consequence: a caller asking "can this asset be used as liquid collateral?" during an outage receives "no". A new loan with that asset as collateral cannot be initiated; the borrower must wait for the sequencer to clear its grace window, or use an asset the protocol treats as illiquid (which has its own explicit-consent flow — see below).

### What users can and cannot do during a sequencer outage

| Action | Status during outage | Why |
|---|---|---|
| Repay a loan (full or partial) | **Allowed** | Repayment does not require `getAssetPrice` for the repaid asset — the debt amount is denominated at loan origination. Borrowers must be able to reduce their exposure while prices are untrusted. |
| Initiate a new loan with liquid collateral | Blocked | HF calculation requires a live price; `checkLiquidity` fail-closes. |
| Initiate a new loan with **illiquid** collateral | Allowed | Illiquid assets are valued at $0 and already require explicit consent from both parties — the sequencer feed is irrelevant. |
| HF-based liquidation (`RiskFacet.triggerLiquidation`) | Blocked — reverts `SequencerUnhealthy` | Liquidating on a stale HF is the attack we are defending against. |
| Time-based default (`DefaultedFacet.triggerDefault`) | Blocked — reverts `SequencerUnhealthy` | Same reasoning. Grace periods are paused in effect. |
| Claim interaction rewards | Unaffected | Reward math is historical, not price-dependent. |
| Read views (subgraph, frontend dashboards) | Unaffected | Reads are best-effort; frontend surfaces a degraded banner but does not block navigation. |

### Why the protocol does *not* pause on a sequencer outage

A protocol-wide pause would block **repayment** — which is exactly what borrowers need to do during the outage to reduce exposure. The fail-closed sequencer gate already blocks every price-dependent write (new loans, liquidations, defaults) without blocking repayment. Pausing on top of that would punish users for an infrastructure event they did not cause.

See [`docs/ops/IncidentRunbook.md` §3.1](docs/ops/IncidentRunbook.md#what-does-not-require-an-emergency-pause) ("What does NOT require an emergency pause") for the on-call procedure. An L2 sequencer outage is a page-for-visibility, not a page-to-act.

---

## Liquidity classification — depth gate

Beyond a live Chainlink-led price, an asset is only eligible as *liquid* collateral if at least one configured v3-style concentrated-liquidity AMM `asset/WETH` pool reports at least `MIN_LIQUIDITY_USD = $1,000,000` of WETH-side depth (converted via ETH/USD) at one of the configured fee tiers.

### Multi-clone OR-logic (Phase 7b.1)

The check OR-combines the configured V3-clone factory set:

- **Uniswap V3** — set via `OracleAdminFacet.setUniswapV3Factory`
- **PancakeSwap V3** — set via `OracleAdminFacet.setPancakeswapV3Factory`
- **SushiSwap V3** — set via `OracleAdminFacet.setSushiswapV3Factory`

across multiple fee tiers (`500 / 3000 / 10000 bps`). One sufficiently deep pool on **any** clone at **any** fee tier is enough. Every probe is a runtime `factory.getPool(asset, WETH, fee)` call followed by a live reserves read; nothing is cached.

`OracleLiquidityORTest.t.sol` enforces this OR-semantic.

### Fail-closed semantics

- Assets with a price feed but insufficient pool depth fail-close to *illiquid*.
- Illiquid assets cannot be force-liquidated through the swap path; on default they are transferred directly to the lender, and both parties must have explicitly consented to the illiquid-path offer via the combined risk acknowledgement.

An asset that was liquid yesterday can become illiquid today if every eligible LP withdraws — and the protocol will correctly refuse to price-based-liquidate a loan whose collateral has degraded, even if the feed is still live.

---

## Liquidation execution — swap failover and slippage cap (Phase 7a)

When a liquid-collateral loan crosses its risk threshold, liquidation runs through a **four-DEX failover pipeline** rather than a single venue. The caller (keeper or frontend) supplies a **ranked** `AdapterCall[]` try-list; `LibSwap.swapWithFailover` iterates it.

### Adapter set

| Adapter | Source | Notes |
|---|---|---|
| `ZeroExAggregatorAdapter` | 0x Settler v2 | calldata signed server-side via the operator's quote proxy |
| `OneInchAggregatorAdapter` | 1inch v6 | same proxy pattern |
| `UniV3Adapter` | Uniswap V3 | direct on-chain swap, `amountOutMinimum` enforced natively |
| `BalancerV2Adapter` | Balancer V2 | subgraph-discovered pool, vault swap, `limit` enforced natively |

Mainnet deployments must register at least one adapter via `AdminFacet.addSwapAdapter` before any value flows. Zero-adapter deployments revert every swap-based liquidation, automatically reaching the documented in-kind fallback path.

### Per-attempt safety

For each ranked attempt:

1. ERC-20 approval is set to **exactly** the input amount needed (no unlimited approvals)
2. the adapter call is wrapped in try/catch
3. approval is **revoked** after the attempt, regardless of success or failure
4. the protocol enforces `realizedOut ≥ minOutputAmount` via balance-delta on the aggregator path or the DEX-native min-out floor on the direct path

The first adapter that meets the floor commits and returns realized proceeds. Total failure (every adapter reverts or under-fills) routes the loan to `FallbackPending` and emits `SwapAllAdaptersFailed`.

### Caller insulation invariant

The keeper picks routes; the keeper **cannot** weaken the slippage cap. `minOutputAmount` is computed by the protocol from the oracle-derived expected output minus the configured slippage budget, and passed to every adapter unmodified. `LiquidationMinOutputInvariant.t.sol` asserts this with `vm.expectCall` on exact calldata across a 1,000-address fuzz of liquidator identities. Any regression that lets a caller influence the floor fails the test.

### Slippage and incentive ceiling

Successful liquidations follow a bounded execution model:

- `realized_slippage% + liquidator_incentive% = MAX_LIQUIDATION_SLIPPAGE_BPS` (default `6%`)
- `liquidator_incentive ≤ MAX_LIQUIDATOR_INCENTIVE_BPS` (`3%`)
- treasury receives an additional `LIQUIDATION_HANDLING_BPS` (`2%`) — separate from the Yield Fee on recovered interest

The `6%` ceiling is governance-configurable within an audited bounded range; the frontend reads the live value rather than hard-coding `6%`.

### Abnormal-market fallback

If every adapter under-fills or reverts (slippage > 6%, liquidity disappears, every venue breaks), the protocol stops trying to convert and routes to `FallbackPending`. This is a **state transition, not a revert**. Full collateral remains held in the Diamond until lender claim. While in `FallbackPending`, the borrower may still cure by full repayment or by adding collateral until lender claim execution begins. See [`docs/MEVProtection.md`](docs/MEVProtection.md) for the complete flow.

---

## Cross-chain security — LayerZero hardening

Vaipakam ships five LayerZero contracts under [`contracts/src/token/`](contracts/src/token/): `VPFIOFTAdapter`, `VPFIMirror`, `VPFIBuyAdapter`, `VPFIBuyReceiver`, and `VaipakamRewardOApp`. The April 2026 cross-chain bridge incident demonstrated that the LayerZero default 1-required / 0-optional DVN configuration is an exploitable single point of trust. Mainnet Vaipakam deployments **must not** ship that default.

### DVN policy (mainnet-deploy gate)

| Field | Required value |
|---|---|
| Required DVN count | **3** |
| Optional DVN count | **2** |
| Optional threshold | **1-of-2** |
| Required DVN set | LayerZero Labs + Google Cloud + (Polyhedra or Nethermind) |
| Optional DVN set | BWare Labs + (Stargate Labs or Horizen Labs) |

Operator diversity is load-bearing — different corporate operators, different infrastructure providers (not all on the same cloud). An attacker must compromise all 3 required DVNs and at least one of the 2 optionals to land a forged message — a minimum of 4 independent verifier compromises.

### Confirmations

| Chain | Confirmations | Wall-clock wait |
|---|---:|---:|
| Ethereum mainnet | 15 | ~3 min |
| Base | 10 | ~20 sec |
| Optimism | 10 | ~20 sec |
| Arbitrum | 10 | ~10 sec |
| Polygon zkEVM | 20 | ~1 min |
| BNB Chain | 15 | ~45 sec |

Higher numbers are acceptable; lower numbers require an audited rationale. Polygon PoS is **out of Phase 1 scope** (weaker bridge trust). Solana is out of scope for all phases until further notice.

### Adapter-layer rate limits

`VPFIBuyAdapter` ships with defence-in-depth caps tracked in storage and enforced before LayerZero send:

- per-request: `50,000 VPFI`
- 24-hour rolling: `500,000 VPFI`

Both are governance-tunable. Defaults are `type(uint256).max` (disabled) at deploy time; mainnet deploys must invoke `VPFIBuyAdapter.setRateLimits(50_000e18, 500_000e18)` before routing real value.

### Mainnet deploy gate

Before any value flows through cross-chain VPFI or buy paths, all of the below must be true:

1. `ConfigureLZConfig.s.sol` has run against every (OApp, eid) pair — sets DVNs, confirmations, libraries, and enforced options
2. `VPFIBuyAdapter.setRateLimits(50_000e18, 500_000e18)` has been called
3. `LZConfig.t.sol` passes — it asserts every OApp × eid reflects the policy, and fails the build otherwise

### Pause surface

Every LZ-facing contract exposes owner-gated `pause()` / `unpause()` on both send and receive paths. The 46-minute pause during the April 2026 incident blocked ~$200M of follow-up drain — that's the precedent. Pause authority on bridge contracts allows the Guardian Safe to act fast; unpause stays on the Owner / Timelock.

---

## State-machine invariants

The protocol enforces one terminal-state invariant for loans, checked both on-chain (by construction — there is no code path that transitions a terminal status) and off-chain by a dedicated subgraph ([`ops/subgraph/`](ops/subgraph/)) that flags any observed violation and increments a global `DriftStats.invalidTransitions` counter.

```
  Unknown ──▶ Active ──┬─▶ Repaid     (terminal)
                       ├─▶ Defaulted  (terminal)
                       ├─▶ Liquidated (terminal)
                       └─▶ FallbackPending ──┬─▶ Repaid
                                             ├─▶ Defaulted
                                             └─▶ Liquidated
```

The Tenderly alert stack ([`ops/tenderly/`](ops/tenderly/)) polls `invalidTransitions` and pages P0 on any increment. A non-zero value means either a contract bug or an indexer/contract drift — both require immediate investigation.

---

## Admin surface and timelock

All facet-level admin setters (`OracleAdminFacet.*`, `AdminFacet.*`, `EscrowFactoryFacet` upgrade controls, `RiskFacet.updateRiskParams`, role grants) are gated by named roles on [`LibAccessControl`](contracts/src/libraries/LibAccessControl.sol). Post-handover, the slow-admin roles (`ADMIN_ROLE`, `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `ESCROW_ADMIN_ROLE`) are held exclusively by a [`TimelockController`](contracts/script/DeployTimelock.s.sol) with a **48h minimum delay**.

The intentional exceptions, both on the Ops Safe (Guardian) hot multi-sig:

- `KYC_ADMIN_ROLE` — KYC tier bumps are an operational same-hour action; not a fit for a 48h delay
- `PAUSER_ROLE` — pausing is fast by design; the live exploit case is exactly the one a 48h delay would defeat

Unpause is timelocked (it represents the "we are confident the issue is fixed" decision, and should be deliberate).

See [`contracts/script/TransferAdminToTimelock.s.sol`](contracts/script/TransferAdminToTimelock.s.sol) for the handover script, [`docs/ops/AdminKeysAndPause.md`](docs/ops/AdminKeysAndPause.md) for the full role-by-role custody matrix, and [`docs/GovernanceRunbook.md`](docs/GovernanceRunbook.md) for the day-to-day procedures (including the contract-change → public keeper-bot ABI sync workflow).

### Permissionless callers vs. role-gated admins

Liquidation (`RiskFacet.triggerLiquidation`) and time-based default (`DefaultedFacet.triggerDefault`) are **permissionless** — by design. The operator's hf-watcher Cloudflare Worker and the public reference keeper bot in the sibling [`vaipakam-keeper-bot`](https://github.com/vaipakam/vaipakam-keeper-bot) repo both submit these calls from hot keys that hold zero on-chain authority. **No Diamond role is granted to keeper-bot operators**, and none should be: a keeper that needed an admin role would be a structural hazard.

---

## Audit and scope

This repository has been reviewed internally. External audit status is tracked in [`docs/audit/`](docs/audit/). Scope for any external review should include:

- Diamond fallback routing and selector uniqueness
- `OracleFacet` staleness, sequencer, and Phase 7b.2 secondary-quorum logic (this document is the spec)
- `OracleAdminFacet` per-feed override semantics (`setFeedOverride` cannot loosen, only tighten)
- Phase 7b.1 multi-clone V3 liquidity OR-logic (`OracleLiquidityORTest` is the spec)
- Phase 7a `LibSwap` swap-failover, including caller insulation on `minOutputAmount` and adapter approval scoping
- Per-user escrow proxy deployment, mandatory upgrade gating, and the storage append-only invariant
- LayerZero OApp surface: peer authentication, DVN configuration readback, replay protection, and the cross-chain reward mesh finalisation
- `VPFIBuyAdapter` rate limits and the `VPFIOFTAdapter` global cap enforcement on bridged supply
- Phase 5 borrower LIF custody (`LibVPFIDiscount.settleBorrowerLifProper` / `forfeitBorrowerLif`) — the held VPFI must never leak through any terminal path
- Phase 6 keeper per-action authorization (lender-side vs borrower-side scoping)
- Permit2 integration (signature replay protection, deadline enforcement, exact scope)
- Role separation under the post-handover timelock; `DeployerZeroRolesTest` enforces the cutover invariant

Out-of-scope by design: frontend code, The Graph indexer logic (which is a *monitor*, not a source of truth), Tenderly alert wiring, the public reference keeper bot in the sibling `vaipakam-keeper-bot` repo (it holds no Diamond role), and Cloudflare Worker quote-proxy infrastructure under [`ops/hf-watcher/`](ops/hf-watcher/).

For the wider MEV threat model and the role of permissionless liquidation in the protocol's safety story, see [`docs/MEVProtection.md`](docs/MEVProtection.md). For the oracle policy in operational depth (per-feed overrides, secondary quorum thresholds, supported chains), see [`docs/OraclePolicy.md`](docs/OraclePolicy.md).
