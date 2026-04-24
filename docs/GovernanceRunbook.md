# Governance Runbook — Safe + Timelock + Guardian handover

This is the operational playbook for moving Vaipakam's privileged surface
off the deployer EOA and onto the Safe + Timelock + Guardian model.
Run it once per chain, per deployment. The code-side pieces are already
merged; the steps here are the on-chain ceremony the signers walk through.

## Model recap

Three roles, each with a different response budget:

| Role | Held by | Path | Delay | Can do |
|---|---|---|---|---|
| Owner | Governance Safe (e.g. 4/7) | via Timelock | 48h | `diamondCut`, `setZeroExProxy`, LZ `setConfig`, UUPS upgrades, `setGuardian`, `unpause` |
| Guardian | Incident-response Safe (e.g. 2/3) | direct | 0 | `pause()` on the Diamond and every LZ OApp |
| KYC Ops | Ops Safe (may equal Guardian) | direct | 0 | per-user tier bumps (`KYC_ADMIN_ROLE`) |

The Guardian exists to close the detect-to-freeze window that a 48h
timelock would otherwise introduce — the April 2026 cross-chain bridge
incident showed a 46-minute pause blocked ~$200M of follow-up drain,
which under a pure timelock would have been impossible. Unpause is
deliberately owner-only so a compromised Guardian cannot race the
incident team to re-enable a live contract.

## Pre-flight — one-time setup

1. **Deploy the Governance Safe.** Recommended 4/7 with signers from
   separate legal entities and geographies. Record the address as
   `GOVERNANCE_SAFE`.
2. **Deploy the Guardian Safe.** 2/3 is reasonable; signers should be
   the on-call rotation. Record as `GOVERNANCE_GUARDIAN`.
3. (Optional) **Deploy the KYC-ops Safe**, distinct from the Guardian
   if the signer sets differ. Otherwise reuse `GOVERNANCE_GUARDIAN` and
   let `GOVERNANCE_KYC_OPS` fall back to it.

All three Safes must be replicated on every chain Vaipakam is deployed
on, at the same address (via Safe's CreateCall / deterministic-deploy
path). Each chain's TimelockController is independent.

## Per-chain sequence

Target chains (Phase 1): Ethereum, Base, Arbitrum, Optimism, Polygon
zkEVM, BNB — mainnet and testnet each.

### 1. Deploy the Timelock

```bash
TIMELOCK_PROPOSER=<GOVERNANCE_SAFE> \
TIMELOCK_EXECUTOR=<GOVERNANCE_SAFE> \
forge script script/DeployTimelock.s.sol \
  --rpc-url $RPC --broadcast
```

Record the emitted address as `<CHAIN>_TIMELOCK_ADDRESS` (e.g.
`BASE_TIMELOCK_ADDRESS`) in your env / secrets store. 48h delay is the
default; override with `TIMELOCK_MIN_DELAY` for testnet rehearsals.

Executor of `GOVERNANCE_SAFE` means the Safe must actively confirm
both the schedule and the execute call — two points to abort a hostile
proposal. Setting executor to `address(0)` opens execution to anyone
after the delay; use only if the Safe may be unavailable.

### 2. Seed the ops roles on the Diamond

```bash
GOVERNANCE_GUARDIAN=<GUARDIAN_SAFE> \
GOVERNANCE_KYC_OPS=<KYC_OPS_SAFE>   # optional, defaults to guardian
forge script script/GrantOpsRoles.s.sol \
  --rpc-url $RPC --broadcast
```

Grants `PAUSER_ROLE` to the Guardian and `KYC_ADMIN_ROLE` to KYC ops on
the Diamond. Must run **before** step 3, otherwise the deployer
renounces both roles and strands them.

### 3. Hand Diamond ownership and admin roles to the Timelock

```bash
CONFIRM_HANDOVER=YES \
forge script script/TransferAdminToTimelock.s.sol \
  --rpc-url $RPC --broadcast
```

Transfers Diamond `owner`, `DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`,
`ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `ESCROW_ADMIN_ROLE` to the
Timelock; renounces them on the deployer. `PAUSER_ROLE` and
`KYC_ADMIN_ROLE` stay on the Guardian / KYC ops Safes.

After this tx lands the Diamond is fully timelock-controlled. Any
further admin action must be Safe-proposed → 48h wait →
Safe-executed.

### 4. Migrate OApp + VPFIToken ownership

```bash
CONFIRM_HANDOVER=YES \
GOVERNANCE_GUARDIAN=<GUARDIAN_SAFE> \
forge script script/MigrateOAppGovernance.s.sol \
  --rpc-url $RPC --broadcast
```

For every LayerZero OApp deployed on this chain (canonical has
`VPFIOFTAdapter` + `VPFIBuyReceiver` + `VaipakamRewardOApp`, mirror
chains have `VPFIMirror` + `VPFIBuyAdapter` + `VaipakamRewardOApp`),
the script:

1. Calls `setGuardian(guardian)` while the deployer still owns it.
2. Calls `transferOwnership(timelock)` — an Ownable2Step **propose**.

Addresses are pulled from per-chain env vars (`<CHAIN>_VPFI_TOKEN_ADDRESS`,
`<CHAIN>_VPFI_OFT_ADAPTER_ADDRESS`, etc.). Missing / zero entries are
silently skipped so the same script runs on canonical and mirror chains.

### 5. Safe-schedule `acceptOwnership()` on each 2-step contract

After step 4, each OApp (and `VPFIToken` on canonical) has the Timelock
listed as *pending* owner. Ownership doesn't transfer until the new
owner calls `acceptOwnership()`. Since the Timelock IS the new owner,
someone must schedule that call through the Timelock.

For each 2-step target, from the Governance Safe UI:

1. Compose a Safe tx calling `TimelockController.schedule(target,
   value=0, data=acceptOwnership(), predecessor=0, salt=<unique>,
   delay=48h)`.
2. Confirm + execute (the Safe threshold). This queues the call.
3. Wait 48h.
4. Compose a second Safe tx calling `TimelockController.execute(target,
   value=0, data=acceptOwnership(), predecessor=0, salt=<same>)`.
5. Confirm + execute. The Timelock now calls `acceptOwnership()` and
   becomes the sole owner.

Repeat for every 2-step target on the chain. These can be batched into
a single Safe multi-send to avoid N separate signing ceremonies.

### 6. Readback verification

Per chain, confirm:

```solidity
// Diamond
IERC173(diamond).owner()                        == timelock
ac.hasRole(DEFAULT_ADMIN_ROLE, timelock)        == true
ac.hasRole(DEFAULT_ADMIN_ROLE, deployerEOA)     == false
ac.hasRole(PAUSER_ROLE, guardian)               == true
ac.hasRole(PAUSER_ROLE, deployerEOA)            == false

