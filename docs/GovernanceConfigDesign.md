# Governance-Configurable Protocol Constants — Design & Phase 1 Plan

**Status.** Draft. All decisions called out in §7 are open until you sign off.

**Context.** The Kelp-response hardening work surfaced a question: which protocol
constants should be governance-configurable, and which should stay immutable?
This doc inventories current state, identifies the real gaps (small — most
infrastructure already exists), and proposes a Phase 1 plan that lands the
timelock + multisig admin structure now, leaving a clean seam for Phase 2
governance to plug in behind the timelock without contract changes.

---

## 1. What's already in place

Significantly more than I initially thought. The architecture was built with
this exact path in mind.

### 1.1 `ProtocolConfig` storage struct

[`contracts/src/libraries/LibVaipakam.sol:276-295`](../contracts/src/libraries/LibVaipakam.sol#L276-L295)
— packed overrides for 12 BPS values and 4 tier thresholds:

| Field | Default (constant) | Stored override |
|---|---|---|
| `treasuryFeeBps` | 100 (1%) | ✅ |
| `loanInitiationFeeBps` | 10 (0.1%) | ✅ |
| `liquidationHandlingFeeBps` | 200 (2%) | ✅ |
| `maxLiquidationSlippageBps` | 600 (6%) | ✅ |
| `maxLiquidatorIncentiveBps` | 300 (3%) | ✅ |
| `volatilityLtvThresholdBps` | 11000 (110%) | ✅ |
| `rentalBufferBps` | 500 (5%) | ✅ |
| `vpfiStakingAprBps` | 500 (5%) | ✅ |
| `vpfiTier1/2/3/4DiscountBps` | 1000/1500/2000/2400 | ✅ |
| `vpfiTier1/2/3Min` + `vpfiTier4Threshold` | 100e18 / 1k / 5k / 20k | ✅ |

Pattern: **stored zero ⇒ use constant default**. So existing deployments keep
their original semantics until a setter is called. Zero-check happens inside
getters that consumers call (see `LibVaipakam.getEffectiveTreasuryFeeBps()`
etc.).

### 1.2 `ConfigFacet` setters

[`contracts/src/facets/ConfigFacet.sol`](../contracts/src/facets/ConfigFacet.sol)
exposes:

- `setFeesConfig(treasuryFeeBps, loanInitiationFeeBps)`
- `setLiquidationConfig(handlingFeeBps, maxSlippageBps, maxIncentiveBps)`
- `setRiskConfig(volatilityLtvThresholdBps, rentalBufferBps)`
- `setStakingApr(aprBps)`
- `setVpfiTierThresholds(t1, t2, t3, t4)`
- `setVpfiTierDiscountBps(t1, t2, t3, t4)`

Every setter is:

- **ADMIN_ROLE-gated** via `DiamondAccessControl` → routed through the 48h
  timelock once `TransferAdminToTimelock` runs.
- **Bounds-checked** against declared maxima: `MAX_FEE_BPS = 5000` (50%),
  `MAX_SLIPPAGE_BPS = 2500` (25%), `MAX_INCENTIVE_BPS = 2000` (20%),
  `MAX_DISCOUNT_BPS = 9000` (90%). Any value above reverts with a typed
  error.
- **Monotonicity-checked** where relevant: tier thresholds must be strictly
  ascending (T1 < T2 < T3 < T4), tier discounts must be monotone
  non-decreasing.
- **Event-emitting** for on-chain audit trail.

### 1.3 Timelock + multisig infrastructure

[`contracts/script/DeployTimelock.s.sol`](../contracts/script/DeployTimelock.s.sol):

- Deploys OpenZeppelin `TimelockController`.
- Default 48h min delay (`TIMELOCK_MIN_DELAY` env override, min 1h).
- Proposer = multisig (Gnosis Safe). Executor default = `address(0)` (anyone
  can execute after delay — prevents a malicious multisig from stalling a
  benign scheduled change).
- Self-administered: no EOA admin backdoor; changing delay / proposers
  also goes through the timelock.

[`contracts/script/TransferAdminToTimelock.s.sol`](../contracts/script/TransferAdminToTimelock.s.sol)
transfers the Diamond's `ADMIN_ROLE` + `DEFAULT_ADMIN_ROLE` + LibDiamond
ownership onto the timelock address, in one multi-step ceremony. Kept
separate from the timelock deploy so the deployer EOA can reclaim control
cheaply if the multisig setup is wrong pre-handover.

---

## 2. What's NOT configurable today — and why

[`ConfigFacet`](../contracts/src/facets/ConfigFacet.sol) explicitly calls out
three categories as **out of scope for tuning**:

### 2.1 Tokenomics supply caps — stay hardcoded

- `VPFI_TOTAL_SUPPLY_CAP = 230_000_000e18` (230M)
- `VPFI_INITIAL_MINT`, `VPFI_*_CAP` subcaps per emission bucket

Rationale: these are **tokenomics floor invariants**. Changing them would
dilute every existing holder and violate the emission schedule promised to
users. Out of scope for governance; only changeable via a full contract
upgrade (which governance can schedule, but the setter doesn't exist).

**Recommendation: keep hardcoded.** No change.

### 2.2 `MIN_HEALTH_FACTOR = 1.5e18` — stay hardcoded (proposed)

Used by `LoanFacet` at loan initiation: a loan can't open unless the
borrower's resulting HF ≥ 1.5. Liquidation threshold is separately
`HF_LIQUIDATION_THRESHOLD = 1e18` (HF < 1 liquidates).

**Argument for making it configurable:** admin wants to tighten in stress
conditions (require 2.0x HF during a volatility spike).

**Argument for leaving it hardcoded:** changes compound with every existing
loan's trajectory — a mid-loan HF bump means loans that opened at 1.5x are
now "below spec" relative to new loans. More importantly, users opened
loans under a specific contract promise; moving the goalposts mid-flight
is the exact class of attack the Kelp incident reminded us about.

**Recommendation: keep hardcoded in Phase 1.** If a future stress event
demands tightening, upgrade via DiamondCut — governance can schedule that.
Revisit in Phase 2 if data shows a need for fine-grained tuning.

### 2.3 KYC thresholds — proposed addition

- `KYC_TIER0_THRESHOLD_USD = 1_000e18` (Tier 0 max cumulative USD)
- `KYC_TIER1_THRESHOLD_USD = 10_000e18` (Tier 1 max)

Used by `ProfileFacet` to gate tier promotions. These ARE good candidates for
governance tuning because:

- Regulatory landscape changes (e.g. FATF guidance revisions) may require
  tightening.
- Different jurisdictions may want different thresholds — a parameter the
  protocol team needs to be able to adjust without a full upgrade.

**Recommendation: add to `ProtocolConfig` + add `setKYCTierThresholds`
setter** with bounds (§5.1).

### 2.4 Fallback settlement split — hardcoded

The 3% / 2% abnormal-market fallback settlement split is also called out as
untunable. Reasoning: this is part of the "dual-consent fallback" contract
between counterparties that they agreed to at offer creation time. Changing
post-facto breaks the consent model.

**Recommendation: keep hardcoded.** No change.

---

## 3. Semantics: retroactive vs. prospective

When governance changes a BPS value mid-protocol, two policies are possible:

- **Retroactive** — the new value applies to every existing loan on the
  next interaction (repayment, fee accrual). Simple, uniform. Risky if a
  malicious governance vote passes: one tx can change economics for every
  open loan.
- **Prospective** — the new value applies only to loans / offers created
  after the change. Requires snapshotting the effective value at creation
  time and storing it in the `Loan` / `Offer` struct.

Current behavior is **retroactive** for all BPS fields (the getter pulls
the effective value at read time, not at loan creation). This is the
simpler and more common pattern (Maker, Aave, Compound all do this).

**Recommendation: keep retroactive** for BPS fields. The timelock's 48h
delay already gives users a window to exit positions before a change
applies. Moving to prospective is a larger refactor (every loan carries
its own fee snapshot), and the attack surface is bounded by the bounds
checks + timelock delay.

Exception worth calling out: **VPFI discount tier table**. Currently the
discount applied to a loan is read at loan initiation and stored on the
loan (check — I believe this is already the case; verify before Phase 1).
If it's read at repayment time, a tier-table change retroactively adjusts
paid fees, which is fine, but worth documenting.

---

## 4. Phase 1 vs Phase 2

### 4.1 Phase 1 — Timelock + multisig

Scope:

- Deploy timelock on every target chain via `DeployTimelock.s.sol`.
- Deploy Gnosis Safe multisig on every target chain (outside our repo — use
  Safe UI).
- Transfer Diamond admin roles to the timelock via
  `TransferAdminToTimelock.s.sol`.
- Tier of signers: recommend 3-of-5 multisig for Phase 1 (team + advisors;
  rotate to community-majority in Phase 2).

**Phase 1 admin flow for any parameter change**:

1. Multisig schedules a `setXxx(...)` call on Diamond, targeting the
   timelock (via Safe transaction builder → Proposer role on timelock).
2. 48h min-delay elapses. Users observe via watcher (§6) and can exit
   positions if they disagree.
3. Anyone (executor role = `address(0)`) executes the scheduled call; the
   change goes live.

**What ships in Phase 1**:

- ✅ ConfigFacet + existing setters (already done).
- ✅ Timelock deploy + admin transfer scripts (already done).
- ➕ **Add KYC threshold storage + setter** (§5).
- ➕ **Frontend pulls from chain** for tier table, fee BPS, etc. (§6).
- ➕ **Bounds audit** — verify every setter has an upper bound that matches
  the documented `MAX_*_BPS` in ConfigFacet (already true for fees, slippage,
  incentive, discount; need to add bounds for KYC thresholds).

### 4.2 Phase 2 — Governance module

Swap the multisig in front of the timelock for a governance module
(`Governor` contract, OZ v5 `GovernorVotes` + `GovernorTimelockControl`).
The timelock itself **doesn't change** — it just gets a different
`proposer`. Zero contract changes to Diamond, facets, or the config path.

Voting mechanism options for Phase 2 (non-exhaustive):

- VPFI-weighted voting (1 VPFI = 1 vote, with snapshot at proposal time).
- Escrow-weighted voting (only escrowed VPFI counts — aligns voting power
  with skin in the game, same mechanism that drives the discount tier).
- Quadratic voting, conviction voting, etc.

That decision belongs in a Phase 2 design doc, not here. The point is
Phase 1 builds the infrastructure such that Phase 2 is a contract deploy +
proposer-role swap, not a re-architecture.

---

## 5. Proposed Phase 1 additions

### 5.1 KYC threshold configurability

**Storage** — extend `ProtocolConfig`:

```solidity
// Additions to LibVaipakam.ProtocolConfig
uint256 kycTier0ThresholdUsd;   // 0 ⇒ KYC_TIER0_THRESHOLD_USD (1_000e18)
uint256 kycTier1ThresholdUsd;   // 0 ⇒ KYC_TIER1_THRESHOLD_USD (10_000e18)
```

**Setter** — new function on `ConfigFacet`:

```solidity
function setKycTierThresholds(uint256 t0Usd, uint256 t1Usd)
    external
    onlyRole(LibAccessControl.ADMIN_ROLE)
{
    // Monotonicity guard — Tier 1 threshold must exceed Tier 0
    // (otherwise Tier 1 is unreachable or covers a gap).
    if (t0Usd == 0 || t1Usd == 0) revert InvalidKycThreshold();
    if (t1Usd <= t0Usd) revert NonMonotoneKycThresholds(t0Usd, t1Usd);
    // Absolute upper bound — keeps governance from setting a value so
    // high it effectively disables KYC (e.g. 1e30 USD).
    if (t1Usd > MAX_KYC_THRESHOLD_USD) {
        revert KycThresholdTooHigh(t1Usd, MAX_KYC_THRESHOLD_USD);
    }
    LibVaipakam.storageLocation().protocolCfg.kycTier0ThresholdUsd = t0Usd;
    LibVaipakam.storageLocation().protocolCfg.kycTier1ThresholdUsd = t1Usd;
    emit KycTierThresholdsSet(t0Usd, t1Usd);
}
```

Bounds:

- `MAX_KYC_THRESHOLD_USD = 1_000_000e18` ($1M) — any value above is
  effectively "no KYC", which violates the compliance model the protocol
  was designed around.

**Getter** — add `getEffectiveKycTier0ThresholdUsd()` +
`getEffectiveKycTier1ThresholdUsd()` to `LibVaipakam`. Consumers
(`ProfileFacet`) switch from `KYC_TIER0_THRESHOLD_USD` direct reference to
the getter.

### 5.2 Frontend: read from chain

Currently `frontend/src/hooks/useVPFIDiscount.ts` has a hardcoded
`VPFI_TIER_TABLE` (lines 282-326). It duplicates the tier thresholds /
discount BPS values that live in `ProtocolConfig`. Sources of truth drift:
governance changes a threshold → frontend table doesn't update → users see
stale numbers on the tier badge.

**Proposal**: add a Diamond getter that returns the full effective tier
table + discount bps in one call:

```solidity
function getVpfiTierSchedule()
    external
    view
    returns (
        uint256 t1Min, uint256 t2Min, uint256 t3Min, uint256 t4Threshold,
        uint16 t1BpsDiscount, uint16 t2BpsDiscount,
        uint16 t3BpsDiscount, uint16 t4BpsDiscount
    );
```

Frontend replaces `VPFI_TIER_TABLE` (static const) with
`useVpfiTierSchedule()` hook that fetches this getter with 60s cache.
Same pattern as `useVPFIDiscount(chainOverride)` — canonical chain is the
source of truth, mirrors read via `useReadChain`.

Same treatment for:

- Fee BPS (already has a Diamond getter in `MetricsFacet` / `ConfigFacet`
  — just needs to be read by the UI).
- KYC thresholds (after §5.1 lands).

### 5.3 Documentation

- Add a new §12 to `contracts/RUNBOOK.md` ("Parameter-change procedure")
  covering: scheduling via Safe Proposer → waiting the 48h → executing
  via any account → verifying via event + readback.
- Extend `CLAUDE.md`'s Cross-Chain Security section with a "Parameter
  Governance" subsection pinning: timelock delay minimum, admin role
  holder, setter bounds list, retroactive-semantics note.

### 5.4 Tests

New Foundry test `test/GovernanceConfigTest.t.sol`:

- Every `setXxx` reverts without `ADMIN_ROLE`.
- Every `setXxx` reverts above its documented `MAX_*` bound.
- Every `setXxx` emits the expected event.
- Every getter returns the constant default when storage is zero.
- Every getter returns the storage override when non-zero.
- Monotonicity checks reject out-of-order inputs (tier thresholds, KYC
  thresholds).
- Timelock flow: proposer schedules → delay → anyone executes → value
  updated → event emitted. Done once as an integration test covering the
  end-to-end flow.

Estimated: 15–20 unit tests + 1 integration test. Roughly 2–3 hours of
work.

---

## 6. Open decisions (need your call before implementation)

1. **KYC thresholds in Phase 1?** Ship as §5.1 proposes, or leave hardcoded
   and revisit in Phase 2?
2. **Frontend tier table from chain in Phase 1?** Worth the getter + hook
   work (§5.2), or acceptable to leave the hardcoded duplicate for Phase 1
   and fix when the first threshold change ships?
3. **Multisig threshold**: 3-of-5, 4-of-7, or different?
4. **Timelock min delay**: accept the 48h default, or choose 24h / 72h
   based on incident-response time vs user-exit window?
5. **Executor role on timelock**: keep `address(0)` (anyone executes) or
   restrict to the multisig (protects against premature execution but
   introduces a stall vector)?
6. **VPFI discount tier — retroactive vs prospective?** Needs a code trace
   to confirm current behaviour. If prospective (stored on loan at
   initiation), document it. If retroactive, document and decide whether
   that's acceptable.
7. **`MIN_HEALTH_FACTOR` — stay hardcoded?** I recommend yes; confirm.

---

## 7. Sequencing

Once you sign off, implementation order:

1. Add `kycTier0ThresholdUsd` / `kycTier1ThresholdUsd` to `ProtocolConfig`.
2. Add getters in `LibVaipakam`.
3. Update `ProfileFacet` to read via getters instead of constant refs.
4. Add `setKycTierThresholds` in `ConfigFacet` with bounds + event.
5. Add `getVpfiTierSchedule` view in `ConfigFacet`.
6. Update frontend `useVPFIDiscount.ts` to fetch tier schedule from chain.
7. Write `GovernanceConfigTest.t.sol`.
8. Update `contracts/RUNBOOK.md` with parameter-change procedure.
9. Update `CLAUDE.md` with parameter-governance policy.

Estimated: 1–2 days depending on how deep the existing ProfileFacet / KYC
integration is. Nothing here is architecturally risky — it's all variations
on the existing ConfigFacet pattern.

---

## 8. Critical files

- [`contracts/src/libraries/LibVaipakam.sol`](../contracts/src/libraries/LibVaipakam.sol) — add 2 fields to `ProtocolConfig`, add 2 getters.
- [`contracts/src/facets/ConfigFacet.sol`](../contracts/src/facets/ConfigFacet.sol) — add `setKycTierThresholds`, `getVpfiTierSchedule` (or a new `ConfigViewFacet`).
- [`contracts/src/facets/ProfileFacet.sol`](../contracts/src/facets/ProfileFacet.sol) — switch `KYC_TIER*_THRESHOLD_USD` refs to getters.
- [`contracts/script/UpgradeConfigFacet.s.sol`](../contracts/script/) (new) — Diamond cut to replace ConfigFacet with the new version.
- [`frontend/src/hooks/useVPFIDiscount.ts`](../frontend/src/hooks/useVPFIDiscount.ts) — replace `VPFI_TIER_TABLE` constant with a chain-fetched hook.
- [`contracts/test/GovernanceConfigTest.t.sol`](../contracts/test/) (new) — bounds + access control + monotonicity + timelock integration tests.
- [`contracts/RUNBOOK.md`](../contracts/RUNBOOK.md) — add §12 parameter-change procedure.
- [`CLAUDE.md`](../CLAUDE.md) — add Parameter Governance subsection.

---

## Bottom line

The infrastructure you asked about — configurable constants, timelock-gated
admin, bounds checks, event audit trail, clean Phase 2 governance seam — is
**~85% already built**. The gap is ~1 day of focused work:

- Add KYC threshold setter (if you want it in Phase 1).
- Frontend reads tier table from chain.
- End-to-end test covering the timelock flow.
- Docs.

The `MIN_HEALTH_FACTOR` / supply-cap / fallback-split constants intentionally
stay hardcoded — making them configurable is a strictly worse tradeoff for
the reasons in §2. Happy to revisit any of those if you disagree.

Phase 1 ops readiness (deploy timelock, deploy multisig, transfer admin) is
already scripted. The `contracts/RUNBOOK.md` covers the full sequence.

No code changes yet — waiting on your decisions in §6.
