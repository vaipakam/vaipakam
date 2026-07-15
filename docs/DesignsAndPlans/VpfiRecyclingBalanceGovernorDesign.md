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
- **(P6) Near-zero legal expenditure (owner directive, 2026-07-15):**
  launching the recycling system must require no legal review; any feature
  that would (a published token price, market operations, holder
  distributions) is either excluded outright or isolated behind a deferred,
  optional activation gate. §14 is the binding posture contract.

## 3. The governor

### 3.1 Budget formula (the one new equation)

At Base day-finalization (`RewardAggregatorFacet._finalizeAndWrite`, where the
per-day #1008 cap threshold is already snapshotted):

```
Ā[D]              = Σ_{d ∈ (D−W .. D]} credited[d]  /  W
                    // credited[d] = the DAY-BUCKETED credit record for day d
                    // (local `recycledCreditedByDay` + mirrors' per-day report
                    // figures, §6) — NEVER a cumulative difference: a mirror
                    // self-healing a missed day via the cumulative must not
                    // shift old receipts into a later window (missed day ⇒
                    // credited[d] = 0 for Ā; the cumulative heals availability
                    // only). ALWAYS divide by W, zero-padding the pre-launch
                    // prefix.
                    // (Dividing by elapsed days would count a launch-day spike
                    // 1/1 + 1/2 + … + 1/7 ≈ 2.6× — violating the ≤1× lifetime
                    // contribution bound and making launch-week wash cycles
                    // profitable. Codex r2.) Warm-up therefore just means a
                    // smaller, conservative Ā in week one.
scheduleFloor[D]  = min( schedule[D] , freshAvailable[D] )
                    // schedule = existing halfPoolForDay × 2; zero on
                    // non-emitting days — day 0 / the first 24h stay excluded,
                    // and the coupled term is gated off with it (Codex r2:
                    // recycling must not make day-0 activity rewardable).
recycledBudget[D] = schedule[D] == 0 ? 0
                    : min( fundable[D] , Ā[D] × (10000 − marginBps) / 10000 )
dailyPool[D]      = scheduleFloor[D] + recycledBudget[D]
```

**Commitment accounting (Codex r2 P1 — availability must be reserved at
finalize, not merely debited at claim).** Rewards are claimable long after
their day finalizes, so availability read at finalize would be re-usable by
every later day (two days near exhaustion could both size against the same
10k). The governor therefore *commits* at finalization and *consumes* at
claim/remit:

```
commit_fresh[D]    = Σ_c chainCappedBudget_fresh[c][D]     // the per-chain
commit_recycled[D] = Σ_c chainCappedBudget_recycled[c][D]  // ceil-div capped
                                                           // budgets, NOT the
                                                           // raw pool — the
                                                           // #1008-capped sum
                                                           // is the true max
                                                           // claimable, finite
freshAvailable[D]  = 69M − paidOutFresh − freshRemitReserved
                     − Σ_{d<D} outstandingCommit_fresh[d]   // remitted-to-mirror
                                                            // fresh is gone too
                                                            // (Codex r6; mirrors
                                                            // the existing
                                                            // rewardBudgetRemittedGlobal
                                                            // subtraction)
fundable[D]        = bucketBalance − Σ_{d<D} outstandingCommit_recycled[d]
                     (Phase-split per §6)
```

Claims/remits consume from their day's commitment (`paidOutFresh` /
`paidOutRecycled` counters, source-split per the dual accumulator below); a
commitment is released back to availability only by forfeit (§4) — never by
time, so no user's claimable reward is ever silently defunded.

**Dual accumulator (Codex r2 P1 — a single cumulative RPN cannot recover a
per-user fresh/recycled split).** Each finalized day contributes to **two**
parallel reward-per-numerator accumulators — `freshRpn` (from
`scheduleFloor[D]`) and `recycledRpn` (from `recycledBudget[D]`) — per side,
per chain. A claim spanning many days computes its fresh and recycled
components exactly from the two accumulators; `paidOutFresh` /
`paidOutRecycled` and the bucket debit follow without drift. On a Phase-B′
mirror the local-vs-remitted split within the recycled component needs no
third accumulator (Codex r5): it was **fixed at broadcast** — the mirror
debits its local bucket pro-rata as recycled claims pay, capped at the
day's Base-instructed `recycleConsume[c][D]`; recycled claims beyond that
cap draw from remitted tokens with no local debit. Cost: one extra uint256
pair per finalized day per side — accepted for exact accounting.

