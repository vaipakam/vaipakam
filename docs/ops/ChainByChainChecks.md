# Chain-by-Chain Operational Checks

The protocol is deployed to multiple chains with **one canonical reward chain (Base)** and **N reporter chains**. Every chain must pass the same structural checks, with two chain-specific deltas (canonical flag, expected-source-eids list).

Run these on:
- Every fresh deploy (before announcing).
- Every 24h as a cron (the full suite is read-only).
- After every admin action (config change / diamond cut / escrow upgrade).

---

## 0. Inventory

For each chain the protocol supports, maintain `deployments/<chain>/addresses.json`:
```json
{
  "chainId": 8453,
  "chainName": "base",
  "lzEid": 30184,
  "isCanonicalRewardChain": true,
  "diamond": "0x...",
  "vpfi": "0x...",
  "rewardOApp": "0x...",
  "governanceMultisig": "0x...",
  "adminTimelock": "0x...",
  "pauserMultisig": "0x...",
  "treasury": "0x...",
  "expectedSourceEids": [30101, 30102, ...]   // canonical only
}
```

The cron below reads this file, so any deploy must update it atomically with the on-chain change.

---

## 1. Diamond integrity

| Check | Call | Expected |
|---|---|---|
| Diamond exists | `diamondLoupe.facetAddresses()` | 29 non-zero entries (DiamondCutFacet + 28 cut via `DeployDiamond.s.sol`) |
| No orphan selectors | `facets()` length matches inventory | ≥ 29 |
| Facet addresses match last release | diff vs. `deployments/<chain>/addresses.json` | identical |
| `supportsInterface(0x01ffc9a7)` (ERC-165) | `loupe.supportsInterface(...)` | true |
| `supportsInterface(0x48e2b093)` (IDiamondCut) | ditto | true |
| `supportsInterface(0x5b5e139f)` (ERC-721 metadata) | ditto | true |

---

## 2. Access control topology

| Check | Call | Expected |
|---|---|---|
| Governance multisig holds `DEFAULT_ADMIN_ROLE` | `hasRole(0x00, GOV_MULTISIG)` | true |
| Timelock holds `ADMIN_ROLE` | `hasRole(ADMIN_ROLE, TIMELOCK)` | true |
| Timelock holds `ORACLE_ADMIN_ROLE` / `RISK_ADMIN_ROLE` / `KYC_ADMIN_ROLE` / `ESCROW_ADMIN_ROLE` | `hasRole(...)` per role | true |
| Pauser multisig holds `PAUSER_ROLE` | `hasRole(PAUSER_ROLE, PAUSER_MULTISIG)` | true |
| Deployer holds **no** roles | `hasRole(each, DEPLOYER)` | all false |
| No EOA holds any role | for each event-logged grantee, confirm contract (multisig/timelock) | true |

---

## 3. Pause & treasury

| Check | Call | Expected |
|---|---|---|
| Not paused | `AdminFacet.paused()` | false (steady state) |
| Treasury set to multisig | `AdminFacet.getTreasury()` | matches `treasury` in addresses.json |
| Phase 7a swap-adapter chain populated | `AdminFacet.getSwapAdapters()` | length ≥ 1; production target is 4 (ZeroEx, OneInch, UniV3, Balancer V2). A length-0 chain reverts every liquidation. |

---

## 4. Oracles

### 4.1 Primary feed (Chainlink)

| Check | Call | Expected |
|---|---|---|
| Chainlink registry set | `OracleAdminFacet` storage read | non-zero |
| USD denominator set | same | non-zero |
| ETH denominator set | same | non-zero |
| WETH contract set | `OracleFacet.getWETH()` (or storage read) | non-zero |
| Sequencer uptime feed set (L2 only) | `OracleFacet.getSequencerUptimeFeed()` | non-zero on Base/Arbitrum/Optimism/zkEVM; `address(0)` on Ethereum mainnet + BNB Chain |
| Sequencer currently healthy (L2 only) | `OracleFacet.sequencerHealthy()` | true (false = live outage or <1h since recovery; do not auto-pause, page on-call) |
| For each supported asset: Chainlink feed fresh | `getAssetPrice(asset)` | `answer > 0` and either `updatedAt > now - 2h` (volatile fast-path) or `updatedAt > now - 25h` AND `decimals == 8` AND `\|answer - $1\| <= 3%` (stablecoin peg grace) |

