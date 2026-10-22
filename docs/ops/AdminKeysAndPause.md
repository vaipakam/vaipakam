# Admin Keys and Pause Process

Defines, for mainnet:
- Which keys hold which role on the Diamond.
- Required topology (multisig, timelock).
- Who can pause, and what a pause does.
- Key-rotation procedure.

Non-mainnet deployments may simplify to a single EOA for speed, but **must** keep the same role separation (ADMIN ≠ PAUSER ≠ EMERGENCY_REVOKER at minimum).

---

## Role map

Roles defined in `LibAccessControl.sol`:

| Role | Constant | Grants on init | Guards (selected) |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | `0x00` | Deployer on init, then rotated to the admin timelock (D1, #934) | Can grant/revoke every other role, `transferAdmin` |
| `ADMIN_ROLE` | `keccak256("ADMIN_ROLE")` | Deployer on init | `AdminFacet.setTreasury/setZeroExProxy/setallowanceTarget/setKYCEnforcement/addSwapAdapter/removeSwapAdapter/reorderSwapAdapters/setPancakeswapV3Factory/setSushiswapV3Factory`, `RewardReporterFacet.set*`, `RewardAggregatorFacet.setExpectedSourceEids` |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` | Deployer on init | `AdminFacet.pause / unpause`, `AdminFacet.pauseAsset / unpauseAsset` (per-asset reserve pause / blacklist — either `ADMIN_ROLE` or `PAUSER_ROLE` accepted) |
| `KYC_ADMIN_ROLE` | `keccak256("KYC_ADMIN_ROLE")` | Deployer on init | `ProfileFacet.updateKYCStatus/updateKYCTier/updateKYCThresholds/setKeeperAccess/setLoanKeeperAccess` |
| `ORACLE_ADMIN_ROLE` | `keccak256("ORACLE_ADMIN_ROLE")` | Deployer on init | `OracleAdminFacet.setChainlinkRegistry/setUsdChainlinkDenominator/setEthChainlinkDenominator/setWethContract/setUniswapV3Factory/setStableTokenFeed/setSequencerUptimeFeed/setFeedOverride/setTellorOracle/setApi3ServerV1/setDIAOracleV2/setSecondaryOracleMaxDeviationBps/setSecondaryOracleMaxStaleness` |
| `RISK_ADMIN_ROLE` | `keccak256("RISK_ADMIN_ROLE")` | Deployer on init | `RiskFacet.updateRiskParams` |
| `VAULT_ADMIN_ROLE` | `keccak256("VAULT_ADMIN_ROLE")` | Deployer on init | `VaultFactoryFacet.upgradeVaultImplementation/setMandatoryVaultUpgrade` |
| `EMERGENCY_REVOKER_ROLE` | `keccak256("EMERGENCY_REVOKER_ROLE")` | Never granted at init; `Handover.s.sol` grants it to the governance multisig | `AccessControlFacet.emergencyRevokeRole` only — removes a role immediately; never `DEFAULT_ADMIN_ROLE`, never from the Diamond owner |

`DEFAULT_ADMIN_ROLE` is the admin of every other role (see `LibAccessControl.initializeAccessControl`).

Two rules keep the ERC-173 owner and the role root together (#906): ownership
moves only to a non-zero address that already holds `DEFAULT_ADMIN_ROLE`, and
`DEFAULT_ADMIN_ROLE` cannot be revoked from or renounced by the current owner.
So the order is always: grant the root, move ownership, then the old owner
gives up the root.

---

## Mainnet topology

### Required

| Entity | Purpose | Signer threshold |
|---|---|---|
| **Governance multisig** | The timelock's proposer. On the Diamond it holds **only** `EMERGENCY_REVOKER_ROLE` (D1, #934) — it cannot grant a role, move ownership or upgrade anything directly; every such action is a timelock operation. | 4-of-7, geographically separated |
| **Admin timelock** (`VaipakamTimelock`) | ERC-173 Diamond owner and `DEFAULT_ADMIN_ROLE`, plus `ADMIN_ROLE`, `UNPAUSER_ROLE`, `KYC_ADMIN_ROLE`, `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE`. Queues every admin-impacting change with a delay. Self-administered (no external admin). | Proposer: governance multisig. Executor: open (after delay). Independent canceller: the pauser multisig. |
| **Pauser multisig** | Holds `PAUSER_ROLE` (pause, per-asset pause — not unpause) and is the timelock's independent canceller. No other role. | 2-of-5, fast-response on-call signers |
| **Deployer hot key** | Used for initial deploy + role transfer. **Revoked** within 24h. | 1 EOA, rotated per deploy |

### Timelock delay

- Default: **48 hours** for production; `DeployTimelock` refuses less on a Phase-1 mainnet.
- Floor: the delay can never be lowered below the value the timelock was deployed with (`MIN_DELAY_FLOOR`, #938). Raising it is an ordinary queued operation. A lower delay needs a new timelock and a governed handover to it.
- No expiry: a ready operation stays executable by anyone until it runs or is cancelled. Cancel anything that will not be executed, and watch `getPendingProposals` for stale entries.
- Emergency override: **no override via timelock.** Emergencies go through `PAUSER_ROLE` (no delay). If an admin-only change is needed under emergency, unpause only after the timelock's delay — or queue the change immediately and pause until it lands.

### Why pauser is separate

`PAUSER_ROLE` is intentionally a fast path with no timelock. If it shared the governance multisig, a 48h delay would make `pause()` useless in the one scenario it exists for (live exploit). Keeping pauser on a 2-of-5 on-call multisig preserves both speed and a second-signer check.

### What the pauser cannot do

- Grant roles.
- Change treasury, oracles, risk params, reward config.
- Finalize or force-finalize reward days.
- Upgrade facets or vault implementation.

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
operator's own keeper Cloudflare Worker
(`apps/keeper/src/liquidator.ts`) follows the same model — it submits
liquidations from a hot key that holds no admin or upgrade authority
(the narrow roles that key CAN hold are itemised in the key table
below).

This means the role-rotation procedure below does **not** need to
touch keeper-bot keys at all. Operators of `vaipakam-keeper-bot` rotate
their own RPC / signer keys on their own schedule; the Diamond is
indifferent.

---

## What pause blocks, and what it doesn't

`AdminFacet.pause()` sets a single boolean consulted by every `whenNotPaused` modifier (see `LibPausable.sol`).

### Blocked while paused (47 call sites across 19 facets)
User flows: `createOffer`, `acceptOffer`, `initiateLoan`, `repayLoan`, `repayPartial`, `triggerLiquidation`, `triggerDefault`, `claimAsLender/Borrower`, `claimStakingRewards`, `claimInteractionRewards`, `addCollateral`, `partialWithdrawCollateral`, every Preclose/Refinance/EarlyWithdrawal/VPFIDiscount entry, `RewardReporterFacet.closeDay`, `RewardAggregatorFacet.finalizeDay`, `RewardBroadcastFacet.broadcastGlobal` (moved out of the aggregator for EIP-170 headroom, #1569; selector unchanged), `TreasuryFacet.*`, etc.

### **Not** blocked by pause (by design)
- `AccessControlFacet.grantRole / revokeRole / renounceRole`
- `DiamondCutFacet.diamondCut`
- `OracleAdminFacet.*`
- `VaultFactoryFacet.upgradeVaultImplementation / setMandatoryVaultUpgrade`
- `AdminFacet.pause / unpause / paused`
- Every pure/view function
- CCIP message ingress to `RewardReporterFacet.onRewardBroadcastReceived` and `RewardAggregatorFacet.onChainReportReceived` (routed CCIP-router → `CcipMessenger._ccipReceive` → `VaipakamRewardMessenger.onCrossChainMessage` → the diamond) — so in-flight messages don't fail-and-retry forever (they still have their own auth gates + the `GuardianPausable` per-contract pause path).

This is audited and enforced by `PauseGatingTest` — any change to the gated set must update that test.

---

## Key rotation procedure (post-deploy)

The rotation is `Handover.s.sol`, run by the deploy pipeline's
`--phase handover` (see `docs/ops/DeploymentRunbook.md`). It is no longer a
hand-typed ceremony. In order, as the admin EOA:

```
# 1. Role root to the timelock FIRST (D1); the admin keeps it until the end
grantRole(DEFAULT_ADMIN_ROLE, TIMELOCK)
# 2. The governance multisig's only Diamond role
grantRole(EMERGENCY_REVOKER_ROLE, GOV_MULTISIG)
# 3. Delayed roles to the timelock
grantRole(ADMIN_ROLE | UNPAUSER_ROLE | KYC_ADMIN_ROLE | ORACLE_ADMIN_ROLE |
          RISK_ADMIN_ROLE | VAULT_ADMIN_ROLE, TIMELOCK)
# 4. Fast pause lever, direct
grantRole(PAUSER_ROLE, PAUSER_MULTISIG)
# 5. Ownership (only accepted because step 1 made the timelock root admin)
transferOwnership(TIMELOCK)
# 6. Admin renounces, DEFAULT_ADMIN_ROLE last
```

Verify afterwards:

```
owner() == TIMELOCK
hasRole(DEFAULT_ADMIN_ROLE, TIMELOCK) == true
hasRole(EMERGENCY_REVOKER_ROLE, GOV_MULTISIG) == true
hasRole(<any other role>, GOV_MULTISIG) == false
hasRole(PAUSER_ROLE, PAUSER_MULTISIG) == true
hasRole(<any role>, DEPLOYER) == false and hasRole(<any role but the bot roles>, ADMIN) == false
```

### Failure modes during rotation

| Failure | Mitigation |
|---|---|
| Deployer renounces before new multisig is active | **Never skip step 6 verify.** If broken, the Diamond has no admin; only recovery is a fresh deploy + migration. |
| A bad proposal is queued | The governance multisig (proposer) or the independent canceller (pauser multisig) cancels via `cancel(id)` during the delay. |
| A bot or pauser key is compromised | The governance multisig calls `emergencyRevokeRole(role, key, reason)` — immediate, no timelock. It cannot touch `DEFAULT_ADMIN_ROLE` or the timelock's roles. |
| PAUSER_ROLE granted to a single EOA (not multisig) | Do not ship. A single-EOA pauser is a single point of compromise *and* a single point of delay. |

---

## Per-chain expected config (summary)

| Item | Canonical chain (Base) | Every other chain |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` holder + ERC-173 owner | Admin timelock | Admin timelock on that chain |
| `EMERGENCY_REVOKER_ROLE` holder | Governance multisig | Governance multisig on that chain (separate safes per chain) |
| `ADMIN_ROLE` holder | Admin timelock | Admin timelock |
| `PAUSER_ROLE` holder | Pauser multisig | Pauser multisig |
| `KYC_ADMIN_ROLE` holder | Admin timelock (dormant on retail) | Admin timelock (dormant on retail) |
| `rewardMessenger` | Base reward messenger | Local reward messenger |
| `isCanonicalRewardChain` | **true** | false |
| `baseChainId` | Base chain id (`8453` mainnet / `84532` testnet) | Base chain id |
| `expectedSourceChainIds` | List of **every other chain's** EVM chain id | (unused — only checked on canonical) |

Verify against `ChainByChainChecks.md` after every change.

---

## Off-chain operator keys (alert watchers)

Two Cloudflare Workers hold long-lived secrets. For most of them,
losing or rotating the value affects only the off-chain notification
rails — **with one carve-out: `KEEPER_PRIVATE_KEY` is an on-chain
signer, not just an off-chain credential.** Its EOA can hold
`KEEPER_ROLE` (every chain) and is separately the configured
`rewardRemittanceKeeper` on Base, so a compromise of that row is
**not** closed by rotating the stored value: the stolen EOA keeps
its on-chain authority until both are explicitly revoked —
`revokeRole(KEEPER_ROLE, …)` per chain AND
`setRewardRemittanceKeeper(…)` on Base. The row below carries the
full sequence; an earlier revision of this lead-in classified the
whole section as "never on-chain protocol authority", which is
exactly the assumption that would leave the attacker authorized
(#1450 r29).

### `apps/keeper` + `apps/agent` (public-facing — user HF alerts + autonomous keeper)

> These secrets moved when the Stage 3 split replaced the single
> pre-split `hf-watcher` Worker with `apps/{keeper,agent,indexer}`. The
> user-facing alert and keeper duties are split across `apps/keeper` and
> `apps/agent`, and the shared credentials now live in the **account-level
> Secrets Store** rather than per-Worker — so one write covers both
> consumers, and a per-Worker `wrangler secret put` for a shared value
> rotates neither.
>
> **Every row in this section is store-bound** — `TG_BOT_TOKEN`,
> `KEEPER_PRIVATE_KEY`, `PUSH_CHANNEL_PK` and the whole `RPC_*` set appear
> as `secret_name` entries under `secrets_store_secrets`, never as
> per-Worker values. So no `wrangler secret put` form is correct here. (An
> earlier revision of this banner claimed the `secret put` forms that
> remained were "genuinely per-Worker" without checking each row — they
> were not. `wrangler secret put` still applies elsewhere, e.g. the `ops/*`
> Workers' `TG_OPS_BOT_TOKEN` and the archive Worker's `B2_*` pair, which
> are not store-bound.)
>
> **Store-bound is not the same as bound everywhere**, and a responder
> scoping exposure needs the difference — an earlier revision of this
> banner said every listed key appears in BOTH Workers, which is false in
> three places. The **Consumers** column is authoritative; it is derived
> from the `secrets_store_secrets` blocks of `apps/keeper`, `apps/agent`
> and `apps/indexer`. In particular `KEEPER_PRIVATE_KEY` is bound by
> `apps/keeper` **only**, and the `RPC_*` set is not uniform. The
> `apps/indexer` Worker binds most of the `RPC_*` set too, so despite this
> section's heading it is a consumer of these credentials — it binds no
> signing key, which is why it is not a heading-level subject here.

| Key | Consumers | Purpose | Storage | Compromise blast radius |
|---|---|---|---|---|
| `TG_BOT_TOKEN` | `apps/keeper` + `apps/agent` | Authenticates the worker as `@VaipakamBot` for Telegram message sends + webhook receives. | Account-level **Secrets Store** (`vaipakam-credentials`) — `wrangler secrets-store secret update`. NOT `wrangler secret put`: that writes a per-Worker value, which every consumer here IGNORES, so it would leave the compromised store credential live while looking like a successful rotation. | Attacker can spam our subscriber base with arbitrary Telegram messages branded as the bot. Rotate via @BotFather → `/revoke` → re-issue → re-set the secret. |
| `PUSH_CHANNEL_PK` | `apps/keeper` + `apps/agent` | Channel signer privkey for the Vaipakam Push channel `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b` (<https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>). Used by `@pushprotocol/restapi` to sign outbound notifications. | Account-level **Secrets Store** (`vaipakam-credentials`), bound by both `apps/agent` and `apps/keeper` — `wrangler secrets-store secret update`, NOT a per-Worker `wrangler secret put`, which would rotate neither. | Attacker can push arbitrary notifications to every Vaipakam Push subscriber. The channel-owner wallet should hold ONLY the 50 PUSH staking deposit + ~$50 of native gas — never operator funds, never connected to a treasury workflow. Rotation is a channel MIGRATION, not a signer swap: Push implements no channel-ownership transfer (its `ChannelOwnershipTransfer` event is declared but never emitted), and both Workers derive the channel id from this key — so a new key means a new channel, which must be created and staked (50 PUSH) before it can post. Update the secret in the account-level Secrets Store, redeploy BOTH `apps/agent` and `apps/keeper`, point the agent's `PUSH_CHANNEL_ADDRESS` at the new channel, and expect to ask subscribers to re-subscribe. Full procedure in `IncidentRunbook.md` §4. Since #1456 the agent posts as the channel `PUSH_CHANNEL_ADDRESS` names, so a key that is a DELEGATE of the channel can be swapped without moving it — provided the channel owner key is held separately and is not the one compromised; the keeper gains the same once it moves onto the shared rail (`packages/push`, #2248). |
| `KEEPER_PRIVATE_KEY` | `apps/keeper` **only** — `apps/agent` does not bind it | Hot-key signer for `apps/keeper`'s autonomous paths. Submits `triggerLiquidation` permissionlessly, but **does NOT hold zero Diamond authority** — an earlier revision of this row said so and it is wrong. Verified in source: the EOA can hold `KEEPER_ROLE` (gating `ConfigFacet.setKeeperTier`, deployed on EVERY chain and feeding loan-init LTV limits; `RewardCommitmentFacet.submitCommitmentBatch`; `ClaimFacet.claimAsLenderViaBackstop`) and is separately the configured `rewardRemittanceKeeper` on Base, which `remitRewardBudget` authorises against via `_checkRemitter` **without consulting `KEEPER_ROLE` at all**. | Account-level **Secrets Store** (`vaipakam-credentials`) — `wrangler secrets-store secret update`. NOT `wrangler secret put`: that writes a per-Worker value, which every consumer here IGNORES, so it would leave the compromised store credential live while looking like a successful rotation. | Attacker who steals the key can submit liquidations with our identity but earns the bonus into the same key — no fund-extraction path against the protocol. They can also drain the keeper EOA's gas balance; bound that balance with a per-chain top-up policy (≤ $200 each). **Rotation is a REVOCATION, and sweeping gas is not one** — a swept EOA keeps every authority it held and can be refunded for pennies. Write a fresh privkey, then: (1) `revokeRole(KEEPER_ROLE, <old EOA>)` then `grantRole(..., <new EOA>)` **on every chain including canonical Base**, not mirrors only; (2) `setRewardRemittanceKeeper(<new EOA>)` on Base — a SEPARATE authority that revoking the role does not touch; (3) redeploy the Worker; (4) read both back per chain; (5) then sweep the old key's gas, as housekeeping. Full procedure in `OffChainRestore.md` §1 step 6, compromise branch. |
| `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b` (public address) | `apps/agent` (`PUSH_CHANNEL_ADDRESS`, plain var, optional, #1456) — no frontend setting since #2251 | The Push channel's public side. The agent posts as the channel `PUSH_CHANNEL_ADDRESS` names (unset: its signer's own address) and reports it from `GET /push/status`; the Alerts card on `/settings` renders it as the "Open the Push channel" deep link — the successor app defines no `/alerts` route. `VITE_PUSH_CHANNEL_ADDRESS` is retired (#2251). | Public. Not committed: set as a plain var on the agent. Displayed to every user. | Public info; no compromise model. Changing it requires creating a new Push channel + 50-PUSH stake and pointing the agent's var at it; the app follows the agent with no redeploy. A signer swap no longer has to change it when the new key is a delegate of this channel (#1456); the keeper derives its channel from its own key until it moves onto the shared rail (#2248). |
| `RPC_*` (one per chain) | **not uniform.** All three of `apps/{keeper,agent,indexer}` bind `RPC_ARB`, `RPC_ARB_SEPOLIA`, `RPC_BASE`, `RPC_BASE_SEPOLIA`, `RPC_BNB`, `RPC_BNB_TESTNET`, `RPC_ETH`, `RPC_OP`, `RPC_OP_SEPOLIA`, `RPC_SEPOLIA`. `RPC_POLYGON_AMOY` is `apps/agent` + `apps/indexer`; `RPC_POLYGON` is `apps/agent` alone. `apps/keeper` binds no Polygon endpoint. | Dedicated RPC URLs — Alchemy / QuickNode / Infura. | Account-level **Secrets Store** (`vaipakam-credentials`) — `wrangler secrets-store secret update` per chain. NOT `wrangler secret put` (see the rows above). | Quota theft (attacker exhausts our RPC budget). Limited blast radius. Rotate by re-issuing the upstream key + re-setting the secret. |

### `ops/lz-watcher` — REMOVED 2026-07-28 (#1440)

> The Worker was **deleted** and its source tree removed; the secrets
> below no longer exist anywhere and nothing rotates them. Retained only
> so an operator who finds a stale reference elsewhere can confirm the
> disposition. `IncidentRunbook.md` §5 is likewise retired — do not
> follow it. The `vaipakam-lz-alerts-db` database deletion is the one
> remaining operator step, gated on a clean nightly backup.
>
> The live ops-internal watcher is now `ops/mesh-watcher` (VPFI recycling
> mesh invariants), which has its own D1 and uses the same
> `TG_OPS_BOT_TOKEN` ops bot.

> **T-068 status:** The cross-chain layer migrated from LayerZero to
> Chainlink CCIP in PR #46 (2026-05-18). The three checks this
> Worker runs (DVN-count drift, OFT mint/burn imbalance, OApp event
> flow) describe the pre-T-068 surface and are deferred for
> decommission. The post-T-068 monitoring surface lives in
> `contracts/RUNBOOK.md` §9 (RMN curse-event drift, CCT mint/burn
> imbalance on `LockReleaseTokenPool` vs sum of mirror
> `totalSupply()`, lane rate-limit saturation, pause-lever health,
> CCIP-fee funding).
>
> **Past tense, per the REMOVED banner above:** these keys existed only
> while the Worker was deployed. It has been deleted, so they are gone and
> there is nothing left to revoke or rotate — the earlier "once it's torn
> down, the secrets below can be revoked" wording described a teardown that
> has since happened, and reading it as pending contradicted the banner.
> The one remaining operator step is deleting the `vaipakam-lz-alerts-db`
> database, gated on a clean nightly backup.

> **The table below is HISTORICAL.** It records what this Worker held
> while it existed, so an operator meeting a stale reference can confirm
> the disposition. None of its storage or rotation instructions are
> executable — the Worker, its per-Worker secret store and its source
> tree are all gone. Do not follow them; there is nothing to rotate.

| Key | Purpose | Storage | Compromise blast radius |
|---|---|---|---|
| `TG_BOT_TOKEN` | Authenticates the worker as the ops Telegram bot. **MAY** be the same `@VaipakamBot` token used by hf-watcher (chat IDs alone don't grant posting access without the token, so one bot serving two chats is fine), or a separate bot identity. The latter limits cross-Worker contagion if either token leaks. | `wrangler secret put TG_BOT_TOKEN` on the lz-watcher Worker — independent secret store from hf-watcher's despite (potentially) the same value. | Attacker can post arbitrary messages into the ops channel — same blast radius as hf-watcher's `TG_BOT_TOKEN`. Rotate via @BotFather. |
| `RPC_*` (one per chain) | Dedicated RPC URLs for log scans + `endpoint.getConfig` reads + `balanceOf` / `totalSupply` reads. Public RPCs rate-limit `eth_getLogs` aggressively — must use Alchemy / QuickNode / Infura. | `wrangler secret put RPC_BASE` etc. — independent secret store from hf-watcher's. | Quota theft only. Limited blast radius. Rotate by re-issuing the upstream key + re-setting the secret. |
| `TG_OPS_CHAT_ID` | Numeric chat id of the internal ops Telegram channel that receives lz-watcher alerts. Negative integer for channels / groups. | `vars` block in `wrangler.jsonc` — **not** a secret. Chat ids alone don't authorize posting; the bot token does. | None — public info. Changing it just retargets where alerts land. |

### Key independence

Worker secrets are **independent of the Diamond key topology** in the
upper sections. Compromise of any of them does **not** require an
on-chain pause — see `IncidentRunbook.md` §4 for the Push channel and
Telegram rotations. Conversely, rotating Diamond admin roles does not
require touching any Worker secret. (`IncidentRunbook.md` §5 was the
lz-watcher response and is retired with that Worker — #1440.)

### How the Workers share credentials — and what that means for scoping

> **SUPERSEDED.** This section previously argued the opposite: that
> `wrangler secret put` is per-Worker, so two Workers holding the same
> value keep independent encrypted copies, and one Worker's exfiltration
> does not expose the other's. That reasoning described the pre-Stage-3
> `hf-watcher` / `lz-watcher` pair. It is **no longer how these Workers
> are configured**, and a responder who scoped an incident by it would
> under-scope it and would reach for a rotation command that updates
> nothing. Corrected below.

The shared credentials now live in **one account-level Secrets Store**
(`vaipakam-credentials`), bound by `secret_name` from each Worker's
`secrets_store_secrets` block. There is one encrypted copy, not one per
Worker. For an incident that means:

- **Exposure is shared by default.** A compromise of a store-bound value
  exposes it to every Worker that binds it — use the **Consumers** column
  above to enumerate them, since the set is not uniform (`RPC_POLYGON` is
  one Worker; the common `RPC_*` are three).
- **One rotation covers every consumer** — `wrangler secrets-store secret
  update` writes the single copy. The corollary is the trap the banner
  above names: a per-Worker `wrangler secret put` of a store-bound value
  rotates *nothing*, because every consumer reads the store binding and
  ignores the per-Worker value.
- **Account-level access control is still the real protection.** Anyone
  with `Workers Edit` on the account could already read every Worker's
  secrets under the old model too, so 2FA, IP allowlisting and member
  audit were always the boundary that mattered. Audit annually.

Per the **post-T-068** cross-chain security model: a Cloudflare
account compromise drops both Workers, but the cross-chain
transport itself runs on Chainlink CCIP — the committing DON +
executing DON + the independent Risk Management Network re-verify
every message regardless of any off-chain monitoring state. No
single off-chain surface compromise (Cloudflare, Telegram bot,
RPC vendor) can break a Vaipakam cross-chain message; the
defense-in-depth that operators DO own is the per-lane rate-limit
governor (`VpfiPoolRateGovernor`) + the `GuardianPausable` pause
lever on every cross-chain contract with a runtime send/receive
path. See ADR-0004 for the full security model.
