# VPFI service bonds — work-token sink (S-4 / R-3)

**Status:** design note for **legal glance → decision → build**. Card:
#1219. Umbrella: #1221. Legal frame: #694. Part of the VPFI circular-flow
programme ([`VpfiCrossChainRecyclingDesign.md`](VpfiCrossChainRecyclingDesign.md)).

## Objective

A temporal + permanent VPFI sink shaped as a **performance bond**, never a
return: service operators (solvers, matchers, keepers) post VPFI deposits
to access higher operational limits; misbehaviour slashes the bond into
the recycle loop.

## Shape rules (the legal spine)

1. **No yield, ever.** Bonds earn nothing — not interest, not rewards, not
   fee shares. Posting a bond buys operational capacity, full stop.
2. **Refundable at will** — a deposit, not a purchase. v1 has no unwind
   delay, because v1 has no evidence that arrives after an operator stops
   acting; a delay arrives with the liveness tier that creates one (rev 4).
3. **Slashing is rule-bound and evidence-anchored**, never discretionary
   value capture: each slash condition is an objectively verifiable
   on-chain fact — and the evidence must be **committed state, not a
   revert** (a reverted transaction leaves nothing to adjudicate; see
   "offence recording" below).
4. Marketing describes bonds as "operational security deposits" —
   never staking, never earning.

## Mechanics

```
ServiceBond { operator; role; amount; state; unlockAt; }
// v1: `state` is Active only and `unlockAt` is unused — both exist for the
// liveness tier's delayed unbond, which v1 does not have (rev 4).
```

| Role | What the bond unlocks | Slash conditions (objective) |
| --- | --- | --- |
| Solver / matcher | larger match-batch sizes; priority-window access (E-2 perk interplay: bond = capacity, spend = priority) | precondition lies recorded via the offence dispatcher below (e.g. repeated fills against listings already committed as stale on-chain); slash at counter threshold, per-offence fixed bps of bond |
| Keeper (opt-in roles) | higher per-pass action counts for granted `KEEPER_ACTION_*` roles | repeated out-of-grant-scope attempts recorded via the offence dispatcher; missing committed liveness windows IF the operator enrolled in a liveness commitment (optional tier) |

- **Offence recording (Codex round-1 finding):** a slashable failure must
  not be a plain revert — a reverted tx leaves no state to slash against.
  Bonded-operator entry points therefore run precondition checks in a
  non-reverting outer dispatcher: on a precondition lie (e.g. submitting a
  fill against a listing already committed as stale on-chain), the call
  **succeeds as a no-op**, records `OffenceRecorded(operator, kind,
  refId)` with a per-operator counter, and only the counter — committed
  state — drives slashing at threshold. Honest failures that the operator
  could not have known (state changed in the same block) are not offences;
  the offence predicate must reference state committed *before* the
  operator's submission.
- Bond sizes + unlock tiers: governance-bounded config.
- **Unbond delay** — NOT in v1 (rev 4). It exists to stop a slash-and-run
  inside a misbehaviour window, and v1 has no such window: every offence is
  debited in the same call that records it. The delay, and the privilege
  revocation and `unlockAt` snapshot that make it sound, arrive with the
  liveness tier.
- Slashed VPFI → treasury **recycle bucket** (`VpfiRecycled(SLASH,...)`),
  joining the netting loop; never burned, never redistributed to a
  "reporter" (bounty-shaped payouts reintroduce the promotional-
  distribution pattern #694 flags — slashing benefits the program, not an
  informant).
- Escrow separation: bonds are a fourth tracked balance class alongside
  user LIF custody, unclaimed budgets, and the recycle bucket; the
  Diamond-balance invariant extends to cover it (the #892/L13 commingling
  discipline).
- Permissionless baseline preserved: **no role requires a bond** — bonds
  raise limits above the free tier; they must never become an entry
  barrier (that would gate permissionless matching/keeping, contradicting
  the §5a competitive-matching intent).

## What was considered and rejected

- **Bond yield / fee-share to bonded operators** — the staking-as-a-service
  shape; rejected outright.
- **Slash bounties to reporters** — promotional-distribution risk;
  rejected. Detection is protocol-verifiable, needing no informant market.
- **Mandatory bonds for all matchers** — breaks permissionlessness;
  rejected.

## Decisions (owner, 2026-08-31)

