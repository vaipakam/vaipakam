# Security

This document describes the security-critical *contracts* the Vaipakam protocol makes with its users, integrators, and operators — specifically, what the protocol guarantees and what it deliberately refuses to do when its price feeds or the underlying L2 sequencer are degraded.

For incident response procedures (who pages whom, when to pause, how to reconcile a zeroed chain), see [`docs/ops/IncidentRunbook.md`](docs/ops/IncidentRunbook.md). This document is the *specification* the runbook operationalises.

For admin-key custody, role custody, and the timelock that mediates privileged calls, see [`docs/ops/AdminKeysAndPause.md`](docs/ops/AdminKeysAndPause.md).

---

## Reporting a vulnerability

Email `security@vaipakam.xyz` (PGP key in repo root `security.asc`). Do **not** open a public GitHub issue.

We aim to acknowledge within 24h and provide a remediation ETA within 72h. In-scope: any facet under [`contracts/src/facets/`](contracts/src/facets/), the escrow implementation under [`contracts/src/`](contracts/src/), the reward OApp, and the subgraph state-machine guard. Out-of-scope: testnet configuration drift, known issues tracked in audit reports, and anything requiring compromise of the admin multi-sig.

---

## Oracle fallback — price resolution contract

Vaipakam uses Chainlink as its *only* trusted price source. Every liquidity gate also validates v3-style concentrated-liquidity AMM pool depth, but depth alone never authorises a loan — a usable Chainlink price must exist first.

### Price resolution order

`OracleFacet.getAssetPrice(token)` resolves in this order and stops at the first successful branch:

1. **WETH short-circuit** — returns the ETH/USD feed answer directly. No registry lookup.
2. **asset/USD via Feed Registry** — mainnet-only. On chains without a registry, this branch is skipped.
3. **Per-asset USD override** — set by `ORACLE_ADMIN_ROLE` via `OracleAdminFacet.setAssetUsdFeed`. Required on every L2 deployment.
4. **asset/ETH × ETH/USD fallback** — multiplied in 1e18-scaled math, same staleness rules applied to both legs.

If every branch reverts or no branch is registered, the call reverts `NoPriceFeedAvailable`. There is no default, no "last known good", and no centralised backstop. A loan that depends on an un-priceable asset cannot be initiated or liquidated.

### Staleness thresholds

Defined in [`contracts/src/libraries/LibVaipakam.sol`](contracts/src/libraries/LibVaipakam.sol):

| Constant | Value | Applies to |
|---|---|---|
| `ORACLE_VOLATILE_STALENESS` | 2 h | ETH, BTC, non-stable ERC20s |
| `ORACLE_STABLE_STALENESS` | 25 h | Feeds whose symbols appear in `VPFI_STABLE_FEED_SYMBOLS` *and* whose answer is within `ORACLE_PEG_TOLERANCE_BPS` of $1 |
| `ORACLE_PEG_TOLERANCE_BPS` | 300 (3%) | Peg-check band used to qualify a feed for the 25h window |

A stable feed whose answer drifts outside the 3% band is **demoted** to the 2h window on that read — it does not retain the relaxed threshold just because it is tagged stable. This is the defence against a depeg being masked by a long heartbeat.

Any read past its applicable staleness window reverts `StalePrice`. Callers do not receive a degraded price.

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

Beyond a live Chainlink price, an asset is only eligible as *liquid* collateral if its v3-style concentrated-liquidity AMM pool (paired against WETH, converted via ETH/USD) reports at least `MIN_LIQUIDITY_USD = $1,000,000` of WETH-side depth at the configured fee tier. This is the second leg of the liquidity contract:

- Assets with a price feed but insufficient pool depth fail-close to *illiquid*.
- Illiquid assets cannot be force-liquidated via 0x swap; on default they are transferred directly to the lender, and both parties must have explicitly consented to the illiquid-path offer.

The depth check is a runtime call, not a cached setting. An asset that was liquid yesterday can become illiquid today if a liquidity provider withdraws — and the protocol will correctly refuse to price-based-liquidate a loan whose collateral has degraded, even if the feed is still live.

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

All facet-level admin setters (`OracleAdminFacet.*`, `AdminFacet.setTreasury`, `EscrowAdminFacet.*`, `RiskAdminFacet.*`, role grants) are gated by named roles on `LibAccessControl`. Post-handover, those roles are held exclusively by a [`TimelockController`](contracts/script/DeployTimelock.s.sol) with a **48h minimum delay**.

The intentional exception is `KYC_ADMIN_ROLE`, which remains on a hot ops multi-sig — KYC tier bumps are an operational same-hour action (user asks to raise their KYC limit after completing verification) and do not belong on a 48h delay. The handover script does not touch this role; operations must explicitly grant it to the ops multi-sig before the deployer EOA renounces it.

`PAUSER_ROLE` is **not** timelocked — pausing is fast by design. Unpause is timelocked (it represents the "we are confident the issue is fixed" decision, and should be deliberate).

See [`contracts/script/TransferAdminToTimelock.s.sol`](contracts/script/TransferAdminToTimelock.s.sol) for the handover script and [`docs/ops/AdminKeysAndPause.md`](docs/ops/AdminKeysAndPause.md) for the full role-by-role custody matrix.

---

## Audit and scope

This repository has been reviewed internally. External audit status is tracked in [`docs/audit/`](docs/audit/). Scope for any external review should include:

- Diamond fallback routing and selector uniqueness.
- `OracleFacet` staleness and sequencer logic (this document is the spec).
- Per-user escrow proxy deployment and upgrade path.
- LayerZero reward mesh finalisation and replay protection.
- Role separation under the post-handover timelock.

Out-of-scope by design: frontend code, The Graph indexer logic (which is a *monitor*, not a source of truth), Tenderly alert wiring.
