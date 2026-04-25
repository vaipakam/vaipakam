# Governance-Configurable Protocol Constants — Design & Phase 1 Plan

**Status.** Draft. All decisions called out in §7 are open until you sign off.

**Context.** The post-incident DVN-hardening work surfaced a question: which protocol
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
is the exact class of attack the April 2026 cross-chain bridge
incident reminded us about.

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

### 2.4 Fallback settlement split — configurable WITH PROSPECTIVE application

The 3% / 2% abnormal-market fallback settlement split. This IS safe to make
configurable **if** new values apply only to loans initiated after the
change — the "dual-consent at offer creation" contract isn't violated when
each loan stores the split values it agreed to at open.

**Recommendation: add to `ProtocolConfig` + `Loan` snapshot on init.**
Bounds: each split in `[0, 1000]` (0-10%), combined `≤ 1500` (15%). See
§5.3 for storage layout.

---

## 3. Semantics: retroactive vs. prospective (DECIDED per constant)

When governance changes a value mid-protocol, two policies are possible:

- **Retroactive** — the new value applies to every existing loan on the
  next interaction (repayment, fee accrual). Simple, uniform. Risky under
  a hostile governance vote: one tx changes economics for every open
  loan.
- **Prospective** — the new value applies only to loans / offers created
  after the change. Requires snapshotting the effective value at creation
  time and storing it in the `Loan` / `Offer` struct.

### Per-constant policy

| Constant | Semantics | Rationale |
|---|---|---|
| `treasuryFeeBps`, `loanInitiationFeeBps` | Retroactive | Small-magnitude changes; 72h timelock delay covers the user exit window. |
| `liquidationHandlingFeeBps`, `maxLiquidationSlippageBps`, `maxLiquidatorIncentiveBps` | Retroactive | Only relevant during liquidation events; changes are rare and emergency-driven. |
| `volatilityLtvThresholdBps`, `rentalBufferBps` | Retroactive | Risk-policy knobs. |
| `vpfiStakingAprBps` | **Era-wise non-retroactive** | Flat APR adjustable by governance. Existing reward-per-token accumulator already locks past accrual into a global `stakingRewardPerTokenStored` — once we add a `checkpointGlobal()` call inside `setStakingApr`, every era gets its own rate applied to exactly its own duration. Applies uniformly to active and dormant users. Details in §5.2. |
| **VPFI lender yield-fee discount** (tier schedule) | **Time-weighted rollup** | Per-user `cumulativeDiscountBpsSeconds` accumulator + per-loan snapshot at offer acceptance. At yield-fee settlement, the time-weighted average BPS over the loan's duration replaces the live-at-repay tier lookup. Governance changes apply to future periods only. Details in §5.2a. |
| **VPFI borrower initiation-fee discount** (tier schedule) | Retroactive (one-shot) | Single point-in-time deduction at offer acceptance, no multi-period interval to average. Details in §5.2b. |
| **Fallback settlement split** (treasury + liquidator BPS) | **Prospective** | Core contract term — dual-consent at offer creation means both parties signed up for specific numbers, not a governance-tunable target. |
| KYC thresholds + `kycRequired` flag | Retroactive | Compliance-driven; effective immediately (users who cross a threshold mid-activity become subject to the new policy on their next action). |

### Why prospective for tier schedule + fallback split

Two user-facing promises:

1. **"Your accrued reward is locked at each balance-change."** When a
   borrower earns Tier 3 / 20% discount while holding X VPFI in escrow,
   the reward accrued during that period is preserved in
   `rolledUpReward` even if governance later tightens the Tier 3
   threshold. Future periods (after the next balance-change) use the
   new schedule. Predictable UX with no "reward claw-back."
2. **"Your liquidation terms are locked at offer creation."** Counterparty
   agreed to a specific 3% treasury / 2% liquidator split when they
   created the offer. Governance can tune future offers; this one settles
   under its original terms.

The tier-schedule promise is enforced by the rollup accumulator (§5.2);
the fallback-split promise is enforced by on-`Loan` snapshot at init
(§5.3).

---

## 4. Phase 1 vs Phase 2

### 4.1 Phase 1 — Timelock + multisig (DECIDED)

Scope:

- Deploy timelock on every target chain via `DeployTimelock.s.sol`.
- Deploy Gnosis Safe multisig on every target chain (outside our repo — use
  Safe UI). **Threshold: 3-of-5.**
- Transfer Diamond admin roles to the timelock via
  `TransferAdminToTimelock.s.sol`.

**Timelock configuration**:

| | Value | Rationale |
|---|---|---|
| Min delay | **72h (259200s)** | 3 days for users to observe + exit positions before a change lands. Longer than the default 48h because the executor is `address(0)` — any counterparty can execute after the delay, so we want the cushion. |
| Proposer role | **Gnosis Safe multisig** (3-of-5) | Schedules + cancels proposals. |
| Canceller role | **Same multisig** (auto-granted with Proposer in OZ v5) | Multisig can cancel any scheduled op during the 72h window — fast escape valve if a proposal is wrong. |
| Executor role | **`address(0)` (open)** | Anyone can execute after the delay. Prevents the multisig from stalling a scheduled change. |
| Admin role | **`address(0)` (self-administered)** | Changing the timelock's own parameters (delay, proposers) also requires going through the timelock — no EOA backdoor. |

**Phase 1 admin flow for any parameter change**:

1. **Multisig schedules** a `setXxx(...)` call on Diamond, targeting the
   timelock (via Safe transaction builder → `TimelockController.schedule`
   with target = Diamond, data = encoded setter call, delay ≥ 72h).
2. **72h min-delay elapses.** Event emitted on schedule; watcher (§6)
   alerts operator + community. Users can exit positions if they disagree.
3. **Multisig retains cancel power** during the entire 72h window — if a
   proposal is wrong or controversy surfaces, one multisig tx (`cancel`)
   kills it.
4. **After 72h, anyone executes** via `TimelockController.execute`. No
   multisig consensus required at this point — the open-executor role
   prevents a malicious multisig from stalling benign changes.

### 4.1.1 Multisig as admin during Phase 1 pre-governance

Until a Phase 2 `Governor` contract is deployed, the multisig IS the admin
for all practical purposes. Every parameter change goes:

```
Team / ops proposal
  → Multisig review (Safe tx in "needs signatures" state)
  → Multisig signs (3-of-5)
  → Multisig submits schedule() to timelock
  → 72h delay
  → (Anyone) executes
  → Change live
```

No governance token vote, no on-chain voting period. The multisig is the
source of proposals. The timelock is the source of delay + cancellability.