### 4.2 Phase 7b.1 — multi-venue liquidity classification

| Check | Call | Expected |
|---|---|---|
| Uniswap V3 factory set | `OracleAdminFacet.getUniswapV3Factory()` | non-zero where Uni V3 is deployed; `address(0)` on BNB / Polygon zkEVM |
| PancakeSwap V3 factory set | `AdminFacet.getPancakeswapV3Factory()` | non-zero where PancakeV3 is deployed |
| SushiSwap V3 factory set | `AdminFacet.getSushiswapV3Factory()` | non-zero where SushiV3 is deployed |
| At least 2 V3 factories configured | sum of non-zero | ≥ 2 (preserves OR-redundancy; falling to 1 collapses to single-venue dependency) |
| For each supported liquid asset: at least 1 V3 factory exposes a deep pool | `checkLiquidity(asset)` | true |
| At least one reference asset passes `checkLiquidityOnActiveNetwork` | | true |

### 4.3 Phase 7b.2 — secondary price-oracle Soft 2-of-N quorum

| Check | Call | Expected |
|---|---|---|
| Tellor oracle set | `OracleAdminFacet.getTellorOracle()` | non-zero on every chain that hosts loans |
| API3 ServerV1 set | `OracleAdminFacet.getApi3ServerV1()` | non-zero on every chain that hosts loans |
| DIA Oracle V2 set | `OracleAdminFacet.getDIAOracleV2()` | non-zero on every chain that hosts loans |
| At least 2 of 3 secondaries configured | sum of non-zero | ≥ 2 (preserves cross-provider redundancy; with 1 the quorum reduces to "secondary must agree"; with 0 the check degrades to Chainlink-only by design) |
| Deviation tolerance reasonable | `OracleAdminFacet.getSecondaryOracleMaxDeviationBps()` | ≤ 1000 (10%); default 500 (5%) |
| Staleness ceiling reasonable | `OracleAdminFacet.getSecondaryOracleMaxStaleness()` | ≤ 14400 (4h); default 3600 (1h) |
| For each supported asset: spot read does NOT revert | `getAssetPrice(asset)` | non-reverting (means primary is fresh AND no fresh secondary disagrees) |

Any oracle check that fails = **pause candidate**. Do not auto-pause from the cron; page the on-call instead.

While `sequencerHealthy()` is false: `getAssetPrice` reverts `SequencerDown` / `SequencerGracePeriod`, `checkLiquidity` fail-closes to `Illiquid`, and both `RiskFacet.triggerLiquidation` and `DefaultedFacet.triggerDefault` revert `SequencerUnhealthy`. This is by design — callers retry once the sequencer recovers past the 1h grace window.

---

## 5. Reward plumbing (cross-chain)

### Every chain
| Check | Call | Expected |
|---|---|---|
| Local eid set | `RewardReporterFacet.getRewardReporterConfig()` | `localEid == inventory.lzEid` |
| Base eid set | same | `baseEid == <canonical chain's eid>` |
| Reward OApp wired | same | `rewardOApp == inventory.rewardOApp` |
| Grace seconds reasonable | same | `graceSeconds` in [3600, 86400] |
| Launch timestamp identical across chains | `getInteractionLaunchTimestamp()` | same value on every chain |

### Canonical chain (Base) only
| Check | Call | Expected |
|---|---|---|
| `isCanonicalRewardChain == true` | `getRewardReporterConfig()` | true |
| Expected source eids match inventory | `getExpectedSourceEids()` | sorted equal to inventory list |
| Every non-canonical inventory chain is in the list | comparison | true |
| No unexpected eid in the list | comparison | true |

