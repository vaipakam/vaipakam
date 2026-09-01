# Governance Runbook — Safe + Timelock + Guardian handover

This is the operational playbook for moving Vaipakam's privileged surface
off the deployer EOA and onto the Safe + Timelock + Guardian model.
Run it once per chain, per deployment. The code-side pieces are already
merged; the steps here are the on-chain ceremony the signers walk through.

## Model recap

Three roles, each with a different response budget:

| Role | Held by | Path | Delay | Can do |
|---|---|---|---|---|
| Owner | Governance Safe (e.g. 4/7) | via Timelock | 48h | `diamondCut`, `setZeroExProxy`, CCIP messenger/channel config, UUPS upgrades, `setGuardian`, `unpause` |
| Guardian | Incident-response Safe (e.g. 2/3) | direct | 0 | `pause()` on the Diamond and every `GuardianPausable` cross-chain contract |
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
`ORACLE_ADMIN_ROLE`, `RISK_ADMIN_ROLE`, `VAULT_ADMIN_ROLE` to the
Timelock; renounces them on the deployer. `PAUSER_ROLE` and
`KYC_ADMIN_ROLE` stay on the Guardian / KYC ops Safes.

After this tx lands the Diamond is fully timelock-controlled. Any
further admin action must be Safe-proposed → 48h wait →
Safe-executed.

### 4. Migrate cross-chain + VPFIToken ownership

```bash
CONFIRM_HANDOVER=YES \
GOVERNANCE_GUARDIAN=<GUARDIAN_SAFE> \
forge script script/Handover.s.sol \
  --rpc-url $RPC --broadcast
```

For every cross-chain contract deployed on this chain (canonical has
`CcipMessenger` + `VaipakamRewardMessenger` + the canonical
`VPFIToken` and its CCIP `LockReleaseTokenPool`; mirror chains have
`CcipMessenger` + `VaipakamRewardMessenger` + `VPFIMirrorToken` + the
CCIP `BurnMintTokenPool`; chains with remittance/return receivers include
those too),
the script:

1. Calls `setGuardian(guardian)` while the deployer still owns it
   (every `GuardianPausable` contract — see
   `docs/adr/0004-ccip-over-layerzero.md` for the coverage map;
   `VpfiPoolRateGovernor` is the documented exception).
2. Calls `transferOwnership(timelock)` — an Ownable2Step **propose**.

Addresses are pulled from per-chain env vars (`<CHAIN>_VPFI_TOKEN_ADDRESS`,
`<CHAIN>_CCIP_MESSENGER_ADDRESS`, etc.). Missing / zero entries are
silently skipped so the same script runs on canonical and mirror chains.

### 5. Safe-schedule `acceptOwnership()` on each 2-step contract

After step 4, each cross-chain Ownable2Step contract (and `VPFIToken` on canonical) has the Timelock
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

**And the CCT administrator, which is NOT an `acceptOwnership()` call.** Where
`CCIP_TOKEN_ADMIN_REGISTRY` is configured, `Handover.s.sol` also runs
`transferAdminRole` on the CCIP `TokenAdminRegistry` for VPFI — a two-step
transfer on a different contract, with a different accept function. Schedule and
execute it the same way, with the registry as the target:

```
TimelockController.schedule(
  target = <CCIP TokenAdminRegistry>,
  data   = acceptAdminRole(<vpfiToken>),
  ... same predecessor / salt / 48h delay as above)
```

Miss this and step 6's administrator readback fails with no step in this runbook
able to fix it — the deployer stays administrator and can still call `setPool` on
the live VPFI token. It batches into the same multi-send as the ownership
acceptances.

**But read the handover's own output first — this leg is CONDITIONAL.**
`_transferCctAdmin` returns false and SKIPS when the signing EOA is not the
token's current administrator, which is a supported path (CCT registration may
have been done by a separate token owner). It prints `SKIP CCT admin transfer`
with the current administrator and the signing key. In that case there is no
pending transfer to accept and scheduling `acceptAdminRole` REVERTS — so confirm
`getTokenConfig(vpfiToken).pendingAdministrator == timelock` before scheduling.
If it is not pending, the CURRENT administrator must run `transferAdminRole`
first; that is a step outside this ceremony and it blocks step 6 until it is
done. Do not read the skip as "not applicable" — the administrator is still an
EOA either way.

**The ORDINARY ownership legs are conditional the same way — the round-6 warning
above was scoped only to the CCT admin leg, and it is not the only skip.**
`_transferCrossChainOwnership` follows the identical supported skip path:
when the signing EOA is not a target's current `owner()` it prints
`SKIP ownership transfer` and creates NO pending transfer (`Handover.s.sol`, the
`currentOwner != signer` branch). Step 5 then instructs the operator to schedule
`acceptOwnership()` for every target; on any skipped target that call REVERTS,
and — worse than the CCT case, which only stalls step 6 — a target still owned by
another key is left OUTSIDE governance with no recovery step documented here. So
before scheduling each ownership acceptance, require the LIVE readback —
`Ownable2Step(target).pendingOwner() == timelock`, or for the pool, whose pending
owner is private, `OwnershipTransferRequested(_, timelock)` outstanding under the
same log rule as step 6. The handover script's output is corroborating evidence
and **not** a substitute: both OpenZeppelin's and Chainlink's `transferOwnership`
REPLACE an outstanding proposal rather than rejecting it, so a successful run
recorded an hour ago says nothing about who is pending now. A stale "yes" here
schedules a Timelock action that reverts after its delay and stalls the
handover. Where it is not
pending, the current owner must run `transferOwnership` first, exactly as for the
CCT leg. Schedule an acceptance only for targets that are actually pending to the
timelock.

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
Ownable2Step(vpfiToken).pendingOwner()          == address(0)

// EVERY cross-chain target `Handover.s.sol` transfers — not only the
// GuardianPausable ones. `_transferCrossChainOwnership` covers: ccipMessenger,
// vpfiTokenPool, vpfiPoolRateGovernor, rewardMessenger, vpfiMirror,
// buybackRemittanceReceiver, rewardRemittanceReceiver, vpfiReturnSender,
// vpfiReturnReceiver.
Ownable2Step(target).owner()                    == timelock
Ownable2Step(target).pendingOwner()             == address(0)

// EXCEPT vpfiTokenPool. Eight of the nine are OpenZeppelin
// `Ownable2StepUpgradeable` and expose `pendingOwner()`. The pool is
// CHAINLINK's `Ownable2Step` (via `Ownable2StepMsgSender`), where
// `s_pendingOwner` is PRIVATE and the only external surface is `owner()`,
// `transferOwnership()` and `acceptOwnership()` — so the call above REVERTS
// on it, and an operator who hits that revert either stalls or skips the
// pending-takeover check entirely. Establish it from the log instead:
//   the LAST OwnershipTransferRequested(from, to) on the pool
//   must be followed by OwnershipTransferred(from, to) with the SAME `to`
//   and no later Requested event outstanding.
// Both events are emitted by that base, so this is decidable from the chain.
//
// ONE terminal exception: `to == address(0)` is how an outstanding pool
// handover is CANCELLED. Chainlink's `_transferOwnership` rejects only
// `to == msg.sender`, so zero is stored and a Requested event is emitted —
// and no Transferred can ever follow it, because address(0) cannot call
// `acceptOwnership()`. A last Requested naming zero, together with
// `owner() == timelock`, is therefore a SAFE cleared state, not an
// unfinished one. Requiring a matching Transferred for every request would
// make a correctly cancelled transfer unpassable.

// guardian() ONLY where the contract carries GuardianPausable.
// `VpfiPoolRateGovernor` does NOT — it is Ownable2Step alone, and its owner
// sets every lane's rate limits and authorizes UUPS upgrades, so scoping the
// ownership assertions to "the GuardianPausable ones" silently exempts it.
GuardianPausable(target).guardian()             == guardian

// The CCT ADMINISTRATOR, where CCIP_TOKEN_ADMIN_REGISTRY is configured. This is
// a SEPARATE two-step transfer from any of the above — `transferAdminRole` is
// leg one and the Timelock `acceptAdminRole`s later — and no Ownable readback
// touches it. Skip the accept and the deployer can still call `setPool`; leave a
// stale pending and that address can accept afterwards and replace the live VPFI
// pool, including after `D*`.
registry.getTokenConfig(vpfiToken).administrator        == timelock
registry.getTokenConfig(vpfiToken).pendingAdministrator == address(0)
```

**The `pendingOwner()` lines are not decoration.** `Ownable2Step` completes a
transfer in two steps and only the second clears the pending address, so
`owner() == timelock` holds perfectly well while some other key is still able to
call `acceptOwnership()`. Checking the owner alone accepts a handover that has
not finished.

A Foundry test `test/GovernanceHandover.t.sol` can drive all of these
in one pass against a fork of the target chain; add that to CI as a
pre-mainnet gate alongside `LZConfig.t.sol`.

### 6.1 Phase 7 oracle + DEX redundancy bring-up (added 2026-04-25)

After the per-chain handover lands but BEFORE the first user loan
settles, the deployer (under the Timelock + Safe path) must wire
the Phase 7 admin surface. Skipping any of these leaves either
liquidations (Phase 7a) or oracle pricing (Phase 7b) operating in a
degraded single-source / single-venue posture.

**Phase 7a — swap-adapter chain** (`AdminFacet`):

```solidity
// Register all four production swap adapters in priority order.
// A diamond with zero adapters reverts every triggerLiquidation /
// triggerDefault call, so this MUST land before any loan settles.
diamond.addSwapAdapter(zeroExAdapter);    // slot 0
diamond.addSwapAdapter(oneInchAdapter);   // slot 1
diamond.addSwapAdapter(uniV3Adapter);     // slot 2
diamond.addSwapAdapter(balancerV2Adapter); // slot 3
```

**Phase 7b.1 — multi-venue liquidity** (`AdminFacet`):

```solidity
// In addition to the existing setUniswapV3Factory call, register
// V3-fork DEX V3 and V3-fork DEX V3 factories per the chain matrix
// in OraclePolicy.md. Setting any to zero disables that leg.
diamond.setPancakeswapV3Factory(panV3FactoryThisChain);
diamond.setSushiswapV3Factory(sushiV3FactoryThisChain);
```

**Phase 7b.2 — secondary price-oracle quorum** (`OracleAdminFacet`):

```solidity
// Wire at least 2 of the 3 secondary oracles so the Soft 2-of-N
// quorum delivers actual cross-provider redundancy. With < 2
// configured the check degrades gracefully to Chainlink-only.
diamond.setTellorOracle(tellorOnThisChain);
diamond.setApi3ServerV1(api3ServerOnThisChain);
diamond.setDIAOracleV2(diaOnThisChain);
// Defaults are 5% deviation and 1h staleness; tighten if desired.
diamond.setSecondaryOracleMaxDeviationBps(500);
diamond.setSecondaryOracleMaxStaleness(3600);
```

**Readback verification (per chain):**

```solidity
AdminFacet(diamond).getSwapAdapters().length            >= 1
AdminFacet(diamond).getPancakeswapV3Factory()           // non-zero where deployed
AdminFacet(diamond).getSushiswapV3Factory()             // non-zero where deployed
OracleAdminFacet(diamond).getTellorOracle()             // expected address
OracleAdminFacet(diamond).getApi3ServerV1()             // expected address
OracleAdminFacet(diamond).getDIAOracleV2()              // expected address
OracleAdminFacet(diamond).getSecondaryOracleMaxDeviationBps() // 500 default
OracleAdminFacet(diamond).getSecondaryOracleMaxStaleness()    // 3600 default
```

A future `test/OraclePolicyReadback.t.sol` should encode all of these
as fork-CI gates. Until then, use the deploy script's verification
log as the artifact.

### 6.2 Aggregator adapter Settler-rotation (added 2026-05-08)

The `ZeroExAggregatorAdapter` instance registered in slot 0 of the
swap-adapter chain (per §6.1) carries an internal allowlist of legal
0x Settler call destinations. 0x rotates Settler addresses with each
release and varies them by route type, which means this allowlist
becomes a recurring governance action — NOT a one-time deploy
config — for the lifetime of the protocol.

**Why governance and not direct-EOA**: each adapter inherits OpenZeppelin
`Ownable2Step`; its owner is the per-chain `<CHAIN>_TIMELOCK_ADDRESS`
established by §3 of this runbook. Rotation calls therefore go through
the same propose-schedule-execute flow as every other privileged
diamond mutation, not via an operator hot key.

**Recurring action — when 0x ships a new Settler:**

1. **Detect.** The keeper bot's swap fetcher will start surfacing a
   new `transaction.to` value in fresh `/swap/allowance-holder/quote`
   responses. Until the new address is added to the allowlist, the
   on-chain `triggerLiquidation` path through 0x reverts with
   `SwapTargetNotAllowed(<newSettler>)` and `LibSwap.swapWithFailover`
   falls through to the next adapter (1inch, then UniV3, then
   Balancer V2). The protocol stays live; only the 0x leg is
   degraded.
2. **Propose.** Schedule a Timelock call against the affected
   adapter (the address logged in the deploy artifact under the
   `swapAdapter[0]` field of `addresses.json`). The call is the
   adapter's own `addSwapTarget(<newSettler>)`, NOT a diamond
   selector.
3. **Wait the 48h delay**, then execute.
4. **Verify.** Read `swapTargetAllowed(<newSettler>) == true` and
   `swapTargetCount > prior` on the adapter. Re-trigger one stale
   quote through the 0x path on a low-stakes loan to confirm the
   liquidation now lands on slot 0 instead of falling through.
5. **(Optional) deprecate the old Settler.** When 0x marks an old
   Settler as deprecated AND the operator has confirmed no in-flight
   quotes still reference it (a few minutes of stale-quote tail is
   normal), schedule `removeSwapTarget(<oldSettler>)`. The adapter
   refuses to remove the LAST allowlisted entry — deprecation always
   requires `addSwapTarget` to land first.

**One-time action — initial Settler seed at deploy time:**
already covered in the Deployment Runbook's "Aggregator adapter
construction — allowanceTarget split" section. The seed is set in
the constructor; this Governance section covers what happens
afterwards.

**1inch adapter rotation**: not currently expected. 1inch v6 uses a
single AggregationRouterV6 address (`0x111111125421cA6dc452d289314280a0f8842A65`,
identical on every chain). If 1inch ever ships a v7 with a new
router, the same `addSwapTarget` / `removeSwapTarget` flow applies
on the `OneInchAggregatorAdapter` instance.

**`allowanceTarget` rotation: not possible.** That field is immutable
on each adapter. If 0x ever moves the canonical AllowanceHolder
address (it hasn't and would be a multi-month telegraphed migration),
the response is to deploy a fresh `ZeroExAggregatorAdapter` against
the new AllowanceHolder, register it in the diamond via
`AdminFacet.addSwapAdapter`, and remove the old slot via
`AdminFacet.removeSwapAdapter` — i.e. a swap-adapter-chain rotation,
not a per-adapter mutation.

**Privileged-actions table (delta from §"Model recap"):**

| Role | Path | Delay | Adds |
|---|---|---|---|
| Owner (Governance Safe) | via Timelock | 48h | `ZeroExAggregatorAdapter.addSwapTarget(...)`, `ZeroExAggregatorAdapter.removeSwapTarget(...)`, equivalent on `OneInchAggregatorAdapter` |

### 6.3 Internal-liquidation match path bring-up (added 2026-05-15)

The internal-match path (B.2 from
`docs/internal/PendingTasks-2026-05-14.md`) ships dormant on
every fresh deploy. To enable per chain after audit sign-off:

| Step | Action | Why |
|---|---|---|
| 1 | Confirm `getInternalMatchConfigBundle()` returns `(false, 200, 100)` post-deploy — defaults landed. | Sanity check that the new selectors are cut into the diamond and the storage slots zero-resolve to library defaults. |
| 2 | Confirm `getTierLiquidationLtvBps()` returns `(9000, 8500, 8000)` post-deploy. | Per-tier liquidation thresholds replaced the retired per-asset `liqThresholdBps` in PR2; verify the defaults stuck. |
| 3 | Ensure keeper-bot deploy (`vaipakam-keeper-bot`) is live on this chain with the `internalMatcher` detector running. | The kill-switch alone enables the path; without a bot, no matches fire. |
| 4 | Governance Safe schedules `timelock.schedule(diamond, 0, setInternalMatchEnabled(true), 0, salt, 48h)`. | Same 48h-gated flow as every other tunable post-handover. |
| 5 | 48h later: Safe executes. `InternalMatchEnabledSet(true)` event emits. | Bots' next tick picks it up and starts matching eligible pairs. **#1896: `apps/keeper`'s matcher will NOT — it is unscheduled (`"crons": []`), so its next tick never comes.** The separate `vaipakam-keeper-bot` deployment from step 3 is unaffected and is what makes this step's expectation hold; if it is not running, enablement produces no matches at all and step 6 will read as a failed rollout rather than a stopped bot. |
| 6 | Monitor `InternalMatchExecuted` event volume + matcher wallet balances for one week. | Validate the match rate is non-zero and the priority window is producing the expected 1% saving per leg. |
| 7 | Optional follow-up: tune the priority window or incentive via `timelock.schedule(setInternalMatchConfig(window, incentive))`. | Only after a week of baseline data. Stay inside the `[0,500]` window cap + `[0,300]` incentive cap. |

**What stays the same after enablement**: external `triggerLiquidation` still callable at LTV ≥ `loan.liquidationLtvBpsAtInit + window`. The internal path is additive, not a replacement — when no match candidate exists, the loan deteriorates through the priority window and external takes over as before.

**Tunable knobs added in PR2 + PR3** (all ADMIN_ROLE, timelock-gated post-handover):

| Setter | Range | Default |
|---|---|---|
| `setTierLiquidationLtvBps(t1, t2, t3)` | each `[5000, 9500]`; `t1 ≥ t2 ≥ t3` enforced | 9000 / 8500 / 8000 |
| `setInternalMatchEnabled(bool)` | — | `false` |
| `setInternalMatchConfig(windowBps, incentiveBps)` | window `[0, 500]`, incentive `[0, 300]` | 200, 100 |

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

#### Fee retunes apply PROSPECTIVELY (#957)

`ConfigFacet.setFeesConfig(treasuryFeeBps, loanInitiationFeeBps)` — like the
loan-admission Health-Factor floor — is **snapshotted onto each loan at
origination**. A retune therefore affects **only loans created after it lands**;
every already-open loan keeps settling at the treasury-fee and initiation-fee
rates it was born under (`Loan.treasuryFeeBpsAtInit` /
`loanInitiationFeeBpsAtInit`, resolved via `LibVaipakam.effectiveTreasuryFeeBps`).
Operationally this means:

- A treasury-fee change does **not** retroactively re-price the interest
  split of the open book — do not expect settlement revenue on existing
  loans to move when the knob changes; the effect ramps in only as new
  loans originate.
- There is **no migration or sweep** to apply a new rate to open loans, and
  none should be attempted — the snapshot is the guarantee to counterparties
  who reviewed the offer.
- The snapshot is taken when the *accept transaction executes*, not when the
  offer is signed, so a retune landing between a counterparty signing and the
  accept being included still applies to that new loan. Only *post-origination*
  retunes are neutralised. If a retune must be coordinated with in-flight
  signings, pause the affected offer surface first.
- Pre-#957 loans (none on a fresh mainnet deploy) carry a zero snapshot and
  fall back to the live knob.

### Contract change → public keeper-bot sync (Phase 9.A)

Whenever a contract change touches a selector the public reference
keeper bot reads (`MetricsFacet.getActiveLoansCount /
getActiveLoansPaginated`, `RiskFacet.calculateHealthFactor /
triggerLiquidation`, `LoanFacet.getLoanDetails`), the
`vaipakam-keeper-bot` sibling repo's checked-in ABIs need to be
regenerated to match. **This is part of the same PR as the
contract change** — shipping a contract update without the
corresponding bot ABI sync leaves the public keeper bot reverting
in production with opaque "function selector not found" failures.

```bash
# In this monorepo, after `forge build` is clean:
KEEPER_BOT_DIR=../../vaipakam-keeper-bot \
  bash contracts/script/exportAbis.sh

