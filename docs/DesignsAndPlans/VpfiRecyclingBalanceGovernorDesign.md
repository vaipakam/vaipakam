# VPFI Recycling Balance Governor — absorption-coupled distribution (redesign, #1222)

**Status:** RATIFIED (owner, 2026-07-15 — all three §11 decisions accepted as
recommended: margin default 500 bps, additive floor, fixed 7-day window) —
supersedes §3.4 of
[`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md) (the
"fresh-mint offset" distributor formula) and re-cuts the #1217 / #1222 phasing.
Everything else in that document — the recycle-bucket ledger (§3.1), the
cumulative reporting field (§3.2), Option-B netted remittance (§3.3), the
keeper-allocation rider (§3.5) — is **kept as the substrate** this governor
sits on.

**Owner directive being implemented:** *"redesign the recycling of VPFI token
effectively, so that the absorption and distributions balance each other, with
slight benefit to the platform (with admin knob, later tunable by
governance)."*

---

## 1. What changed vs. the prior design — and why a redesign is warranted

Two code facts (verified 2026-07-15) invalidate the prior design's central
formula and, more importantly, open the door to the balance property the owner
wants:

1. **No recycling code exists.** `grep -rniE "recycl|freshMint"` over
   `contracts/src` is empty. The prior design, #1217, #1218 and #1222 are all
   unbuilt. We are free to build the *right* shape first time.
2. **Interaction rewards are never minted per-claim.** They are paid by
   `safeTransfer` out of a **pre-funded pool balance** on the Base Diamond,
   bounded by a software counter
   (`interactionPoolPaidOut + rewardBudgetRemittedGlobal ≤
   VPFI_INTERACTION_POOL_CAP = 69M`,
   `InteractionRewardsFacet.claimInteractionRewards`). The daily budget is a
   **fixed decaying schedule** (`LibInteractionRewards.halfPoolForDay`:
   `annualRateBps × 23M / (10000 × 365 × 2)` per side; 3200 bps → ~20,164
   VPFI/day at launch, decaying in seven ~182-day tiers to a 5% tail). The
   prior design's `freshMint[D] = dailyPool[D] − recycledConsumed[D]` offset
   therefore has **no mint call to offset** — the correct coupling point is the
   *daily budget computation itself*, at day finalization.

The prior design also had a structural gap against the new requirement: its
distribution side stayed a **blind schedule**. Recycling only changed *how*
the schedule was funded (recycled-first), never *how much* was distributed.
Absorption and distribution were decoupled by construction — the platform
could absorb heavily on a quiet day and still emit the full schedule, or
absorb nothing in a hot week and still emit the full schedule. The owner's
requirement is the opposite: **distribution tracks absorption**, with the
platform structurally net-positive by a tunable margin.

## 2. Requirement (restated precisely)

Let, per finalized reward day `D` (all quantities in VPFI, 1e18):

- **A[D] — absorption**: VPFI credited to the protocol's recycle bucket on any
  chain during day `D` (the receipt classes in §4).
- **E[D] — distribution**: the interaction-reward budget released for day `D`
  (the pool the per-user #1008-capped claims draw against, both sides, all
  chains).

Required properties:

- **(P1) Balance:** in steady state, `E ≈ A` — the reward program is funded by
  platform usage, not by an unconditional schedule.
- **(P2) Platform edge:** the platform retains a slight, *tunable* share of
  absorption: `E[D] ≤ (1 − m) × Ā[D] + floor[D]`, where `m` is the platform
  margin (bps knob) and `Ā` a smoothed absorption signal. Retained margin
  accumulates in the protocol-owned recycle bucket.
- **(P3) Bootstrap continuity:** at launch absorption is near zero (most VPFI
  receipt classes are peg-gated dormant — §4), so distribution must degrade
  gracefully to today's schedule, not to zero. No cliff, no mode flag.
- **(P4) Cap discipline:** drawdown of the *pre-funded* 69M pool ("fresh
  drawdown") remains bounded by the existing schedule and the 69M counter;
  recycled re-use extends the program without touching it. The token-enforced
  230M global cap is unaffected either way.
- **(P5) Governance shape:** the margin is a bounded ADMIN_ROLE knob behind
  the 48h timelock, later transferable to governance — the house
  `setInteractionCapVpfiPerEth` pattern (compile-time bounds, zero-sentinel
  default, raw + effective getters, event).

## 3. The governor

### 3.1 Budget formula (the one new equation)

At Base day-finalization (`RewardAggregatorFacet._finalizeAndWrite`, where the
per-day #1008 cap threshold is already snapshotted):

```
Ā[D]              = trailing-W-day mean of global recycle-bucket credits
                    = (recycledCreditedCum[D] − recycledCreditedCum[D−W]) / W
recycledBudget[D] = min( bucketAvailable ,  Ā[D] × (10000 − marginBps) / 10000 )
dailyPool[D]      = scheduleFloor[D] + recycledBudget[D]
```

- `scheduleFloor[D]` **is the existing emission schedule, unchanged**
  (`halfPoolForDay × 2`). It is re-labelled from "the pool" to "the floor":
  the guaranteed minimum that decays on the existing seven-tier curve. Funded
  from the pre-funded pool and counted against the 69M counter, exactly as
  today.
- `recycledBudget[D]` is the absorption-coupled add-on. Funded exclusively
  from the recycle bucket (ledger transfer, no token movement — §5) and **not**
  counted against the 69M counter (P4).
- `bucketAvailable` is the hard constraint: the governor never schedules more
  recycled budget than the bucket actually holds, so the trailing average is a
  smoothing *target*, never an overdraft. The bucket cannot go negative.
- The split and caps downstream are untouched: `dailyPool[D]` still divides
  50/50 lender/borrower, pro-rata to eligible interest, under the per-user
  #1008 cap (`min(Δ_d, T_d)`), with ceil-div per-chain budgets — the governor
  changes only the pool's size, never its distribution rules.

**Why additive (`floor + coupled`) and not `max(floor, coupled)`:** with
`max`, absorption below the floor has zero effect — the flywheel signal
("usage funds rewards") only engages after absorption exceeds ~20k VPFI/day,
which may take a long time and reads as "recycling does nothing." With the
additive form every absorbed token visibly raises the next budgets by
`(1 − m)`, from day one; the platform edge (P2) applies to *all* absorption;
and the cap invariant is trivial (`freshDrawdown[D] ≤ scheduleFloor[D]` ⇒
`Σ freshDrawdown ≤ Σ schedule ≤ 69M`). The floor's built-in decay does the
hand-over automatically: early life is schedule-dominated, mature life is
absorption-dominated, and after the 69M pre-fund exhausts the program
continues indefinitely at `(1 − m) × Ā` — **rewards stop hard-stopping**.

### 3.2 The margin knob

```solidity
// LibVaipakam constants
uint16 constant RECYCLE_MARGIN_DEFAULT_BPS = 500;   // 5% — "slight benefit"
uint16 constant RECYCLE_MARGIN_MAX_BPS     = 2_500; // 25% hard ceiling

// ConfigFacet (ADMIN_ROLE, behind the 48h timelock like every bounded knob)
function setRecycleMarginBps(uint16 newBps) external onlyRole(ADMIN_ROLE);
// bounds: 0 = reset-to-default sentinel (house pattern); [1 .. 2500] explicit.
// A literal 0% margin is expressed as 1 bp (0.01%) — the sentinel is reserved.
// emits RecycleMarginSet(oldEffective, newEffective)
```

Resolver `LibVaipakam.cfgRecycleMarginBps()` (stored 0 ⇒ 500), raw + effective
getters, mirroring `setInteractionCapVpfiPerEth` /
`getInteractionCapVpfiPerEth`. The margin is read **once per day at
finalization** and stamped into the day's finalized record
(`recycleMarginBpsAtFinalize`), so a mid-day retune can't rewrite an already
finalized day (the #957 snapshot discipline, applied at day granularity).
Ownership migrates to governance with the same timelock handover every other
ConfigFacet knob follows — no special path.

The smoothing window `W` is a **compile-time constant of 7 days** in v1
(`RECYCLE_TRAILING_WINDOW_DAYS = 7`), deliberately not a knob: one economic
knob is auditable; two interacting ones invite mis-tuning. Revisit only with
evidence.

### 3.3 Where the retained margin goes

Nowhere — and that is the point. The margin share `m × Ā[D]` simply **stays in
the recycle bucket** and is never scheduled for distribution. Cumulative
platform retention = the bucket's structural growth. This is deliberately the
same surplus that the prior design's **Phase C tooling** manages (governance
surplus knob, batched repatriation): the governor *creates* a predictable
surplus; Phase C *manages* it. Nothing new to invent there — Phase C is kept
verbatim, now with a purpose.

## 4. Absorption classes (what credits the bucket)

Same classes as the prior design §3.1, re-verified against code, with their
launch-time status stated honestly:

| Class | Code anchor | Status at Phase-1 launch |
|---|---|---|
| Forfeited borrower LIF (net of 1% matcher) | `LibVPFIDiscount.forfeitBorrowerLif` | Peg-gated dormant (LIF-in-VPFI entry needs the peg) |
| Borrower LIF treasury share at proper close | `LibVPFIDiscount.settleBorrowerLifProper` | Peg-gated dormant |
| Lender yield-fee share in VPFI | `LibVPFIDiscount.tryApplyYieldFee` | Peg-gated dormant (and E-1 direct-reduction mode absorbs no VPFI while peg unset) |
| Notification fees | `LibNotificationFee.bill` (fixed Phase-1 peg) | **LIVE** |
| Matcher-share remainders | inside the LIF splits | Peg-gated dormant |
| Forfeited interaction rewards | `InteractionRewardsFacet` forfeit → treasury | **LIVE** (see below) |
| Service-bond slashes (#1219) | — | Future |

Two consequences the design owns explicitly:

- **Bootstrap honesty (P3):** until the peg is set, `A ≈ notification fees +
  reward forfeits` — small. The governor degrades to `dailyPool ≈
  scheduleFloor`, i.e. exactly today's behaviour. The day the peg is
  configured, the LIF/yield-fee families start feeding the bucket and the
  coupled term ramps with zero code or governance action.
- **Forfeit circularity:** a forfeited interaction reward is pool money coming
  *back*. Crediting it to the bucket and re-distributing it must not
  double-count against the 69M counter. Accounting rule: the counter tracks
  **fresh drawdown only** — split the existing counter into
  `paidOutFresh` (counts) and `paidOutRecycled` (doesn't), and a forfeit
  credit reduces neither (the tokens simply move ledger-wise from
  "user-owed reward" to "recycle bucket"). Net effect:
  `Σ paidOutFresh + rewardBudgetRemittedGlobalFresh ≤ 69M` is the (P4)
  invariant, and a forfeit genuinely extends the runway instead of leaking.

## 5. Custody & the bucket ledger (unchanged substrate, one sharpening)

The prior design's §3.1 bucket model is kept: each Diamond carries a
protocol-owned `recycleBucket` **ledger slice of its own VPFI balance**, with
`VpfiRecycled(source, refId, amount, dayId)` emitted per credit and the
bucket-separation invariant
`diamondVpfiBalance ≥ userLifCustody + unclaimedRewardBudget + recycleBucket`.

One sharpening this redesign makes load-bearing: **recyclable VPFI receipt
classes must terminate in Diamond custody, not an external treasury wallet.**
`LibFacet.recordTreasuryAccrual` already only ledger-accrues when
`treasury == address(this)`; the recycle credit tees off the same single
choke-point (`transferToTreasury` / the VPFI-receipt sites) and requires that
posture for VPFI. Non-VPFI treasury flows are untouched. Day-bucketed credit
totals (`recycledCreditedByDay[dayId]`) are recorded at credit time to feed
`Ā[D]` cheaply.

## 6. Cross-chain composition (Option B kept verbatim)

The mesh is unchanged from the prior design — it composes because the governor
sits at the single canonical point (Base finalization):

- Mirrors report cumulative `chainRecycledVpfi18` on the existing day-close
  report (§3.2) → Base computes **global** `Ā[D]` across all chains.
- The finalized-denominator broadcast carries `recycleConsume[c][D]`
  (Base-instructed mirror bucket consumption) and the netted CCIP remittance
  sends only `max(0, budget − availRecycled)` (§3.3). Claims-first, keeper
  residual (§3.5). Cumulative counters self-heal missed reports; whole-day
  idempotency stamps prevent double-apply.
- Numbers travel daily; tokens travel only on genuine net shortfall — the
  property that made Option B the right substrate is exactly preserved.

## 7. Invariants (test targets)

1. `Σ paidOutFresh (+ fresh remit reservations) ≤ 69,000,000e18` — cap bounds
   fresh drawdown only (restates the prior "fresh-mint-only" decision in
   drawdown terms).
2. `recycleBucket ≥ 0` always; `recycledBudget[D] ≤ bucketAvailable` at
   finalize (no overdraft; trailing average is a target, not a claim).
3. Bucket separation: `diamondVpfiBalance ≥ userLifCustody +
   unclaimedRewardBudget + recycleBucket` on every chain, every day.
4. Per-day identity: `dailyPool[D] == scheduleFloor[D] + recycledBudget[D]`,
   and `recycledBudget[D] == (1 − m̂) × Ā[D]` when the bucket suffices
   (`m̂` = the stamped `recycleMarginBpsAtFinalize`).
5. Platform-edge monotone: cumulative bucket retention ≥
   `m̂ × Σ recycledBudget/(1−m̂)`-consistent lower bound — i.e. the bucket
   never distributes more than `(1 − m̂)` of what it absorbed over any window.
6. Per-chain `consumedCumulative ≤ reportedCumulative`; duplicate broadcast is
   a no-op; missed report self-heals (all carried over from the prior design).
7. Anti-gaming economic check (property test): a closed self-dealing loop
   (pay VPFI fee → raise Ā → claim) strictly loses ≥ `m` per cycle before per
   user caps and pro-rata dilution — the margin makes wash-cycling
   value-destructive by construction.

## 8. Phasing (re-cut)

- **Phase A′ — Base-only, the new #1217 scope.** Bucket ledger + credits at
  every live receipt site + `VpfiRecycled` events + bucket-separation
  invariant + **the governor in `_finalizeAndWrite`** + `recycleMarginBps`
  knob + fresh/recycled counter split in `claimInteractionRewards` + the
  #1218 metrics (below). Delivers the owner's balance property single-chain
  immediately; mirrors keep their current behaviour (schedule-only budgets)
  until Phase B′.
- **Phase B′ — mesh netting (the #1222 body, unchanged list).** The two
  message fields, mirror bucket consumption, netted remittance, global `Ā`,
  3-chain e2e + self-heal/idempotency tests, watcher bucket-balance checks.
  Mirror Diamonds already exist on arb-sepolia / sepolia / op-sepolia /
  bnb-testnet — Phase B′ needs only an in-place facet refresh there, not
  fresh deploys.
- **Phase C′ — surplus tooling, kept verbatim, now purposeful.** Governance
  surplus knob (N× trailing daily budget), batched repatriation via the #776
  machinery, optional keeper-budget credit — all now managing the
  margin-created buffer.

## 9. Metrics (#1218, extended)

Per day, on the transparency dashboard: `absorbed[D]` (global credit total),
`recycledBudget[D]`, `scheduleFloor[D]`, `freshDrawdown[D]`,
`selfFundingRatio[D] = recycledBudget/dailyPool`, cumulative
`platformRetained` (bucket growth), and `runwayExtensionDays` (cumulative
recycled ÷ current daily floor). `netEmission[D]` from the prior design maps
to `freshDrawdown[D]`.

## 10. Alternatives considered (and why not)

- **Keep the prior offset-only design** (schedule unchanged, recycled-first
  funding): fails P1/P2 — distribution never responds to absorption and there
  is no platform edge. It optimises runway, not balance.
- **Hard same-day matching** (`E[D] = (1−m) × A[D]`, no floor, no smoothing):
  fails P3 (day-one rewards = 0 → activity flywheel never starts) and is
  trivially gameable/volatile day-to-day.
- **`max(floor, coupled)` instead of additive:** see §3.1 — absorption below
  the floor is invisible, the edge only applies above ~20k/day, weak flywheel
  signal. Rejected for the additive form.
- **Buyback-style balancing** (sell/buy VPFI to equalise flows): reintroduces
  the market-operations legal surface the #687-A excision removed. Ruled out
  on the standing legal posture.
- **Per-claim coupling** (scale each user's claim by live absorption):
  couples user UX to instantaneous noise and breaks the finalized-day
  determinism the cross-chain mesh depends on. The day-granular governor at
  finalization keeps determinism and idempotency.

## 11. Owner decisions folded in / newly required

Folded in (this design, if adopted, settles them):

- ~~Adopt Option B~~ → **kept as substrate** (§6).
- ~~69M cap bounds fresh mint only~~ → **restated as fresh-drawdown-only**
  (§7.1), same intent, correct mechanics.

Newly required — **all three RATIFIED by the owner, 2026-07-15**:

1. **`RECYCLE_MARGIN_DEFAULT_BPS = 500` (5%)** — ratified as the "slight
   benefit" default. (Any value in [1..2500] bps remains tunable via the knob
   from day one.)
2. **Additive floor semantics** (§3.1) — `floor + coupled` ratified over
   `max(floor, coupled)`.
3. **`W = 7 days` fixed** in v1 (compile-time constant, not a knob) —
   ratified.

## 12. Spec edits shipped with the implementation PRs

TokenomicsTechSpec §4 (daily pool = decaying floor + absorption-coupled
recycled budget; fresh-drawdown cap statement), §4a (message fields — Phase
B′), §9 (recycle bucket, margin, surplus posture; replaces the "budget may
accumulate without affecting mint flow" stub), plus the #1218 metric
definitions. Release-note fragments and `_CodeVsDocsAudit` rows per house
convention.