1. **Slash conditions v1 = OBJECTIVE LIES ONLY.** Ratified. The liveness
   tier is a later opt-in and is out of v1 scope — so v1 ships no clock-based
   slash, and an operator who simply goes quiet is never slashed. That keeps
   every v1 slash anchored to a fact the chain can check without a timing
   judgement, which is also what keeps the offence dispatcher below tractable.
2. **Bond sizes + unbond delay** — proposal below, awaiting ratification.
   Rev 4 REMOVES the delay from v1 rather than sizing it; see below for why
   that is the answer to the question rather than a gap in it.
3. **No-yield refundable-deposit shape: RATIFIED.** The legal glance is
   discharged. Bonds earn nothing, are refundable at will subject to the
   any unbond delay in force, and are described as operational security
   deposits — never
   staking, never earning.

### Proposed: bond sizes and capacity (rev 4)

This section has been through four revisions, and the shape of that history
is itself the finding: revs 1-3 each added a parameter to make the previous
parameter safe. Rev 4 stops extending and removes two mechanisms v1 does not
need — the unbond delay, and the fixed epoch — which answers five review
findings by deletion rather than by specification.

**1. The debit formula — every recorded offence debits, immediately.**

Rev 1 said "slash at a counter threshold" AND "10% per offence, ten offences
to zero", which are not the same rule: for any threshold above one it is
undefined whether the earlier offences debit, whether crossing the threshold
takes 10% once or the accumulated total, and what the counter does afterwards.

**The threshold is ONE.** Each `OffenceRecorded` immediately debits
`slashBps` of the bond's CURRENT balance into the recycle bucket. That is the
whole rule:

- Geometric, not linear — 10% of what remains, so the bond asymptotes toward
  zero rather than hitting it at a fixed count. "Ten offences to zero" in rev
  1 was wrong arithmetic as well as an ambiguous rule.
- **The decay question dissolves.** Rev 1 asked whether the offence counter
  should decay, to stop a long-lived honest operator accumulating sparse
  offences into a slash. With immediate debit there is no accumulator to
  decay: each offence is priced once, at the time, against a bond that is
  already smaller for every previous one. The counter survives only as a
  lifetime tally for observability, and nothing reads it.
- Governance-bounded: `slashBps` default **1,000** (10%), ceiling **2,500**
  (25%), following the `MAX_*_BPS` convention in `ConfigFacet`.

**2. v1 HAS NO UNBOND DELAY — and that is the honest answer, not a gap.**

Revs 1–3 specified a delay, then privilege revocation to make the delay
mean something, then an `unlockAt` snapshot to stop retunes moving it. Review
then asked the question that dissolves all three: **what pending evidence is
the delay waiting for?**

In ratified v1 scope, nothing. Every offence is an objective lie, detected by
the outer dispatcher and debited **in the same successful call**. The liveness
tier — the only source of evidence that arrives *after* an operator stops
acting — is explicitly out of v1. So there is no adjudication in flight when
an operator unbonds, and a 3–30 day lock protects nothing. It is a pure
lockup, and it sits badly beside a shape whose legal spine is
"refundable at will".

**So v1 unbonds immediately.** Bond, capacity, and the whole withdrawal
machinery collapse to: reduce the bond, capacity follows continuously (see
below), withdraw.

The delay is specified as arriving **with the liveness tier**, because that
tier is what creates delayed evidence — and the rules revs 1–3 worked out are
kept here for it rather than discarded: privileges revoke at the request (or
the window does not cover actions taken inside it), and `unlockAt` is
snapshot at the request (or a retune moves a pending withdrawal in both
directions). Those were right answers to a question v1 does not ask yet.

This is the third revision in which a parameter was added to make a previous
parameter safe. That is the signal to stop extending and check whether the
mechanism is needed at all — it was not.

**3. Capacity is a LEAKY BUCKET, which is what actually delivers the claims.**

Rev 3's fixed epoch was wrong in two ways review caught, and one mechanism
fixes both plus a third:

- **Boundary bursts.** An address spending its whole allocation just before a
  boundary and again just after consumes two full budgets back-to-back, so
  "a ceiling over every window" was false — it was a ceiling per *epoch*, and
  the rolling worst case was double.
- **A resurrected implicit minimum.** Discarding unused credit plus rounding
  down means sub-action credit can never accumulate, so every bond below a
  calculable threshold buys literally nothing — exactly the implicit minimum
  the continuous-credit model was introduced to remove. Rev 3 reintroduced
  it while claiming to have solved it.