# In the keeper-bot repo:
cd ../../vaipakam-keeper-bot
git diff src/abis/      # review the change
npm run typecheck       # confirm bot still builds
git commit -am 'Sync ABIs with vaipakam@<commit>'
git push
```

The script writes `src/abis/_source.json` with the monorepo's
commit hash + UTC timestamp at export, so an auditor reviewing a
released bot version can correlate it to a specific contracts
state. CI in the keeper-bot repo runs the `abi-shape` job on
every PR; well-formed JSONs land green, hand-edited / pretty-
table outputs fail loud.

Full protocol behind this surface is documented in
[`CLAUDE.md`](../../CLAUDE.md) → "Keeper-bot ABI sync" and
`docs/ReleaseNotes-2026-04-25.md` → Phase 9.A "Sync mechanism".

### Incident response — pause

Guardian Safe directly calls `pause()` on the relevant contract:

- `AdminFacet.pause()` on the Diamond — halts every `whenNotPaused`
  Diamond entry point.
- `CcipMessenger.pause()` / `VaipakamRewardMessenger.pause()` /
  `RewardRemittanceReceiver.pause()` / `BuybackRemittanceReceiver.pause()` /
  `VpfiReturnSender.pause()` / `VpfiReturnReceiver.pause()` /
  `VPFIMirrorToken.pause()` — halts send and receive legs on every
  cross-chain contract carrying `GuardianPausable`.

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

### Bumping the Terms of Service

The on-chain ToS gate is the `(currentTosVersion, currentTosHash)`
pair on `LegalFacet`. The retail launch ships with
`currentTosVersion == 0`, which short-circuits `isAccepted(...)` to
`true` for every wallet — the gate is dormant. Whenever the canonical
ToS text changes (`docs/Terms/TermsOfService.md` is the source of
truth; since #1998 `apps/www` RENDERS the text from a frozen
byte-copy of it and serves every published version at a pinned route
`/terms/v<N>` — there is no hand-mirrored transcription to keep in
sync), governance must also bump the on-chain pair so users re-sign
before the frontend re-opens.

1. Edit the canonical text in `docs/Terms/TermsOfService.md`, then
   publish it as the NEW version in `apps/www`: copy the file
   byte-for-byte to `apps/www/src/pages/terms/v<N>.md` (N = the new
   version number) and add the matching entry — version, effective
   date, keccak256 of those bytes — to
   `apps/www/src/pages/terms/versions.ts`. **Never edit a published
   `v<M>.md` or its registry entry** — old versions stay frozen at
   their pinned routes because acceptances were recorded against
   them. The page picks the new file up automatically. Two separate
   guards enforce this, and they catch DIFFERENT things: the
   `check-terms-canonical-hash` guard (in `apps/www`'s typecheck,
   which CI runs for `docs/Terms/` changes too) fails the build when
   the frozen copy, the registry hash, and the canonical document do
   not all agree *within one tree* — but an edit that rewrites a
   published archive AND its registered hash together still agrees
   with itself, so cross-commit immutability is enforced by the
   "Published Terms archives are unchanged from the base" step
   inside CI's REQUIRED `workspaces` job, which diffs the PR against
   its base and rejects any change to a `v<M>.md` that exists there.
   A local typecheck alone therefore CANNOT confirm an archive edit
   is legal; only the base diff can, and it will refuse it.
2. The content hash for `setCurrentTos` is the same value the site
   publishes: each `/terms/v<N>` page displays its "canonical source
   fingerprint" — keccak256 over the exact bytes of the version's
   frozen Markdown, which are the bytes the page renders — and the
   guard script recomputes it on every typecheck. Adopt that
   derivation in the proposal (record it there so the hash can be
   independently re-derived from the text it covers); with it, users
   and auditors can compare the fingerprint the site publishes
   against the hash the acceptance gate shows from chain. Note the
   gate itself only ECHOES the on-chain hash (`useTosAcceptance`
   reads and re-submits it; it derives nothing) — the cross-check
   from text to hash lives in the guard script and in anyone
   re-deriving the fingerprint, not in the app.
3. **Deploy the updated `apps/www` FIRST** and verify `/terms/v<N>`
   serves the new text (and that its displayed fingerprint equals
   the hash the proposal will commit). Order matters because the
   frontend only echoes `currentTosHash`, so activating the hash
   before the text is live would open a window where users record
   acceptance of terms the public site does not yet show — with
   versioned hosting that window fails SAFE rather than silently: the
   acceptance gate links the version-pinned route for the version it
   read from chain, so a not-yet-published version renders an honest
   "not published here" explainer telling the user not to accept
   text they cannot read, instead of someone else's text. The
   reverse interval (page live, `setCurrentTos` not yet executed) is
   also harmless now: `/terms` already shows the new text, but the
   gate's pinned link still resolves to the exact old version its
   hash pins — the user reads what they record.
4. Governance Safe schedules
   `timelock.schedule(target=diamond, data=setCurrentTos(newVersion,
   newHash), delay=48h)`. `newVersion` MUST strictly exceed
   `currentTosVersion` — the setter rejects replays and downgrades.
   (The 48h delay also gives step 3's deploy time to be verified
   live before the hash flips.)
5. Wait 48h. Execute. The Diamond emits `CurrentTosUpdated(prev,
   newVersion, newHash)`. From this moment new acceptances bind to
   the new hash, whose text has been publicly rendered since step 3.
6. Existing on-chain positions are NOT affected — the gate is a
   frontend-level UX, not a protocol-level deny. Users keep their
   loans / claims / repays without re-signing; only NEW state-creating
   entries through the Vaipakam frontend require a fresh acceptance.

When `currentTosVersion == 0` (retail-launch state), step 1 ships
without on-chain action. Future bumps from version 0 → version 1 are
the moment the gate becomes active across all live wallets.

### Enabling progressive risk access (#671)

The progressive-risk gate (per-vault tiers + per-pair illiquid consent +
optional strict mode) ships **off** behind `riskAccessGateEnabled`
(`ConfigFacet`), default `false` — a fresh deployment behaves exactly as
before. It is NOT part of the retail launch; this section applies only
when a deployment deliberately turns it on. Two anchors back it:
`currentRiskTermsVersion` (a numeric counter, the freshness anchor for
contract-written tier/consent stamps) and `currentRiskTermsHash` (an
**unguessable secret**, the anchor every signed grant binds — see
[`AcceptAckFreshnessAnchorDesign.md`](../DesignsAndPlans/AcceptAckFreshnessAnchorDesign.md)).
Both start at zero.

**Hard precondition — reveal a real anchor BEFORE enabling the gate.**
While `currentRiskTermsHash == 0`, every relayed `*BySig` self-sovereign
grant reverts `RiskTermsHashStale` (#737) and the acceptance-ack anchor
would bind the guessable zero value. Enabling the gate before the first
reveal therefore bricks the relayed path and ships no freshness guarantee.
Always run the commit–reveal first.

The anchor is published via a two-step commit–reveal split across two
roles ON PURPOSE: the hiding commit goes through the slow/timelock
authority so its queued calldata never exposes the future secret, and the
reveal-and-activate runs through the **off-timelock** `PAUSER_ROLE` (which
`TransferAdminToTimelock` deliberately does NOT migrate) so the secret is
never parked in a public timelock queue. Steps:

1. **Mint a fresh random secret** `termsAnchor` (32 bytes) per
   diamond/chain — NEVER the public ToS / risk-terms document hash (a
   published hash is pre-stampable), and NEVER reuse one secret across
   chains (revealing on chain A leaks it for a still-pending chain B; the
   ledger is single-use per diamond). Keep it secret until step 4.
2. **Schedule op A via the Timelock (`ADMIN_ROLE`): BATCH
   `setRiskAccessUnlockCooldown(seconds)` + `commitRiskTermsBump(
   keccak256(abi.encode(termsAnchor)))` into one operation.** Batching makes
   the cooldown go live the instant the commit executes — before any reveal —
   so the first opt-ups can't arm at cooldown 0 (the direct opt-up setters
   stamp each `unlockAt` from whatever cooldown is current and never pick up a
   later value). Set the cooldown **≥ the Timelock delay** (see step 5). The
   commitment is the only call tied to the future anchor and reveals nothing.
   Skip the cooldown call only if you want immediate opt-ups AND accept the
   step-5 window. **If you supersede this commit** (the anchor leaked or was
   wrong), explicitly `cancel` the old Timelock operation — the facet
   overwrites `pendingRiskTermsCommitment` only when the NEW commit executes,
   so an un-cancelled old one can execute later and clobber it (stalling the
   reveal, or letting the `PAUSER` reveal an obsolete anchor).
3. Wait out the 48h, then **execute op A.** Verify on-chain BEFORE revealing:
   `getRiskAccessUnlockCooldown()` == your value, AND
   `getPendingRiskTermsCommitment() == keccak256(abi.encode(termsAnchor))`
   (the live pending commitment is yours, not a superseded one).
4. **Reveal.** The `PAUSER_ROLE` guardian calls
   `revealRiskTermsBump(termsAnchor)` directly (no Timelock delay — the reveal
   IS the activation, atomic). It bumps `currentRiskTermsVersion` to 1 and
   sets `currentRiskTermsHash`. The secret is exposed only in this tx's brief
   mempool window. **Verify `currentRiskTermsHash != 0`** before proceeding.
5. **Only AFTER the reveal is confirmed on-chain, schedule and (after its 48h)
   execute op B: `setRiskAccessGateEnabled(true)`.** Scheduling the gate flip
   *after* the reveal is deliberate: a flip pre-scheduled alongside op A
   carries **no on-chain dependency on the reveal**, so once its delay elapses
   it can be executed first (especially with a permissionless Timelock
   executor) — turning the gate on while `currentRiskTermsHash` is still 0,
   which bricks the relayed `*BySig` path (it reverts) and binds the accept
   ack to the guessable zero. The cost of scheduling-after is the gate's own
   48h delay following the reveal: during it the anchor is public and users
   can arm opt-ups, which is exactly why step 2 sets the cooldown **≥ this
   delay** — any window-armed opt-up stays locked until the gate is live.
   (Advanced optimisation: to remove the window you MAY pre-schedule op B with
   op A, but ONLY if your Timelock executor is trusted / non-permissionless,
   so you can guarantee op B is executed after step 4 and never before.)

**Changing the risk terms later** repeats op A's `commitRiskTermsBump` + the
`revealRiskTermsBump` (steps 2–4; the cooldown and gate flip are one-time
enablement steps you skip) with a fresh secret:
each reveal bumps the version, and every held tier / per-pair consent /
mid-tier ack whose anchor is now stale **re-locks at read time** with zero
per-user writes — users re-affirm against the new terms to regain access.
Each anchor is single-use for the protocol's lifetime, so rolling A→B→A
can never revive a stale grant. Publish the human-readable terms document
+ its (separate, public) hash off-chain for users to review.

**Disabling** is `setRiskAccessGateEnabled(false)` — a ratchet-down that
makes the gate a no-op again without touching any per-vault state.

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

## VPFI recycling — activation ceremony (M7)

One-time, cross-chain, and **partly irreversible**. Read the gates before
scheduling anything: the arming call cannot be undone, cannot be repeated, and
cannot be postponed once the day it names arrives.

Sourced from `docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md` §M7 and
verified against the contracts. Where the two disagreed, the contracts won.

**Order matters, and it is not the order the plan reads in.** Every keeper-side
prerequisite comes BEFORE the arming call. Arming is a one-shot write that names
a future day; if a role grant, a balance, or a lane limit turns out to be wrong
afterwards, governance cannot move `D*` and the affected mirrors' claims stay
halted until the setup is repaired. Nothing below the arm is recoverable by
re-arming, so nothing that can fail belongs after it.

### Gate A — backing separation (NOT yet discharged)

Reward payouts must be bounded by funding **delivered for rewards**, not by the
Diamond's un-earmarked VPFI **balance**. Two of that balance's other claimants
are user collateral — a live swap-to-repay intent's `custodialCollateral`, and
liquidation `fallbackSnapshot` custody — so a payout drawing on the balance can
spend a borrower's collateral. This is a fund-safety gate, not an accounting one.

- **#1460 is closed and fixed.** `RewardClaimFacet` reverts
  `InteractionRewardBackingShort(payableFresh, backingRoom)` when a claim's fresh
  components will not fit the un-earmarked balance. It **reverts rather than
  truncating** on purpose: `backingRoom` rises when a remit lands, so truncating
  would delete value that was about to become payable.
- **The fund-safety half is #1566, and it is OPEN.** Do not arm until it closes
  — and **not until the fix is DEPLOYED on every Diamond you are arming.** Issue
  closure is not an on-chain safeguard: the arming setter checks authorization,
  canonical role, one-shot state and the future day, and nothing about which
  implementation is routed. A merged fix on an un-refreshed Diamond leaves the
  vulnerable claim path live. Assert the deployment, per chain, the same way the
  other code-slice gates in this section are asserted.

  **And on the ACTIVE-MIRROR branch, deployment is not the gate — the per-day
  funding property is.** Step 5 forbids propagation while any reachable mirror
  lacks that property, and a mirror learns `D*` only through propagation. So
  arming on "the fix is deployed" can leave an operator armed, with `D*`
  immutable, and the ceremony's own prohibition blocking the only route to
  completing the cutover. Before arming an active-mirror mesh, establish the
  property — a claim against a day whose budget has not arrived cannot consume
  value belonging to anything else — not merely that #1566's implementation is
  routed. On the dark branch this does not apply: arming Base IS the cutover and
  there is nothing to propagate.

> **#1498 is not the card to check.** It reads `closed / completed` and was the
> original number for this work; #1555's `Closes #1498` fired when only the
> de-duplication half landed, and the fund-safety half was re-filed as #1566.
> The completion plan and `LibVpfiRecycle`'s natspec both name #1566 now. If you
> arrive at #1498 from an older document, its green label is an artifact of that
> mis-scoped close, not evidence.