### Reporter chains only
| Check | Call | Expected |
|---|---|---|
| `isCanonicalRewardChain == false` | `getRewardReporterConfig()` | false |
| `setExpectedSourceEids` **reverts** (not canonical) | dry-run call | `NotCanonicalRewardChain` |

---

## 6. Yesterday's reward day — state machine

Let `D = currentDay - 1` (every chain should have finalized D by now).

### On Base (canonical)
| Check | Call | Expected |
|---|---|---|
| Day finalized | `isDayReadyToFinalize(D)` | `reason == 1` (already finalized) |
| Chain report count matches expected eids | `getChainDailyReportCount(D)` | `== len(expectedSourceEids)` — if less, the gap finalized via zeroing (see `IncidentRunbook.md`) |
| Global interest > 0 | `getDailyGlobalInterest(D)` | ideally > 0; 0 is valid only on an all-zero day (quiet launch week) |

### On every reporter
| Check | Call | Expected |
|---|---|---|
| Known global set | `getKnownGlobalInterestUSD18(D)` + loupe-stored `knownGlobalSet[D]` | set == true |
| Known global matches Base's `getDailyGlobalInterest(D)` | cross-chain read | equal |
| Chain report was sent | `getChainReportSentAt(D)` | non-zero |

### Alert rules (wire into PagerDuty / Discord)
- `D` elapsed + Base not finalized within **8h**: page.
- Any `DayForceFinalized` event: page.
- Any `ChainContributionZeroed`: page + frontend toast (see below).
- Reporter `getKnownGlobalInterestUSD18(D)` != Base's value: **critical page** (consistency broken).

---

## 7. VPFI token state

| Check | Call | Expected |
|---|---|---|
| Canonical flag set correctly | `VPFITokenFacet.isCanonicalVPFIChain()` | true on canonical, false elsewhere |
| Total supply consistent | `getVPFITotalSupply()` on canonical vs. sum of mirrors | canonical total == sum of circulating on mirrors + canonical retained |
| Cap headroom non-negative | `getVPFICapHeadroom()` | ≥ 0 on every chain |
| Peers wired | LZ OApp `peers(eid)` for every other chain | non-zero + non-default |

---

## 8. Daily TVL / metrics snapshot

| Check | Call | Expected |
|---|---|---|
| TVL reasonable | `MetricsFacet.getProtocolTVL()` | within ±10% of yesterday's snapshot |
| Active loans count | `getActiveLoansCount()` | monotonic-ish |
| Active offers count | `getActiveOffersCount()` | expected band |
| Protocol health | `getProtocolHealth()` | all fields non-zero / no underflow |

Any > 10% daily TVL move triggers manual review, not auto-pause — TVL can legitimately move that much on a single whale deposit.

---

## 9. Frontend toast (for `ChainContributionZeroed`)

Expected UX:
- Subgraph query runs on every Rewards-page mount: `ChainContributionZeroed(dayId, eid)` in the last 48h.
- If `eid == activeChainEid`, render a non-blocking toast:
  > "On <date>, your chain's rewards for day N were zeroed from the cross-chain total due to a message delivery issue. If you had interaction activity that day, you'll be reimbursed from the Insurance pool — see status page for details."
- Toast suppressed after user dismisses (local storage keyed by `(chainEid, dayId)`).

Implementation lives alongside `useRewards.ts` (future work: `useChainZeroedEvents.ts` querying a subgraph).

---

## 10. Running the cron

A minimal read-only script (`scripts/ops/chain_audit.ts` — future work) that:
1. Reads `deployments/<chain>/addresses.json`.
2. Executes every check in §1–§8 via `ethers.Contract` calls.
3. Emits PASS/FAIL per check line.
4. Exits non-zero if any FAIL, wired to PagerDuty.

Until that script exists, the checks above are the **manual** audit checklist for each deploy and for weekly review.
