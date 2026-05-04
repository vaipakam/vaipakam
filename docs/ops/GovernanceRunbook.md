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
// PancakeSwap V3 and SushiSwap V3 factories per the chain matrix
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
[`CLAUDE.md`](../CLAUDE.md) → "Keeper-bot ABI sync" and
`docs/ReleaseNotes-2026-04-25.md` → Phase 9.A "Sync mechanism".

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

### Bumping the Terms of Service

The on-chain ToS gate is the `(currentTosVersion, currentTosHash)`
pair on `LegalFacet`. The retail launch ships with
`currentTosVersion == 0`, which short-circuits `isAccepted(...)` to
`true` for every wallet — the gate is dormant. Whenever the canonical
ToS text changes (`docs/Terms/TermsOfService.md` is the source of
truth; `frontend/src/pages/TermsPage.tsx` mirrors it), governance must
also bump the on-chain pair so users re-sign before the frontend
re-opens.

1. Edit the canonical text in `docs/Terms/TermsOfService.md` and the
   mirrored copy in `frontend/src/pages/TermsPage.tsx`. Verify the two
   bodies are byte-identical (modulo HTML wrapping in the React file).
2. Compute the canonical content hash. The exact algorithm is whatever
   the frontend's signing flow uses (see
   `frontend/src/hooks/useTosAcceptance.ts`); typically a
   `keccak256` over the normalised text.
3. Governance Safe schedules
   `timelock.schedule(target=diamond, data=setCurrentTos(newVersion,
   newHash), delay=48h)`. `newVersion` MUST strictly exceed
   `currentTosVersion` — the setter rejects replays and downgrades.
4. Wait 48h. Execute. The Diamond emits `CurrentTosUpdated(prev,
   newVersion, newHash)`.
5. Frontend deploy: ship the updated `TermsPage.tsx` so the rendered
   text matches the now-pinned hash. Stale frontend pages will
   continue to render — the on-chain hash gate catches signature
   mismatches at signing time but does not stop a stale page from
   loading.
6. Existing on-chain positions are NOT affected — the gate is a
   frontend-level UX, not a protocol-level deny. Users keep their
   loans / claims / repays without re-signing; only NEW state-creating
   entries through the Vaipakam frontend require a fresh acceptance.

When `currentTosVersion == 0` (retail-launch state), step 1 ships
without on-chain action. Future bumps from version 0 → version 1 are
the moment the gate becomes active across all live wallets.

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
| What do they convert to? | ETH / WBTC / VPFI per admin-configurable mix. |
| Does any cut auto-route to a "founder address"? | **No.** This is the load-bearing design choice. |
| How do founders capture value? | (1) Genesis VPFI grant, vested over 4 years via a vester contract. (2) Discretionary governance-approved operating budget post-launch for the founding team's ongoing work. |

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

3. **Operational fragility.** SushiSwap's 2020 "Chef Nomi" episode
   is the textbook cautionary tale: the protocol had a hardcoded
   `developerFund` that auto-collected 10% of SUSHI emissions. The
   pseudonymous founder withdrew ~$14M to a personal address three
   weeks after launch. Community uproar; founder eventually
   returned it; Sushi restructured to multisig / DAO control. The
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
| Aave | Team allocation upfront | 4 years | No (fees → Ecosystem Collector → governance) |
| MakerDAO | Founders received MKR at genesis | Multi-year | No (Foundation dissolved 2021) |
| Curve | 30% shareholders + 3% employees + 2% early users | 2-5 years | No |
| Compound | 24% founders + 22.25% investors | 4 years | No |
| Synthetix | Team / advisors at genesis | Vested | No (SCCP-approved budget) |
| Yearn | 0% founder originally; later 6,666 YFI for treasury+team via gov vote | n/a / multi-year | No |
| dYdX | Employees + investors + community | Multi-year | No (v4 fees → validators / stakers) |
| 1inch | 18% team + 21% investors | 4 years | No |
| Lido | Team + investors at genesis | Multi-year | No (10% fee → operators+DAO, never founders) |
| Balancer | Founders + devs + investors + advisors | Multi-year | No |
| Convex | 3.3% team + 9.7% investors | 1-3 years | No |
| GMX | 30% founders & team | Vested | No (fees → GMX stakers + GLP LPs) |
| Pendle | 16% team + 7% advisors | Vested | No |
| Frax | Founders at genesis | Vested | No |

What protocols **do** auto-route per-tx — but only to **token
holders** (which includes founders proportional to their
holdings, not as a special insider class):

- **Curve**: 50% of swap fees auto-distributed to veCRV stakers.
- **GMX**: 30% of trading fees to GMX stakers, 70% to GLP LPs.
- **SushiSwap xSUSHI**: 0.05% of every swap to xSUSHI stakers.
- **Lido**: 10% of staking yield, half to node operators, half
  to DAO treasury.
- **Maker**: surplus → MKR burn (deflationary; benefits all
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
- Modeled on Aave Companies / Yearn yTeam / BGD Labs. Each grant
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

### Cross-references

- T-056 in [`../ToDo.md`](../ToDo.md) for the implementation
  shape.
- [`../internal/Tokenomics.md`](../internal/Tokenomics.md) for
  the genesis VPFI allocation breakdown (when it lands).
- The protocol's existing `s.treasury` field, configurable via
  `AdminFacet.setTreasury`, defaults to the Diamond itself for
  this design.
- T-051's `protocolTrackedEscrowBalance` counter (per-user) +
  `treasuryBalances` (per-token treasury accrual) are the two
  ledgers that keep operating-fee accounting separate from
  unsolicited dust at the Diamond level.
