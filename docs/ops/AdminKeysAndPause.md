# Admin Keys and Pause Process

Defines, for mainnet:
- Which keys hold which role on the Diamond.
- Required topology (multisig, timelock).
- Who can pause, and what a pause does.
- Key-rotation procedure.

Non-mainnet deployments may simplify to a single EOA for speed, but **must** keep the same role separation (ADMIN ≠ PAUSER ≠ DEFAULT_ADMIN at minimum).

---

## Role map

Roles defined in `LibAccessControl.sol`:

| Role | Constant | Grants on init | Guards (selected) |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Deployer on init, then rotated to governance multisig | Can grant/revoke every other role |
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | Deployer on init | `AdminFacet.setTreasury/setZeroExProxy/setallowanceTarget/setKYCEnforcement/addSwapAdapter/removeSwapAdapter/reorderSwapAdapters/setPancakeswapV3Factory/setSushiswapV3Factory`, `RewardReporterFacet.set*`, `RewardAggregatorFacet.setExpectedSourceEids` |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Deployer on init | `AdminFacet.pause / unpause`, `AdminFacet.pauseAsset / unpauseAsset` (per-asset reserve pause / blacklist — either `ADMIN_ROLE` or `PAUSER_ROLE` accepted) |
| `KYC_ADMIN_ROLE` | `keccak256("KYC_ADMIN_ROLE")` | Deployer on init | `ProfileFacet.updateKYCStatus/updateKYCTier/updateKYCThresholds/setKeeperAccess/setLoanKeeperAccess` |
| `ORACLE_ADMIN_ROLE` | `keccak256("ORACLE_ADMIN_ROLE")` | Deployer on init | `OracleAdminFacet.setChainlinkRegistry/setUsdChainlinkDenominator/setEthChainlinkDenominator/setWethContract/setUniswapV3Factory/setStableTokenFeed/setSequencerUptimeFeed/setFeedOverride/setTellorOracle/setApi3ServerV1/setDIAOracleV2/setSecondaryOracleMaxDeviationBps/setSecondaryOracleMaxStaleness` |
| `RISK_ADMIN_ROLE` | `keccak256("RISK_ADMIN_ROLE")` | Deployer on init | `RiskFacet.updateRiskParams` |
| `ESCROW_ADMIN_ROLE` | `keccak256("ESCROW_ADMIN_ROLE")` | Deployer on init | `EscrowFactoryFacet.upgradeEscrowImplementation/setMandatoryEscrowUpgrade` |

`DEFAULT_ADMIN_ROLE` is the admin of every other role (see `LibAccessControl.initialize`).

---

## Mainnet topology

### Required

| Entity | Purpose | Signer threshold |
|---|---|---|
| **Governance multisig** | Holds `DEFAULT_ADMIN_ROLE`. Only actor that can grant/revoke roles. Actions **always** go through the timelock. | 4-of-7, geographically separated |
| **Admin timelock** (OZ `TimelockController`) | Holds `ADMIN_ROLE`, `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `ESCROW_ADMIN_ROLE`. Queues all admin-impacting changes with a delay. | Proposer: governance multisig. Executor: open (after delay). |
| **Ops hot-key multisig** | Holds `PAUSER_ROLE` and `KYC_ADMIN_ROLE`. Same-hour response surface: pause/unpause, per-asset reserve pause (`pauseAsset` / `unpauseAsset`), KYC tier bumps. No other role. | 2-of-5, fast-response on-call signers |
| **Deployer hot key** | Used for initial deploy + role transfer. **Revoked** within 24h. | 1 EOA, rotated per deploy |

### Timelock delay

- Default: **48 hours** for production.
- Minimum: **24 hours** after a deploy has stabilised and ops has built confidence. Never below 24h on mainnet without an audited rationale.
- Emergency override: **no override via timelock.** Emergencies go through `PAUSER_ROLE` (no delay). If an admin-only change is needed under emergency, unpause only after the timelock's delay — or queue the change immediately and pause until it lands.

### Why pauser is separate

`PAUSER_ROLE` is intentionally a fast path with no timelock. If it shared the governance multisig, a 48h delay would make `pause()` useless in the one scenario it exists for (live exploit). Keeping pauser on a 2-of-5 on-call multisig preserves both speed and a second-signer check.

### What the pauser cannot do

- Grant roles.
- Change treasury, oracles, risk params, reward config.
- Finalize or force-finalize reward days.
- Upgrade facets or escrow implementation.

Pausing is a **brake**, not a wrench. Anything structural requires governance → timelock.

---

## What pause blocks, and what it doesn't

`AdminFacet.pause()` sets a single boolean consulted by every `whenNotPaused` modifier (see `LibPausable.sol`).

### Blocked while paused (47 call sites across 19 facets)
User flows: `createOffer`, `acceptOffer`, `initiateLoan`, `repayLoan`, `repayPartial`, `triggerLiquidation`, `triggerDefault`, `claimAsLender/Borrower`, `claimStakingRewards`, `claimInteractionRewards`, `addCollateral`, `partialWithdrawCollateral`, every Preclose/Refinance/EarlyWithdrawal/VPFIDiscount entry, `RewardReporterFacet.closeDay`, `RewardAggregatorFacet.finalizeDay`, `RewardAggregatorFacet.broadcastGlobal`, `TreasuryFacet.*`, etc.

### **Not** blocked by pause (by design)
- `AccessControlFacet.grantRole / revokeRole / renounceRole`
- `DiamondCutFacet.diamondCut`
- `OracleAdminFacet.*`
- `EscrowFactoryFacet.upgradeEscrowImplementation / setMandatoryEscrowUpgrade`
- `AdminFacet.pause / unpause / paused`
- Every pure/view function
- LayerZero message ingress to `RewardReporterFacet.onRewardBroadcastReceived` and `RewardAggregatorFacet.onChainReportReceived` — so in-flight messages don't fail-and-retry forever (they still have their own auth gates).

This is audited and enforced by `PauseGatingTest` — any change to the gated set must update that test.

---

## Key rotation procedure (post-deploy)

Executed once, within 24h of a fresh deploy, from the deployer hot key. Each step is one tx unless noted.

```
# 1. Grant new governance multisig DEFAULT_ADMIN_ROLE
AccessControlFacet.grantRole(DEFAULT_ADMIN_ROLE, GOV_MULTISIG)