Two hard caps make the formula self-consistent (Codex #1257 r1, unified with
the commitment model in r3 — the ONLY availability terms are the
commitment-netted ones above; there is no separate "freshRemaining"):

- **`freshAvailable` caps the floor** (`= 69M − paidOutFresh − fresh remit
  reservations − Σ outstandingCommit_fresh`). The existing schedule has an
  indefinite 5% tail, so `Σ schedule` is unbounded — the cap is enforced by
  the counters, never the schedule — and the floor **goes to zero at
  exhaustion**, leaving the recycled term alone: the promised steady state.
  **Ceil-dust rule (Codex r3):** what is *reserved* is `commit_fresh[D]` /
  `commit_recycled[D]` — the ceil-div per-chain sums, which can exceed the
  raw `scheduleFloor`/`recycledBudget` by bounded dust (≤ chains × sides
  wei). Availability checks run against the **commit sums**; if the last
  chain's ceil would breach availability, its slice is trimmed by the dust
  and the trim logged (`commitDust[D]`) — reservations can therefore never
  exceed what exists. **The trim propagates** (Codex r5): the trimmed
  chain's *per-chain* broadcast figures (its budget slice /
  `recycleConsume`) carry the trimmed amounts, so that chain's users accrue
  against the trimmed slice — never against the untrimmed global halves.
- **`fundable` is resolved PER-CHAIN — no global fixed point (Codex r5→r6:
  any uniform global add-on with chain-local funding either overcommits or
  decays geometrically; the source-scoped funding model already implies
  per-chain resolution).** Phase A′ (Base custody): a single pool,
  `recycledBudget = min(target, BaseAvail)`. Phase B′ (mesh), one pass,
  exact:
  1. `targetRecycled_c = p_c × target` — chain c's share of the coupled
     target at its demand weight `p_c` (from the finalized denominators).
  2. `localFunded_c = min(targetRecycled_c, mirrorAvail_c)` (Base's own
     slice funds from `BaseAvail` first).
  3. Base allocates its remaining bucket across the still-unfunded
     portions pro-rata (claims-first, keeper residual): `baseTopUp_c`.
  4. `recycledBudget_c = localFunded_c + baseTopUp_c`;
     `recycledBudget[D] = Σ_c recycledBudget_c` (the global metric).
  Each chain's broadcast carries ITS OWN `recycledHalf_c` (consistent with
  the per-chain trim rule above), so a chain whose slice is unfunded simply
  gets a smaller recycled add-on — never a claim against funds that sit
  unreachable on another mirror. Un-repatriated quiet-chain surplus beyond
  its own demand stays parked until Phase C′ repatriation; a mirror's
  bucket funds only its own chain's slice; Base's bucket tops up the rest —
  global `Ā` sizes the *target*, per-chain funding bounds the *reality*.

- `scheduleFloor[D]` is the existing emission schedule (`halfPoolForDay × 2`),
  re-labelled from "the pool" to "the floor": the guaranteed minimum that
  decays on the existing seven-tier curve, capped by `freshAvailable` (above).
  Funded from the pre-funded pool and counted against the 69M counter, exactly
  as today.
