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
| `VAULT_ADMIN_ROLE` | `keccak256("VAULT_ADMIN_ROLE")` | Deployer on init | `VaultFactoryFacet.upgradeVaultImplementation/setMandatoryVaultUpgrade` |

`DEFAULT_ADMIN_ROLE` is the admin of every other role (see `LibAccessControl.initialize`).

---

## Mainnet topology

### Required

| Entity | Purpose | Signer threshold |
|---|---|---|
| **Governance multisig** | Holds `DEFAULT_ADMIN_ROLE`. Only actor that can grant/revoke roles. Actions **always** go through the timelock. | 4-of-7, geographically separated |
| **Admin timelock** (OZ `TimelockController`) | Holds `ADMIN_ROLE`, `ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE`. Queues all admin-impacting changes with a delay. | Proposer: governance multisig. Executor: open (after delay). |
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
User flows: `createOffer`, `acceptOffer`, `initiateLoan`, `repayLoan`, `repayPartial`, `triggerLiquidation`, `triggerDefault`, `claimAsLender/Borrower`, `claimStakingRewards`, `claimInteractionRewards`, `addCollateral`, `partialWithdrawCollateral`, every Preclose/Refinance/EarlyWithdrawal/VPFIDiscount entry, `RewardReporterFacet.closeDay`, `RewardAggregatorFacet.finalizeDay`, `RewardAggregatorFacet.broadcastGlobal`, `TreasuryFacet.*`, etc.

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
    grantRole(VAULT_ADMIN_ROLE, TIMELOCK)
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
For each role in [DEFAULT_ADMIN, ADMIN, PAUSER, KYC_ADMIN, ORACLE_ADMIN, RISK_ADMIN, VAULT_ADMIN]:
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
| `PUSH_CHANNEL_PK` | `apps/keeper` + `apps/agent` | Channel signer privkey for the Vaipakam Push channel `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b` (<https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>). Used by `@pushprotocol/restapi` to sign outbound notifications. | Account-level **Secrets Store** (`vaipakam-credentials`), bound by both `apps/agent` and `apps/keeper` — `wrangler secrets-store secret update`, NOT a per-Worker `wrangler secret put`, which would rotate neither. | Attacker can push arbitrary notifications to every Vaipakam Push subscriber. The channel-owner wallet should hold ONLY the 50 PUSH staking deposit + ~$50 of native gas — never operator funds, never connected to a treasury workflow. Rotation is a channel MIGRATION, not a signer swap: Push implements no channel-ownership transfer (its `ChannelOwnershipTransfer` event is declared but never emitted), and both Workers derive the channel id from this key — so a new key means a new channel, which must be created and staked (50 PUSH) before it can post. Update the secret in the account-level Secrets Store, redeploy BOTH `apps/agent` and `apps/keeper`, repoint `VITE_PUSH_CHANNEL_ADDRESS`, and expect to ask subscribers to re-subscribe. Full procedure in `IncidentRunbook.md` §4; #1456 would reduce this to a secret swap. |
| `KEEPER_PRIVATE_KEY` | `apps/keeper` **only** — `apps/agent` does not bind it | Hot-key signer for `apps/keeper`'s autonomous paths. Submits `triggerLiquidation` permissionlessly, but **does NOT hold zero Diamond authority** — an earlier revision of this row said so and it is wrong. Verified in source: the EOA can hold `KEEPER_ROLE` (gating `ConfigFacet.setKeeperTier`, deployed on EVERY chain and feeding loan-init LTV limits; `RewardCommitmentFacet.submitCommitmentBatch`; `ClaimFacet.claimAsLenderViaBackstop`) and is separately the configured `rewardRemittanceKeeper` on Base, which `remitRewardBudget` authorises against via `_checkRemitter` **without consulting `KEEPER_ROLE` at all**. | Account-level **Secrets Store** (`vaipakam-credentials`) — `wrangler secrets-store secret update`. NOT `wrangler secret put`: that writes a per-Worker value, which every consumer here IGNORES, so it would leave the compromised store credential live while looking like a successful rotation. | Attacker who steals the key can submit liquidations with our identity but earns the bonus into the same key — no fund-extraction path against the protocol. They can also drain the keeper EOA's gas balance; bound that balance with a per-chain top-up policy (≤ $200 each). **Rotation is a REVOCATION, and sweeping gas is not one** — a swept EOA keeps every authority it held and can be refunded for pennies. Write a fresh privkey, then: (1) `revokeRole(KEEPER_ROLE, <old EOA>)` then `grantRole(..., <new EOA>)` **on every chain including canonical Base**, not mirrors only; (2) `setRewardRemittanceKeeper(<new EOA>)` on Base — a SEPARATE authority that revoking the role does not touch; (3) redeploy the Worker; (4) read both back per chain; (5) then sweep the old key's gas, as housekeeping. Full procedure in `OffChainRestore.md` §1 step 6, compromise branch. |
| `0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b` (public address) | frontend (`VITE_PUSH_CHANNEL_ADDRESS`) — no Worker binding | The Push channel-owner wallet's public side. Surfaced on the frontend via `VITE_PUSH_CHANNEL_ADDRESS` and rendered on `/alerts` as a "Subscribe on Push →" deep link. | Public — committed to `apps/defi/.env.example`, displayed to every user. | Public info; no compromise model. Changing it requires creating a new Push channel + 50-PUSH stake + frontend redeploy. Note that rotating the `PUSH_CHANNEL_PK` signer forces this too — both Workers derive the channel from the key, so a signer swap IS a channel change and the frontend value must move with it or subscribers land on a silent channel (IncidentRunbook, Push channel signer rotation; #1456). |
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
