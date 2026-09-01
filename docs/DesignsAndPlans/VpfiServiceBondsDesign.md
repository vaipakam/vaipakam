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
OffenceRecorded(operator, role, kind, refId)   // role, not just operator
// v1: `state` is Active only and `unlockAt` is unused — both exist for the
// liveness tier's delayed unbond, which v1 does not have (rev 4).
```

| Role | What the bond unlocks | Slash conditions (objective) |
| --- | --- | --- |
| Solver / matcher | larger match-batch sizes; priority-window access (E-2 perk interplay: bond = capacity, spend = priority) | precondition lies recorded via the offence dispatcher below (a submission contradicted by state it itself carries or creates — NOT staleness, which left v1's predicates: see the offence-recording bullet); **immediate** debit of a fixed bps of the OFFENDING ROLE's bond, per recorded offence — the threshold is one; see the decisions below |
| Keeper (opt-in roles) | higher per-pass action counts for granted `KEEPER_ACTION_*` roles | repeated out-of-grant-scope attempts recorded via the offence dispatcher; missing committed liveness windows IF the operator enrolled in a liveness commitment (optional tier) |

- **Offence recording (Codex round-1 finding):** a slashable failure must
  not be a plain revert — a reverted tx leaves no state to slash against.
  Bonded-operator entry points therefore run precondition checks in a
  non-reverting outer dispatcher: on a precondition lie (e.g. a submission whose
  own arguments or effects contradict a precondition it asserted — NOT a
  stale-listing fill, which left v1's predicates; see below), the call
  **succeeds as a no-op**, records `OffenceRecorded(operator, role, kind,
  refId)`, and debits that `(role, address)` bond IMMEDIATELY — the threshold
  is one (see the decisions below). The counter is keyed by role too, and
  survives only as a lifetime tally for observability; nothing reads it to
  decide a slash. An earlier revision of this bullet described a
  per-OPERATOR counter driving a deferred threshold slash, which left an
  implementation with no role to select the bond from and no reason to debit
  on the spot. **Honest failures are excluded by a SUBMITTED-AGAINST
  SNAPSHOT, not by a same-block rule.** An earlier revision exempted only
  same-block changes and required the predicate to reference state committed
  before the operator's submission. That does not hold: a transaction can sit
  pending while the disqualifying state commits in an EARLIER block than its
  execution, so at execution the predicate sees state that preceded the call
  even though the operator could not have known it when signing. Ordinary
  congestion or builder ordering would then turn an honest fill into a
  recorded offence and slash a good bond — the worst failure this design can
  have, because it punishes the operators it exists to attract.

  A caller-supplied snapshot does NOT fix this, and that was the previous
  attempt: if the submission carries the state version it claims to have
  validated against, a dishonest operator simply attaches a version from
  immediately before the mutation it already knows about. Nothing
  authenticates when a snapshot was observed, so every staleness slash
  becomes evadable while honest congested calls stay exposed to whatever the
  rule does not exempt.

  **So STALENESS LEAVES the v1 slash predicates entirely** — it fails v1's
  own bar rather than needing a better mechanism. v1 is *objective lies
  only*: a fact the chain can check without judging what the operator knew.
  A stale fill is only a lie if the operator KNEW the listing was stale, and
  knowing is exactly what the chain cannot see — not through timing, which
  builders control, and not through a self-declared snapshot, which the liar
  picks. Both attempts failed in opposite directions, and that is the
  signature of a predicate that is not objective.

  What remains slashable in v1 is what needs no such inference: a submission
  contradicted by state the submission ITSELF carries or creates — a fill
  against a listing the same transaction proves already consumed, a claimed
  precondition the call's own arguments disprove. Staleness returns with the
  liveness tier, where an attested observation window exists to make "knew"
  adjudicable; the alternative — a protocol-issued, expiry-bounded snapshot
  commitment — is a real mechanism, and it belongs with that tier rather
  than bolted onto v1.
- Bond sizes: governance-bounded config. **NOT unlock tiers** — capacity
  rises CONTINUOUSLY with the bond and nothing is unlocked at a threshold.
  This bullet said "unlock tiers" until rev 7, and an implementation
  following it would assign no incremental capacity below a tier boundary,
  reintroducing both a threshold and the implicit minimum the continuous
  curve exists to remove.
- **Unbond delay** — NOT in v1 (rev 4). It exists to stop a slash-and-run
  inside a misbehaviour window, and v1 has no such window: every offence is
  debited in the same call that records it. The delay, and the privilege
  revocation and `unlockAt` snapshot that make it sound, arrive with the
  liveness tier.
- Slashed VPFI → treasury **recycle bucket** through the programme's single
  chokepoint, `LibVpfiRecycle.credit(RecycleSource.ServiceBondSlash, …)`.
  That enum member is ALREADY reserved and must be used rather than a new
  generic one — appending a duplicate would split service-bond absorption
  from the metrics class reserved for it. (This bullet said
  `VpfiRecycled(SLASH,...)`; there is no such source.)
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
2. **Unbond delay: RATIFIED — v1 has NONE.** Rev 4 removed it rather than
   sizing it, because v1 has no evidence arriving after an operator stops
   acting; the reasoning is below. Immediate withdrawal and the
   clamp-on-decrease were decided together and are both invariants, not
   recommendations. A delay arrives with the liveness tier.
   **Bond sizes** remain a proposal (see the two open numbers at the end).
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

**1. The debit formula — every recorded offence debits, immediately, against the OFFENDING ROLE's bond.**

Rev 1 said "slash at a counter threshold" AND "10% per offence, ten offences
to zero", which are not the same rule: for any threshold above one it is
undefined whether the earlier offences debit, whether crossing the threshold
takes 10% once or the accumulated total, and what the counter does afterwards.

**The threshold is ONE.** Each `OffenceRecorded` immediately debits
`slashBps` of the CURRENT balance of the `(role, address)` bond whose entry
point recorded the offence, into the recycle bucket.

**Keyed by role, not by address.** One address may hold solver, matcher and
keeper bonds at once, and an offence recorded through a matcher entry point
must debit the matcher bond — not another role's, and not all of them. The
offence record and its counter therefore carry the role alongside the
operator, or the same event admits three materially different losses. That is the
whole rule:

- Geometric, not linear — 10% of what remains, so the bond falls away rather
  than hitting zero at a fixed count. "Ten offences to zero" in rev 1 was
  wrong arithmetic as well as an ambiguous rule.
- **Rounding is UP, with a minimum debit of one unit**, and a balance below
  that minimum is consumed entirely. Integer arithmetic does not asymptote:
  `balance * 1_000 / 10_000` is ZERO once the balance drops under ten units,
  leaving a permanently unslashable positive bond that still buys capacity.
  An earlier revision described the asymptote as a feature; in Solidity it is
  a floor at which slashing silently stops.
- **The decay question dissolves.** Rev 1 asked whether the offence counter
  should decay, to stop a long-lived honest operator accumulating sparse
  offences into a slash. With immediate debit there is no accumulator to
  decay: each offence is priced once, at the time, against a bond that is
  already smaller for every previous one. The counter survives only as a
  lifetime tally for observability, and nothing reads it.
- Governance-bounded: `slashBps` default **1,000** (10%), **floor 100**
  (1%) — restored in rev 7 after rev 6's restructure dropped it. A zero
  leaves bonds granting elevated capacity while every proven offence debits
  nothing, which is a performance bond in name only and worse than none,
  because capacity is still being handed out on the strength of it. Ceiling
  **2,500**
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
below), withdraw — **with the decrease clamping any accrued credit in the
same step.** That clamp is load-bearing here rather than incidental: without
it, immediate withdrawal hands back the capital while leaving the accrued
capacity spendable, which is the slash-and-run this section argued v1 does
not need a delay to prevent.

The delay is specified as arriving **with the liveness tier**, because that
tier is what creates delayed evidence — and the rules revs 1–3 worked out are
kept here for it rather than discarded: privileges revoke at the request (or
the window does not cover actions taken inside it), and `unlockAt` is
snapshot at the request (or a retune moves a pending withdrawal in both
directions). Those were right answers to a question v1 does not ask yet.

This is the third revision in which a parameter was added to make a previous
parameter safe. That is the signal to stop extending and check whether the
mechanism is needed at all — it was not.

**3. Capacity — the DECISION, and why the mechanism is not specified here.**

**The decision, which is what this note is for:** a bond buys capacity
*continuously and proportionally*, with **no minimum bond**, up to a ceiling
of **4× the free tier** per address.

**And any reduction in CAPACITY — a bond withdrawal, a slash, or a
governance retune that lowers the curve, `bondAt4x` or the free tier — must
reconcile outstanding limiter credit down to the new capacity before that
bucket's next admission.**

Bond-decrease-only is not sufficient, and the gap is easy to miss: raising
`bondAt4x` leaves every bond BALANCE untouched while buying less capacity,
so an unvisited bucket keeps credit above the new ceiling indefinitely.
Config changes cannot walk every bucket, so the reconciliation is lazy and
versioned — the config carries an epoch, and a bucket whose epoch is stale
is clamped on its next touch, before admission. This is a decision, not an
implementation detail, because without it the bond is bypassable: an
operator accrues elevated credit, withdraws the bond, and still spends
bonded capacity with nothing left to slash. It is also what makes v1's
immediate withdrawal safe — the two were decided together, and separating
them re-opens exactly the slash-and-run the delay was originally proposed to
close. "Capacity follows the bond continuously" is not sufficient on its own
and was the wording that hid this. Any bond, including none, is valid; a
larger bond buys proportionally more throughput; nothing is unlocked by
crossing a threshold. That is the shape the owner is being asked to ratify.

**The limiter's FORM is deliberately left to implementation**, and rev 6
removes the specification revs 2–5 accumulated. That is a change of position,
so here is the reasoning.

Four revisions specified a limiter, and each one's parameters created the
next round's findings: a fixed epoch needed initial-credit semantics; a leaky
bucket needed a refill floor; initialising buckets full created a
bond-recycling vector (deposit, take a full bucket, spend, withdraw, repeat
on a fresh address); making a zero window mean "dark" raised whether
withdrawals survive darkness; specifying `refillWindow`'s zero left
`bondAt4x`'s zero dividing by itself. Every one of those findings is
correct. None of them is a decision the owner needs to make, and none can be
settled well in prose without the code, the tests, and a call-site inventory
of what an "action" costs in each role.

Specifying it here had a cost beyond wasted rounds: it repeatedly asserted
guarantees the mechanism did not deliver. A one-budget rolling ceiling was
claimed for the epoch, then for the bucket; neither has it. Writing a
limiter's *envelope* honestly is exactly the thing that needs the
implementation in front of you.

**What implementation must settle** — the output of those rounds, kept as a
checklist rather than as a design:

1. The bond→capacity curve's arithmetic: precision, rounding direction, and
   the amount that reaches 4×. Rounding must not create an implicit minimum.
2. The limiter's envelope, stated as what it actually admits over a rolling
   window rather than as a round number.
3. Fresh-storage and zero semantics for **every** divisor and knob, and
   whether a role is dark until all of them are set. `bondAt4x` and the
   refill parameter both divide.
4. What "dark" preserves: withdrawals must stay callable and the free tier
   must keep working, or disabling the feature strands escrowed VPFI and
   breaks the permissionless baseline.
5. Initial capacity for an unseen `(role, address)`, chosen so a bond cannot
   be recycled through fresh addresses to mint repeated full-capacity bursts
   — the aggregate cost claim in §4 depends on this.
6. Cost units per role — per fill, per action, per admission — with only
   executed items charged, so batching cannot walk through the limit.

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
  idle. That is a cost curve, not a bound. **It holds only if a fresh
  address cannot be handed a full capacity balance on first touch**: with
  immediate withdrawal and a full initial bucket, one `bondAt4x` can be
  walked through fresh addresses to mint repeated bursts, and the claim
  collapses to the cost of one bond. That is item 5 of the implementation
  checklist above, and this claim depends on it being settled correctly.
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
2. ~~Whether the permissionless roles keep a per-address ceiling at all.~~
   **RATIFIED: the 4× per-address ceiling stands.** This was listed as an
   open choice while the ceiling's meaning was still being argued; leaving
   it open in a note that is about to merge would leave an implementation
   unable to tell whether 4× is a required invariant or a suggestion. It is
   an invariant. What was withdrawn is the CLAIM that it bounds an operator
   — it bounds an address, and the aggregate story is the linear cost curve
   in §4.
3. Whether v1 ships at all without the liveness tier. Rev 4 removed the
   unbond delay because v1 has no delayed evidence — which is correct, and
   also worth looking at squarely: a bond that can be withdrawn the instant
   before an offence would have been recorded still deters, because the
   offence is debited in the same call it is detected in and there is no
   window to escape through. But it deters only what the dispatcher can see
   in-call. If the owner wants deterrence against slower-to-prove
   misbehaviour, that IS the liveness tier, and it should be scoped together
   with the delay rather than approximated by one.

## Tests

Rev 6's restructure deleted this section along with the limiter it was
retiring. That was a regression: the cases below are acceptance criteria for
the bond's SAFETY, not for the limiter's shape, and they survive whatever
form the limiter takes.

**Fund accounting and lifecycle — restored, and the reason they matter is
that everything else is throughput and these are custody:**

- Bond / unbond lifecycle, including that v1 withdrawal is IMMEDIATE and that
  the withdrawal clamps accrued credit in the same step. A test that
  withdraws and then spends is the one that catches the bypass.
- Escrow accounting invariant: bonds are a fourth tracked balance class
  alongside user LIF custody, unclaimed budgets and the recycle bucket, and
  the Diamond-balance invariant must cover it (#892 / L13).
- Slash → recycle: the debit credits
  `LibVpfiRecycle.credit(RecycleSource.ServiceBondSlash, …)` through the
  chokepoint, with the event carrying that source and not a new generic one.
- Each objective slash predicate proven on-chain-verifiable, and proven to
  fire on committed state rather than a revert — an offence that reverts
  leaves nothing to slash.
- **An honest operator is NOT slashed when the state moved between broadcast
  and execution** while their submitted-against snapshot was still valid.
  Test it with the disqualifying write landing in an EARLIER block than the
  operator's call — that is precisely the case a same-block exemption misses.
- **Dust slashing**: a balance too small for `slashBps` to round to a
  non-zero debit is consumed, never left permanently unslashable.
- Free-tier operation at ZERO bond, for every role. This is the
  permissionless baseline the whole design is built to preserve, and it is
  the case a capacity bug silently breaks.
- Dark mode preserves withdrawals and the free tier: disabling the feature
  must not strand escrowed VPFI or block unbonded operation.

**Limiter shape** — deferred with the mechanism, per §3's checklist, but its
acceptance criteria are: no implicit minimum (a small bond eventually affords
an action), the stated envelope holds over a rolling window, and a capacity
reduction of any cause clamps before the next admission.