- `recycledBudget[D]` is the absorption-coupled add-on, **not** counted
  against the 69M counter (P4). It is a **sizing reservation, not a
  finalize-time transfer**: the bucket is debited pro-rata **at claim /
  remittance time** (the `paidOutRecycled` counter), so when per-user #1008
  caps or zero denominators leave part of the day's pool unclaimed, the
  unclaimed recycled slice simply never leaves the bucket — nothing strands in
  the reward allocation and the retained-margin accounting stays exact
  (Codex #1257 r1).
- `fundable[D]` is the hard constraint: the governor never sizes more recycled
  budget than is actually consumable that day, so the trailing average is a
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
and the cap invariant is enforced by construction (`freshDrawdown[D] ≤
scheduleFloor[D] ≤ freshRemaining`, so the counter can never overrun 69M —
note the raw schedule alone would NOT guarantee this, its 5% tail is
unbounded; the `freshRemaining` cap is what closes it). The floor's built-in
decay does the
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
- **Forfeit circularity — source-split rule (Codex r2 P1):** a forfeited
  interaction reward is an *unclaimed commitment* being released, and its
  handling must decompose by funding source (known exactly via the dual
  accumulator, §3.1):
  - the **fresh-funded share** genuinely left the fresh budget and lands in
    protocol custody → it **credits the recycle bucket** (real absorption)
    and stays counted in `paidOutFresh` — counted once, absorbed once;
  - the **recycled-funded share** never physically left the bucket (its
    budget was a commitment) → forfeiting it is a **pure commitment release**
    (`outstandingCommit_recycled` shrinks, bucket availability restores) with
    **zero new credit** — crediting it would mint a phantom absorption event
    for tokens that never moved, inflating future `Ā` and budgets.
  Net effect: `Σ paidOutFresh + fresh remit reservations ≤ 69M` stays the
  (P4) invariant, forfeits extend the runway, and no token is ever counted
  as absorbed twice.

### 4.1 The absorption plan, layered (owner question, 2026-07-15)

Distribution is the easy half (usage rewards + fee discounts). Absorption —
how VPFI flows *back* — is planned in three layers, ordered by what they cost
legally (P6):

**Layer 0 — live at launch, zero legal surface:**
- **Notification tariff** — the paid-push fee, billed in VPFI
  (pre-existing). **Custody re-route required (Codex r3):** the current bill
  withdraws user-vault → treasury directly; Phase A′ redirects the
  destination into Diamond custody with a bucket credit (per §5's
  Diamond-custody rule for recyclable VPFI classes) — without that one-line
  re-route, an external-treasury deployment would leak this class out of the
  loop and the "live at launch" claim would not hold.
- **Reward forfeits** — lender-entry transfers and non-clean closes forfeit
  the fresh-funded share into the bucket (§4 rule above).
- *(Velocity sink, not absorption:)* the discount tiers require **vaulted
  VPFI holdings**, structurally locking supply while utility exists.

**Layer 1 — buildable now, peg-free, zero legal surface (recommended):
native-VPFI service tariffs.** The generalisable principle behind the
notification fee: **denominate optional platform services directly in VPFI
units — a tariff, not a conversion.** "This service costs N VPFI" publishes
no exchange rate, converts nothing, and promises nothing — it is a price
schedule in the platform's own unit, the same legal shape as the E-1 fee
discount. Concrete candidates already on the roadmap:
- **E-4 borrower auto-protect** (#1206) — the keeper-automation service fee,
  billed per protective action or per subscription period, in VPFI.
- **E-5 standing intents** (#1207) — standing-order keeper execution fees,
  in VPFI.
- **#1219 service bonds (R-3/S-4)** — keepers/operators post VPFI bonds
  sized natively in VPFI units to register; misbehaviour slashes into the
  bucket (absorption), honest operation keeps supply locked (sink). No
  conversion anywhere in the lifecycle.
Boundary rule: tariffs apply **only to optional conveniences** — never to
protocol-safety functions (permissionless liquidation, default triggering,
close-outs stay free), preserving the liveness/ethos posture.

**Layer 2 — tariff-priced discount entitlements (owner-proposed, ADOPTED
2026-07-15 — peg-free, zero legal surface; see §4.2):** at loan initiation a
borrower/lender may pay a **tariff-sized VPFI amount** —
`k × loanVolumeETH × durationDays` — to buy that loan's LIF + yield-fee
discount entitlement. This replaces the peg-gated conversion family as the
highest-volume absorption path and makes the ENTIRE absorption plan
launchable with zero legal spend.

**Layer 3 — optional, market-era only:** `FixedRate`/`MarketFeed` activation
(§13) wakes the conversion-based classes (fee *equivalents* paid in VPFI).
No longer load-bearing for absorption — purely a UX/pricing refinement once
an organic market exists, behind the one bounded legal glance.

### 4.2 Tariff-priced discount entitlements (Layer 2, adopted)

**The load-bearing rule — tariff, not conversion:** the VPFI amount is a
QUANTITY schedule sized by the loan's characteristics (`k` VPFI per
ETH-of-volume × day), governed like the #1008 reward ratio. It must NEVER be
derived by converting the fee's value at a VPFI price — that would be a
price representation and re-enter §13/§14 territory. `k` is an independent
bounded knob (`recycleTariffKPer1e18EthDay`, zero-sentinel default, ADMIN →
timelock → governance; default + bounds set with the implementation card,
tuned so the loop stays net-absorbing after rewards at the governor margin).

Mechanics:
- **Absorb at initiation — non-refundable (Codex r5):** the tariff buys the
  entitlement outright: VPFI moves user-vault → Diamond and **credits the
  recycle bucket immediately at initiation**. It is deliberately NOT
  `vpfiHeld`-style user custody (that flow stays user-owned during the loan
  and rebates at proper close — crediting it at init would double-count);
  only the vault-pull plumbing is reused. No rebate on any outcome — the
  discounted fee schedule for that loan is what was purchased.
- **Distribute at close:** unchanged — the existing interaction-reward
  system already sizes by time × ETH volume (eligible interest, #1008
  ETH-capped) and closes at terminal. The pair is symmetric by construction
  and the governor's `Ā`/margin binds the two sides.
- **Immediate sink:** the tariff is absorbed at initiation, so the sink is
  instant and proportional to ETH·day; a wash-cycle forfeits the whole
  tariff up-front against at most `(1 − m)` of it returning via the coupled
  term days later — strictly value-destructive.
- **Position transfers (Codex r5):** the entitlement is **loan-bound** — it
  travels with the position NFT exactly like the loan's other economics
  (the E-7 fair-value sale prices it in); the seller gets no refund and the
  buyer inherits the discounted schedule for the remaining term, mirroring
  how reward entries re-anchor to the buyer.
- **Illiquid loans excluded** (no oracle → no ETH volume): no tariff, no
  discount entitlement, no rewards — symmetric with the reward side's
  existing treatment.
- **Coexistence (recommended):** the hold-based tier discount (E-1) remains
  as-is — holdings park supply and keep day-one utility; the tariff route
  offers the DEEPER discount (it absorbs; holding only parks). Exact
  discount schedule split is an implementation-card decision.
- **Fairness boundary:** the tariff buys fee discounts only — never
  priority, safety-function access, or matching preference.

The governor then closes the loop by construction: whatever these layers
absorb becomes `Ā`, and distribution's coupled term is `(1 − m) × Ā` — so
the two sides *cannot* drift apart by more than the margin plus the decaying
schedule floor, at every stage of the rollout.

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

- Mirrors report **both** the cumulative `chainRecycledVpfi18` (availability
  accounting, self-healing across missed reports) **and the day-bucketed
  credit total for the closing day** (Codex r2: the trailing mean needs
  per-day attribution — a cumulative delta spanning a missed day cannot be
  split between D and D+1, letting report *timing*, not receipt timing,
  shift budgets). A missed day zero-fills in `Ā` — a conservative
  under-count, never an over-count — while the cumulative still self-heals
  availability. Base computes **global** `Ā[D]`, but the day's recycled
  budget is bounded by `fundable[D]` (§3.1): each mirror's bucket funds only
  *its own* chain's slice, Base's bucket funds the rest, and un-repatriated
  quiet-chain surplus never sizes another chain's budget (Codex #1257 r1 P1).
- **`fundable[D]` is computed by the §3.1 two-pass algorithm** (defined
  once there — Codex r4: this section previously restated a stale one-pass
  form; §3.1 is authoritative). The demand a mirror's bucket can fund is its
  **recycled-component demand only** (`chainRecycledBudget_c`, never the
  fresh floor share — consistent with the source-scoped netting below), and
  after fresh-floor exhaustion the target keeps that demand non-zero, so a
  funded bucket can never deadlock the program against a zero floor.
- The finalized-denominator broadcast carries `recycleConsume[c][D]`
  (Base-instructed mirror bucket consumption) **and stamps the finalized
  day's pool composition — `scheduleFloorHalf[D]` **and** `recycledHalf[D]`
  as SEPARATE fields (the aggregate `dailyPool` is NOT sufficient — Codex r3:
  a mirror needs the split to maintain its own `paidOutFresh` /
  `paidOutRecycled` counters, feed the dual accumulators, and source-split
  forfeits)** — so a mirror computes claims against the true governor-sized
  pool instead of locally re-deriving the schedule floor and silently
  dropping the recycled add-on (Codex #1257 r1 P1). The netted CCIP remittance is **source-scoped** (Codex r3): netting
  applies only to the RECYCLED component of a chain's budget —
  `remit_recycled[c] = max(0, chainRecycledBudget[c] − availRecycled[c])`,
  where `availRecycled[c]` is **commitment-netted** (reported cumulative −
  consumed cumulative − that chain's outstanding recycled commitments —
  Codex r4: the old reported-minus-consumed form would let one bucket
  balance back two days' netting) —
  while the fresh-floor component always remits from the fresh pool
  (`remit_fresh[c] = chainFreshBudget[c]`). A mirror's bucket can therefore
  never be spent on the fresh floor while the accumulators book those
  payouts as fresh (the drift the old whole-budget netting allowed). Claims-first, keeper residual (§3.5). Cumulative counters self-heal
  missed reports; whole-day idempotency stamps prevent double-apply.
- Numbers travel daily; tokens travel only on genuine net shortfall — the
  property that made Option B the right substrate is exactly preserved.

## 7. Invariants (test targets)

1. `Σ paidOutFresh (+ fresh remit reservations) ≤ 69,000,000e18` — cap bounds
   fresh drawdown only (restates the prior "fresh-mint-only" decision in
   drawdown terms).
2. `recycleBucket ≥ 0` always; commitment discipline (Codex r2): at every
   finalize, `Σ outstandingCommit_recycled ≤ bucketBalance` and
   `Σ outstandingCommit_fresh + paidOutFresh ≤ 69M` — a day can never size
   against availability another unclaimed day already committed.
3. Bucket separation: `diamondVpfiBalance ≥ userLifCustody +
   unclaimedRewardBudget + recycleBucket` on every chain, every day.
4. Per-day identity: `dailyPool[D] == scheduleFloor[D] + recycledBudget[D]`,
   and `recycledBudget[D] == (1 − m̂) × Ā[D]` when `fundable[D]` suffices
   (`m̂` = the stamped `recycleMarginBpsAtFinalize`).
5. Platform-edge monotone — **all-time cumulative, not per-window** (the
   trailing mean deliberately redistributes a spike across later days, so a
   window test would fail a correct implementation — Codex #1257 r1):
   `Σ_{d ≤ D} paidOutRecycled[d] ≤ (1 − m̂_min) × Σ_{d ≤ D} absorbed[d]` for
   every D, where `m̂_min` is the smallest margin stamped over the horizon.
   Holds by construction: each absorbed unit contributes at most `1/W` to each
   of the W following days' `Ā`, so its lifetime contribution to recycled
   budgets is at most `(1 − m)` of itself.
6. Per-chain `consumedCumulative ≤ reportedCumulative`; duplicate broadcast is
   a no-op; missed report self-heals (all carried over from the prior design).
7. Anti-gaming economic check (property test), **scoped to the coupled term**
   (Codex #1257 r1): the *marginal* recycled budget attributable to a wash
   cycle's own absorption returns at most `(1 − m)` of what was absorbed —
   before pro-rata dilution and per-user caps shrink it further — so the
   recycling mechanism itself is strictly value-destructive to game. The
   `scheduleFloor` is capturable by whoever has eligible activity regardless
   of recycling; that is a pre-existing property of the reward program that
   this design neither creates nor changes.

## 8. Phasing (re-cut)

- **Phase A′ — Base-custody recycling, the new #1217 scope.** Bucket ledger +
  credits at every live receipt site + `VpfiRecycled` events +
  bucket-separation invariant + **the governor in `_finalizeAndWrite`** +
  `recycleMarginBps` knob + commitment accounting + the dual
  fresh/recycled accumulators + the #1218 metrics (below). **The
  pool-composition broadcast field ships in A′, not B′** (Codex r2 P2): the
  finalized denominators already include mirror activity, so if mirrors kept
  re-deriving a schedule-only pool while Base finalized floor+recycled, the
  same reward day would pay inconsistently by chain. Broadcasting the
  finalized composition (the plumbing already carries `dayCapThreshold18`;
  this adds a field) keeps every chain pricing the identical `dailyPool[D]`
  from day one, while all recycle *custody* stays on Base and mirror claims
  keep funding through the existing #776 remittance (source-split on Base's
  ledger) — **with its sizing updated in A′ to the broadcast pool
  composition** (Codex r5: `chainRewardBudgetForDay` reads the schedule-only
  `halfPoolForDay` today and would underfund the recycled add-on). Mirror-
  local buckets, day-bucketed reporting, consumption and netting remain
  Phase B′.
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
`platformRetained = bucketBalance − Σ outstandingCommit_recycled` (raw bucket
growth would overstate the reserve by counting committed-but-unclaimed user
liabilities — Codex r3), and `runwayExtensionDays` (cumulative recycled ÷
trailing-W mean of `dailyPool`, reported as `∞ / self-funded` once the fresh
floor is zero — never a division by the zeroed floor — Codex r3). `netEmission[D]` from the prior design maps
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

## 13. VPFI price source — peg activation (owner question, 2026-07-15)

**Owner proposal:** set the peg at **1 VPFI = 0.001 ETH** until organic
secondary markets exist, then use the market rate.

**Recommendation (FINAL, superseding the earlier build-now/launch-Unset
form — owner tariff unification, 2026-07-15): do not build the price source
at all now.** With tariff-priced entitlements as Layer 2, no launch-path
consumer needs a price; `LibVpfiPrice` is a market-era work item, and even
its future *activation* remains the one item in this design that would need
a legal glance (§14). At launch, E-1's direct-reduction mode delivers the
user-facing utility ("hold VPFI → pay lower fees") with **no conversion, no
token movement, and no published price** — so nothing user-visible is lost by
deferring activation, only the absorption ramp is slower (the governor's
schedule floor covers exactly that phase by design, §3.1/P3).

Today the codebase carries *three* disconnected VPFI-price notions:

1. `VPFI_PER_ETH_FIXED_PHASE1 = 1e15` — a compile-time constant (exactly
   1 VPFI = 0.001 ETH) hard-wired into the notification-fee path, whose own
   comment anticipates this moment: *"When VPFI lists on an exchange
   (Phase 2), governance can replace this fixed rate with a live
   VPFI/numeraire feed."*
2. `s.vpfiDiscountWeiPerVpfi` + `s.vpfiDiscountEthPriceAsset` — the
   admin-settable discount peg (`VPFIDiscountFacet.setVPFIDiscountRate` /
   `setVPFIDiscountETHPriceAsset`), left unset at launch, which is the only
   thing keeping the yield-fee/LIF VPFI paths dormant.
3. The E-1 dual-mode predicate, which must key on (2).

The owner's proposed rate is **identical to the constant already embedded in
(1)** — the platform has effectively been running this peg for notification
fees all along. Ratifying it merely makes the price story coherent.

**The clean architecture — one resolver, three modes:**

```
LibVpfiPrice.source() → { Unset | FixedRate | MarketFeed }
LibVpfiPrice.weiPerVpfi() → the single canonical rate every consumer reads
```

- **`FixedRate` — BUILD DEFERRED ENTIRELY (owner decision 2026-07-15, the
  tariff unification):** with tariff-priced entitlements adopted as Layer 2,
  no conversion consumer remains on the launch path, so `LibVpfiPrice` is
  not built now at all. The dormant discount-peg config pair is retired;
  the resolver becomes a market-era work item. When built, its consumers
  are **conversion-based fees ONLY** — native tariffs (Layer 1/2, E-4/E-5
  service fees, #1219 bonds) must NEVER read it (Codex r5: routing "any
  future VPFI-denominated fee" through the resolver would silently convert
  tariffs into price representations). The owner's 1 VPFI = 0.001 ETH rate
  is recorded here as the pre-staged `FixedRate` value for that future
  ceremony, gated on the §14 legal glance.
  **Notification fee (Codex r5 — the last conversion):** the current bill
  converts an ETH-denominated fee value via the fixed 1e15 constant — a
  platform-defined VPFI/ETH conversion, however small. Recommendation:
  re-denominate it as a **flat native VPFI tariff**, with the default chosen
  at the implementation card to preserve today's typical bill (the current
  formula yields ≈0.5 VPFI on the default USD-numeraire deployment — Codex
  r6; NOT 2 VPFI), removing the final conversion from the launch surface
  and making §14.2 unconditionally true.
- **`MarketFeed` (the succession, Phase 2):** activatable **only** when the
  organic market passes the platform's own liquidity-depth machinery (the
  slippage-at-floor probe), and priced by **TWAP, never spot** — a
  thin-market spot rate feeding every fee conversion is a textbook
  manipulation vector. Until the probe passes, the switch refuses.
- Mode is derived from config state (feed set + probe pass ⇒ `MarketFeed`;
  rate set ⇒ `FixedRate`; neither ⇒ `Unset`), so activation and succession
  are config ceremonies, not redeploys.

**Consequences of the deferred-activation posture:**

- **At launch (no price source):** discounts flow through the two peg-free
  routes (hold-tier → direct reduction; tariff → deeper schedule). VPFI
  absorption comes from the **tariff entitlements (§4.2 — the high-volume
  path)**, the notification tariff, and reward forfeits (Codex r6: the
  earlier notification+forfeits-only wording predated the tariff adoption
  and would under-scope the implementation cards). The schedule floor still
  covers any slow-ramp phase per P3. Nothing user-visible is lost.
- **When activated (`FixedRate`, later):** the dormant absorption classes
  (borrower LIF, yield-fee-in-VPFI, matcher remainders) go live, the
  flywheel accelerates, and E-1's role shifts to resilience fallback
  (covering `Unset` windows, oracle outages, unconfigured chains — see the
  delivery-chain plan on #1203). Activation is gated on the §14 legal
  glance; testnets can activate any time for rehearsal.
- The peg-unset posture stays the documented conservative legal choice
  (#884) until the owner deliberately spends that one bounded review. The
  eventual surface is materially blunted by the fact that **no purchase
  surface exists** (#687-A): nobody can *buy* VPFI at this rate — it is a
  fee-payment conversion for tokens users already earned.
- Arbitrage honesty: once a real market exists, a fixed rate becomes arbable
  (market < peg ⇒ buying cheap VPFI to extinguish fees drains real fee
  revenue). That is precisely why the `MarketFeed` succession rule above is
  part of the same decision: prompt, depth-gated, TWAP-based switch — with
  the fixed rate retained as the break-glass fallback if the feed degrades.

## 14. Legal-surface posture — near-zero legal expenditure (owner directive, 2026-07-15)

The recycling design is deliberately shaped so that **launching it requires no
legal spend at all**, and only one future, optional, isolated decision ever
would. The properties that make that true — each of them load-bearing, to be
preserved through implementation and every spec/marketing edit:

1. **No purchase or sale surface.** The protocol never sells, buys, or quotes
   VPFI for acquisition (#687-A stands). The §10 rejection of buyback-style
   balancing is re-affirmed *on this ground*, independent of its mechanical
   flaws: no market operations, ever, in the recycling loop.
2. **No published token price at launch — and no price code at all.** The
   price source's build is deferred entirely (§13); the discount-peg config
   is retired. Discounts are fee schedules (hold-tier → direct reduction;
   tariff → deeper schedule), and the notification fee is re-denominated as
   a flat native VPFI tariff — zero conversions anywhere on the launch
   surface.
3. **Rewards are usage rebates, never yield.** The interaction-reward program
   pays users for their *own* platform activity, sized by a deterministic
   formula over their own eligible interest, per-user capped. The governor
   changes the pool's *funding arithmetic*, not its character: fees the
   protocol received come back as usage rebates. Nothing accrues to passive
   holding; no APY, no distribution to holders, no profit-sharing mechanics.
4. **The margin is a retained protocol reserve, not a distribution.** The
   platform edge (`recycleMarginBps`) is value that *stays* in protocol
   custody as a sustainability buffer. It is never paid out to token holders;
   Phase-C tooling moves it only between the protocol's own pockets
   (repatriation, keeper budget). Spec and UI language must describe it as
   reserve retention — never "platform profit share."
5. **Tokens cross chains only as internal netting.** Cross-chain movement is
   the protocol rebalancing its own custody (shortfall-only remittance of
   already-owned tokens over CCIP). No user-facing cross-chain financial
   product is created.
6. **Everything is internal accounting of fee receipts.** The bucket, the
   governor, the counters — all bookkeeping over tokens the protocol already
   holds. No new instrument, no external counterparty, no custody of user
   assets beyond the existing (already-reviewed) vault model.

**The single deferred legal item:** activating `FixedRate` (§13) — a bounded,
optional, future decision, isolated so that everything else in this design
ships without it. `MarketFeed` succession inherits the same gate. Nothing
else in Phases A′/B′/C′ introduces a surface that the platform's existing
posture hasn't already carried.