In Phase 2, the Governor contract replaces the multisig in the Proposer
role: proposals originate from token-weighted votes, but the 72h timelock
+ bounds + cancel-during-delay remain the safety primitives. No contract
changes to the Diamond / facets / setter path.

### 4.1.2 What ships in Phase 1

- ✅ ConfigFacet + existing setters (already done — fees, liquidation,
  risk, staking APR, tier thresholds + discounts).
- ✅ Timelock deploy + admin transfer scripts (already done).
- ➕ **Add KYC policy storage + setter** with blanket `kycRequired` flag
  (§5.1).
- ➕ **Add fallback settlement split storage + setter + prospective
  snapshot** on `Loan` struct (§5.3).
- ➕ **VPFI tier schedule snapshot** on `Loan` struct at init (§5.2).
- ➕ **Frontend pulls tier schedule + fee BPS + KYC policy from chain**
  (§6).
- ➕ **Bounds audit** — verify every setter has an upper bound that matches
  the documented `MAX_*_BPS` in ConfigFacet. Add bounds for KYC and
  fallback-split setters.

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

### 5.1 KYC policy configurability (DECIDED)

Two configurable layers:

1. **Blanket flag**: `kycRequired` bool. When `false`, *all* KYC tier
   checks are bypassed — every user is treated as verified regardless of
   transaction USD value. Use case: jurisdiction-specific deploy where
   the protocol team has determined KYC isn't required, or the early
   testnet / incentivised-alpha period.
2. **Per-tier USD thresholds** when `kycRequired == true`: below Tier 0
   threshold → no KYC; above Tier 1 threshold → fully verified required.

**Storage** — extend `ProtocolConfig`:

```solidity
// Additions to LibVaipakam.ProtocolConfig
bool    kycRequired;             // Set explicitly; default true (constructor).
uint256 kycTier0ThresholdUsd;    // 0 ⇒ KYC_TIER0_THRESHOLD_USD (1_000e18)
uint256 kycTier1ThresholdUsd;    // 0 ⇒ KYC_TIER1_THRESHOLD_USD (10_000e18)
```

**Setter** — new function on `ConfigFacet`:

```solidity
function setKycPolicy(bool required, uint256 t0Usd, uint256 t1Usd)
    external
    onlyRole(LibAccessControl.ADMIN_ROLE)
{
    // When thresholds are being configured, monotonicity + bounds apply.
    // Callers that only want to flip the flag pass zero for t0/t1 and
    // we keep the existing stored values (or leave on-constant default).
    if (t0Usd != 0 || t1Usd != 0) {
        if (t0Usd == 0 || t1Usd == 0) revert InvalidKycThreshold();
        if (t1Usd <= t0Usd) revert NonMonotoneKycThresholds(t0Usd, t1Usd);
        if (t1Usd > MAX_KYC_THRESHOLD_USD) {
            revert KycThresholdTooHigh(t1Usd, MAX_KYC_THRESHOLD_USD);
        }
        LibVaipakam.storageLocation().protocolCfg.kycTier0ThresholdUsd = t0Usd;
        LibVaipakam.storageLocation().protocolCfg.kycTier1ThresholdUsd = t1Usd;
    }
    LibVaipakam.storageLocation().protocolCfg.kycRequired = required;
    emit KycPolicySet(required, t0Usd, t1Usd);
}
```

Bounds:

- `MAX_KYC_THRESHOLD_USD = 1_000_000e18` ($1M) — absolute cap to prevent
  accidental "effectively no KYC" via a huge threshold.

**Getter** — add `isKycRequired()` + `getEffectiveKycTier0ThresholdUsd()`
+ `getEffectiveKycTier1ThresholdUsd()` to `LibVaipakam`.

**Consumer change** (`ProfileFacet`): every tier-promotion gate adds a
short-circuit:

```solidity
if (!LibVaipakam.isKycRequired()) {
    return; // No KYC required — accept any amount.
}
// else original threshold check
```

### 5.2 VPFI staking APR — reuse existing accumulator, fix the gov-change gap