# 2. From GOV_MULTISIG: queue timelock grant (48h delay). KYC_ADMIN_ROLE
#    and PAUSER_ROLE are NOT in this batch — they live on the ops
#    hot-key multisig so pause/blacklist and tier bumps bypass the delay.
TimelockController.scheduleBatch(
  targets=[DIAMOND, DIAMOND, DIAMOND, DIAMOND],
  values=[0,0,0,0],
  payloads=[
    grantRole(ADMIN_ROLE, TIMELOCK),
    grantRole(ORACLE_ADMIN_ROLE, TIMELOCK),
    grantRole(RISK_ADMIN_ROLE, TIMELOCK),
    grantRole(ESCROW_ADMIN_ROLE, TIMELOCK)
  ],
  ...
)

# 3. Grant the ops hot-key multisig its two roles directly (no timelock —
#    speed matters). Same multisig holds both so one key rotation covers
#    every hot-key path.
From GOV_MULTISIG:
  AccessControlFacet.grantRole(PAUSER_ROLE,    OPS_MULTISIG)
  AccessControlFacet.grantRole(KYC_ADMIN_ROLE, OPS_MULTISIG)

# 4. After 48h timelock delay, execute the batch from step 2.

# 5. From deployer hot key: renounce every role
For each role in [DEFAULT_ADMIN, ADMIN, PAUSER, KYC_ADMIN, ORACLE_ADMIN, RISK_ADMIN, ESCROW_ADMIN]:
  AccessControlFacet.renounceRole(role, DEPLOYER)

# 6. Verify
For each role: AccessControlFacet.hasRole(role, DEPLOYER) == false
AccessControlFacet.hasRole(DEFAULT_ADMIN_ROLE, GOV_MULTISIG) == true
AccessControlFacet.hasRole(ADMIN_ROLE, TIMELOCK) == true
AccessControlFacet.hasRole(PAUSER_ROLE, OPS_MULTISIG) == true
AccessControlFacet.hasRole(KYC_ADMIN_ROLE, OPS_MULTISIG) == true
```

### Failure modes during rotation

| Failure | Mitigation |
|---|---|
| Deployer renounces before new multisig is active | **Never skip step 6 verify.** If broken, the Diamond has no admin; only recovery is a fresh deploy + migration. |
| Timelock delay too short and a bad proposal is queued | Governance multisig cancels via `TimelockController.cancel(id)`. Cancel permission is on the multisig by default. |
| PAUSER_ROLE granted to a single EOA (not multisig) | Do not ship. A single-EOA pauser is a single point of compromise *and* a single point of delay. |
| KYC_ADMIN_ROLE or PAUSER_ROLE accidentally queued through the timelock | Cancel via `TimelockController.cancel(id)` from GOV_MULTISIG. Both roles must stay on the ops hot-key multisig — a 48h delay makes either role useless in its actual scenario. |

---

## Per-chain expected config (summary)

| Item | Canonical chain (Base) | Every other chain |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` holder | Governance multisig | Governance multisig on that chain (separate safes per chain) |
| `ADMIN_ROLE` holder | Admin timelock | Admin timelock |
| `PAUSER_ROLE` holder | Ops hot-key multisig | Ops hot-key multisig |
| `KYC_ADMIN_ROLE` holder | Ops hot-key multisig (not timelocked) | Ops hot-key multisig (not timelocked) |
| `rewardOApp` | Base OApp contract | Local OApp contract |
| `isCanonicalRewardChain` | **true** | false |
| `localEid` | Base eid | Local eid |
| `baseEid` | Base eid (self) | Base eid |
| `expectedSourceEids` | List of **every other chain's** eid | (unused — only checked on canonical) |

Verify against `ChainByChainChecks.md` after every change.
