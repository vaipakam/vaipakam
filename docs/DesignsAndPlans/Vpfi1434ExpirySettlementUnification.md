# #1434 — Expiry settlement rides the day primitive (root-cause unification)

**Status**: design pin, opened after PR #1699 round 6
**Supersedes**: the bespoke expiry delivered-gate added in #1699 rounds 1, 4 and 5

## Why this exists

Three consecutive review rounds on PR #1699 each fixed the expiry-path
funding gate, and each fix introduced new defects:

| Round | The gate measured | What was wrong |
| --- | --- | --- |
| r1 | `st.rawSplit.armedFresh` | the raw obligation — nobody remits against the part a cap refused, so a capped entry waits forever |
| r4 | the loan-side-capped split | `_loanSideCapCompute` leaves UNSTAMPED loans untrimmed, and mirror loans are never stamped — so the quantity never changed on the one chain that matters |
| r5 | `_userArmedFreshNeed` | a claim-path aggregate: per-USER not per-entry, chunk-bounded to 30 days, and loan-side capped — producing group-cap bypass, claimant value loss, and an exemption violation (4 findings, 2×P1) |

The individual bugs differ. The **shape** of the mistake does not: at each
round the expiry path re-derived "the D1-capped armed obligation" from
whatever helper was nearest, at a different stage, with a different cap
set. Patching the arithmetic cannot converge, because the arithmetic is
not the defect — **owning a second implementation of settlement is.**

## The root cause

`processUserSideDay` is the pricing primitive. It already computes, for a
`(user, side, day)` group:

- each entry's own allocation under the shared D1 ceiling — allocation
  *within* the group, not the aggregate handed to each member;
- whether that allocation counts against the loan-side payout ledger, as
  an explicit **per-slice flag** (`DaySlice.loanSideChargeable`), which
  forfeits already set false because they recycle rather than pay a side;
- the delivered-fresh bound for the day (`DayCharge.deliveredCapForDay`).

`_persistDay` then writes the consequences: `userSideDayPaidVpfi` (the D1
consumption ledger), the loan-side ledger where chargeable, each entry's
`rewardEntryClaimNextDay` cursor, and `processed` when a window completes.

Every property the four round-6 findings ask for is therefore **already
implemented, once, correctly** — in the path expiry does not use.

## The cut

Expiry stops computing and starts *consuming*. It becomes a **mode of the
settlement path** rather than a parallel implementation: same pricing, same
D1 ledger, same delivered bound, same cursor advance — differing only in
destination (recycle bucket, not claimant) and in the loan-side exemption,
which is already a parameter.

This is the same relationship forfeit settlement has to the walk, and the
`loanSideChargeable` flag exists precisely to express it.

### Expiry is the CLAIM, not just the walk

An earlier revision of this note said "a mode of the day primitive". That
was too narrow, and the implementation proved it: **the primitive owns
ARMED days only.** `processUserSideDay` refuses anything else outright
(`DayCapModeUnsetPostCutover`, deliberately behind the readiness gate), and
`_shareOfPoolCursorDay` never even presents a pre-cutover day — it returns
`startDay` when nothing is armed, and jumps straight to `armedFrom` for a
spanning entry.

So routing ALL of expiry through the primitive handled the armed leg and
dropped the legacy one: 17 suites reverted. The claim already solves this
— `claimInteractionRewardsTo` is an entry-path LEGACY leg *plus* the
ShareOfPool walk — and expiry mirrors that composition. A wholly
pre-cutover entry carries no armed value, so no D1 group, no delivered
bound and no loan-side question arise; it settles whole, as it always did.

**The general lesson**: finding the component that already owns a concept
is right, but its DOMAIN must cover every case the caller has.

## Where the sweep lives (EIP-170, measured)

Sharing the engine costs bytecode wherever the sweep is hosted, and in a
Diamond **reuse and inlining pull in opposite directions**. Measured:

| Host | Sweep cost | Result |
| --- | --- | --- |
| `InteractionRewardsFacet` (engine inlines fresh) | ~12.8 KB | 28,607 / 24,576 — breach |
| `RewardClaimFacet` (engine already present) | ~6.8 KB | 28,800 / 24,576 — breach (only 2,593 B headroom) |
| **`RewardHorizonSweepFacet` (new, sweep alone)** | ~12.8 KB | fits — a full budget to itself |

Hosting beside the engine did halve the marginal cost, as expected; it was
simply not enough against the available headroom. The sweep therefore gets
its own facet — the same remedy already applied twice here (the #1306 lens
split, the #1351 slice-2c claim move).

The 4-byte selector is unchanged throughout, so on-chain callers at the
Diamond address are unaffected. What moves is the compile-time type, the
per-facet ABI json, and the deploy wiring — including
`RefreshAllFacetsInPlace`, which only Replace/Adds the selectors it lists:
omitting the destination facet there would leave the sweep routed at the
PRE-unification implementation while every other reward facet moved
forward.

### What each round-6 finding becomes

| Finding | Resolution under the unified cut |
| --- | --- |
| Group cap applied per-entry instead of allocated (P1) | structural — the primitive allocates within the group and `_persistDay` records consumption, so a sibling sees reduced headroom |
| 30-day chunk treated as the whole entry (P1) | structural — the primitive advances the cursor per day and terminalises only what it priced; a long entry reaps across sweeps with no value loss and bounded gas |
| Expiry inherits the loan-side payout cap | structural — `loanSideChargeable = false`, the existing exemption mechanism, instead of an accident of which helper was called |
| Headroom compared against raw, credit capped | structural — the gate compares what the primitive actually allocated, because there is only one number |

The bespoke expiry delivered-gate is **deleted**, not re-fixed. Expiry
inherits `deliveredCapForDay` from the primitive, so the mirror's
delivered bound applies to expiry through the same code path that applies
it to a claim — one bound, one place.

## Invariants to preserve

- **Commitment retirement stays RAW.** `consumeArmedFresh` must retire the
  cap-truncated remainder too; under-retiring leaks it and permanently
  depresses every later day's availability. "What moved" and "what was
  owed" remain distinct quantities.
- **The expiry exemption is real** (#1371 r2): an expired reward recycles
  to the bucket rather than paying a side, so the loan-side cap must not
  bind it. Expressed via the flag, not by bypassing the primitive.
- **A wait must stay satisfiable.** Any funding gate must key on an amount
  a remittance will actually fund — the capped liability Base's commitment
  report states, per the owner's cap-both-at-D1 decision.
- **All-or-nothing becomes per-priced-chunk ACROSS days, and is PRESERVED
  WITHIN a day.** This is the one deliberate semantic change, and it is
  narrower than it first looks.

  Chunking fixes the across-days case: the cursor advances only over days
  actually settled, so unpriced days keep their value and a long entry
  reaps over several sweeps. That removes the value-loss P1.

  It does NOT fix the within-day case, and the old rule guards it UP TO THE
  REMOVAL POINT. A 69M shortfall deliberately truncates-and-advances, routing
  the remainder to `cappedOff` — commitment retired, no value credited. For a
  CLAIM that is correct: the pool is monotone, so deferring would livelock a
  claimant who is asking to be paid, and the trimmed tail was never drawable.
  For an expiry of a STILL-CLAIMABLE entry it is not: expiry reaps someone
  who never asked, and their claim path stays open, so deferring costs only a
  later sweep.

  **After the removal point the rule INVERTS, and must.** The two guards are
  sequenced, not both applied (Codex r9). Once a chunk has credited, the
  entry is removed and the claim paths skip it — so a deferral can never be
  cleared by the claimant, and the 69M budget it waits on only shrinks. That
  wait is permanent: the tail is stranded, no `RewardEntryExpired` is ever
  emitted, and the commitment never retires. The guard against silent loss
  becomes its cause. So the condition is `charge.freshShortfall != 0 &&
  !e.expiryBegun`: defer before removal, truncate-and-terminate after.

  **This sequencing is documented platform doctrine, not new policy.** The
  canonical FunctionalSpec (`ProjectDetailsREADME.md`, position-sale
  timing) states it generally: *timing gates protect the moment of entry,
  never strand a committed settlement* — a purchase entered before the
  deadline must remain completable however the gates would answer later.
  And `TokenomicsTechSpec.md` (#1351 slice 2d-0) already ratified the
  per-source half for the payment path: a recycled shortfall DEFERS
  because the bucket refills; a fresh shortfall is TERMINAL because the
  69M schedule only shrinks. Rounds 9–10 bring the expiry path into line
  with both — the removal point is the "moment of entry", and everything
  after it is a committed settlement.

  **A removed entry also bypasses the pre-removal gates** (Codex r10). The
  feature switch, claimability, executability and notice gates each ask a
  question about a claimant who still holds a claim; past removal there is no
  such claimant, and answering them with an early return made the terminal
  policy unreachable in precisely the states needing it — an exhausted
  lifetime cap makes `_poolCappedPayable` permanently zero, and a dark
  horizon knob returns at the first line. After removal this path does one
  thing: finish the settlement bookkeeping.

  **Terminal progress must still retire the commitment** (Codex r10). A final
  chunk under exhaustion can move NO tokens while carrying its whole
  remaining obligation in `cappedOff`, so a caller that returns early on
  token totals alone skips `consumeArmedFresh` and leaks that obligation into
  the outstanding sum permanently. Asserting `processed` does not catch this;
  the test asserts the outstanding commitment DECREASES.

  **The same truncation rule is right for a claim and wrong for an expiry.**
  Two tests (`testExpirySweepDefersAtFullFreshExhaustion`,
  `testExpiryIsAllOrNothingAtNearExhaustion`) encode this; they were failed
  by the first cut and were DECIDED on the merits rather than relaxed to
  match new behaviour.

## Pre-merge adversarial review (2026-08-17) — four findings, all interactions

Per the big-PR review discipline, an independent adversarial pass over the
whole diff ran before convergence. Every finding is once again an
interaction between individually-correct pieces:

1. **P1 — the post-removal terminal rule conflated two shortfall causes.**
   The sweep's fresh ceiling is `min(pool-cap room, backing room)`, and any
   trim against it lands in `freshShortfall` — the quantity the removal
   sequencing treats as monotone. Only the pool cap is; backing refills
   with any inflow. A permissionless sweep timed to a momentary balance
   dip therefore PERMANENTLY discarded a removed entry's remainder that
   one block of patience recovered. The claim walk never had this defect —
   it budgets on `poolRemaining()` alone. Fix: the facet passes
   `freshRecoverable` (backing was the binding min), and a removed entry's
   shortfall defers while it is set — the per-source rule (#1351 slice
   2d-0) applied to the third source. Termination now requires the
   monotone cause.

2. **P2 — removal fired on the first chunk that ADVANCED, not the first
   that CREDITED.** A chunk advancing past a day whose D1 ceiling a
   sibling's claim consumed (or a worthless day, or a zero-value legacy
   leg) moved nothing irreversible, yet closed the owner's claim and
   flipped the entry into truncate mode — defeating the r9 defer's purpose
   with zero value moved. The event and storage docs had promised
   "credits" all along; the code now matches them: `_beginExpiry` runs
   only when the chunk moved value.

3. **P2 — the role predicate has two inputs and r9 guarded one.**
   `isMirrorRewardChain` is `!canonical && baseChainId != 0`;
   `setBaseChainId(0)` detached a mirror into the unbounded "neither"
   state with the delivered residual intact, and re-attaching re-offered
   it. The spec (§"retired whenever its role changes") was already right —
   the code diverged. Fix: one shared helper keyed on the EFFECTIVE
   predicate, called by both setters, so a third role input inherits it by
   construction.

4. **P3 — the claim-executable aggregate and the pending preview still
   counted removed entries.** The claim skips them, so the aggregates
   overstated by value no claim can draw — freezing sibling entries'
   expiry clocks behind an unsatisfiable funding need. Both entry-path
   filters now exclude `expiryBegun` (the walk leg already did). The
   mutation pass then MEASURED an asymmetry the finding overstated: the
   aggregate filter is load-bearing (`_entryPriceCore` prices a removed
   entry's remaining window regardless of its cursor), but the preview
   filter is defence-in-depth — a removed entry always has `processed` or
   a stamped cursor, and `_previewEntryLeg` already prices a
   stamped-cursor entry at zero. Its reversion-mutant survives for that
   reason and is recorded proven-equivalent; the filter is kept so both
   sites state the same invariant.

A security-lens pass over the same diff ran in parallel: no surviving
fund-safety findings; its one observability note (a forfeit-terminalized
removed entry emits no terminal `RewardEntryExpired`) is deferred as
issue #1789.

Codex round 11 landed while this pass was underway and independently
found #3 (its P1 — same defect, same remedy), plus one new P2 the
internal pass missed: `rewardEntryExpiry` cleared the countdown only at
`processed`, so a removed entry mid-chunks kept showing a claimant-facing
deadline for the whole life of a deferred tail. Removal is now terminal
for the countdown too — past the removal point what remains is
settlement progress, signalled by `RewardEntryExpiryBegun`, never a
claimant deadline.

Round 13 (auto-fired on the merge-from-main push, after round 12 came
back clean) added one final P2 in the same constraint-attribution family
as the internal pass's P1: the delivered-funding dry run hardcoded
`fresh: type(uint256).max` while binding the live delivered allowance,
and `_attributeLegs` decides which constraint binds by COMPARING them.
Near 69M exhaustion the live claim truncates at the cap and pays the
headroom, but the dry run attributed the same trim to DELIVERED and
deferred — a zero preview for a claim that succeeds, and an armed-need
figure demanding delivered allowance for value the schedule will never
owe, freezing the expiry clock forever. The dry run now binds
`fresh: poolRemaining()` — which is what the spec always said the bar
was ("the fresh share truncated to the 69M pool cap"). The general
lesson joins the earlier one: two bounds threaded into one settlement
must be modelled together EVERYWHERE the settlement is simulated,
because each bound's correctness depends on the other's presence.

Round 14 completed that lesson with the two halves r13's fix still
missed, both P2: **a bound is a budget, and a budget both DEPLETES and
has PREDECESSORS.** (a) The dry run bound fresh at batch start but never
decremented it between days — two d-valued days against 1.5d of headroom
dry-ran as 2d while the live walk pays d then terminally truncates the
second day (`ctx.pool.fresh -= freshSpent` was half the walk the dry run
hadn't mirrored). (b) The live claim threads `poolRemaining() −
windowReward − legacyFreshReserved` into the walk; the dry run started
from the full figure, so the armed-need could demand delivered allowance
for headroom the earlier legs consume — pausing the expiry clock after
Base has remitted the capped liability in full. The fix makes the walk's
fresh budget ONE definition (`_userWalkFreshBudget`: pool headroom minus
window minus legacy legs) supplied to the dry run as a REQUIRED
parameter — the same computed-once-and-threaded rule the claim facet
states for its own three legs — and the dry-run day loop now depletes
fresh exactly as it already depleted recycled and delivered.

Round 15 added the final quarter-turn, P2: **a predecessor leg reserves
by SPEND, not by DESTINATION.** The live claim's `legacyFreshReserved`
is `(toUser − recycled) + (toTreasury − recycled)` — a forfeited entry's
legacy slice spends the same 69M pool on its way to the treasury
channel — but the r14 reservation reused the user-facing preview loop,
which rightly excludes forfeited entries from what the CLAIMANT sees.
The legacy-legs helper now returns the two destinations separately: the
displayed preview shows the user half alone, and the walk's reservation
sums both.

Round 16 sharpened that reservation to the LEGACY component only
(`total − recycled − armedFresh`), P2: a forfeited entry whose loan is
terminal still passes the worklist's claimable gate, so its ARMED days
are priced by the walk itself — on both the live and simulated sides —
and reserving the whole remaining split counted them twice. Notably the
error direction FLIPPED: rounds 14–15 fixed overstatement (frozen
clocks); the r15 fix overshot into understatement, which is the
dangerous direction — an expiry clock accruing while the live claim
still defers on delivered allowance. A reservation must equal what the
predecessor leg actually spends: no less, and no more.

Round 17 (on the merged tree) found the family's LAST members on two
OTHER paths, P1 + P2. The P1 is the forfeit-path twin of the whole
r13–r16 arc: the forfeit sweep's delivered gate demanded the RAW armed
figure while Base's commitment report funds only `min(rawPay, cap)` per
day — allowance no remittance will ever deliver, so a D1-capped
forfeited entry (and its commitment) wedged permanently. The sweep now
measures the capped liability (`_forfeitArmedCapped`, mirroring the
report's form exactly): the capped figure gates, credits and charges;
the cap-trimmed excess is written off precisely as Base wrote it off at
report time; and the RAW commitment still retires — the same
owed-vs-moved split every terminal path keeps. The P2: the
executability probe (two whole-worklist dry runs) ran even where its
answer gates nothing — post-removal and, for the delivered half,
off-mirror — a gas-DoS surface that could strand a removed entry's
settlement; both probes now run lazily, pre-removal only, delivered
mirror-only, exactly as the countdown view already scoped them.

A process note recorded here deliberately: the session-scratchpad
mutation harness was lost to a power outage mid-round-17. It is rebuilt
INTO THE REPO at `script/mutation/p1b_mutants.py` (19 exact
fix-reversion mutants + the proven-equivalent pair with evidence); the
earliest rounds' mutants — kills recorded per-round on PR #1699 — are
re-derived in a follow-up rather than reconstructed from memory.

Round 18 (2×P1, 2×P2) closed the loop the design opened: **the forfeit
armed leg was the last path still owning its own settlement**, and r17's
hand-rolled capped scan walked straight into the catalogued rounds-1–5
anti-pattern — it mis-attributed the split (the `cumMinArmed*` series is
the COMBINED armed reward, so capping it and calling the result "fresh"
demanded delivered allowance for recycled value no remittance funds) and
scanned every remaining day unbounded. The remedy is the r6 remedy:
forfeited entries' armed days now settle through `processUserSideDay` +
`_persistDay` in per-day chunks with a persistent cursor — D1-capped,
split-attributed, delivered-bounded, gas-bounded — while the pre-cutover
legs keep their O(1) settles. Two semantic consequences, both stated
deliberately: a DELIVERED shortfall now defers per day (partial progress
persists; r2's whole-sweep revert is retired with its guarantee intact,
enforced per day), and the unconditional pool-exhaustion revert is gone
(a zero-liability forfeit must still retire at exhaustion — the r18 P2).
The refresh script's migration block now gates on the on-chain
`armedFreshPaidSeeded` flag (new one-view getter) so a routine rerun of
an already-seeded Diamond no longer wedges paused demanding obsolete
inputs — the earlier "the one-shot revert IS the signal" position
required reaching the seed call at all, and the input require sat in
front of it.

With this, every settlement consumer — claim, expiry, forfeit — prices
through the one engine. That is the design's end state.

## Testing

The expiry fixture is unusually easy to make vacuous: **five distinct
preconditions each defer the entry and each credit zero** — unstamped
mirror day, exhausted 69M headroom, a clock that never accrued (expiry
executability itself consults the delivered bound), the delivered
shortfall, and the D1 trim. Only the last two are properties under test.
Every expiry test therefore carries a liveness control per precondition,
and is proven by reverting the fix and confirming it fails at the
*intended* assertion rather than an incidental one.

A sixth way in, found by the mutation pass itself: the post-removal
terminal fixture must use a **fresh-only** armed day. A recycled share
moves regardless of the 69M pool, so with any recycled component a
"fully exhausted" terminal chunk still moves tokens and still reads
claim-executable — the removed-entry gate bypass and the capped-only
commitment retirement are then both dead code under the test, which
passes against their reversions. Both r10 mutants survived a
recycled-carrying version of the fixture for exactly this reason; the
test now stamps a zero recycled credit, asserts it (`recycled5 == 0`),
and asserts the terminal sweep returns zero tokens moved.