- **Retune ambiguity.** Changing the epoch length mid-epoch either flips the
  derived epoch id and grants everyone a fresh budget, or defers — materially
  different throughput, and a one-time quota duplication.

The bucket:

```
capacity   = freeTierBudget × multiplier        // the SAME continuous multiplier
refillRate = capacity / refillWindow            // governance-set window, default 1h
credit(t)  = min(capacity, credit(t₀) + refillRate × (t − t₀))
```

An action is admitted iff `credit >= cost`, and debits `cost`. Keyed
`(role, address)`, as before.

Why this answers all three: the maximum burst is ONE capacity rather than two,
because credit is capped at `capacity` and never granted in a lump — which is
the guarantee rev 3 claimed and did not have. Sub-action credit accumulates
continuously, so a small bond simply takes proportionally longer to afford an
action and is never useless — no implicit minimum, this time actually. And
there is no boundary to retune across: changing `refillWindow` changes the
rate from that moment, with no epoch id to flip and no budget to re-grant.

Rev 3 rejected a bucket because "a bucket lets an operator idle and then
burst". That is true of a bucket whose capacity exceeds its window's budget;
it is not true here, because capacity IS the window's budget. The objection
was to an unbounded bucket, and the fix was to bound it — not to abandon the
shape.

**4. The 4× ceiling bounds an ADDRESS, not an operator — stated as such.**

Rev 1 claimed the ceiling stops bonds becoming de-facto exclusivity. It does
not, and the claim is withdrawn. Solver and matcher entry points are
permissionless, so one controller splits its bond across two addresses for 8×
aggregate, and across `N` for `4N×`. The ceiling is not a Sybil bound and
nothing here makes it one.

What is actually true, and all that is claimed:

- **Per address**, capacity is bounded at 4× the free tier.
- **In aggregate**, dominance costs capital LINEARLY — `N` addresses at the
  ceiling require `N × bondAt4x` bonded, all of it slashable and all of it
  idle. That is a cost curve, not a bound.
- **Even where roles are GRANTED, the bound is still PER ADDRESS.** Rev 2
  claimed the keeper `KEEPER_ACTION_*` tiers could aggregate capacity under
  the granted principal. Checked against the wiring, that does not hold
  either (rev 3): `LibVaipakam.Storage.approvedKeeperActions` is keyed
  `[principal][keeper]` and `LibAuth.requireKeeperFor` authenticates
  `msg.sender`, so the protocol learns **no identity shared by several
  grantee addresses**. A controller takes the same grant on `N` addresses and
  gets `N` separate caps.

  Keying capacity to the granting PRINCIPAL instead is worse, not better: a
  principal's approved keepers are typically unrelated parties, so they would
  consume one another's quota and one keeper could starve the rest.

  So the honest statement is the same in both cases — **a per-granted-address
  bound**. A genuine per-operator bound needs an operator identity mechanism
  that does not exist here, and inventing one is out of scope for this note.
  This is the second revision in a row where a per-operator claim did not
  survive contact with the wiring; it should not be made a third time without
  that mechanism landing first.

**Bond sizes: still no minimum.** A VPFI-denominated floor is a price-varying
entry cost, and the design forbids bonds becoming an entry barrier. The
continuous credit above is what makes "no minimum" implementable rather than
merely stated.

**Open for the owner**, and these are genuine choices rather than gaps:

1. `bondAt4x` and `refillWindow` per role — the two numbers that set how much
   capacity a bond buys and how fast it comes back.
2. Whether the permissionless roles keep a per-address ceiling at all, now
   that it is understood not to bound an operator. The alternative is no
   ceiling plus the linear cost curve, which is honest about what the
   mechanism does and removes a number that could be mistaken for a
   guarantee.
3. Whether v1 ships at all without the liveness tier. Rev 4 removed the
   unbond delay because v1 has no delayed evidence — which is correct, and
   also worth looking at squarely: a bond that can be withdrawn the instant
   before an offence would have been recorded still deters, because the
   offence is debited in the same call it is detected in and there is no
   window to escape through. But it deters only what the dispatcher can see
   in-call. If the owner wants deterrence against slower-to-prove
   misbehaviour, that IS the liveness tier, and it should be scoped together
   with the delay rather than approximated by one.