// VPFIToken (canonical only)
Ownable2Step(vpfiToken).owner()                 == timelock

// Each LZ OApp
Ownable2Step(oapp).owner()                      == timelock
LZGuardianPausable(oapp).guardian()             == guardian
```

A Foundry test `test/GovernanceHandover.t.sol` can drive all of these
in one pass against a fork of the target chain; add that to CI as a
pre-mainnet gate alongside `LZConfig.t.sol`.

## Day-to-day operations after handover

### Routine admin action (e.g. tweak a risk param)

1. Governance Safe proposes `timelock.schedule(target=diamond, ...,
   data=encoded call, delay=48h)`.
2. Threshold signs + executes. Tx is now queued.
3. 48h elapses (off-chain monitoring emits alerts on all queued txs).
4. Governance Safe proposes `timelock.execute(target=diamond, ...)`.
5. Threshold signs + executes. The Diamond call fires.

Users observe every queued admin action via the `CallScheduled` and
`CallExecuted` events on the Timelock contract. A public subgraph /
dashboard surfacing these is recommended but not strictly required.

### Incident response — pause

Guardian Safe directly calls `pause()` on the relevant contract:

- `AdminFacet.pause()` on the Diamond — halts every `whenNotPaused`
  Diamond entry point.
- `VPFIOFTAdapter.pause()` / `VPFIMirror.pause()` / etc. on each LZ
  contract — halts send and receive legs.

No schedule / delay — the call lands inside one block. Pause event
emitted on-chain; off-chain alerting should trigger a broader
incident-response runbook.

### Incident response — unpause

Unpause goes through the full Timelock path (48h). Recovery cannot
race the incident team — if 48h of market exposure is unacceptable,
the correct move is a separate surgical fix (facet upgrade, parameter
change) also queued via Timelock, then unpause.

### Rotating a Safe signer

Handled by the Safe's internal Modules / Owners page. No Vaipakam-side
ceremony needed — the Safe retains its address; only its signer set
changes.

### Rotating the Guardian

1. Governance Safe schedules `timelock.schedule(target=diamond, ...,
   data=grantRole(PAUSER_ROLE, newGuardian))`.
2. Wait 48h. Execute. New Guardian now holds `PAUSER_ROLE`.
3. For each OApp: schedule `timelock.schedule(target=oapp, ...,
   data=setGuardian(newGuardian))`. Wait 48h. Execute.
4. Governance Safe schedules `timelock.schedule(target=diamond, ...,
   data=revokeRole(PAUSER_ROLE, oldGuardian))`. Wait 48h. Execute.

Order matters — install the new Guardian before revoking the old, so
the pause surface is never unmanned.

### Rotating the Timelock itself

Deploy a fresh `TimelockController` with the Safe as proposer. From
the current Governance Safe:

1. Schedule `diamond.transferOwnership(newTimelock)` through the old
   Timelock. Also schedule `grantRole` on every admin role to the new
   Timelock, and `revokeRole` on every admin role from the old one.
2. For each Ownable2Step target (VPFIToken + every OApp): schedule
   `transferOwnership(newTimelock)` through the old Timelock.
3. Wait 48h. Execute all.
4. From the Safe, schedule `newTimelock.schedule(acceptOwnership())`
   against every 2-step contract. Wait 48h. Execute.
5. Retire the old Timelock address from `<CHAIN>_TIMELOCK_ADDRESS`.

## Testnet rehearsal

Before mainnet:

- Deploy all three Safes on Sepolia / Base Sepolia / Arb Sepolia /
  OP Sepolia / BNB Testnet / Polygon zkEVM Cardona at the same address
  as the intended mainnet ones (via CreateCall).
- Walk steps 1–6 end-to-end against each testnet Diamond with
  `TIMELOCK_MIN_DELAY=3600` (1h) to compress the rehearsal.
- Confirm `GovernanceHandover.t.sol` passes against each testnet fork
  before re-deploying with the 48h mainnet delay.

## Known trade-offs

- **48h on unpause is long.** The alternative (a Guardian unpause
  surface) lets a compromised Guardian re-open an incident mid-
  response. We accept 48h as the cost of a single trust assumption.
- **Timelock can't block a Safe-signer compromise.** If N-of-M Safe
  signers are compromised the attacker can schedule any call. Mitigation
  is social / operational: off-chain alerts on `CallScheduled` events
  give 48h for white-hat cancellation via the Safe's CANCELLER_ROLE
  (held by the Safe itself).
- **Open execution vs Safe-only execution.** Open execution (executor
  = `address(0)`) means anyone can execute after delay; useful if the
  Safe is unavailable, but removes a cancellation checkpoint. Current
  default is Safe-only; flip per chain if availability concerns dominate.