### Gate B — arming preconditions

M1b live (absorption has a live feed) **AND** one of:

- reward claims are Base-only / dark on every mirror, **or**
- M3 (Phase B′) complete **AND** #1434 has made mirror settlement reachable.

The dark-mirror branch does not require #1434. Only the M3 branch carries the
settlement-reachability condition. Gate A constrains **both** branches.

### Step 1 — enable the fee entitlement (chain-side, before the scan)

**Prove two code slices are live on THIS Diamond first.** The setter does not
enforce them and will enable happily without them: the loan-side reward cap
(PR-5c) and the settlement sweep that honours the lender Full stamp (PR-6).

**PR-6 IS discharged (#1947 closed 2026-08-26, verified against the API
2026-09-01) — but no deploy assertion bears on whether THIS Diamond runs the
fixed bytecode.** That distinction is the whole of this step, and an earlier
revision collapsed it into "PR-6 is NOT discharged", which halts enablement
indefinitely over work that has landed.
The only deploy assertion touching this flag pins it OFF on a fresh deploy
(`DeployDiamondIntegrationTest.t.sol`); it observes no settlement path at all,
and the setter checks only the chain role. Treat the whole of this step as a
MANUAL readback. The test corpus does cover the source behaviour of the swept
paths (`VPFIDiscountFacetTest`, `SwapToRepayFacetTest`), but no test can show
that THIS Diamond routes that bytecode, and none covers the recovery paths or
refinance at all — so a green suite is not evidence for this step. The RECOVERY paths — time-based
default, liquidation, discounted liquidation, split and partial (FIVE, not the
six an earlier revision of this step named — the periodic-interest
auto-liquidation leg deducts a handling fee on swap PROCEEDS and charges no
lender yield fee at all, so there is nothing there for the bump to reduce) —
still take the ordinary cut from recovered lender interest without consulting
the stamp; and refinance resolves the stamp against the STORED lender rather
than the current holder. **Partial liquidation is worse than the others**: it
deposits the lender share to `loan.lender` and deliberately writes no claim
record, so on a transferred position the previous lender keeps the proceeds
outright and the current holder has nothing to claim against — the discount is
the smaller half of that defect. (The collateral prepay-SALE terminals were named here
in an earlier revision and are REMOVED: their treasury leg is an ADDITIVE
consideration item funded from the sale price — the lender receives principal
plus interest GROSS and the BORROWER's residual bears the fee — so there is no
lender discount to deliver and applying the bump would subsidise the borrower.) Frozen §F2
is "at every lender-yield settlement", so that is a live divergence and a hard
precondition for this step, not a scope boundary. Enabling here while it stands
collects `C*` for a discount a lender can lose depending on how their loan ends.
The frozen rule is `### F2 — Lender yield fee (frozen — rev 8)` in
`docs/DesignsAndPlans/VpfiAbsorptionDistributionFormulaRedesign.md` (read its two
IN-PLACE SUPERSESSION notes before acting on it: the F2 pseudocode keys the
discount on `loan.lender` and must be read as the current position-NFT holder,
and its C1 gate names PR-5c alone and must be read as also requiring #1947) — NOT
`TokenomicsTechSpec`, which has no §F2 of its own. The open implementation card
is **#1947**; #1383 is the COMPLETED repayment/early-close family and is not the
blocker. See also `TokenomicsTechSpec`'s lender-settlement section for the
discharge criterion.
Without the cap, a Full loan enters the uncapped reward path; without the sweep,
a user can pay `C*` for a discount settlement then ignores. This bites on partial
or stacked upgrades, where a Diamond can have M1b live and still be missing
either.

**Do NOT "read back the deploy assertions" for these** — an earlier revision of
this step said to, and there is nothing to read: the only deploy assertion
touching this flag pins it OFF on a fresh deploy and observes no settlement path.
Establish both by hand on the TARGET Diamond before scheduling anything:

- **PR-5c (loan-side reward cap) — this is NOT one facet.** The per-loan cap is
  STAMPED by `FeeEntitlementFacet` and ENFORCED through `LibInteractionRewards`,
  which is a library and is therefore inlined into **every** reward-counting
  facet — `RewardClaimFacet` and `RewardHorizonSweepFacet` among them. An old
  stamping facet leaves new loans unstamped; an old payout or sweep facet ignores
  the cap. Resolving one selector and reading the haircut knob proves neither.
  On a partial or stacked target, verify that the whole set was refreshed
  together (this is what `RefreshAllFacetsInPlace` exists for) rather than
  spot-checking a facet, and read the cap knob as well.
- **PR-6, the ALREADY-LANDED family** — an upgrade that installs the #1947 fix
  says nothing about whether THIS Diamond ever received #1354/#1383. Loupe-resolve
  and compare `RepayFacet`, `RepayPeriodicFacet`, `PrecloseFacet`,
  `SwapToRepayFacet`, `SwapToRepayIntentFacet`, `IntentDispatchFacet`,
  `AutoLifecycleFacet`, `RefinanceFacet`, and the shared resolver host
  `VPFIDiscountFacet`. Skip this and Full can be enabled on a Diamond whose
  ordinary repayment and early-close settlements still ignore the purchased bump
  — the failure this step exists to prevent, on the paths it already calls done.
- **PR-6 / #1947, the family that was reopened and CLOSED again on
  2026-08-26** — confirm the DEPLOYED bytecode of
  `DefaultedFacet`, `RiskFacet`, `RiskSplitLiquidationFacet` and `RefinanceFacet`
  is the fixed version, the same way.

**ONE branch now, not two.** This step used to fork on whether #1947 was open:
with no fixed build for that family the readback could not pass, and the
escape was an explicit **superseding decision** against the frozen §F2. #1947
CLOSED on 2026-08-26, so a fixed build exists and neither the halt nor the
supersession applies — an operator reaching for the supersession route today
would be seeking a policy exception for work that is already done.

What remains is the readback itself, which was always the substantive half:
confirm the DEPLOYED bytecode of the named facets is the fixed version on THIS
Diamond. A closed card is evidence about the repository, never about a
particular deployment.

**One requirement survives ANY supersession, and it is inside the recovery
family, so it is easy to lose here.** The partial-liquidation PAYOUT re-key is
not a discount matter — it is misrouted principal and interest, with no claim
record for the current holder to recover through — so a decision about whether
recovered interest earns the Full bump has no bearing on it. Even on the
superseded branch, require `RiskFacet` bytecode in which
`triggerPartialLiquidation` pays or parks for `ownerOf(lenderTokenId)`. Passing
this step without it leaves the previous lender holding the proceeds of a
transferred position. Without this branch a granted supersession
would leave `feeEntitlementEnabled` blocked forever by a readback that can never
be satisfied.

```
ConfigFacet.setFeeEntitlementEnabled(true)      # ADMIN_ROLE
```

Post-handover this is a Timelock action: Safe schedules, wait the delay, execute.

While it is off, plain canonical originations skip Full-tariff stamping, so any
loan accepted between a clean unstamped-scan and enablement rejoins the unstamped
class and invalidates the scan. Enabling first means every subsequent origination
stamps itself and the scan result cannot be overtaken by new loans.

### Step 2 — zero the unstamped reward-eligible canonical loans

On armed days the legacy cap retires and the loan-side cap deliberately skips an
**unstamped** loan, so any reward-eligible canonical loan still open and unstamped
at `D*` earns **uncapped**. Enumerate open reward-eligible canonical loans with
`openDays == 0`, resolve each, and read back **zero unresolved**.

**There is no backfill surface.** Stamping runs only at origination —
`chargeFullTariff` is `address(this)`-gated with `OfferAcceptFacet` its only
caller — and no admin or migration path stamps an existing loan. The supported
resolutions are the enable-first ordering above (which prevents new members of
the class) and **waiting for close**, or a voluntary close and re-open, for
existing ones. A true backfill needs a migration card that does not yet exist.

On a pre-live mainnet genesis, enabling and arming together makes this set empty
by construction. The readback is still the gate; any testnet rehearsal or
post-launch `D*` will have such loans.

### Step 3 — complete EVERY keeper prerequisite (still before the arm)

**Which of these apply depends on which Gate B branch you took, and the split is
not cosmetic — items that do not apply must be SKIPPED, not performed anyway.** On the
**M3 / active-mirror** branch, all of it applies. On the **Base-only /
dark-mirror** branch, the commitment-report and recycled-ledger surfaces need not
exist on those chains at all — so 3a, 3b's mirror half, 3b-i, 3e and 3f are M3
items and are not preconditions there. Do not treat them as blocking on the dark
branch: requiring a clean commitment-report tail or a mesh-watcher tick over
ledgers that were never deployed makes the ceremony unreachable on a branch Gate
B explicitly permits. What still applies on the dark branch: `KEEPER_ROLE` on Base (3b's canonical
half) **and on every dark mirror the Worker still resolves** — `KEEPER_ENABLED`
runs the liquidity-confidence pass on each of them and submits the role-gated
`setKeeperTier`, so a dark mirror without the role has its risk-tier updates
reverting; Base funding (3d) **and native gas on every dark mirror the Worker resolves**,
since the liquidity-confidence pass signs `setKeeperTier` there and an unfunded
signer leaves those writes failing; the RL-4 readback (3f-bis); and
`KEEPER_ENABLED` with its tail confirmation. **NOT 3c** — there is no Base→mirror
remittance to authorize — and **not** `REWARD_COMMIT_ENABLED` or
`REWARD_REMIT_ENABLED`, whose passes have no mirrors to serve.

**3a. Apply the D1 migrations** — from `apps/indexer/`:

```
wrangler d1 migrations apply vaipakam-archive --remote
```

covering `0043_keeper_commitment_scan.sql` and `0044_keeper_remit_ack.sql`.

**3b. Grant `KEEPER_ROLE` to the keeper EOA on EVERY chain — every mirror AND
canonical Base.** `submitCommitmentBatch` is mirror-only (`_assertMirror`) and
role-gated, so granting on Base alone, or missing one mirror, leaves that
mirror's commitment pass reverting forever: its report never completes and the
remit gate stalls that chain's funding.

Base is not optional even though the commitment batch never runs there. Step 5
turns on the Worker-wide `KEEPER_ENABLED`, and the liquidity-confidence pass
iterates **every configured chain** and submits the `KEEPER_ROLE`-gated
`ConfigFacet.setKeeperTier`. Without the role on Base those risk-tier updates
revert, and loan-init LTV confidence can go stale during a degradation — a
failure with nothing to do with recycling, triggered by this ceremony.

**3b-i. Read back that the keeper can SEE every reward chain.** The Worker
builds its chain list from whatever RPC secrets and deployment artifacts
resolve, and **silently skips a chain whose RPC secret or deployment entry is
missing** — no error, no warning. A mirror absent from that list never submits
its armed-day commitment report, Base's remit gate waits on a report that will
never arrive, and that chain's claims stay unfunded with nothing anywhere
reporting a fault. Compare the keeper's resolved chain IDs against the **live on-chain
topology, not against your own inventory**. An "intended set" written down by
whoever maintains the deployment artifacts can be missing the same chain the
keeper is missing, and then the preflight passes while Base waits for a report
from a chain nobody has noticed is absent.

**Check CONTAINMENT, not equality, and check it in one direction only.** The
defect is a chain the keeper cannot see; an extra chain it can see is harmless.
Equality fails on correct configurations for two independent reasons — the two
getters cover different sets (`getExpectedSourceChainIds()` is the full
reward-chain list, the messenger's `getBroadcastDestinations()` holds **mirrors
only**, canonical filtered out), and the Worker binds both mainnet and testnet
RPC families, so a correctly configured keeper legitimately resolves chains
outside this Diamond's mesh.

So, against **this** Diamond's mesh:

- every id in `getExpectedSourceChainIds()` must be **present** in the keeper's
  resolved set;
- every id in `getBroadcastDestinations()` must be **present** there too;
- and each of those resolved endpoints must return a matching `eth_chainId`.

**Check that canonical Base is IN the expected-source list**, explicitly. Every
containment test above validates only ids already present, and the mirror-set
comparison looks at the mirror subset — so a list that OMITS Base passes all of
them while the mesh has no canonical member.

**Check every rotated mirror's clock requirement HERE, not in Step 5.** A mirror
with `rewardEraRotated == true` rejects the legacy V2 wire, so a clockless
propagation day cannot reach it — and Step 5 is after the one-shot arm has
already executed. If any destination has rotated, confirm now that a
clock-bearing pre-`D*` day exists for it.

**Check every mirror's Base-era binding here, not only at promotion.** If an
active mirror's `baseRewardDeployment` is unset or names an earlier Base Diamond,
the V3 ingress rejects the clock-bearing propagation broadcast with
`BroadcastEraUnauthenticated` — and on the initial ceremony that rejection
surfaces only AFTER Base has executed its one-shot arm. Read the binding back on
every mirror before the arm, not when a promotion goes wrong.

**And check both ends of every reward channel.** Matching chain ids, Diamond
addresses and lane limiter states all pass with a missing or stale messenger
peer: `setBroadcastDestinations` validates neither `remoteMessengerOf` nor the
channel peer. Read both directions of each pairing before the arm — a broadcast
that cannot authenticate is a `D*` that never lands.

**And compare the two getters to EACH OTHER, not only to the keeper.** A mirror
present in `getExpectedSourceChainIds()` but absent from
`getBroadcastDestinations()` passes both checks above as long as the keeper
resolves it — and then never receives `D*`, because `broadcastGlobal` enumerates
only the messenger's destination list. Base waits for a chain that was never
told. Require the expected-source mirrors and the broadcast destinations to
describe the same set before the arm.

A missing chain is the defect. **An extra one is not automatically harmless,
though — and that is a consequence of step 3g.** Both the remit and the
commitment-report passes iterate the FULL `getChainConfigs(env)` result, so
turning the Worker-wide flags on for THIS ceremony also starts fund-moving and
reporting passes against every other resolved mesh, testnet included. Either
scope the Worker to one mesh for the ceremony, or run the same role, remitter,
balance, migration and lane checks against every mesh the flags will reach. Do
not read "extra chains are fine" as "extra chains can be ignored".

**And the chain ID is not enough to identify the right Diamond.** A deployment
artifact pointing at an OBSOLETE Diamond on the correct chain passes every check
above: the id is in both live lists, the keeper reports it, and the RPC agrees.
The keeper then reads the old Diamond, whose `armedFromDay` stays zero, and
submits nothing while Base waits for the live mirror. Compare the artifact's
Diamond ADDRESS per chain against the address governance actually administers.

All of this BEFORE the arm.

**3c. Authorize the Base remittance signer — a SEPARATE authorization, and easy
to miss.** *(M3 / active-mirror branch ONLY — on the dark branch skip 3c
entirely, and see 3g for which flags apply there: the reward passes perform
Base→mirror remittance, mirror commitment reporting and acknowledgements, none of
which exist on the dark branch.)* `remitRewardBudget` is `onlyCanonical onlyRemitter`, and
`_checkRemitter` admits only an `ADMIN_ROLE` holder or the address stored as
`rewardRemittanceKeeper`. A least-privilege keeper EOA is neither by default, and
the mirror-side `KEEPER_ROLE` grants of 3b do **not** cover it:

```
RewardRemittanceFacet.setRewardRemittanceKeeper(<keeper EOA>)   # ADMIN_ROLE, on Base
```

Read the value back before proceeding. Skip this and commitment reports complete
normally while **every** Base→mirror remit reverts `NotRewardRemitter`, so mirror
claims stay unfunded — a failure that looks like a funding problem and is a
permissions one.

**3d. Fund the keeper EOA on every mirror AND on Base.** Mirrors need gas for
`submitCommitmentBatch` plus the quoted native CCIP fee for
`sendCommitmentReport` / `sendRemitAck`. **Base needs gas and the CCIP
`msg.value` fee for every Base→mirror `remitRewardBudget` send** — the remit is
submitted from the canonical chain, so an unfunded Base EOA lets commitment
reports complete while every reward-budget send fails. Read balances back per
chain, **including Base**.

**3e. Raise BOTH capacity limits, and understand that only one of them is the
keeper's.** The keeper excludes a day whose eligible slice exceeds
`REWARD_REMIT_LANE_CAP` — its own configured value — and logs that exclusion.
**It does not read the on-chain CCIP token-bucket capacity at all.** So a lane
cap configured above the live bucket capacity does not produce an exclusion: the
oversized send is planned, dispatched, and **rejected by the rate limiter
on-chain**. The two limits must be raised together, and the 50,000-VPFI default
bucket capacity can sit below an early high-concentration daily slice. Read back
each destination's bucket capacity *and* the keeper lane cap against the largest
supported single-day slice (#918).

**Capacity alone is not the check.** A lane has SEPARATE outbound and inbound
rate-limiter states, each with its own `capacity`, `rate`, `isEnabled` and
current `tokens`. A configured capacity that looks adequate can still fail
delivery — because the two directions are configured differently, or
because a bucket is currently DEPLETED and has not refilled.
A Base send can consume the outbound side and then be rejected or delayed by the
mirror's inbound limiter, and Step 5 is waiting on `RewardBudgetReceived` against
an immutable `D*`. Read both states, both directions, per lane, and check present
`tokens` as well as configured capacity.

**And check the BATCH, not only the largest day.** The keeper greedily combines
several individually-valid days into one send, so a lane cap above either enabled
bucket lets a batch of legal days exceed the bucket that only per-day checking
said was fine. Bound the keeper's cap by the live bucket capacities, not by the
largest single-day slice.

**Verify the WIRING, not the components — as one pass, because they fail the
same way.** **M3 / ACTIVE-MIRROR BRANCH ONLY**, like the rest of 3e. On the
Base-only / dark-mirror branch the reward transport this pass inspects — each
mirror's `VaipakamRewardMessenger` and `RewardRemittanceReceiver`, the reward and
reward-budget channels, the mirror pools — need not exist at all, and requiring
them makes the ceremony unreachable on a branch Gate B explicitly permits (see
the branch split at the head of Step 3). What survives on the dark branch is
Base's own side: Base is not a mirror, has no remittance receiver, and sends
nothing, so nothing here applies to it either. Skip the whole block; do not
perform it "just in case". Every check above inspects a component you believe is in use. The
protocol dispatches through what is actually STORED and REGISTERED, and a
`ConfigureCcip` or `ConfigureRewardReporter` that stopped partway leaves those
disagreeing while each component reads back healthy on its own. Before the arm,
read back on every chain:

- **each Diamond's reward-chain ROLE** — `isCanonicalRewardChain`, and
  `baseChainId` non-zero and correct on every mirror. A partial reporter config
  can leave a mirror flagged canonical, or pointed at the wrong Base id, and the
  topology checks above still pass because they validate RPC and artifact
  identity rather than the Diamond's own belief about what it is;
- **the Diamond's OWN stored messenger addresses** — Base's cross-chain
  messenger and each mirror's reward messenger. `remitRewardBudget` dispatches
  through the stored value, so a stale or zero one reverts or takes an
  uninspected lane after the arm;
- **and Base's OWN stored reward messenger** — `getRewardReporterConfig()
  .rewardMessenger` on the canonical Diamond, which is a different address from
  the cross-chain messenger above and is missed by checking that one. Both
  `broadcastGlobal` and Base's authenticated reward-report ingress dispatch
  through it, so a `ConfigureRewardReporter` that stopped partway, or a
  redeployed messenger, leaves the remittance lane reading back perfectly while
  commitment reports and the post-arm `D*` broadcast both fail. Require it to
  equal the live `VaipakamRewardMessenger` whose peers you inspected;
- **the remittance RECEIVER wiring on each mirror** — a redeployed
  `RewardRemittanceReceiver`, or a config that stopped before the reward-budget
  wiring, leaves an inbound delivery with nowhere to land while every outbound
  check passes;
- **the LOCAL channel-handler bindings, in both directions** — `channelOf` for
  each handler and `handlerOf` for each channel id, on every participating
  chain, for the reward channel and the reward-budget channel alike. A Diamond,
  reward messenger or remittance receiver rotated without completing
  `registerChannel` passes every stored-address, peer, receiver, registry and
  pause check above while the local `CcipMessenger` still binds the channel to
  the OLD handler. Outbound then reverts at `channelOf[msg.sender]` with
  `CallerNotHandler`, and inbound resolves the stale `handlerOf[channelId]` — so
  the first remit or `D*` broadcast fails after the one-shot arm. The peer
  checks look outward and cannot see this; it is local to each chain;
- **each live pool through the CCIP token registry** — `getPool` for the token,
  not the pool address you configured. If CCT registration was skipped because
  the configuring account did not own the token, or a pool was redeployed, you
  will have inspected a healthy pool that is not the one CCIP will use;
- **and that the whole path is UNPAUSED — the participating DIAMONDS included,
  not only the non-Diamond cross-chain contracts.** Every cross-chain contract
  carries a guardian pause, the remit is `whenNotPaused`, and the arming setter
  checks none of it — so an emergency pause left on after a partial recovery
  passes every wiring readback and then stops the propagation the arm depends on.
  The remit itself lives on the Diamond: Base's `remitRewardBudget` is
  `whenNotPaused`, and a mirror rejects the receiver's `onRewardBudgetReceived`
  call at the SAME guard — so a Base Diamond or any mirror Diamond left paused
  after an incident breaks the path even when every cross-chain contract is
  unpaused and every wiring readback is clean. Require `AdminFacet.paused() ==
  false` on Base AND every participating mirror, not just on the transport
  contracts.

**If ANY of this was rotated, matching readbacks are not enough — the lane has
to be DRAINED first.** `CcipMessenger` resolves the destination handler at
DELIVERY time and the envelope names no intended handler, so a message sent while
the old handler was live — with any tokens it carries — is forwarded to the
REPLACEMENT if it lands after the re-registration. In the other direction,
installing a new channel peer makes `_ccipReceive` reject a delayed message that
the old peer had already sent, because the originator on the wire is the old one.
Both states pass every readback in this pass.

The contract says so itself and points here: the drain "is the control, and it is
documented in the admin runbook rather than enforced here". So it belongs in this
ceremony, not in a comment. For every binding changed by a rotation: quiesce the
channel, then RECONCILE rather than wait — "let in-flight deliveries land" is not
a condition an operator can observe, and a delayed or already-failed delivery
leaves the lane in exactly the state that forwards tokens to the replacement.
Take every outbound message id sent on that channel since the last known-good
point, and require each one to have **EXECUTED successfully at its
destination**. That is the only terminal state, and the round-4 wording here was
wrong to offer "abandoned with the reason recorded" as an alternative: a FAILED
CCIP message stays manually re-executable indefinitely, and `CcipMessenger` has
no cancellation and no per-message-id tombstone — so a re-execution after the
rotation resolves `handlerOf[channelId]` to the REPLACEMENT and hands it the old
message and its tokens. That is the precise hazard this drain exists to prevent,
and an operator note does not close it. Re-execute a failed message to success
before rotating, or do not rotate. Only then clear and re-register.

A pending id is a blocker, not a delay — CCIP will deliver it eventually, and
eventually is after the rotation. The peer rejection is recoverable (clear the new peer, re-install
the old, manually re-execute the stranded message, then repeat the rotation), but
running that recovery re-points a live lane's trust anchor backwards, which is a
worse thing to be doing than waiting was — and worse still with `D*` immutable.

**Read every mutable pointer FROM THE CONTRACT THAT HOLDS IT — the list above
walks outward from the Diamond, and each hop's far side is settable too.** Every
bullet above reads what the Diamond, or the local `CcipMessenger`, believes. The
reward messenger and the remittance receiver each hold their OWN owner-settable
addresses and flags, and a rotation that updated one side leaves the other naming
what was replaced — with every check so far passing. There is no need to guess
which ones; each contract's settable state is short enough to enumerate, so
enumerate it and read all of it back:

| Contract | Read back | Already covered above? |
| --- | --- | --- |
| `VaipakamRewardMessenger` | `messenger()` | **no — read it** |
| | `diamond()` | **no — read it** |
| | `isCanonical()` | **no — read it** |
| | `baseChainId()` | **no — read it** |
| | `getBroadcastDestinations()` | yes, in the topology pass |
| | `destGasLimit()` | yes, below |
| `RewardRemittanceReceiver` | `messenger()` | **no — read it** |
| | `diamond()` | **no — read it** |
| | `vpfiToken()` | **no — read it** |
| `CcipMessenger` | `remoteMessengerOf` | yes, in the topology pass |
| | `chainSelectorOf` / `chainIdOf` (both directions) | **no — read them** |
| | reward-channel peers | yes, in the topology pass |
| | reward-BUDGET channel peers | **no — read them** |
| | `channelOf` / `handlerOf` | yes, above |
| | `channelOfPeer` (the REVERSE index) | **no — read it** |
| `vpfiTokenPool` | `getRateLimitAdmin()` | **no — read it** |
| | `isSupportedChain(selector)` per lane | **no — read it, and see below** |
| | `getRemotePools(selector)` both ends | **no — read it, and see below** |
| | `getRouter()` (the POOL's own router) | **no — read it, and see below** |
| | `getRmnProxy()` | **no — read it, and see below** |
| | `getAllowListEnabled()` | **no — read it, and see below** |
| | `getRemoteToken(selector)` both ends | **no — read it, and see below** |
| | its own `owner()` + event-log rule | **no — see the pair note below** |
| `VpfiPoolRateGovernor` (cont.) | `owner()`, `pendingOwner()`, implementation | **no — see the pair note below** |
| `VpfiPoolRateGovernor` | `pool()` | **no — read it, and see below** |
| `CcipMessenger` (cont.) | `getRouter()` (the ADAPTER's) | **no — read it, and see below** |
| *all three* | `owner()`, `pendingOwner()` | **no — read them** |
| | `guardian()` | **no — read it** |
| | the proxy's implementation | **no — read it** |

**And re-apply the PRINCIPAL checks to the live pool and its governor as a
pair.** The reciprocal `getRateLimitAdmin()` / `pool()` readbacks prove the two
point at each other; they say nothing about who controls either. If the
registry-selected pool or the governor was replaced after step 6, both pointers
agree while the replacement is still deployer-controlled or carries a pending
takeover — and the pool's owner can rewrite its router, its remote pools, its
allowlist and its limiters with none of the governor's bounds, while the
governor's owner can repoint it and authorise a UUPS upgrade. The `all three`
principal rows below cover the handlers, and the mirror-token paragraph covers
the token; neither reaches this pair. Apply the pool's owner + event-log rule and
the governor's owner / zero-pending-owner / implementation checks to the exact
live addresses this pass resolved.

The table above is the settable STATE. It is not the whole answer, and saying it
enumerated everything was too strong: the last three rows are the PRINCIPALS who
can rewrite that state after you have read it. All three contracts are
`Ownable2Step` + `GuardianPausable`, so an owner can rewrite every field above
and authorise a UUPS upgrade, and a guardian can pause the transport — after this
preflight and after the irreversible arm. The handover check earlier in this
runbook establishes ownership of the Diamond, the token and the timelock targets;
it says nothing about a cross-chain contract REPLACED since, which is precisely
the case this section exists for. Two EXACT values, not one comparison: `owner() ==
the governance address` **and `pendingOwner() == address(0)`**. A completed
transfer clears the pending owner, so a non-zero one means a handover is still
open and that address can call `acceptOwnership()` whenever it likes — including
after `D*`, at which point it holds every setter above and the UUPS upgrade
authority. "Owned by the timelock" is true of that state too, which is why the
pending value has to be named rather than folded into the owner check. Then
`guardian()` against the current guardian key, and each proxy's implementation
against the one you intend to be running.

What each of the newly-required ones costs if it is wrong:

- **`messenger()` and `diamond()` on both handlers** are the reciprocal of the
  channel bindings above. Those maps can correctly name the new handler while the
  handler still names the old adapter or the old Diamond: inbound then reverts
  inside the handler, outbound reward sends go through the stale adapter, and
  `onlyDiamond` rejects the live Diamond. Match both against the exact adapter
  and Diamond inspected in this pass.
- **`isCanonical()` and `baseChainId()` on the messenger** are a SEPARATE
  topology from the Diamond's role fields in the first bullet, and a replacement
  messenger can disagree with the Diamond it serves. Wrong `isCanonical` and Base
  rejects commitment reports with `ReportOnMirror`, or a mirror rejects the `D*`
  broadcast with `BroadcastOnCanonical`; a stale `baseChainId` sends that
  mirror's reports and acknowledgements to the wrong chain.
- **`vpfiToken()` on each receiver** must equal the mirror token whose registry
  entry and minting pool you just checked. After a token rotation the channel,
  registry and pool all read healthy while every delivery reverts `TokenMismatch`
  inside the receiver, and the pre-`D*` receipt gate simply never completes.
- **both selector mappings, in both directions.** Outbound resolution reads
  `chainSelectorOf[destinationChainId]` and inbound authentication derives the
  source identity from `chainIdOf[sourceChainSelector]` — and nothing else in
  this ceremony reads either. The `eth_chainId`, peer, router and lane checks all
  pass with a missing or stale selector binding, and the first send after the arm
  then resolves to no lane or to the wrong one. Require
  `chainSelectorOf[chainId] == expectedSelector` AND
  `chainIdOf[expectedSelector] == chainId` for every live lane. This row was
  marked covered by the topology pass in the first version of this table and it
  was not: `grep` the ceremony for either name and it appears nowhere else.
- **the reward-BUDGET channel's peer on each mirror**, separately from the reward
  channel's. The pairing check earlier in Step 3 is about the reward messenger
  that broadcasts carry; the remittance arrives on its own channel, and
  `_ccipReceive` rejects the Base Diamond as an unauthorized peer if that entry
  is missing or stale — with every receiver, handler, token, router and ownership
  readback above still passing. Require each mirror's
  `channelPeerOf[<reward-budget channel>][baseChainId]` to equal the live Base
  Diamond. "Channel peers" as a single line covered one channel and read as
  covering both.
- **`channelOfPeer[remoteChainId][peer]` for every forward peer**, and not just
  the forward `channelPeerOf` entries the topology pass already compared. The
  reverse index was APPENDED to this contract, so on a proxy upgraded from the
  earlier implementation it starts EMPTY while the forward map is fully
  populated — and until `backfillChannelPeerIndex` has run over every pair, the
  one-peer-to-one-channel invariant `setChannelPeer` advertises does not hold:
  its duplicate check reads an empty reverse entry and admits an address that is
  already another channel's live peer. A rotation performed during this ceremony
  can therefore bind a live peer to a second channel and leave one lane
  rejecting messages. The contract is explicit that completeness here is the
  OPERATOR's, because mappings are not enumerable and it cannot discover its own
  configured pairs: derive the pair list from this proxy's `ChannelPeerSet`
  event log, not from memory, and confirm
  `channelOfPeer[remoteChainId][peer] == channelId` for each. Three deployments
  are already in that state.
- **`getRateLimitAdmin()` on the live registry-selected pool**, against the
  verified `VpfiPoolRateGovernor`. `setChainRateLimiterConfig(s)` authorises
  `s_rateLimitAdmin` **or** the owner, and `ConfigureCcip` deliberately points
  that principal at the governor because the governor is the bounds-checked path
  — it refuses to disable a lane and range-bounds every value. A pool left with a
  deployer or stale EOA there passes every registry, bucket and ownership
  readback in this pass, and that address can rewrite both limiter
  configurations directly, immediately before or after the arm, with none of the
  governor's bounds applied. The ownership rows above do not cover it: this is a
  second principal on the same contract.
- **`getRouter()` on every adapter**, and this one is not proxy storage at all —
  the router is a CONSTRUCTOR immutable baked into the implementation, so an
  implementation upgrade can change it while every storage readback in this pass
  is unchanged. `sendMessage` quotes and dispatches through `getRouter()`, so
  confirm it equals the live router the selectors, lanes and token registry
  belong to. Nothing else here can see this one.
- **`getRemotePools(expectedSelector)` on the pool at BOTH ends of every lane.**
  The registry, supported-chain, rate-limit, ownership and messenger checks can
  all pass on a lane whose peer pool was redeployed while the local lane still
  lists only the OLD peer address. The first delivery from the replacement is
  then rejected inside `_validateReleaseOrMint`, because `isRemotePool` does not
  recognise its `sourcePoolAddress`. Require the live peer pool to appear in
  `getRemotePools(expectedSelector)` on both ends — do NOT require the old entry
  to be removed, since it may still cover an in-flight message — before the
  irreversible arm.
- **`getRouter()` on the POOL, not only on the adapter.** The pool carries its
  OWN independently-mutable router (`TokenPool.setRouter`), separate from the
  `CcipMessenger` router the previous bullet reads. A pool left on a stale router
  authenticates the live on-ramp and off-ramp against that stale router in
  `_onlyOnRamp` / `_onlyOffRamp` and rejects the first remittance, while every
  lane check above still reads healthy. Confirm `vpfiTokenPool.getRouter()` equals
  the live router the lane belongs to, alongside the adapter readback.
- **`getRmnProxy()` on the live pool**, against the published RMN proxy for that
  chain. It is a CONSTRUCTOR immutable consulted in both `_validateLockOrBurn`
  and `_validateReleaseOrMint`, so a redeployment carrying a stale
  `CCIP_RMN_PROXY` passes every router, remote-pool, lane, limit and ownership
  readback above. A stale permissive proxy lets transfers through a lane the live
  RMN has CURSED; an invalid one halts every transfer. Neither is visible from
  storage.
- **`getAllowListEnabled() == false` on each live pool.** `i_allowlistEnabled` is
  set from `allowlist.length > 0` in the constructor, and `DeployCrosschain`
  builds both pools with `new address[](0)` — "empty allowlist => permissionless
  pool". A replacement constructed with a non-empty list reads back healthy
  everywhere in this table while ordinary VPFI sends revert `SenderNotAllowed`
  for any `originalSender` not on it. If permissioning is ever introduced
  deliberately, verify the complete required sender set instead.
- **`getRemoteToken(expectedSelector)` on both ends of every lane**, decoded and
  compared against the live peer token. `lockOrBurn` returns it as the
  destination token, and `ConfigureCcip` stores it SEPARATELY from
  `remotePoolAddresses` — so a rotated mirror token with the lane's
  `remoteTokenAddress` left behind passes the registry, live-token, remote-pool,
  router and limiter checks, and then targets the retired token or fails at the
  destination where the receiver expects the new one.
- **`VpfiPoolRateGovernor.pool()`, the reciprocal of `getRateLimitAdmin()`.**
  Setting the pool's `rateLimitAdmin` to the governor is only half the pairing:
  the governor stores the pool it drives, and after a pool rotation a
  freshly-registered pool can point AT the governor while the governor still
  points at the RETIRED pool. Every bounds-checked `setLaneRateLimits` call is
  then dispatched through `VpfiPoolRateGovernor.pool` to the old pool, so
  governance cannot repair or tune the live lane after arming. Require
  `VpfiPoolRateGovernor.pool() == registry.getPool(vpfiToken)` so the governor
  and the live pool name each other.

**And verify the mirror token's live minting pool.** Messenger peers and rate
limiters can all read back correctly against the intended pool while the mirror
token still points at a redeployed or unset one — `setTokenPool` is a separate
step that `ConfigureCcip` may not have completed. Read the token's pool back on
each mirror and confirm it is the pool whose limits you just checked.

**And read back the mirror TOKEN's own principals — not only its pool pointer.**
`VPFIMirrorToken` is `Ownable2StepUpgradeable` + `GuardianPausable` + UUPS, so
confirming only `tokenPool()` lets a deployer-owned replacement token pass this
preflight: its owner can immediately repoint `tokenPool` via `setTokenPool`
— handing an arbitrary address the SOLE mint/burn authority — and can authorise a
UUPS upgrade, while its guardian can pause every mint and transfer, all after the
irreversible arm. The Step-6 handover readback covers the mirror token that was
handed over; it says nothing about one REPLACED since, which is the case this
section exists for. Apply the SAME four readbacks the table's last rows require of
the other proxies to the live mirror-token proxy on each mirror: `owner() ==
timelock`, `pendingOwner() == address(0)`, `guardian()` == the current guardian
key, and the proxy implementation == the one you intend to be running.

**And read back every live messenger's `destGasLimit`.** Commitment reports and
the `D*` broadcast both size their CCIP callback from it, and `setDestGasLimit`
accepts any value without validation — so a zero or stale limit left by an
upgrade passes every wiring, capacity, peer and pause check here and then makes
each delivery run out of gas on arrival, repeatedly, with `D*` already immutable.
Read it back against the supported callback budget on each messenger, or prove it
with an end-to-end delivery rehearsal, before the arm.

**A DISABLED limiter is not a failure — it is unlimited. But establish the lane
EXISTS before applying that rule.** A missing lane and a validly disabled one are
indistinguishable through the limiter getters: both return the mapping's
zero-initialised bucket — `isEnabled == false`, zero capacity, zero rate. So
"disabled is unlimited" reads a pool that was registered before its lane was
added as a healthy no-limit lane, the arm proceeds, and the first transfer then
reverts `ChainNotAllowed` because `_onlyOnRamp` checks `isSupportedChain` as a
SEPARATE condition the buckets know nothing about. Require
`isSupportedChain(expectedSelector) == true` first; only then does the rest
apply. The rate limiter returns immediately when the bucket is disabled, and the
config validator requires a disabled bucket to be fully zeroed — so on a lane that
exists, `isEnabled == false` with zero capacity is a correctly configured no-limit
lane, not a blocked one, and treating it as blocked would stall a ceremony over a
healthy configuration.

**3f. Deploy `ops/mesh-watcher` AND verify it runs clean.** It reads every
reward chain's recycled ledger and alerts on the commitment invariants, and it is
code-complete but **undeployed** — D1 creation, secrets and the first deploy are
operator steps in its README. Do this before arming, not after: arming is when
the invariants it watches start moving.

**Deploying is not verifying.** A Worker deploys successfully with a wrong RPC, a
missing deployment stanza or a bad alert credential, and a cron that has not
fired yet looks exactly like one that is broken. Trigger the authenticated
`POST /run` and require a clean health result — delivery succeeded, no coverage
gaps — before Step 4. Arming behind a watcher that has never completed a tick is
arming with no invariant coverage at all, which is the state this step exists to
prevent.

**3f-bis. Read back the RL-4 allocation weights** — the dormant posture is
`[keeper 0, reserve 10000]`, the register is consulted from the FIRST armed-day
finalization, and a rehearsed Diamond can carry a stale non-zero
`recycleRegisterKeeperBps` that silently earmarks user-reward runway. Step 6
describes the posture; this is where it gets checked, because Step 6 may be
deferred past `D*`.

> **⚠ HOLD — #1896: the keeper is deliberately UNSCHEDULED.**
> `apps/keeper/wrangler.jsonc` commits `"crons": []` because the Worker
> was terminated for exceeding CPU on ~100% of invocations. **Do not
> restore the schedule or arm `KEEPER_ENABLED` as part of this procedure**
> until #1896's CPU work has landed. With no schedule, no pass runs, so a
> quiet `wrangler tail` here proves nothing — it is the expected state,
> not a passing check. Re-enable only via the sequence kept beside the
> empty list in `apps/keeper/wrangler.jsonc`.

**3g. Set and CONFIRM the master flags NOW, before the arm — they are not a
step 5 item.**

> **⚠ #1896 AMENDMENT TO 3g — do not follow this step as written while the
> keeper is unscheduled.** The hold above says not to arm `KEEPER_ENABLED`;
> this step as written says to set it now and confirm it by watching a cron
> cycle. Both cannot hold, and unamended the step either latches the
> unreadable master secret to `true` — destroying the guaranteed-disarmed
> posture the re-enable sequence depends on — or simply cannot be completed,
> because with `"crons": []` the confirming cycle never comes.
>
> While the hold is in force:
> - **`REWARD_COMMIT_ENABLED` / `REWARD_REMIT_ENABLED`** — set and record them
>   as this step describes. They are reward flags and latch correctly for when
>   the schedule returns. Their `wrangler tail` confirmation is **deferred**,
>   not skipped: no pass runs to log a start.
> - **`KEEPER_ENABLED`** — do **not** set it here. It is not a reward flag and
>   the ceremony must not be what arms it. Leave it to the re-enable sequence
>   in `apps/keeper/wrangler.jsonc`, which sets it to `false` explicitly first
>   and arms it only after a live unarmed tick has been observed.
> - Record both deferrals in the ceremony log, so `D*` is not treated as
>   fully confirmed on evidence that could not have been produced.
>
> The "do NOT switch off flags that are already running" note below still
> applies unchanged, and matters more here: this hold is a reason not to ARM
> `KEEPER_ENABLED`, never a licence to turn off a flag that is currently
> funding live mirror claims.

**`KEEPER_ENABLED` is not a reward flag**: turning it on resumes
the matcher, the liquidator, the liquidity-confidence pass and the rest of the
keeper's jobs on every resolved chain. If it is currently off — on a fresh
deployment, or because of an incident — validate ALL of those passes before
flipping it, not only the reward ones. This ceremony must not be the thing that
silently restarts an unrelated subsystem. `KEEPER_ENABLED`, `REWARD_COMMIT_ENABLED`, `REWARD_REMIT_ENABLED`.
These are secrets, and **secrets cannot be read back** — the API returns names
only, so an unset, mis-cased or malformed value is indistinguishable from a
correct one until a pass actually runs. One `wrangler tail` cycle is the
confirmation: watch each gated pass log its start. Discovering a bad flag after
the arm means discovering it when `D*` can no longer be moved.

**Do NOT switch off flags that are already running.** If this deployment is on
Gate B's active-mirror branch, `REWARD_REMIT_ENABLED` and `KEEPER_ENABLED` may
already be funding ordinary pre-`D*` mirror claims — the reward-budget remit pass
processes finalized days whether or not the program is armed. This ceremony spans
Timelock delays and a propagation window, so turning them off "until step 5"
starves live mirror claims for days over a cutover that has not happened yet.
On such a deployment 3g confirms what is already on and adds only what is
missing; it is never an instruction to disable a running one.

### Step 4 — arm, sized from EXECUTION time

```
RewardAggregatorFacet.setGovernorCommitArmedFromDay(D*)   # ADMIN_ROLE, canonical only
```

**⛔ On the M3 / ACTIVE-MIRROR branch, do not execute this call until every
reachable mirror ENFORCES THE PER-DAY FUNDING PROPERTY** — a claim against a day
whose budget has not arrived cannot consume value belonging to anything else.
Not "#1566 is deployed": see the warning in Step 5, and Gate A above.

This is an arming gate and not merely a propagation one, because the two are the
same gate. Step 5 forbids propagation while any reachable mirror lacks the
property, and **a mirror learns `D*` only through propagation** — so arming
without it leaves the cutover impossible to complete, with `D*` immutable and no
second one to schedule. On the dark branch this does not apply: arming Base IS
the cutover and there is nothing to propagate.

**Read back that the D1 share-of-pool cap (M2 PR-2) is live on every Diamond
this arm will actually reach.** On the **M3 / active-mirror** branch that is Base
AND every mirror, not only the one you are calling: arming propagates, each
mirror installs `D*` from the broadcast and switches to ShareOfPool on its own
schedule, so a partially upgraded mirror makes that switch without the
`(user, side, day)` concentration bound even though Base is fine.

On the **dark-mirror** branch it is **Base only**. Nothing propagates there, so a
dark mirror may legitimately lack PR-2 under Gate B and requiring it would block
a cutover the gate permits. The same scoping applies to the per-chain clock
readback below. The setter checks authorization, canonical role, one-shot state and a
future day — and nothing else. At `D*` the reward path switches to ShareOfPool,
and on a partial or stacked Diamond that has the PR-3c setter but not PR-2, that
switch happens with the required `(user, side, day)` cap absent. The joint
cutover gate is PR-2 **and** PR-5c; step 1 covers PR-5c and PR-6, this covers
PR-2.

This single Base call **is** the `D*` cutover. It is:

- **one-shot** — a second call reverts `GovernorAlreadyArmed`;
- **future-day-only** — `dayId <= today` reverts `GovernorArmingDayNotFuture`;
- **canonical-only** — there is no per-chain `D*` administration, and a call on a
  mirror reverts.

**First confirm the reward clock is actually RUNNING.** On a fresh Diamond
`interactionLaunchTimestamp` is zero and the current day reads zero too, so a
"the clocks agree" check passes vacuously — every chain agreeing at zero — and
the setter then accepts any non-zero `D*` because the current day is zero as
well. A check that cannot fail on the state you are guarding against is not a
check.

Require a **NON-ZERO launch timestamp** and an **ACTIVE clock** on every chain
before comparing them — *not* a non-zero current day. `currentDayOrZero()`
returns a `(day, active)` pair: `(0, false)` when the launch is unset or still in
the future, and `((now − launch) / 1 days, true)` once it has passed. So during
the first 24 hours of a valid launch it returns `(0, true)` — day zero is the
first ACTIVE reward day, not an idle clock. Requiring a non-zero day would block
the documented genesis activation, which the setter accepts perfectly well since
it only demands `D* > 0` and `D* > today`. The `active` flag is what separates
"not started" from "started, on day zero"; the day number cannot.

**Then confirm every target mirror is still UNARMED.** Both ingress paths
install the incoming `armedFromDay` only while the local value is zero
(`armedFromDay != 0 && s.governorCommitArmedFromDay == 0`), so a mirror carrying
a non-zero value from a rehearsal, a previous Base deployment or a partial
cutover **silently keeps its old `D*`** and ignores the new one. Nothing reverts,
nothing warns, and the Base setter is one-shot. Read
`getGovernorCommitState().armedFromDay` on every target mirror and require zero
before calling it.

**Then confirm every chain shares a reward-day clock.** The day index derives
from each Diamond's own `interactionLaunchTimestamp`, and the mirror ingress
stores `armedFromDay` **directly** — it does not repeat the future-day check the
setter applies against BASE's local day. So if launch timestamps differ, one
numeric `D*` is not one instant: an earlier mirror can cut over the moment the
broadcast lands, while a later one cannot yet report the Base armed day and
stalls its remittance. Read `interactionLaunchTimestamp` and the current reward
day back on every chain and confirm they agree before choosing `D*`.

**`D*` must be measured from when the call EXECUTES, not from when you schedule
it.** Post-handover this is an `ADMIN_ROLE` action and therefore goes through the
Timelock: Safe schedules, the delay elapses, then someone executes. The contract
evaluates `dayId <= today` **at execution**. So a `D*` chosen a few broadcast
cycles from the scheduling moment either reverts on execution because the day has
already arrived, or lands with most of its propagation buffer already spent.

Pick `D*` several broadcast cycles beyond the **expected execution time**, and
schedule/wait/execute as for any other Timelock action.

**Re-run the volatile preflights immediately before EXECUTING, not only before
scheduling — and that includes Steps 1 and 2.** `setFeeEntitlementEnabled(false)`
executing after Step 2's scan lets subsequent canonical originations skip
stamping again, so the clean scan goes stale and those loans enter `D*`
uncapped. Re-read the entitlement flag and re-run the unstamped scan at
execution, not only the balances and endpoints. The delay is long enough for the state Step 3 checked to move:
keeper balances drain, an RPC or deployment artifact can be re-pointed, lane
buckets deplete, the watcher can start failing, and a Worker flag can be changed
by anyone with secret access. Balances, endpoint-and-Diamond identity, both
rate-limiter states, watcher health and the three flags are all point-in-time
readings — take them again at execution, because the call they gate cannot be
undone.

**Re-check `D*` itself, not only the preflights.** The day is encoded when the
action is scheduled, so an execution later than planned can leave a `D*` that is
merely `today + 1` — the setter still succeeds, and the several-cycle propagation
buffer the choice existed to provide is simply gone. If the buffer has eroded,
cancel and re-schedule with a later `D*` rather than executing.

The setter writes Base storage and emits `GovernorCommitArmed`. **It sends
nothing itself.** A mirror learns `D*` in-band, when a finalized day's
broadcast reaches it after arming.

**A replay of an ALREADY-APPLIED day now installs it too** (#1944). This
paragraph said the opposite until 2026-09-01, and the change was deliberate:
the old behaviour let any third party burn a mirror's propagation days by
applying them first, leaving that mirror unarmable through this path
entirely. Both the V2 replay branch and the V3 clock-backfill branch install
`D*` when the mirror has none — never re-choosing one already set, and never
from a retired era's legacy wire.

### Step 5 — DRIVE the propagation and verify it (M3 / active-mirror branch only)

**⛔ FIRST, the prohibition that governs everything in this step.** The broadcast
entry points are PERMISSIONLESS with respect to the caller, and on a mesh where
ANY REACHABLE mirror lacks the per-day funding property (a claim against a day whose budget has not arrived cannot consume value belonging to anything else — **not** merely "#1566 deployed") an early broadcast pays a claimant out
of borrower collateral rather than reverting.

**Reachable** = a LIVE OUTBOUND LANE **and** any one of:

1. current membership of `getBroadcastDestinations()`;
2. current membership of `getExpectedSourceChainIds()`;
3. a historical standing day that can pass the V3 lapse-clock gate —
   **applied or not** (#1944). "Unapplied" was part of this definition until
   2026-09-01 and is now WRONG in the unsafe direction: a replay installs
   `D*` on a mirror that has none, so an applied day still makes a mirror
   armable and therefore reachable.

   **Being ALREADY ARMED is not an exclusion** — a correction to the first
   version of this rewrite (Codex #2031 r13). `D*` being one-shot stops a
   second arming; it does not stop `broadcastGlobalTo`. A fresh apply of an
   unapplied standing day passes `_assertDayStanding` and opens that day's
   claim gate whether or not `armedFromDay` was already set, so an armed
   mirror lacking the per-day funding property is still an exposure.

   A removed mirror drops out of reachability only when it is absent from
   the expected-source list AND its lane or era is genuinely unreachable
   (a rotated-away era cannot arm and its legacy wire cannot apply) OR every
   qualifying standing day has already been applied — so no fresh apply
   remains to open a gate.

**This is the one definition. Everything else in this runbook refers to it
rather than restating it** — the two places that restated it drifted apart three
times, which is most of what the review of this section found.

Three disjuncts because three things make a mirror targetable. `broadcastGlobal`
fans out to the CURRENT destination list and calls no standing assertion, so
(1) suffices with no history at all. `broadcastGlobalTo` calls
`_assertDayStanding`, so (3) is what makes a REMOVED mirror targetable. And (2)
is PROSPECTIVE: `_finalizeAndWrite` sets `s.chainDailyIncluded[dayId][chainId] =
true` for every participating chain, so a mirror still on the expected-source
list acquires standing on its next accepted report and becomes targetable
through `broadcastGlobalTo` afterwards — being absent from the destination list
and having no history today does not make it safe tomorrow.

The historical disjunct needs one more qualifier: `broadcastGlobalTo` checks
`dayLapseClock[dayId].finalizedAt` FIRST and reverts `DayHasNoLapseClock`, so
standing that exists only on days finalized before the V3 lapse-clock upgrade
does not make a REMOVED mirror targetable at all. Require a standing day that can
pass that gate; otherwise a mirror with nothing but pre-upgrade history would
hold the mesh paused over a broadcast that cannot be sent.

**SUPERSEDED — an APPLIED day is no longer spent for arming (#1944 / #1569,
2026-09-01).** This paragraph used to say that a removed mirror whose every
V3-clock standing day had already been applied could not be reopened, because
`_applyBroadcastV2Core` took the idempotent replay branch *before* installing
`armedFromDay`. That premise was removed on purpose: the replay branch now
installs `D*` when the mirror has none, and so does the V3 clock-backfill
branch, because the old behaviour left a mirror permanently unarmable once a
third party had applied its days first.

The consequence for THIS gate is the dangerous direction. A permissionless
`broadcastGlobalTo` of an ALREADY-APPLIED day still passes historical standing
and can now arm that mirror, so "its finite history is spent" no longer
follows from "every standing day is applied". Following the old reachability
test would permit unpausing the mesh while an unsafe mirror is still
targetable.

**Treat an authenticated V3 replay as an arming path.** A removed mirror is
excluded from the gate only if it is absent from the expected-source list AND
either its era has been rotated away (a retired legacy wire cannot arm — that
exclusion is deliberate and tested) or it is already armed (`D*` is one-shot;
a replay fills an empty slot, never re-chooses a set one). "Applied" on its
own is no longer a safety property. **Do not run the cycle
below, and do not unpause the reward messenger, while that is true of any such
mirror** — see "the one safe branch" and the dead-end list further down, which
record five procedures that were each tried against this and refuted. The cycle
below is for a mesh where every reachable mirror enforces the PER-DAY FUNDING PROPERTY (a claim against a day whose budget has not arrived cannot consume value belonging to anything else — **not** merely "#1566 deployed", see the warning in the propagation section).

**Everything in this step — the promotion gate below, the propagation cycle, the
pause discussion — sits under that prohibition.** An earlier revision placed it
eighty lines down, after the promotion instructions, which is the same as not
having it: the promotion preflight requires #1566 only on the promoted chain, so
following it can have an operator reopen the global sender while another mirror
is still targetable through `broadcastGlobalTo`.

**Promoting a dark mirror later needs its own gate, and this runbook does not
otherwise provide one.** Once Base is armed, EVERY subsequent broadcast carries
its stored `armedFromDay`, and a mirror sitting at zero installs it on first
application — so a mirror brought up after M3 lands cuts over the moment it
receives any broadcast, at a `D*` that may be long past. **Check the mirror's Base-era binding FIRST — a wrong one makes propagation
impossible, not merely slow.** If `baseRewardDeployment` is unset or still names
an earlier Base Diamond, the clock-bearing broadcast is rejected outright
(`BroadcastEraUnauthenticated`) and `D*` cannot install by any route. And if the
mirror previously followed a Base rotation, `rewardEraRotated` stays permanently
true, which closes the clockless V2 fallback too — so a rotated mirror needs BOTH
a correct era binding and a clock-bearing day, and the clockless bootstrap below
does not apply to it.

**Promotion is a full Step 3 for that chain, not a short checklist.** Run the
whole active-mirror preflight against it — `KEEPER_ROLE`, keeper funding, the
deployment artifact's Diamond address, both lane rate-limiter states, watcher
coverage — plus PR-2, PR-5c, PR-6 and the PER-DAY FUNDING PROPERTY (a claim against a day whose budget has not arrived cannot consume value belonging to anything else — **not** merely "#1566 deployed", see the warning in the propagation section) enforced on it — the #1566 fix being *live* is not the same test, its clock
agreeing with Base, and its `armedFromDay` reading zero. A mirror bootstrapped
without those arms into a mesh that cannot report, fund or observe it; then expect it to arm on its first
broadcast rather than on a day you choose. There is no second cutover to
schedule.

**And it cannot be bootstrapped with an ordinary current-day broadcast** — the
same deadlock as the original propagation, arriving by a different door. The
keeper's report returns while the mirror's `armedFromDay` is zero, while
`_planDay` declines an armed-day remit until that report completes; and after
`D*` has passed, every current day IS an armed day. Bootstrapping it is harder than Step 5's case and may not be possible with a
remit at all: a mirror that was genuinely dark until after M3 has **no report in
any historical finalization**, so it is not an included chain for any pre-`D*`
day and `_planDay` produces no budget for it — the remit reverts
`NothingToRemit`. Use a pre-`D*` day the mirror has not applied and broadcast it
WITHOUT a remit; the day carries no budget for that mirror, so there is nothing
to strand, and the mirror installs `D*` and can report from then on.

**Check what the FAN-OUT does to the OTHER mirrors first.** The dark mirror has
no day standing, so `broadcastGlobalTo` cannot target it and the fan-out form is
forced — which delivers that day to every destination. Any active mirror that has
not already applied it, and has a non-zero slice for it, gets its claim gate
opened unfunded. Choose a day every other destination has already applied, or
remit their slices before the fan-out.

**And the promoted mirror is not exempt from that either.** If it has accrued
local pre-`D*` entries, it prices the day from `halfPoolForDay` — its own local
pool — not from the zero slice it was allotted, so the no-remit bootstrap opens
it against a day it was never funded for. Where the mirror holds local entries,
fund it before the broadcast rather than relying on the absent slice.

**If the promoted mirror holds local pre-`D*` entries, there is no safe day to
bootstrap it with, and you must fund it first.** It was excluded from every
historical finalization, so no pre-`D*` day carries a slice for it, and a
zero-slice destination cannot be remitted at all — the plan returns before
setting a close and the remit reverts. Credit the mirror's local pool by the
normal funding route BEFORE broadcasting the bootstrap day, or promote it only
after its local entries have settled. Broadcasting first is the case this whole
section exists to prevent.

Confirm the day predates `D*` and has fully ELAPSED. **A lapse clock is NOT required here, UNLESS a destination has
followed a Base rotation** — a rotated mirror rejects the legacy V2 wire the
clockless fan-out falls back to, so for those the propagation day must carry a
clock, and that applies to initially-active rotated mirrors on the FIRST ceremony
too, not only to promotions. Otherwise: on a deployment armed before the V3 upgrade every pre-`D*` day
may have `finalizedAt == 0`, and demanding one would leave no eligible day and no
way to promote the mirror at all. The fan-out falls back to the clockless wire —
it is the per-destination form that needs the clock, and this case uses the
fan-out anyway.

**On the Base-only / dark-mirror branch, skip this step entirely.** There is no
mirror to propagate `D*` to, and the remit, receipt and broadcast surfaces this
step drives are the M3 surfaces Step 3 already established need not exist on that
branch. Arming Base is the cutover there; go to Step 6.

(For the RL-3 horizon knob that completes M7, see Step 6 — it is deliberately
separate and separately gated.)

**Arming sends nothing, and nothing sends it for you.** The setter writes Base
storage and emits its event; mirrors learn `D*` only from a day broadcast. On the
documented operating path there is **no deployed daemon that finalizes a day and
broadcasts it** — that cycle is operator-driven, and the testnet finalization
script does not broadcast either. So an operator who arms and then waits for
mirrors to show `D*` can wait until the cutover day arrives with every mirror
still unarmed.

**On a mesh where every reachable mirror enforces the per-day funding property**
(not merely "has #1566" — see the warning further down), drive the cycle
explicitly after arming: finalize a day that has
not yet been applied on the mirrors, **remit that day to every destination and
wait for each mirror to CONFIRM receipt**, and only then call the payable
`broadcastGlobal` (or `broadcastGlobalTo` per destination) and pay the transport
fee.

**Your ordering is not enforced.** Anyone willing to pay the CCIP fee can
broadcast a newly finalized day between your remit submission and its arrival,
opening the mirror's claim gate early. Shortening the window by finalizing and
remitting close together helps and does not close it — and an earlier revision of
this paragraph presented shortening as the whole remedy, which is only tolerable
on a mesh that enforces the per-day funding property, where the residue is an
empty balance. A mesh that merely carries #1566 may not: see the warning below.

**The propagation day must have fully ELAPSED, not merely be numerically below
`D*`.** The force-finalization path does not check the reward clock, so "a day
before `D*`" admits today or a future day; finalizing one of those publishes a
day whose activity is still accruing. Require `day < currentRewardDay` as well as
`day < D*`.

**The per-destination form is not always available.** It also reverts
`DayHasNoLapseClock` on a day finalized before the V3 lapse-clock upgrade, whose
`dayLapseClock.finalizedAt` is zero — likely for exactly the old pre-`D*` days
this step reaches for. Check the clock before choosing the per-destination form. If the chosen pre-`D*` day
was grace- or force-finalized without a particular mirror's daily report, that
mirror has no day standing for it — and being pre-cutover, it has no armed-day
zeroed marker either — so `broadcastGlobalTo` reverts
`DestinationHasNoDayStanding`. Use the fan-out form for such a day, or pick a day for
which every destination has a NON-ZERO remittable slice — inclusion alone is not
enough, since a destination that submitted a ZERO-VALUED report is included and
still budgets to zero, which exits the plan without a close and reverts the remit
exactly as exclusion does.

**That first propagation day must be strictly BEFORE `D*`, or the ceremony
deadlocks — after the irreversible arm.** An armed-day remit is refused until
that mirror's commitment report is complete; the keeper's report returns early
while the mirror's `armedFromDay` is still zero; and the mirror learns `D*` only
from the broadcast this step performs after remitting. Remit waits on the
report, the report waits on `D*`, `D*` waits on the broadcast, the broadcast
waits on the remit. Choosing a pre-`D*` day breaks the cycle, because a pre-`D*`
remit does not need the report. **Confirm such a day will still be available
when you execute** — this is another reason `D*` needs a real buffer beyond
execution.

**Source order is not delivery order.** The messenger sets
`allowOutOfOrderExecution: true`, so sending the remit first does not guarantee
it ARRIVES first — and it is the arrival that funds the mirror, while the
broadcast opens its claim gate. Wait for each mirror's `RewardBudgetReceived`
before broadcasting to it, rather than treating the send order as sufficient.

**And that wait is a convention you keep, not an order you enforce — the
broadcast is PERMISSIONLESS.** `broadcastGlobal` and `broadcastGlobalTo` are
`onlyCanonical`, and that modifier checks `isCanonicalRewardChain` — a property
of the CHAIN, not of the caller. Any account on Base willing to pay the CCIP fee
can broadcast a finalized day. So between finalizing the day and the last
`RewardBudgetReceived` landing, a third party can open every mirror's claim gate
against a budget that has not arrived, and no amount of operator discipline
prevents it. **While #1566 is undeployed on that mirror this is a fund-loss path,
not an empty-balance revert** — see the containment note below; an earlier
revision of this sentence said the opposite and it survived one round of the
correction because only the paragraph below was rewritten.

**This window cannot be closed by ordering, and an earlier revision of this
paragraph was wrong to say it could.** Moving the remit and its receipts ahead of
the arm does not help: `broadcastGlobal`'s only day-state prerequisite is
`dailyGlobalFinalized[dayId]`, so a third party can broadcast the day the moment
it is finalized, whichever side of the arm that falls on.

**A pre-arm application NO LONGER spends the day** (#1944, 2026-09-01). This
paragraph said it did, and the whole "exhaust the day set" worry below follows
from that premise. If the day is applied on a mirror while Base is still
unarmed, that mirror records `broadcastV2Applied[dayId]` — and
`_applyBroadcastV2Core`'s replay branch now INSTALLS `armedFromDay` when the
mirror has none, so rebroadcasting *that same day* after arming works. The V3
clock-backfill branch installs it too.

Any other eligible day also still works, as it always did:
`_assembleDayV2` stamps the CURRENT `s.governorCommitArmedFromDay` into every
newly assembled payload, so a fresh apply installs the same `D*`. What a replay
never does is RE-choose a `D*` already set, or install one from a retired era's
legacy wire.

The paragraph below is retained because its reasoning still holds for the cases
that DO exhaust — a rotated-away era, or a lane that is genuinely gone.
Permanent failure requires EXHAUSTING
the eligible alternatives, not losing one. (An earlier revision of this paragraph
said the mirror could not be armed at all; that was wrong and would have had an
operator treat a recoverable cutover as irreparable.)

**On a mirror that does NOT enforce the per-day funding property, do not run a propagation procedure at
all.** Keep the reward messenger paused and leave that mirror out of the cutover
until that property or a day-scoped protocol gate lands there (#1944). Everything below
about pausing and unpausing applies ONLY to a mirror that already carries the
property, where an early broadcast costs a user an empty balance until funding
arrives rather than paying them out of borrower collateral. Read the dead-end
list before reaching for any of it.

**⚠ "#1566 deployed" is NOT the same as the property this scoping needs.** What
makes an early broadcast survivable is a per-day funding property: *a claim
against a day whose budget has not arrived cannot consume value belonging to
anything else.* #1566 does not specify that.
`Vpfi1566CanonicalDeliveredBoundDesign.md` leaves options B–E open, and only some
deliver it — Option C, for instance, closes the gap by earmarking the USER-OWNED
custody classes, which protects borrower collateral while still letting such a
claim consume another day's reward funding, payroll custody, escrowed value or
newly minted supply. Before treating any mirror as out of the block, confirm the
DEPLOYED fix enforces the per-day property; where it only protects a subset of
owners, containment stays for cross-day funding corruption even though borrower
collateral is safe.

**Sequence the pause AFTER report coverage, or the ceremony stalls.**
`VaipakamRewardMessenger.onCrossChainMessage` is itself `whenNotPaused`, so
pausing the canonical reward messenger REJECTS inbound mirror reports — they
become failed, manually re-executable deliveries. `finalizeDay` then either stays
below coverage or eventually grace-finalizes WITHOUT that destination, and the
day is then excluded for it, which collides with this runbook's own requirement
that every destination have a non-zero remittable slice. Confirm complete report
coverage for the candidate day and read it back BEFORE pausing, then pause
immediately before finalization. Otherwise the post-arm ceremony can run out of
usable days against an immutable `D*`.

**That ordering is best-effort and does not make the pause a gate for the
candidate day.** The moment the last required report lands, `reportCount >=
nExpected` makes `finalizeDay` permissionless — so between that block and the
guardian's separate pause transaction being mined, anyone can finalize and
broadcast, both from one helper contract. On a property-enforcing mesh the cost
is a claim outage and a spent day rather than a loss, but the window is real and
cannot be closed here: report completion and the pause are two transactions and
nothing makes them atomic. A day-scoped protocol gate is what would (#1944).

**Where that property IS enforced, the messenger pause is a usable gate.**
`VaipakamRewardMessenger` is `GuardianPausable` — `pause()` is guardian-or-owner
— and every V2/V3 broadcast sender on it is `whenNotPaused`, while reward-budget
remittance and receipt run over the SEPARATE `crossChainMessenger` /
`RewardRemittanceReceiver` path. So:

1. pause the reward messenger;
2. finalize the candidate day, remit to every destination, confirm every
   `RewardBudgetReceived` — all while it stays paused, and none of it blocked by
   the pause;
3. unpause, then broadcast.

**That closes the finalize→receipt window for the CANDIDATE day and nothing
more** — on an unfixed mirror the residue is a fund-loss path, which is why the
scoping above is not a formality. Five successive attempts to make this sequence
safe on an UNFIXED mirror were each refuted, and they are recorded here as a
DEAD-END LIST so the next person does not re-derive them under time pressure:

| Attempted procedure | Why it does not hold |
| --- | --- |
| Remit + receipts BEFORE arming | `broadcastGlobal`'s only day-state gate is `dailyGlobalFinalized`; arming is irrelevant to it. Worse, a pre-arm application spends that day for propagation (`_applyBroadcastV2Core` replays without installing `armedFromDay`). |
| Pause, fund the candidate, unpause, broadcast | `broadcastGlobal` accepts ANY finalized day, so unpausing re-opens every other unfunded finalized day at once. |
| Reconcile every broadcastable day first | An applied-but-unfunded day is ALREADY open and pausing Base cannot close it; and `finalizeDay` is permissionless, so new broadcastable days can appear after the inventory. |
| Contain the destination's claim path meanwhile | `AdminFacet.pause()` is the Diamond's single global flag: `claimInteractionRewards` and `onRewardBudgetReceived` are BOTH `whenNotPaused`, so pausing claims also blocks the remittance receipt. "Wait until every pending day is funded" is unreachable — funding cannot land while claims are stopped, and unpausing to admit it re-opens the race. |
| Safe-only executor + fresh reconciliation before execution | Restricting the executor controls only WHO unpauses. It does not make reconciliation and unpause atomic, and `finalizeDay` — permissionless and not routed through the paused messenger — lets a new unfunded day be created after the inventory, including by front-running the Safe's own unpause. |

**So there is ONE safe branch, and it is MESH-WIDE rather than per-mirror: while
ANY REACHABLE mirror lacks the per-day funding property below, keep the reward
messenger PAUSED for the whole mesh, reconcile every outstanding broadcast
message to a SAFE state — not delivered and provably not re-executable, or
delivered and its day FUNDED (or that destination secured) — and run no post-arm
propagation at all.**

Three parts, and each was added because leaving it out was tried:

- **REACHABLE** is the definition given at the head of this step — a live
  outbound lane and any of destination-list membership, expected-source
  membership, or a V3-clock standing day (applied or not, per #1944).
  Deliberately NOT restated
  here: the two copies of it drifted apart three times during review, so this
  bullet points at the one statement instead of paraphrasing it.
- **Reconciliation of outstanding broadcasts is part of the branch, not a
  footnote — and "terminal" is not the test.** The pause does not reach a
  broadcast already dispatched, and pausing the destination's ingress leaves it
  failed and manually re-executable rather than cancelled. But a SUCCESSFUL
  delivery is terminal too, and it is the one that opens that day's claim gate:
  an applied-but-unfunded day keeps paying from unrelated custody while the Base
  sender sits paused. So each outstanding message must end in one of two states —
  **not delivered and provably not re-executable**, or **delivered and its day
  FUNDED** (or that destination's claim path secured / the per-day property
  enforced there). An earlier revision required only a terminal state, which
  labels the continuing loss as safe.
- **The condition is a PROPERTY, not "#1566 is closed".** See below.

It cannot be scoped to the unfixed mirror, and an earlier revision implied it
could. The sender's pause is GLOBAL — unpausing it to serve the fixed mirrors
re-enables every broadcast entry point at once. And `broadcastGlobalTo` does not
consult `getBroadcastDestinations()`: it takes `destChainId` as a parameter,
asserts only that the day has standing there, and sends. So dropping an unfixed
mirror from the destination list does not protect it — anyone can target it
directly for any day with historical standing.**

**Teardown exemption — an unfixed mirror whose LANE is gone is not reachable and
must not block the mesh.** `broadcastDayV3Single` dispatches through
`CcipMessenger.quoteMessageFee` / `sendMessage`, and `_resolveDestination`
reverts before any send when the lane has been decommissioned:
`UnconfiguredChain` on a cleared `chainSelectorOf`, `NoRemoteMessenger` on a
cleared `remoteMessengerOf`, or `UnsupportedByRouter` when the router no longer
supports the selector. So a mirror can be taken out of the block by a
genuine teardown — but the exemption must be keyed to what GOVERNANCE controls.

Require, for that chain: **EITHER** protocol-owned lane field cleared —
`chainSelectorOf[chainId] == 0` **or** `remoteMessengerOf[chainId] ==
address(0)`, since `_resolveDestination` reverts on either alone
(`UnconfiguredChain` / `NoRemoteMessenger`) and both setters clear
independently, so demanding both would hold the mesh over an already-dead lane —
**and** the chain absent from `getBroadcastDestinations()` (which closes the
fan-out path the standing check never guards) **and absent from
`getExpectedSourceChainIds()`** (which stops it acquiring new standing from its
next accepted report). The exemption must negate every disjunct of the
definition, not the one being discussed — and each condition should be no
stronger than what actually makes the path unreachable. Either cleared mapping already
makes `_resolveDestination` revert before the router is consulted.

**Do NOT require `isChainSupported` to be false.** That is the CCIP router's
state, not ours: it reflects whether the router has an on-ramp for the selector,
and governance cannot clear it. Requiring it would make the exemption
unsatisfiable whenever Chainlink still supports the destination — holding the
mesh paused over a lane we have completely decommissioned. Router non-support is
an additional blocker where it happens to hold; it is never a condition of the
exemption. An earlier revision said "read all three back as cleared", which had
that defect. That is
expensive — it stops all reward messaging on that messenger and leaves the mirror
unarmed — and it is the only option in the list above that does not fail to an
argument already written down. Prefer arming a mesh whose mirrors carry the
property; where that is not yet true, the mirror waits.

Two mechanical facts that survive whatever branch is taken:

- **The pause does not reach a broadcast already IN FLIGHT.** It blocks future
  sends on that messenger instance; a CCIP message dispatched a moment earlier
  still reaches the mirror and applies the day. Pausing the mirror's ingress
  does not cancel it either — the delivery is left FAILED and manually
  re-executable, so it stays hazardous rather than being resolved.
- **A queued unpause on an open-executor Timelock is public.**
  `DeployTimelock.s.sol` defaults `TIMELOCK_EXECUTOR` to `address(0)`, so anyone
  may execute once the delay expires. Scheduling late and watching for trouble
  is not a mitigation: cancellation cannot outrun an attacker who executes the
  ready operation themselves.

Whether or not the pause is used:

- **Pick a propagation day and confirm its state per mirror immediately before
  broadcasting.** Call `RewardReporterFacet.getBroadcastV2Applied(dayId)` on
  each mirror.

  **`true` NO LONGER means the day is spent for arming** (#1944, 2026-09-01).
  It once did, and this line said so; the replay branch now installs `D*` on a
  mirror that has none, precisely so a third party applying a day first cannot
  render that mirror unarmable. An applied day is therefore still a usable
  propagation day over an authenticated V3 wire. The readback remains worth
  doing — it tells you whether the broadcast will take the fresh path or the
  replay path, which is what you are reconciling afterwards — but it is no
  longer a go/no-go on arming. Do this as a readback in
  the same sitting as the broadcast, not from notes taken earlier: any third
  party can apply a finalized day in between.

  **Check the getter is routed on that Diamond first** (`cast call` it, or
  `DiamondLoupeFacet.facetAddress` on its selector). It was added by **#1944**
  and reaches a deployment only through a facet refresh, so a Diamond that
  predates the refresh reverts `FunctionDoesNotExist`. On such a Diamond the
  only source is the mirror's LOGS — a `RewardBroadcastV2Applied(dayId, …)`
  event for that `dayId` means the day is spent.

  **Prefer the readback wherever it is available, and treat a log scan as the
  degraded path.** A scan that silently misses a page — provider retention,
  block-range caps, a truncated response — reports "not applied", which is the
  one wrong answer that burns the candidate day. The readback has no such
  failure mode.
- **Have alternates ready.** Identify several unapplied pre-`D*` days before
  arming, not one.
- **Keep the finalize→broadcast interval short**, since finalization is what
  makes a day broadcastable by anyone.
- **If every eligible day has been applied on a mirror, stop and escalate** —
  that is the exhaustion case, and it is a protocol question rather than a
  runbook step.

**⛔ While #1566 is open, an early broadcast is a FUND-LOSS exposure, not a UX
one — and an earlier revision of this paragraph asserted the opposite.** The
claim gate opening ahead of its funding does not simply revert on an empty
balance: `LibVpfiRecycle.backingPosition` derives `unearmarked` from
`balanceOf(address(this))` less the bucket, the stranded-recovery reservation and
the recovery position — and NOT less the other owners of that same balance, which
its own enumeration says include a live swap-to-repay intent's
`custodialCollateral` and liquidation `fallbackSnapshot` custody. So a claimant
reaching an early-opened gate on an unfixed mirror can be paid out of borrower
collateral. Since broadcasting is independent of arming, this is reachable before
the ceremony's deploy-before-arm check is ever performed. Treat a finalized,
unapplied day on an active mirror that does not enforce the per-day funding property as an exposure to
contain now, not a hazard scheduled for the ceremony.

**One exception, and without it the wait never ends.** If the chosen day
allocates zero budget to a destination, `remitRewardBudget` closes it locally,
emits `RewardBudgetRemitted` with a zero message id and returns **without sending
a CCIP payload** — so that mirror will never emit `RewardBudgetReceived`. Waiting
for one there burns the propagation window and can run past an immutable `D*`.
A THIRD case sits between those two, and the fan-out advice above does not
reach it: if the chosen pre-`D*` day was grace- or force-finalized without a
mirror's report, `_planDay` sees no included-chain budget, returns no close at
all, and `remitRewardBudget` reverts `NothingToRemit` — so there is neither a
receipt nor a zero-message close to observe. **Do not read that revert as permission to broadcast.** `NothingToRemit` means
the day carries no budget FOR THAT DESTINATION — not that opening its gate is
harmless. Before `D*` a mirror prices the day from its own local pool rather than
from the per-destination slice, so an active mirror holding local entries will
pay against a day it was never funded for. **Choose a day every destination was
included in.** That is the only safe resolution, and it also avoids the
`broadcastGlobalTo` restriction below.

**A pre-`D*` day cannot produce a zero-total close at all** — the plan returns
before setting one and the remit reverts, so there is nothing to observe and
nothing to treat as satisfied. That is why the propagation day must give every
destination a NON-ZERO remittable slice: there is no benign zero case here to
fall back on. The zero-close exception below applies to ARMED days only: its
stamped payable budget is zero, so opening its gate funds nothing and strands
nobody. Confirm the zero-total close in the emitted event rather than assuming
it.

The remit-first order is not a preference. The broadcast **opens the mirror's
claim gate**, and it does so independently of the keeper's remittance cron — so a
day broadcast before its budget lands opens claims against funding that has not
arrived. **On a mirror that does not enforce the per-day funding property that is a fund-loss path, not a
revert**: the payout is measured against a balance whose other owners include
borrower collateral (see the containment note in the propagation section). Where
that property IS enforced, the harm reduces to users hitting an empty balance until
funding arrives. The keeper narrows that gap on a best-effort basis
and does not close it, which is exactly why a MANUAL broadcast has to remit
first. A replay of an already-applied day **does** install `D*` on a mirror
that has none (#1944), so the day you broadcast no longer has to be one the
mirrors have not seen — this sentence said it did until 2026-09-01. Choosing
an unseen day is still the cleaner operation, because a fresh apply
reconciles in one step, but it is a preference now rather than a
precondition.

Then read `D*` back on every mirror, with days to spare:

```
RewardAggregatorFacet.getGovernorCommitState()   # → (armedFromDay, outstandingFresh, outstandingRecycled, paidOutRecycled)
```

`armedFromDay` is `0` while unarmed. Governance **cannot postpone `D*`**, so have
the contingency written down before you arm: a mirror that misses the day keeps
its claims halted until CCIP delivery recovery or manual re-execution restores
the broadcast.

The flags were set and tail-confirmed in step 3g, deliberately: a chain running
without all three leaves reports and acks inert and stalls multi-chain funding,
and that is not something to discover once `D*` is immutable. Re-check the tail
here only to confirm the armed-day passes are running against the new state.


### Step 6 — the RL-3 horizon knob (M7.2), separately gated

```
ConfigFacet.setRewardClaimHorizonDays(<days>)      # ADMIN_ROLE
```

**It defaults to zero, and zero means the expiry/sweep path is dark.** A
ceremony that stops at Step 5 leaves it that way — which is a coherent state,
but an operator who marks recycling "activated" without noticing will believe
RL-3 is live when nothing sweeps.

**Read back the RL-4 allocation weights — and do it BEFORE Step 4, not here.**
The register is consulted during armed-day finalization independently of the
horizon knob, so on a deployment that defers Step 6 this check never runs before
`D*` and a stale non-zero split quietly earmarks user-reward runway from the
first armed day. It is described here because it belongs to M7.2's posture; it
must be PERFORMED alongside the other pre-arm readbacks in Step 3.

The requirement: The required dormant posture is
`[keeper 0, reserve 10000]`. On a Diamond that was upgraded or rehearsed,
`recycleRegisterKeeperBps` may already be non-zero, and nothing in this ceremony
restores it — once armed-day finalizations run, the register earmarks part of the
realized margin into the keeper budget, removing it from fundable user rewards
while the operator believes the default allocation is in force. Read it back, and
ratify explicitly if it is not zero.

It is separate from Steps 1-5 on purpose: it carries **its own** preconditions,
and setting it ad hoc later is how those get skipped. All of them must be
verified live first:

- **both** ratified RL-3 UX safeguards — the free-channel pre-expiry notice in
  the in-app notification centre **and** the claim-centre countdown surface.
  Notice alone does not satisfy the ratified safeguard: a user has to be able to
  see when claimable rewards become terminally sweepable;
- the **same mesh gate as arming** — rewards Base-only / dark on mirrors, OR M3
  complete. Mirror expiry credits land in local buckets Base can neither count
  nor consume until B′, so activating across an incomplete mesh strands them;
- **#1499 CLOSED, and its fix deployed on every reward chain** — not merely
  "the shared definition exists". While the expiry predicate and the claim gate
  measure different quantities, executable time accrues for claims that currently
  revert, so restored funding lets the next sweep expire entitlements on stale
  elapsed time. Assert the deployed code slice per chain, as Steps 1 and 4 do;
- **#1566 CLOSED and its fix deployed ON EVERY REWARD CHAIN** — per chain, the
  same way the #1499 bullet above is worded and for the same reason: this setter
  is a LOCAL write scheduled on each chain (see the closing note of this step),
  so a mirror can receive the horizon while running its own expiry sweep against
  its own balance-based backing. A Base-only verification does not satisfy this.
  It is also the same gate Step 4 carries, and it
  belongs here TOO rather than only there. Step 4's version reads *"the
  fund-safety half is #1566, and it is OPEN. Do not arm until it closes"*, which
  binds arming. This step is deliberately separate and can be performed later,
  ad hoc — which is precisely the route by which a precondition gets skipped, and
  the reason this list exists. While payouts are bounded by un-earmarked BALANCE
  rather than by funding delivered for rewards, the bucket's backing shares one
  fungible balance with claimants that include **user collateral**
  (`LibVpfiRecycle`'s custody enumeration lists a live swap-to-repay intent's
  `custodialCollateral` and liquidation `fallbackSnapshot` custody, and says
  outright that a payout drawing on them spends a BORROWER's collateral).
  Turning on the sweep moves more value through that shared balance, so enabling
  RL-3 ahead of #1566 widens the exposure the arming gate was written to hold
  shut. Deferring Step 6 does not defer this.

The setter range-checks a non-zero value against the configured minimum, so a
too-short horizon reverts rather than silently truncating a user's window.

**It is a LOCAL write with no broadcast.** Unlike `D*`, nothing propagates this:
the setter writes the calling Diamond's storage and emits. Setting it on Base
alone leaves every mirror at the zero/dark default, so mirror entries never
accrue toward expiry and never sweep — while the ceremony looks complete.
Schedule it through the Timelock **on every reward chain**, and read
`getRewardClaimHorizonDays` back on each.

## Testnet rehearsal

Before mainnet:

- Deploy all three Safes on Sepolia / Base Sepolia / Arb Sepolia /
  OP Sepolia / BNB Testnet / Polygon zkEVM Cardona at the same address
  as the intended mainnet ones (via CreateCall).
- Walk the **per-chain handover** steps 1–6 above (Deploy the Timelock →
  Readback verification) end-to-end against each testnet Diamond with
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
- **Open execution vs Safe-only execution. The DEPLOYED default is OPEN, not
  Safe-only** — `DeployTimelock.s.sol` reads
  `vm.envOr("TIMELOCK_EXECUTOR", address(0))` and sets `executors[0] = executor`,
  so omitting the variable grants `EXECUTOR_ROLE` to `address(0)`. An earlier
  revision of this bullet said the default was Safe-only; an operator who
  believed it would leave every scheduled operation publicly executable at delay
  expiry, which the reward-messenger unpause procedure depends on NOT being the
  case. Open execution (executor
  = `address(0)`) means anyone can execute after delay; useful if the
  Safe is unavailable, but removes a cancellation checkpoint. **Set
  `TIMELOCK_EXECUTOR` to the Safe explicitly if you want Safe-only execution —
  it is not what you get by default.** An earlier revision of this bullet ended
  by saying the current default was Safe-only, contradicting its own opening two
  sentences after they were corrected.

---

## Treasury and founder distribution policy

This section captures the protocol's chosen approach to treasury
management and how founders / the operating company capture
protocol value. Decisions here have outsized securities / tax /
operational implications, so the reasoning is recorded rather than
the design just being a code reference.

### TL;DR

| Question | Answer |
|---|---|
| Where do operating fees accumulate? | Diamond as treasury (`s.treasury == address(this)`); per-token in `treasuryBalances[asset]`. |
| When are accumulated fees converted? | Aggregated, threshold-or-time-triggered. NOT per-tx. |
| What do they convert to? | A fully governance-configurable target-allocation list of `(asset, %)` entries (`s.treasuryConvertTargets`) — no hardcoded reserve set. |
| Does any cut auto-route to a "founder address"? | **No.** This is the load-bearing design choice. |
| How do founders capture value? | (1) Genesis VPFI grant, vested 4 yr / 1 yr cliff via a `VaipakamVestingWallet`. (2) A founder **salary stream** (`PayrollFacet`) — a fixed governance-budgeted wage paid continuously from the treasury. (3) Discretionary governance-approved operating budget for ongoing team work. |

### The pattern we're NOT adopting (and why)

The original T-056 sketch was: convert treasury tokens to a target
mix, and on every conversion send a hardcoded founder's-cut
percentage to a `.env`-configured address. Reviewing this against
the major-protocol pattern surfaced four converging reasons to drop
it:

1. **Securities exposure.** Auto-routing protocol-fee revenue to a
   hardcoded insider address strengthens the SEC's "efforts of
   others" prong of the Howey test. Discretionary, governance-
   approved distributions are dramatically safer. Multiple 2023-2024
   SEC actions (Coinbase staking, Kraken staking, BlockFi) cited
   automated revenue-distribution-from-user-activity as a key
   factor.

2. **Tax fragility.** Every fee accrual = a separate realization
   event for the founder. Hundreds-to-thousands of taxable receipts
   per year in many tokens creates a reporting nightmare. Aggregated
   periodic distributions = one event per cycle, clean treatment.

3. **Operational fragility.** V3-fork DEX's 2020 "Chef Nomi" episode
   is the textbook cautionary tale: the protocol had a hardcoded
   `developerFund` that auto-collected 10% of SUSHI emissions. The
   pseudonymous founder withdrew ~$14M to a personal address three
   weeks after launch. Community uproar; founder eventually
   returned it; V3-fork DEX restructured to multisig / DAO control. The
   pattern itself is fragile even with good actors.

4. **Sanctions surface.** A hardcoded founder address creates a
   permanent target. Erroneous flagging (which happens — see the
   2022 Tornado Cash dust attack on hundreds of unrelated wallets)
   would freeze protocol revenue or worse. Multisig + governance =
   recoverable.

### Industry survey (2026)

A scan of protocol allocations and fee-routing across major DeFi
venues found unanimity on two points: founders get **upfront
genesis allocations vested over 3-5 years**, and operating fees
**never auto-route to a founder address**.

| Protocol | Genesis founder/team allocation | Vesting | Per-tx auto-route to founders? |
|---|---|---|---|
| Uniswap | 21.5% team + 17.8% investors | 4 years | No |
| a major DeFi protocol | Team allocation upfront | 4 years | No (fees → Ecosystem Collector → governance) |
| a major DeFi protocol | Founders received governance token at genesis | Multi-year | No (Foundation dissolved 2021) |
| Curve | 30% shareholders + 3% employees + 2% early users | 2-5 years | No |
| a major DeFi protocol | 24% founders + 22.25% investors | 4 years | No |
| Synthetix | Team / advisors at genesis | Vested | No (SCCP-approved budget) |
| a yield aggregator | 0% founder originally; later 6,666 YFI for treasury+team via gov vote | n/a / multi-year | No |
| dYdX | Employees + investors + community | Multi-year | No (v4 fees → validators / stakers) |
| 1inch | 18% team + 21% investors | 4 years | No |
| a liquid-staking protocol | Team + investors at genesis | Multi-year | No (10% fee → operators+DAO, never founders) |
| Balancer | Founders + devs + investors + advisors | Multi-year | No |
| Convex | 3.3% team + 9.7% investors | 1-3 years | No |
| GMX | 30% founders & team | Vested | No (fees → GMX stakers + GLP LPs) |
| a yield protocol | 16% team + 7% advisors | Vested | No |
| a stablecoin protocol | Founders at genesis | Vested | No |

What protocols **do** auto-route per-tx — but only to **token
holders** (which includes founders proportional to their
holdings, not as a special insider class):

- **Curve**: 50% of swap fees auto-distributed to veCRV stakers.
- **GMX**: 30% of trading fees to GMX stakers, 70% to GLP LPs.
- **V3-fork DEX xSUSHI**: 0.05% of every swap to xSUSHI stakers.
- **a liquid-staking protocol**: 10% of staking yield, half to node operators, half
  to DAO treasury.
- **Maker**: surplus → governance token burn (deflationary; benefits all
  holders).

The legal distinction is meaningful: distributing to **token
holders** = "protocol mechanics benefiting all participants
proportional to their stake." Distributing to a **hardcoded
founder address** = "ongoing payment from user activity to an
insider." The first is treated like a coupon-paying instrument;
the second looks like an ongoing unregistered securities offering.

### Vaipakam's chosen approach

**Founder value capture (genesis):**

- VPFI allocation determined at TGE per the tokenomics document.
- Vested via a Sablier / Hedgey / custom linear-vester contract;
  recommended shape: 4-year linear unlock with a 1-year cliff.
- Funded ONCE at TGE from the protocol token reserve.
  Decoupled from operating revenue mechanics.
- Founders capture protocol success identically to any other
  VPFI holder — their tokens benefit from buyback-and-burn /
  staking-pool distributions / treasury-funded growth.

**Operating budget (post-launch):**

- Founding team's ongoing work funded via per-quarter or
  per-milestone discretionary governance grants from the
  converted treasury.
- Modeled on a major DeFi protocol Companies / a yield aggregator yTeam / BGD Labs. Each grant
  proposal lists scope, deliverables, and budget; governance
  votes; payout flows from treasury.
- This is the only ongoing revenue-coupled compensation route.
  It is discretionary, transparent, and controllable.

**Treasury accumulation + conversion (T-056):**

- Diamond is the treasury. Fees accrue per-token in
  `treasuryBalances[asset]` as today.
- Conversion to ETH / WBTC / VPFI per admin-configured mix
  fires when EITHER the accumulated USD-value crosses
  `treasuryConvertUsdThreshold` for any input token, OR
  `treasuryConvertMaxIntervalDays` has passed since the last
  conversion (whichever first). Aggregated, NOT per-tx.
- Routing through 1inch / 0x aggregators (reuse the liquidation
  swap router). Slippage-bounded via per-token `minOut` arg.
- Phase 1: admin role triggers manually.
  Phase 2: timelock-gated.
  Phase 3: governance-proposal-triggered.

**Token-holder distribution from converted treasury:**

- Per-cycle, governance proposes how the converted ETH / WBTC /
  VPFI is split between:
  - Operating budget for the team
  - VPFI buyback-and-burn (deflationary; benefits all holders)
  - Staker rewards (boost the existing 5% APR pool)
  - Treasury runway / strategic reserves
- This split is the lever governance uses to balance ongoing
  team compensation against VPFI-holder returns.

### Pre-TGE prerequisites

Before any of this goes live, the following need a securities
lawyer's sign-off:

1. **Genesis allocation distribution** (founder %, employee %,
   investor %, community %).
2. **Vesting schedule contract** — SAFE-T, Sablier, Hedgey, or
   custom — chosen, audited, deployed.
3. **The treasury convert function's eligibility for
   non-securities treatment** — the function operates on
   protocol-collected fees only, with no path to a hardcoded
   insider address; this should be straightforward but document
   the design rationale formally.
4. **The discretionary-governance-budget mechanism** for ongoing
   founder team compensation — documented in a charter that makes
   clear governance retains discretion (no automatic payouts).

### Why this isn't future-flexible-only

Some protocols try to keep options open by deferring this design.
Vaipakam should NOT do that. The "we'll figure out founder
distribution post-launch" path tends to result in either (a) bolted-
on hardcoded routes that look like insider-deals, or (b) governance
inertia where the team can't easily get paid, leading to attrition.
Specifying upfront — genesis vest + governance budget — is the
clean path.

### As-built (T-600 — shipped 2026-05-16)

The contract layer landed under T-600 (PR #25, branch
`feat/t600-treasury-founder-comp`). Where the as-built differs from
the plan-stage prose above, this subsection governs. Full detail:
[`../DesignsAndPlans/TreasuryFunctionalSpec.md`](../DesignsAndPlans/TreasuryFunctionalSpec.md)
(auditor) and `TreasuryExplainer.md` (plain-language).

**Conversion — `TreasuryFacet.convertTreasuryAsset(tokenIn, perTargetCalls, minOuts)`.**
One input asset per call (a keeper loops off-chain). The target
allocation is the governance-configurable `s.treasuryConvertTargets`
list — set atomically by `ConfigFacet.setTreasuryConvertTargets`,
which is the single lever for **add / remove / reweight** a reserve
asset and validates `Σ bps == 10000` on every write (1–8 entries, no
zero address, no duplicates). Eligibility (USD-value OR max-interval)
is unchanged; thresholds via `setTreasuryConvertThresholds`. Requires
Diamond-as-treasury mode. **Governance op:** to change the reserve
mix, submit the complete new `(asset, bps)` list to
`setTreasuryConvertTargets`.

**Founder salary — `PayrollFacet` (the new Layer 2).** The plan above
listed only genesis-vest + discretionary budget; the as-built adds a
**continuous salary stream**. `createPayrollStream` / `fundPayrollStream`
/ `setPayrollRate` / `setPayrollStreamPaused` are ADMIN_ROLE → Timelock;
`withdrawSalary` is beneficiary-only. A stream pays out only what
governance has explicitly funded (`withdrawable = min(accrued, funded)
− withdrawn`) — it is a salary, structurally NOT an automatic
revenue share. **Governance op:** each budget period, call
`fundPayrollStream(streamId, amount)` to top the stream up.

**Vesting — `VaipakamVestingWallet`.** One per grantee; cliff +
linear. Funded once at TGE via `TreasuryFacet.mintVPFI`. The genesis
funding actions remain gated on the pre-TGE securities-lawyer
sign-off (see "Pre-TGE prerequisites" above); `DeployFounderVesting.s.sol`
enforces the gate (`CONFIRM_TGE_FUNDING=YES`).

### Cross-references

- T-600 / T-056 in [`../ToDo.md`](../ToDo.md); card #4 on `@vaipakam-labs` is the live tracker.
- [`../DesignsAndPlans/TreasuryFunctionalSpec.md`](../DesignsAndPlans/TreasuryFunctionalSpec.md) — auditor functional spec.
- [`../DesignsAndPlans/TreasuryAndFounderDistribution.md`](../DesignsAndPlans/TreasuryAndFounderDistribution.md) §12 — as-built design record.
- [`../internal/Tokenomics.md`](../internal/Tokenomics.md) for
  the genesis VPFI allocation breakdown (when it lands).
- The protocol's existing `s.treasury` field, configurable via
  `AdminFacet.setTreasury`, defaults to the Diamond itself for
  this design.
- T-051's `protocolTrackedVaultBalance` counter (per-user) +
  `treasuryBalances` (per-token treasury accrual) are the two
  ledgers that keep operating-fee accounting separate from
  unsolicited dust at the Diamond level.
