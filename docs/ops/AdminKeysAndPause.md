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

### Permissionless callers vs. role-gated admins

Not every off-chain actor that interacts with the Diamond holds a role.
The public reference keeper bot in the sibling `vaipakam-keeper-bot`
repo (Phase 9.A) calls `RiskFacet.triggerLiquidation` and
`DefaultedFacet.triggerDefault` permissionlessly — both functions are
designed to be open so that any third party can race for the
liquidation bonus once HF crosses 1.0 or grace expires. **No Diamond
role is granted to keeper-bot operators**, and none should be: a
keeper that needed an admin role would be a structural hazard. The
operator's own hf-watcher Cloudflare Worker
(`ops/hf-watcher/src/keeper.ts`) follows the same model — it submits
liquidations from a hot key that holds zero on-chain authority.

This means the role-rotation procedure below does **not** need to
touch keeper-bot keys at all. Operators of `vaipakam-keeper-bot` rotate
their own RPC / signer keys on their own schedule; the Diamond is
indifferent.

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

---

## Off-chain operator keys (alert watchers)

Two Cloudflare Workers hold long-lived secrets that are **not**
Diamond roles. Losing or rotating them affects only the
off-chain notification rails, never on-chain protocol authority.

### `ops/hf-watcher` (public-facing — user HF alerts + autonomous keeper)

| Key | Purpose | Storage | Compromise blast radius |
|---|---|---|---|
| `TG_BOT_TOKEN` | Authenticates the worker as `@VaipakamBot` for Telegram message sends + webhook receives. | `wrangler secret put TG_BOT_TOKEN` (encrypted at rest in Cloudflare Workers). | Attacker can spam our subscriber base with arbitrary Telegram messages branded as the bot. Rotate via @BotFather → `/revoke` → re-issue → re-set the secret. |
| `PUSH_CHANNEL_PK` | Channel signer privkey for the Vaipakam Push channel `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b` (<https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>). Used by `@pushprotocol/restapi` to sign outbound notifications. | `wrangler secret put PUSH_CHANNEL_PK` (encrypted at rest). | Attacker can push arbitrary notifications to every Vaipakam Push subscriber. The channel-owner wallet should hold ONLY the 50 PUSH staking deposit + ~$50 of native gas — never operator funds, never connected to a treasury workflow. Rotate by transferring channel ownership at app.push.org to a fresh EOA, updating the secret, redeploying the worker (procedure in `IncidentRunbook.md` §4). |
| `KEEPER_PRIVATE_KEY` | Hot-key signer for the autonomous-keeper liquidation path inside hf-watcher. Submits `triggerLiquidation` from this EOA when on-chain HF crosses 1.0. Holds **zero** Diamond roles. | `wrangler secret put KEEPER_PRIVATE_KEY` (encrypted at rest). | Attacker who steals the key can submit liquidations with our identity but earns the bonus into the same key — no fund-extraction path against the protocol. They can also drain the keeper EOA's gas balance; bound that balance with a per-chain top-up policy (≤ $200 each). Rotate by writing a fresh privkey, redeploying the worker, then sweeping the old key's residual gas. |
| `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b` (public address) | The Push channel-owner wallet's public side. Surfaced on the frontend via `VITE_PUSH_CHANNEL_ADDRESS` and rendered on `/app/alerts` as a "Subscribe on Push →" deep link. | Public — committed to `frontend/.env.example`, displayed to every user. | Public info; no compromise model. Changing it requires creating a new Push channel + 50-PUSH stake + frontend redeploy. |
| `RPC_*` (one per chain) | Dedicated RPC URLs — Alchemy / QuickNode / Infura. | `wrangler secret put RPC_BASE` etc. | Quota theft (attacker exhausts our RPC budget). Limited blast radius. Rotate by re-issuing the upstream key + re-setting the secret. |

### `ops/lz-watcher` (internal-only — LayerZero security alerts)

This Worker is internal ops only. Its alerts go to a private
Telegram channel. No public surface, no autonomous keeper, no
user-facing notifications. See `IncidentRunbook.md` §5 for the
per-alert response SOPs.

| Key | Purpose | Storage | Compromise blast radius |
|---|---|---|---|
| `TG_BOT_TOKEN` | Authenticates the worker as the ops Telegram bot. **MAY** be the same `@VaipakamBot` token used by hf-watcher (chat IDs alone don't grant posting access without the token, so one bot serving two chats is fine), or a separate bot identity. The latter limits cross-Worker contagion if either token leaks. | `wrangler secret put TG_BOT_TOKEN` on the lz-watcher Worker — independent secret store from hf-watcher's despite (potentially) the same value. | Attacker can post arbitrary messages into the ops channel — same blast radius as hf-watcher's `TG_BOT_TOKEN`. Rotate via @BotFather. |
| `RPC_*` (one per chain) | Dedicated RPC URLs for log scans + `endpoint.getConfig` reads + `balanceOf` / `totalSupply` reads. Public RPCs rate-limit `eth_getLogs` aggressively — must use Alchemy / QuickNode / Infura. | `wrangler secret put RPC_BASE` etc. — independent secret store from hf-watcher's. | Quota theft only. Limited blast radius. Rotate by re-issuing the upstream key + re-setting the secret. |
| `TG_OPS_CHAT_ID` | Numeric chat id of the internal ops Telegram channel that receives lz-watcher alerts. Negative integer for channels / groups. | `vars` block in `wrangler.jsonc` — **not** a secret. Chat ids alone don't authorize posting; the bot token does. | None — public info. Changing it just retargets where alerts land. |

### Key independence

These watcher secrets are **independent** of the Diamond key
topology in the upper sections. Compromise of any of them does
**not** require an on-chain pause — see `IncidentRunbook.md` §4
for hf-watcher rotation, §5 for lz-watcher response. Conversely,
rotating Diamond admin roles does not require touching any
watcher secret.

### Why the two Workers don't share a Cloudflare account secret store

Cloudflare Workers `secret put` is per-Worker. So even if both
Workers use the same value for, say, `TG_BOT_TOKEN`, they hold
independent encrypted copies. This means:

- A Cloudflare account compromise that exfiltrates one Worker's
  secrets does not automatically expose the other's, **but**
- Anyone with `Workers Edit` permission on the account can read
  both. So account-level access controls (2FA, IP allowlisting,
  member audit) are the real protection. Audit annually.

Per the LayerZero hardening plan: a Cloudflare account
compromise drops both Workers, which is one reason our DVN
configuration uses 3 required + 2 optional with a 1-of-2
optional threshold — no single off-chain surface compromise
should be sufficient to break a Vaipakam cross-chain message.