**What's already in place.** `LibStakingRewards` ([`contracts/src/libraries/LibStakingRewards.sol`](../contracts/src/libraries/LibStakingRewards.sol))
already implements reward-per-token time-weighted accrual. Every escrow-
VPFI balance-mutation site calls `LibStakingRewards.updateUser(user,
newBalance)` **before** the mutation — the ordering invariant is
enforced at [`VPFIDiscountFacet.depositVPFIToEscrow` line 368](../contracts/src/facets/VPFIDiscountFacet.sol#L368),
[`VPFIDiscountFacet.withdrawVPFIFromEscrow` line 414](../contracts/src/facets/VPFIDiscountFacet.sol#L414),
[`LibVPFIDiscount.tryApply` line 220](../contracts/src/libraries/LibVPFIDiscount.sol#L220),
and [`LibVPFIDiscount.tryApplyYieldFee` line 273](../contracts/src/libraries/LibVPFIDiscount.sol#L273).
Spec reference: [TokenomicsTechSpec.md §7](TokenomicsTechSpec.md) — flat
5% APR, single `rewardPerToken` counter. No per-year schedule.

**The gap.** `ConfigFacet.setStakingApr` writes the new APR without
first checkpointing the global counter at the **old** APR:

```solidity
// Today (broken for non-retroactive semantics):
function setStakingApr(uint16 aprBps) external onlyRole(ADMIN_ROLE) {
    if (aprBps > BASIS_POINTS) revert InvalidStakingAprBps(aprBps);
    s.protocolCfg.vpfiStakingAprBps = aprBps;   // ← old-rate accrual lost
    emit StakingAprSet(aprBps);
}
```

Because `currentRewardPerToken()` computes `stored + dt × currentApr`
against the new APR, the whole `dt` since `stakingLastUpdateTime`
retroactively charges the new rate. A user who held 1 000 VPFI for
365 days at 5% and claims one second after gov flips APR to 10% would
collect 10% on year-1 instead of 5% — an unambiguous bug.

**The fix — 5 lines.** Expose `LibStakingRewards.checkpointGlobal()` as
`internal` (it already exists as `private`), and call it from
`setStakingApr` before writing the new value:

```solidity
// Corrected:
function setStakingApr(uint16 aprBps) external onlyRole(ADMIN_ROLE) {
    if (aprBps > BASIS_POINTS) revert InvalidStakingAprBps(aprBps);
    LibStakingRewards.checkpointGlobal();        // ← fold OLD apr × dt into stored
    s.protocolCfg.vpfiStakingAprBps = aprBps;
    emit StakingAprSet(aprBps);
}
```

The checkpoint advances `stakingRewardPerTokenStored +=
oldApr × elapsed / year` and stamps `stakingLastUpdateTime = now`.
After the write, future `currentRewardPerToken()` calls compute
`stored + dt × newApr`, with `stored` already carrying the
old-rate integral. Every historical APR era is locked in at its
own rate.

**Why this handles both active and dormant users.** The reward-per-token
pattern is era-agnostic: only the **global** counter tracks historical
rates (as an integral), and each user's `userRewardPerTokenPaid` pins
their personal starting line. A dormant user who staked on Day 0 and
claims on Day 1095 after two APR changes gets:

```
pending = stake × (currentRewardPerToken_at_claim − userPaid_at_Day0)
        = stake × (integral_over_all_3_years − 0)
        = stake × (apr₁ × year_1 + apr₂ × year_2 + apr₃ × year_3) / year
```

— correctly credited for each era, automatically, with no per-user
schedule walk needed at claim time.

**Audit trail.** `setStakingApr` already emits `StakingAprSet(aprBps)`
on every change. This is the historical record for indexers / UIs. A
separate on-chain `AprEvent[]` array is **not** required (redundant
with events for all practical queries) and is deliberately skipped
to keep gas minimal.

**What's configurable (confirmed).** `vpfiStakingAprBps` is a single
flat value, governance-tunable via `setStakingApr`. No predeclared
schedule. Phase 1 launches at 5% (the `LibVaipakam` default, applied
when the storage override is zero). Gov can raise or lower this at
any time; the checkpoint fix guarantees every transition is
non-retroactive.

### 5.2a VPFI lender yield-fee discount — time-weighted rollup

**Why this needs to change.** The existing discount resolver reads the
lender's **live** escrow VPFI balance at repay and applies the tier
table at that moment ([`LibVPFIDiscount.quoteYieldFee` line 157](../contracts/src/libraries/LibVPFIDiscount.sol#L157),
called from `RepayFacet`, `RefinanceFacet`, `PrecloseFacet`). A lender
who deposits 20 000 VPFI one block before repay jumps to Tier 4 / 24%
discount on the entire loan's yield fee with no time-held commitment.
The fix is a time-weighted accumulator scoped to the loan duration.

**Only the lender side changes.** Borrower initiation-fee discount
stays one-shot at acceptance (§5.2b) — there's no multi-period interval
over which to average; the discount is decided and settled in the same
moment.

**Storage — one new per-user struct, one new per-loan snapshot:**

```solidity
// New mapping on LibVaipakam.Storage
struct UserVpfiDiscountState {
    uint16  discountBpsAtPreviousRollup;   // stamped BPS for the open period
    uint64  lastRollupAt;                  // timestamp of last rollup
    uint256 cumulativeDiscountBpsSeconds;  // Σ(stamped_bps × elapsed), monotone
}
mapping(address => UserVpfiDiscountState) userVpfiDiscountState;

// Addition to LibVaipakam.Loan
uint256 lenderDiscountAccAtInit;           // lender's counter at offer acceptance
```

The `uint16 + uint64` pack into one slot; the accumulator gets its own
slot. **Per-loan cost: one slot.** Per-user cost: two slots, once per
user regardless of how many loans they're lender on.

**Rollup helper** — sibling to `LibStakingRewards.updateUser`:

```solidity
// New in LibVPFIDiscount (or a new LibVpfiDiscountRollup):
function rollupUserDiscount(address user, uint256 balAtPeriodEnd) internal {
    UserVpfiDiscountState storage u =
        LibVaipakam.storageSlot().userVpfiDiscountState[user];

    if (u.lastRollupAt == 0) {
        // Self-seed on first rollup (handles pre-upgrade users).
        u.discountBpsAtPreviousRollup =
            uint16(discountBpsForTier(tierOf(balAtPeriodEnd)));
        u.lastRollupAt = uint64(block.timestamp);
        return;
    }

    uint256 elapsed = block.timestamp - u.lastRollupAt;
    if (elapsed > 0) {
        u.cumulativeDiscountBpsSeconds +=
            uint256(u.discountBpsAtPreviousRollup) * elapsed;
    }
    u.discountBpsAtPreviousRollup =
        uint16(discountBpsForTier(tierOf(balAtPeriodEnd)));
    u.lastRollupAt = uint64(block.timestamp);
}
```

**Hook wiring.** The four balance-mutation sites already call
`LibStakingRewards.updateUser` in the same position — we add
`rollupUserDiscount` next to it:

```solidity
// e.g. inside VPFIDiscountFacet.depositVPFIToEscrow — same pattern at all 4 sites.
LibStakingRewards.updateUser(msg.sender, prevBal + amount);            // existing
LibVPFIDiscount.rollupUserDiscount(msg.sender, prevBal + amount);      // NEW
IERC20(vpfi).safeTransferFrom(msg.sender, escrow, amount);             // existing mutation
```

The ordering invariant (rollup BEFORE mutation) is already enforced by
the staking checkpoint's placement — we inherit it for free.

**At offer acceptance** — force a rollup on the lender so their
accumulator reflects "as of now", then snapshot onto the new `Loan`:

```solidity
// Inside OfferFacet.acceptOffer, near loan init:
uint256 lenderBal = IERC20(vpfi).balanceOf(lenderEscrow);
LibVPFIDiscount.rollupUserDiscount(offer.lender, lenderBal);
loan.lenderDiscountAccAtInit =
    s.userVpfiDiscountState[offer.lender].cumulativeDiscountBpsSeconds;
```

The live balance here is a read, not a mutation — the staking-style
"rollup before mutation" invariant still holds because no mutation is
happening at this point.

**At yield-fee settlement** (every site that calls `tryApplyYieldFee`
today — `RepayFacet`, `RefinanceFacet`, `PrecloseFacet`) — force a
final rollup, compute the time-weighted average BPS for this loan's
window, then use it in place of `discountBpsForTier(tier)`:

```solidity
uint256 lenderBal = IERC20(vpfi).balanceOf(lenderEscrow);
LibVPFIDiscount.rollupUserDiscount(loan.lender, lenderBal);

uint256 windowSeconds = block.timestamp - loan.startTime;
uint256 avgBps =
    (s.userVpfiDiscountState[loan.lender].cumulativeDiscountBpsSeconds
     - loan.lenderDiscountAccAtInit) / windowSeconds;

// avgBps REPLACES `discountBpsForTier(tier)` in quoteYieldFee math.
// The VPFI deduction from lender escrow still happens in tryApplyYieldFee,
// just using this avgBps as the discount rate.
```

**Gaming defeated.** The lender of a 30-day loan who tops up on Day 29
gets roughly `(29 × oldBps + 1 × newBps) / 30` — a 1/30 sliver of the
tier bump, not the full Tier-4 boost. Holding VPFI throughout the loan
is the only way to earn the full discount.

**Governance changes to the tier schedule** — take effect at every
lender's next rollup for every open loan. `cumulativeDiscountBpsSeconds`
locks in what the lender earned under the old schedule for already-
elapsed periods; future periods accrue at the new schedule. No
retroactive claw-back or bonus.

**Same-block safety.** If two operations on the same escrow land in
the same block, the second call's `elapsed == 0` — the rollup is a
no-op for the period, the stamped BPS is re-evaluated against the new
balance, and no double-credit is possible.

**Edge case — zero-duration loans.** If a loan is accepted and repaid
in the same block, `windowSeconds == 0` — division by zero. Code must
guard and fall through to zero discount on the yield fee (spec behaviour
for an impossible loan pattern anyway).

### 5.2b VPFI borrower initiation-fee discount — unchanged (one-shot)

Confirmed out of scope for the rollup mechanism. [`LibVPFIDiscount.tryApply`](../contracts/src/libraries/LibVPFIDiscount.sol#L196)
stays as-is: the borrower's tier is resolved from live escrow balance
at `OfferFacet.acceptOffer`, the discounted initiation fee is deducted
in VPFI in the same tx, and no further accrual runs on the borrower
side for this fee.

**Why one-shot is fine here.** The initiation fee is computed and
settled atomically with loan creation — there is no "period" over
which the borrower's balance could vary for this specific fee. A
borrower *could* deposit just before accepting the offer to claim a
higher tier, but they've committed VPFI to escrow at that moment,
which is exactly what the discount is meant to reward. Withdrawing
after acceptance doesn't give back the already-paid discount.

The yield-fee gaming vector — deposit just before a distant repay —
doesn't have an analogue on the borrower side.

### 5.2c Storage cost summary

| State | Location | Slots | Notes |
|---|---|---|---|
| `UserVpfiDiscountState` | per-user mapping | 2 | Stamped BPS + timestamp pack into one slot; accumulator in another. Written at most once per user-event. |
| `lenderDiscountAccAtInit` | per-loan | 1 | Snapshot taken once at offer acceptance. |
| Staking state | existing | 0 | Unchanged — reuses what's already there. |

Marginal cost: **~40k gas per new lender-involved loan at acceptance**
(one SSTORE + snapshot), plus ~25k gas per balance-mutation event (two
SSTOREs across staking + discount rollups, one of which already existed).
Yield-fee settlement adds one rollup + one division for the time-
weighted BPS — roughly 10k gas on top of the existing `tryApplyYieldFee`
path. All well within our existing per-operation gas envelopes.

### 5.3 Fallback settlement split — prospective per-loan snapshot

Same pattern as §5.2 but for the fallback split:

```solidity
// Additions to LibVaipakam.ProtocolConfig
uint16 fallbackTreasurySplitBps;    // 0 ⇒ 300 (3%)
uint16 fallbackLiquidatorSplitBps;  // 0 ⇒ 200 (2%)

// Additions to LibVaipakam.Loan (packed into 1 slot with above)
uint16 fallbackTreasurySplitBpsAtInit;
uint16 fallbackLiquidatorSplitBpsAtInit;
```

**Setter**:

```solidity
function setFallbackSplit(uint16 treasuryBps, uint16 liquidatorBps)
    external
    onlyRole(LibAccessControl.ADMIN_ROLE)
{
    if (treasuryBps > MAX_FALLBACK_SPLIT_BPS ||
        liquidatorBps > MAX_FALLBACK_SPLIT_BPS) {
        revert FallbackSplitTooHigh(treasuryBps, liquidatorBps);
    }
    if (uint256(treasuryBps) + uint256(liquidatorBps) > MAX_FALLBACK_COMBINED_BPS) {
        revert FallbackSplitCombinedTooHigh(treasuryBps, liquidatorBps);
    }
    LibVaipakam.storageLocation().protocolCfg.fallbackTreasurySplitBps = treasuryBps;
    LibVaipakam.storageLocation().protocolCfg.fallbackLiquidatorSplitBps = liquidatorBps;
    emit FallbackSplitSet(treasuryBps, liquidatorBps);
}
```

Bounds:

- `MAX_FALLBACK_SPLIT_BPS = 1000` (10%) — per-party cap.
- `MAX_FALLBACK_COMBINED_BPS = 1500` (15%) — combined cap (treasury +
  liquidator) can't exceed 15% of proceeds.

Snapshot + settlement follows §5.2's pattern.

### 5.4 Frontend: read from chain (DECIDED)

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

**Staking pending-reward display.** `StakingRewardsFacet` already
exposes `pendingOf(user)` via `getStakingPending(address)`. Surface
this on the Dashboard and on the per-loan detail view:

- "Accrued VPFI staking reward: X" with a tooltip explaining it
  accrues continuously on every VPFI held in escrow and can be
  claimed via `claimStakingRewards()`.
- Historical APR transitions can be reconstructed off-chain from the
  `StakingAprSet` event stream — the Dashboard's "Staking details"
  drawer can show the current rate + the timestamp of the last
  governance change.

**Lender effective-discount display.** The per-loan detail view (on
the lender side) needs to expose the time-weighted average discount
BPS the lender has accumulated **so far** for each open loan, so the
lender can see the discount they'd receive if the loan were to
settle right now:

```
effectiveAvgBps(loan) =
  (userVpfiDiscountState[lender].cumulativeDiscountBpsSeconds
   + userVpfiDiscountState[lender].discountBpsAtPreviousRollup
     × (now − userVpfiDiscountState[lender].lastRollupAt)
   − loan.lenderDiscountAccAtInit)
  / (now − loan.startTime)
```

Note the `+ stamped × open_period` term: the frontend must compute the
live accumulator value (including the currently-open period) rather
than reading `cumulativeDiscountBpsSeconds` raw, because the on-chain
accumulator only advances at rollup events. The display formula is
identical on-chain and off-chain so users never see a mismatch
between "what the UI shows" and "what the next rollup will persist."

- Show: "Your effective yield-fee discount for this loan: Y%" (= avg
  BPS / 100).
- Show: "Your current tier (would apply to next period): Tier N /
  Z%" — gives lenders a preview of what they're earning right now.
- Link to a "Learn more" explaining the gaming-resistance rationale
  (time-weighted, not live-at-repay).

**Tier badge for borrowers and lenders.** On the Dashboard VPFI card
and on offer-browse pages, show the user's current tier badge (Tier
0–4) sourced from the live escrow balance + `useVpfiTierSchedule()`.
This is the tier that applies to a **new** offer accept (borrower
initiation discount is one-shot, so "tier right now" is authoritative)
or to the **next** rollup period (lender time-weighted discount is
prospective, so "tier right now" is what you'll earn from this moment
onward).

### 5.5 Documentation

- Add a new §12 to `contracts/RUNBOOK.md` ("Parameter-change procedure")
  covering: scheduling via Safe Proposer → waiting the 48h → executing
  via any account → verifying via event + readback.
- Extend `CLAUDE.md`'s Cross-Chain Security section with a "Parameter
  Governance" subsection pinning: timelock delay minimum, admin role
  holder, setter bounds list, retroactive-semantics note.

### 5.6 Tests

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

## 6. Decisions — all confirmed

| Decision | Outcome |
|---|---|
| KYC in Phase 1 | ✅ configurable, with blanket `kycRequired` flag + per-tier USD thresholds (§5.1) |
| Frontend tier table from chain | ✅ yes (§5.4) |
| Multisig threshold | ✅ **3-of-5** |
| Timelock min delay | ✅ **72h** |
| Executor role | ✅ `address(0)` (open) — multisig retains cancel right during delay |
| Cancel during delay | ✅ yes — multisig holds `CANCELLER_ROLE` (auto-granted with proposer in OZ v5) |
| VPFI staking APR | ✅ **Flat rate, gov-adjustable.** Leverage existing `LibStakingRewards` reward-per-token accumulator. Add `checkpointGlobal()` call in `setStakingApr` so every APR era is non-retroactively preserved. No predeclared schedule; history tracked via `StakingAprSet` events (§5.2). |
| VPFI lender yield-fee discount | ✅ **Time-weighted rollup over loan duration** — per-user `cumulativeDiscountBpsSeconds` accumulator + per-loan snapshot at offer acceptance; applied at yield-fee settlement (§5.2a). |
| VPFI borrower initiation-fee discount | ✅ **Unchanged (one-shot at accept)** — no rollup on borrower side (§5.2b). |
| Fallback settlement split | ✅ configurable + **prospective** snapshot on `Loan` (§5.3) |
| `MIN_HEALTH_FACTOR` | ✅ **stays hardcoded** |
| Tokenomics supply caps | ✅ **stay hardcoded** |

Everything is settable by the **multisig → timelock → Diamond** chain
during Phase 1. Phase 2 governance plugs a `Governor` contract into the
Proposer role without any contract changes to the Diamond / facets.

---

## 7. Implementation sequencing

Order below is the dependency DAG — each step depends on earlier ones.
Nothing here is architecturally risky; it's all variations on the existing
`ConfigFacet` / `ProtocolConfig` pattern.

1. **Extend storage structs**:
   - `ProtocolConfig`: add `kycRequired`, `kycTier0ThresholdUsd`,
     `kycTier1ThresholdUsd`, `fallbackTreasurySplitBps`,
     `fallbackLiquidatorSplitBps`.
   - `LibVaipakam.Storage`: add
     `mapping(address => UserVpfiDiscountState) userVpfiDiscountState`
     (2 slots per user; §5.2a).
   - `Loan`: add `lenderDiscountAccAtInit uint256` (1 slot, §5.2a) +
     2 fallback-split snapshot fields (§5.3).
2. **Add getters in `LibVaipakam`**: `isKycRequired`,
   `cfgKycTier0/1ThresholdUsd`, `cfgFallbackTreasurySplitBps`,
   `cfgFallbackLiquidatorSplitBps`.
3. **Staking APR checkpoint fix** — the only required change to the
   staking path:
   - Expose `LibStakingRewards.checkpointGlobal()` as `internal`
     (currently `private`).
   - Update `ConfigFacet.setStakingApr` to call `checkpointGlobal()`
     before writing the new APR. Five-line change; locks every APR
     era into the global accumulator at its own rate (§5.2).
4. **Lender yield-fee rollup helper** — add to `LibVPFIDiscount` (or a
   new `LibVpfiDiscountRollup`):
   - `rollupUserDiscount(address user, uint256 balAtPeriodEnd)` —
     reward-per-token: closes out the open period using stamped BPS,
     stamps the new tier against the current schedule, stamps
     `lastRollupAt = now`. Self-seeds when `lastRollupAt == 0`.
   - Re-export `tierOf(balance)` and `discountBpsForTier(tier)` as
     `internal` if not already exposed — used inside `rollupUserDiscount`
     and by the settlement-time readback.
5. **Wire the discount rollup into every escrow-VPFI mutation path** —
   four sites, each already calls `LibStakingRewards.updateUser` before
   the mutation:
   - [`VPFIDiscountFacet.depositVPFIToEscrow` line 368](../contracts/src/facets/VPFIDiscountFacet.sol#L368)
   - [`VPFIDiscountFacet.withdrawVPFIFromEscrow` line 414](../contracts/src/facets/VPFIDiscountFacet.sol#L414)
   - [`LibVPFIDiscount.tryApply` line 220](../contracts/src/libraries/LibVPFIDiscount.sol#L220)
   - [`LibVPFIDiscount.tryApplyYieldFee` line 273](../contracts/src/libraries/LibVPFIDiscount.sol#L273)

   Add `LibVPFIDiscount.rollupUserDiscount(user, newBal)` next to each
   existing `updateUser` call. Pass the **new** (post-mutation) balance
   — the rollup first closes the open period against the stamped tier,
   then stamps the new tier from `newBal`.
6. **Lender snapshot at offer acceptance** — in
   [`OfferFacet.acceptOffer`](../contracts/src/facets/OfferFacet.sol):
   force a rollup against the lender's live escrow balance, then
   snapshot `cumulativeDiscountBpsSeconds` onto the new
   `loan.lenderDiscountAccAtInit`.
7. **Yield-fee settlement** — in every site that calls
   `tryApplyYieldFee` (`RepayFacet`, `RefinanceFacet`, `PrecloseFacet`):
   - Force a final rollup against the lender's live balance.
   - Compute `windowSeconds = block.timestamp - loan.startTime`; guard
     `windowSeconds == 0` with a zero-discount fallback.
   - Compute `avgBps = (currentAcc - loan.lenderDiscountAccAtInit)
     / windowSeconds`.
   - Use `avgBps` in `quoteYieldFee` / `tryApplyYieldFee` instead of
     the current `discountBpsForTier(tierOf(balanceOf(lenderEscrow)))`
     lookup.
8. **Fallback settlement split** (`RepayFacet`, `DefaultedFacet`, any
   other settlement path) — read splits from the loan snapshot instead
   of the hardcoded constants.
9. **Update `ProfileFacet`**: short-circuit all KYC checks when
   `LibVaipakam.isKycRequired() == false`. Per-tier threshold reads go
   through the getters.
10. **Add setters to `ConfigFacet`**:
    - `setKycPolicy(bool required, uint256 t0, uint256 t1)` with bounds.
    - `setFallbackSplit(uint16 treasury, uint16 liquidator)` with bounds.
11. **Add `getVpfiTierSchedule()` view** in `ConfigFacet` returning the
    full 8-value tier schedule in one call. Used by the UI to display
    the live schedule (what the next rollup will stamp).
12. **Update frontend**:
    - Replace `VPFI_TIER_TABLE` const in `useVPFIDiscount.ts` with a
      `useVpfiTierSchedule()` hook fetching from chain.
    - New hook `useProtocolConfig()` exposing fee BPS + fallback splits
      + KYC policy + staking APR for UI-level rendering.
    - New hook `useLenderEffectiveDiscount(loanId)` computing the live
      time-weighted average BPS for a lender's open loan (§5.4).
    - Surface `getStakingPending(user)` on Dashboard and per-loan
      detail views with "Accrued VPFI staking reward" copy (§5.4).
13. **Write tests**:
    - `GovernanceConfigTest.t.sol` (new) — bounds, access control,
      monotonicity, event emission, timelock integration (§5.6).
    - `VpfiDiscountRollupTest.t.sol` (new) — self-seed on first rollup,
      deposit/withdraw triggers rollup, tier-schedule-change-applies-
      next-period, gaming scenario (Day 29 top-up yields 1/30 of tier
      bump), same-block-no-double-accrual, ordering-violation-fails,
      zero-duration-loan guard.
    - `StakingAprCheckpointTest.t.sol` (new) — three-era trace (5%→7%→6%
      over three years), active user interaction preserves per-era
      accrual, dormant user through all three eras gets correct
      weighted sum, setStakingApr without checkpoint would have
      double-counted (regression guard).
14. **Update `contracts/RUNBOOK.md`**: add §12 parameter-change
    procedure. Flag the staking-APR checkpoint fix in the "must ship
    before any gov APR change" section.
15. **Update `CLAUDE.md`**: parameter-governance policy subsection +
    the rollup ordering invariant (all four escrow-VPFI mutation sites
    must call both `LibStakingRewards.updateUser` AND
    `LibVPFIDiscount.rollupUserDiscount` before mutation).

### 7.1 Backfill for existing state at upgrade time

Three state surfaces to reason about when the DiamondCut lands:

**Per-user discount accumulator** (`userVpfiDiscountState[user]`). Every
user has zero-initialised storage until their first rollup. The helper
self-seeds on `lastRollupAt == 0`: stamps the current tier from the
passed-in balance, stamps `lastRollupAt = now`, returns without
accrual. This means a user who held VPFI for months pre-upgrade gets
no credit for that historical period in the yield-fee accumulator —
they start earning from the first post-upgrade interaction. This is
the correct conservative behaviour: without a timestamp we can't
reconstruct what tier applied for any past period.

**Per-loan snapshot** (`loan.lenderDiscountAccAtInit`). Loans that
already exist at upgrade time have `0` in this field. Since the
user-side accumulator is also effectively zero at first touch, the
settlement math `(currentAcc − 0) / windowSeconds` ends up using the
**whole post-upgrade lifetime** of that loan as the window, which
over-credits an old loan's remaining duration. Two remedies:

- **Preferred — freeze old-loan discount at repay.** Add a sentinel:
  if `loan.startTime` is before the upgrade timestamp, treat the loan
  as "pre-upgrade" and resolve the yield-fee discount using the
  existing (live-at-repay) path instead of the time-weighted path.
  Clean cut-over. Record the upgrade timestamp in storage at the
  DiamondCut.
- **Alternative — seed `lenderDiscountAccAtInit`-at-upgrade.** On the
  first post-upgrade rollup for a lender with open pre-upgrade loans,
  stamp each open loan's `lenderDiscountAccAtInit` to the lender's
  post-seed accumulator value. Subsequent settlement then measures
  only the post-upgrade window for these loans. Requires iterating
  a lender's open loans — doable if tracked, otherwise needs a
  lazy-init pattern at first settlement access.

Testnet doesn't matter — wipe and redeploy. Mainnet: the staking
checkpoint fix must ship **before or atomically with** any APR change
(otherwise the APR change goes out with the retroactive-bug semantics).
Gate the RUNBOOK on this.

**Staking side has no backfill.** The reward-per-token accumulator is already
running in production and is correct for every user who interacted
at-least-once. The checkpoint fix only affects future `setStakingApr`
calls — it doesn't alter any past accrual. Deploy the fix before gov
calls `setStakingApr` for the first time post-upgrade and all era
boundaries from that point on are preserved correctly.

Estimated: **2-3 days** of focused work for everything above. Most of
the time is in steps 4-7 (discount rollup helper + wiring at four
sites + offer-accept snapshot + yield-fee-settlement integration) and
step 12 (frontend); the others are mechanical.

---

## 8. Critical files

- [`contracts/src/libraries/LibVaipakam.sol`](../contracts/src/libraries/LibVaipakam.sol) — extend `ProtocolConfig` (KYC + fallback-split fields); extend `Loan` with `lenderDiscountAccAtInit uint256`; add `userVpfiDiscountState` mapping to `Storage`; add getters for KYC policy + fallback split.
- [`contracts/src/libraries/LibStakingRewards.sol`](../contracts/src/libraries/LibStakingRewards.sol) — expose `checkpointGlobal()` as `internal` (currently `private`). No other logic change.
- [`contracts/src/libraries/LibVPFIDiscount.sol`](../contracts/src/libraries/LibVPFIDiscount.sol) — add `rollupUserDiscount(user, balAtPeriodEnd)` reward-per-token helper. Add time-weighted path to `quoteYieldFee` / `tryApplyYieldFee` that reads `loan.lenderDiscountAccAtInit` and computes `avgBps` over the loan window.
- [`contracts/src/facets/ConfigFacet.sol`](../contracts/src/facets/ConfigFacet.sol) — add `LibStakingRewards.checkpointGlobal()` call at the top of `setStakingApr`. Add `setKycPolicy`, `setFallbackSplit`, `getVpfiTierSchedule`.
- [`contracts/src/facets/OfferFacet.sol`](../contracts/src/facets/OfferFacet.sol) — in `acceptOffer`: force a lender-side `rollupUserDiscount` against live escrow balance, snapshot `cumulativeDiscountBpsSeconds` onto `loan.lenderDiscountAccAtInit`.
- [`contracts/src/facets/VPFIDiscountFacet.sol`](../contracts/src/facets/VPFIDiscountFacet.sol) — add `LibVPFIDiscount.rollupUserDiscount(user, newBal)` next to the existing `LibStakingRewards.updateUser` call in `depositVPFIToEscrow` and `withdrawVPFIFromEscrow` (lines 368 and 414). Also in `tryApply` (line 220, borrower init-fee deduction) and `tryApplyYieldFee` (line 273, lender yield-fee deduction).
- [`contracts/src/facets/RepayFacet.sol`](../contracts/src/facets/RepayFacet.sol) + [`contracts/src/facets/RefinanceFacet.sol`](../contracts/src/facets/RefinanceFacet.sol) + [`contracts/src/facets/PrecloseFacet.sol`](../contracts/src/facets/PrecloseFacet.sol) — at every `tryApplyYieldFee` call site: force final lender rollup, compute time-weighted `avgBps`, use in place of live-tier lookup. Also read fallback split from loan snapshot.
- [`contracts/src/facets/DefaultedFacet.sol`](../contracts/src/facets/DefaultedFacet.sol) — read fallback split from loan snapshot instead of constants.
- [`contracts/src/facets/ProfileFacet.sol`](../contracts/src/facets/ProfileFacet.sol) — short-circuit on `!kycRequired`, read thresholds via getters.
- [`contracts/script/UpgradeGovernanceConfig.s.sol`](../contracts/script/) (new) — Diamond cut that replaces the affected facets + records the upgrade timestamp for pre-upgrade-loan handling (§7.1).
- [`frontend/src/hooks/useVPFIDiscount.ts`](../frontend/src/hooks/useVPFIDiscount.ts) — replace `VPFI_TIER_TABLE` with `useVpfiTierSchedule()` chain-fetched hook.
- [`frontend/src/hooks/useProtocolConfig.ts`](../frontend/src/hooks/) (extend) — expose fee BPS, fallback splits, KYC policy, staking APR.
- [`frontend/src/hooks/useLenderEffectiveDiscount.ts`](../frontend/src/hooks/) (new) — reads `userVpfiDiscountState[lender]` + `loan.lenderDiscountAccAtInit`, computes the live time-weighted `avgBps` for a given open loan (includes the currently-open period so the UI matches what the next rollup will persist).
- [`frontend/src/hooks/useStakingPending.ts`](../frontend/src/hooks/) (new or extend existing staking hook) — reads `getStakingPending(user)` for Dashboard + per-loan UI.
- [`contracts/test/GovernanceConfigTest.t.sol`](../contracts/test/) (new) — bounds + access control + monotonicity + timelock integration.
- [`contracts/test/VpfiDiscountRollupTest.t.sol`](../contracts/test/) (new) — self-seed, deposit/withdraw triggers rollup, gaming-defeated (Day-29 top-up = 1/30 boost), governance-change-applies-next-period, same-block-no-double-accrual, zero-duration-loan guard, ordering-violation fails.
- [`contracts/test/StakingAprCheckpointTest.t.sol`](../contracts/test/) (new) — 3-era APR trace, active + dormant user both correct, regression guard against the missing-checkpoint bug.
- [`contracts/RUNBOOK.md`](../contracts/RUNBOOK.md) — add §12 parameter-change procedure; add "mainnet must ship staking-APR checkpoint fix before any gov APR change" to the go/no-go gate; update §1's timelock-delay row to 72h.
- [`CLAUDE.md`](../CLAUDE.md) — add Parameter Governance subsection + the rollup ordering invariant (every escrow-VPFI mutation must call both `LibStakingRewards.updateUser` and `LibVPFIDiscount.rollupUserDiscount` before mutating).
- [`docs/TokenomicsTechSpec.md`](TokenomicsTechSpec.md) — §7 gets the "era-wise non-retroactive APR" clarification; a new §7a (or equivalent) captures the time-weighted lender yield-fee discount (functional spec already drafted separately).
- [`docs/BorrowerVPFIDiscountMechanism.md`](BorrowerVPFIDiscountMechanism.md) — add a "One-shot at acceptance" note explicitly excluding the borrower init-fee discount from the rollup path (§5.2b).

---

## Bottom line

**Phase 1 admin model is: multisig (3-of-5) → timelock (72h, open
executor, multisig can cancel) → Diamond setters (bounded + event-
emitting).** All parameter changes go through this chain. Phase 2
governance adds a `Governor` contract in front of the multisig without
contract changes.

**What's era-wise non-retroactive** (each value gets its own accrual
period, governance boundaries locked in at the moment of the change):
- **VPFI staking APR** — reuses the existing `LibStakingRewards`
  reward-per-token accumulator. Only change: `setStakingApr` now calls
  `checkpointGlobal()` before writing the new value, so every APR era
  accrues at its own rate regardless of user activity. Protects active
  and dormant stakers equally. History via `StakingAprSet` events.

**What's time-weighted over the loan window**:
- **VPFI lender yield-fee discount** — per-user accumulator
  `cumulativeDiscountBpsSeconds` rolled up at every escrow-balance
  change (`LibStakingRewards.updateUser`-parallel helper at the same
  four call sites). Each loan snapshots the lender's counter at offer
  acceptance; yield-fee settlement computes the time-weighted average
  BPS over the actual loan duration. Last-minute top-ups can't game the
  discount — a 30-day loan with a Day-29 top-up yields ~1/30 of the
  tier bump. Governance schedule changes apply to the next period only.

**What's prospective (init snapshot, locked per loan)**:
- **Fallback settlement split** — snapshotted on `Loan` at init
  (§5.3). Gov changes tune future offers; already-accepted offers
  settle under their original terms.

**What's one-shot (unchanged from today)**:
- **VPFI borrower initiation-fee discount** — resolved once at offer
  acceptance from live escrow balance + live tier schedule. No
  rollup needed; the discount and the fee are computed and settled
  in the same transaction. (§5.2b)

---

## 9. Phase 7 oracle + DEX redundancy admin surface (added 2026-04-25)

The Phase 7 security sprint added two new chain-level admin
surfaces. Both are admin-gated through `OracleAdminFacet` /
`AdminFacet` (timelock-gated post-handover); both are explicitly
**chain-level only** — no per-asset governance writes are required
when adding new collateral assets.

### 9.1 Phase 7a swap-failover adapter chain (`AdminFacet`)

Liquidation swaps now fail over across a registered list of
`ISwapAdapter` contracts. Production registers four: `ZeroExAdapter`,
`OneInchAdapter`, `UniV3Adapter`, `BalancerV2Adapter`. The chain
is priority-ordered; the failover library iterates and commits on
the first adapter to return proceeds at least equal to the oracle-
derived `minOutputAmount`.

| Setter | Purpose |
|---|---|
| `addSwapAdapter(address)` | Append to chain (priority = current length). |
| `removeSwapAdapter(address)` | Remove + shift higher slots down. |
| `reorderSwapAdapters(address[])` | Replace order with explicit permutation. |
| `getSwapAdapters() → address[]` | Read priority-ordered chain. |

**Required pre-mainnet**: at least one adapter registered. A diamond
with zero adapters reverts every liquidation. Recommended: register
all four production adapters in `[ZeroEx, OneInch, UniV3, Balancer]`
order at deploy time.

### 9.2 Phase 7b.1 multi-venue liquidity OR-logic (`AdminFacet`)

`OracleFacet.checkLiquidity` runs an OR-combine across three
Uniswap-V3-fork DEX factories.

| Setter | Purpose |
|---|---|
| `setPancakeswapV3Factory(address)` | PancakeSwap V3 factory (chain-specific). Zero disables the leg. |
| `getPancakeswapV3Factory() → address` | Read current value. |
| `setSushiswapV3Factory(address)` | SushiSwap V3 factory (chain-specific). Zero disables the leg. |
| `getSushiswapV3Factory() → address` | Read current value. |

Combined with the pre-existing `setUniswapV3Factory` from
`OracleAdminFacet`, an asset is classified Liquid iff at least one
of the three factories exposes an asset/WETH pool meeting the
`MIN_LIQUIDITY_USD` floor. **No per-asset config**; the probe
discovers pools via `factory.getPool(token0, token1, fee)` against
the standard fee-tier set `[3000, 500, 2500, 10000, 100]`.

### 9.3 Phase 7b.2 secondary price-oracle quorum (`OracleAdminFacet`)

Soft 2-of-N quorum across Tellor + API3 + DIA, all three keyed by
`asset.symbol()` derivation on-chain.

| Setter | Purpose |
|---|---|
| `setTellorOracle(address)` | Chain-level Tellor oracle. Zero disables. |
| `getTellorOracle() → address` | Read current. |
| `setApi3ServerV1(address)` | Chain-level API3 ServerV1. Zero disables. |
| `getApi3ServerV1() → address` | Read current. |
| `setDIAOracleV2(address)` | Chain-level DIA Oracle V2. Zero disables. |
| `getDIAOracleV2() → address` | Read current. |
| `setSecondaryOracleMaxDeviationBps(uint16)` | Allowed Chainlink↔secondary deviation, in bps. Default 500 (5%). |
| `getSecondaryOracleMaxDeviationBps() → uint16` | Read current. |
| `setSecondaryOracleMaxStaleness(uint40)` | Max acceptable secondary report age, in seconds. Default 3600 (1h). |
| `getSecondaryOracleMaxStaleness() → uint40` | Read current. |

**Pyth was removed in Phase 7b.2** — its per-asset `priceId` mapping
conflicted with the no-per-asset-config policy. The previous
`setPythEndpoint` / `setPythFeedConfig` setters and the
`PythFeedConfig` storage struct were stripped from the diamond
pre-mainnet (no production write was ever made).

### 9.4 Audit-trail events

Every Phase 7 admin write emits a transition event so off-chain
monitors can alert on changes:

```
SwapAdapterAdded(uint256 index, address adapter)
SwapAdapterRemoved(uint256 index, address adapter)
SwapAdaptersReordered(address[] adapters)
PancakeswapV3FactorySet(address previous, address current)
SushiswapV3FactorySet(address previous, address current)
TellorOracleSet(address previous, address current)
Api3ServerV1Set(address previous, address current)
DIAOracleV2Set(address previous, address current)
SecondaryOracleMaxDeviationBpsSet(uint16 previous, uint16 current)
SecondaryOracleMaxStalenessSet(uint40 previous, uint40 current)
```

Operators should hook each into the existing config-change alerting
the same way `TreasurySet` / `ZeroExProxySet` are tracked today.

### 9.5 External consumers of the admin surface

The Diamond's admin-set state is read by three distinct off-chain
consumers, each with its own sync mechanism:

| Consumer | Reads | Sync to upstream changes |
|---|---|---|
| **Frontend dApp** (`frontend/`) | full Diamond ABI + per-chain config | Per-facet JSONs in `frontend/src/contracts/abis/`. Manually maintained alongside contract edits. |
| **HF watcher worker** (`ops/hf-watcher/`) | a narrow Diamond surface (HF reads, loan struct, autonomous keeper) | Hand-typed `parseAbi([...])` strings in `src/keeper.ts` + `src/watcher.ts`. Maintained alongside contract edits in the same monorepo PR. |
| **Public keeper bot** (sibling `vaipakam-keeper-bot` repo) | same narrow surface as the watcher's keeper | Per-facet JSONs in `src/abis/`, regenerated by the upstream `contracts/script/exportAbis.sh`. CI in the bot's repo runs an `abi-shape` job to validate the JSONs are well-formed. |

The keeper-bot is the **only** consumer that lives outside the
monorepo. Phase 9.A introduced the `exportAbis.sh` script + a
`_source.json` provenance stamp so the bot's ABI bundles can be
correlated back to a specific monorepo commit hash. Future
`@vaipakam/abis` NPM-published bundle (deferred) would unify the
sync mechanism across all three consumers; for now duplication is
the simpler choice.

**What's retroactive (applies on next interaction)**: base fee BPS,
liquidation-path knobs, risk parameters, KYC policy. 72h timelock
delay + cancel-during-delay are the safety primitives.

**What's hardcoded (not configurable)**: `MIN_HEALTH_FACTOR`, VPFI
supply caps, settlement-math-core invariants. Changes require a full
DiamondCut upgrade which governance can still schedule via the
timelock.

**The ordering invariant**: every escrow-VPFI mutation path must call
`LibStakingRewards.updateUser(user, newBal)` **and**
`LibVPFIDiscount.rollupUserDiscount(user, newBal)` **before** mutating
the balance. Four sites exist today, all already follow this pattern
for the staking checkpoint — we just add the second call next to it.

Implementation: ~2-3 days. No architectural surprises — the staking
infrastructure is already in place, the discount accumulator is a
direct parallel of it, and all ordering invariants are enforced at the
same four call sites that already exist.

Ready to implement on your go.
