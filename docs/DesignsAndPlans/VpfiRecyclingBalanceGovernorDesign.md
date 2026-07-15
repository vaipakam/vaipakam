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
elapsed           = min(W, D − launchDay + 1)          // warm-up: divide by days
                                                       // that actually exist
Ā[D]              = (recycledCreditedCum[D] − recycledCreditedCum[max(D−W, launchDay−1)])
                    / elapsed                          // zero when elapsed == 0
scheduleFloor[D]  = min( schedule[D] , freshRemaining )  // schedule = existing
                                                         // halfPoolForDay × 2
recycledBudget[D] = min( fundable[D] ,  Ā[D] × (10000 − marginBps) / 10000 )
dailyPool[D]      = scheduleFloor[D] + recycledBudget[D]
```

Two hard caps make the formula self-consistent (Codex #1257 r1):

- **`freshRemaining` caps the floor.** The existing schedule has an indefinite
  5% tail, so `Σ schedule` is unbounded — the 69M cap is enforced by the
  payout counters, not the schedule. The floor is therefore explicitly capped
  by the remaining fresh budget (`freshRemaining = 69M − paidOutFresh − fresh
  remit reservations`) and **goes to zero at exhaustion** — at which point the
  pool is the recycled term alone, which is exactly the promised steady state.
- **`fundable[D]`, not raw bucket balance.** Phase A′ (Base-only):
  `fundable = Base bucketAvailable`. Phase B′ (mesh): `fundable = Base
  bucketAvailable + Σ_c min(mirrorBucketAvailable[c], that chain's own day-D
  claim demand)` — a mirror's bucket funds **its own** chain's slice
  (Base-instructed `recycleConsume[c][D]`, §6), and Base's bucket funds the
  rest via the netted remit. Un-repatriated surplus sitting on a *quiet*
  chain is **not** fundable for other chains' budgets until Phase C′
  repatriation moves it — global `Ā` sizes the *target*, `fundable` bounds
  the *reality*, so a credit-rich-but-idle chain can never cause an
  underfunded pool elsewhere or a silent draw on the fresh 69M.

- `scheduleFloor[D]` is the existing emission schedule (`halfPoolForDay × 2`),
  re-labelled from "the pool" to "the floor": the guaranteed minimum that
  decays on the existing seven-tier curve, capped by `freshRemaining` (above).
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
  report (§3.2) → Base computes **global** `Ā[D]` across all chains — but the
  day's recycled budget is bounded by `fundable[D]` (§3.1): each mirror's
  bucket funds only *its own* chain's slice, Base's bucket funds the rest, and
  un-repatriated quiet-chain surplus never sizes another chain's budget
  (Codex #1257 r1 P1).
- The finalized-denominator broadcast carries `recycleConsume[c][D]`
  (Base-instructed mirror bucket consumption) **and stamps the finalized
  day's pool composition — `scheduleFloorHalf[D]` + `recycledHalf[D]` (or
  equivalently the finalized `dailyPool[D]`)** — so a mirror computes claims
  against the true governor-sized pool instead of locally re-deriving the
  schedule floor and silently dropping the recycled add-on (Codex #1257 r1
  P1). The netted CCIP remittance sends only `max(0, budget − availRecycled)`
  (§3.3). Claims-first, keeper residual (§3.5). Cumulative counters self-heal
  missed reports; whole-day idempotency stamps prevent double-apply.
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

## 13. VPFI price source — peg activation (owner question, 2026-07-15)

**Owner proposal:** set the peg at **1 VPFI = 0.001 ETH** until organic
secondary markets exist, then use the market rate.

**Recommendation (REVISED per the owner's near-zero-legal-expenditure
directive, 2026-07-15): build the unified price source now, launch with it
`Unset`, activate `FixedRate` only when/if the flywheel benefit justifies one
bounded legal glance.** Building the architecture costs no legal review;
*activating* a platform-published rate is the one item in this whole design
that would (§14). At launch, E-1's direct-reduction mode delivers the
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

- **`FixedRate` (built now, activation deferred):** `1e15` wei/VPFI — the
  owner's proposed 1 VPFI = 0.001 ETH — as a bounded governed knob (event,
  timelock, zero-sentinel = `Unset`), replacing BOTH the hard-wired
  notification constant and the discount-peg pair. Every consumer —
  notification fees, borrower LIF, lender yield-fee (E-1 VPFI-payment mode),
  and any future VPFI-denominated fee — reads the same rate. No more
  per-feature price forks. Activation is a config ceremony gated on the §14
  legal glance, not a redeploy.
- **`MarketFeed` (the succession, Phase 2):** activatable **only** when the
  organic market passes the platform's own liquidity-depth machinery (the
  slippage-at-floor probe), and priced by **TWAP, never spot** — a
  thin-market spot rate feeding every fee conversion is a textbook
  manipulation vector. Until the probe passes, the switch refuses.
- Mode is derived from config state (feed set + probe pass ⇒ `MarketFeed`;
  rate set ⇒ `FixedRate`; neither ⇒ `Unset`), so activation and succession
  are config ceremonies, not redeploys.

**Consequences of the deferred-activation posture:**

- **At launch (`Unset`):** E-1 direct-reduction is the *primary* discount
  delivery (no conversion, no published price — the legally quietest shape).
  VPFI absorption comes from the peg-independent classes (notification fees,
  reward forfeits), so the governor's coupled term ramps slowly and the
  schedule floor carries the program — exactly the P3 bootstrap the formula
  was built for. Nothing user-visible is lost.
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
2. **No published token price at launch.** Price source ships `Unset` (§13).
   The lender discount is delivered as a fee schedule — "hold VPFI → pay
   lower fees" — with no conversion, no token movement, no rate
   representation. The pre-existing notification-fee constant is absorbed
   into the unified source without changing its behaviour.
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
