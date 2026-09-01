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
2. **Refundable at will** (subject to an unwind delay, below) — a deposit,
   not a purchase.
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
- **Unbond delay** (e.g. 7 days) so an operator can't slash-and-run
  within one misbehaviour window.
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
3. **No-yield refundable-deposit shape: RATIFIED.** The legal glance is
   discharged. Bonds earn nothing, are refundable at will subject to the
   unbond delay, and are described as operational security deposits — never
   staking, never earning.

### Proposed: bond sizes and unbond delay (rev 2)

Rev 1 of this section was reviewed and found underspecified in five places —
each of them a spot where two implementers would have built different things.
Rev 2 answers all five. Nothing here is a new pattern; both knobs follow
conventions the repository already uses.

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

**2. Bonded privileges stop when unbonding STARTS.**

Otherwise the delay does not do what rev 1 claimed. An operator could request
unbonding, keep its elevated limits, use them for slashable actions near the
end of the window, and withdraw before the evidence for those actions was
recorded — a delay measured from the request does not cover actions taken
during it.

So a bond enters `Unbonding` at the request, and capacity drops to the FREE
TIER at that instant. The delay then protects only the adjudication of
actions already taken, which is a claim it can actually keep. The alternative
— restarting the delay from the last privileged action — was considered and
rejected: it lets an operator hold a refund hostage to its own activity and
makes the unlock time unpredictable for an honest one.

**3. The unbond delay is SNAPSHOT at request time.**

The delay is governance-mutable, and the bond record in rev 1 stored only
`unbondRequestedAt`. A pending withdrawal would then float on the live knob:
lowering 30 days to 3 would make every request older than 3 days instantly
withdrawable, bypassing the exact window a role chose because its offences
take that long to adjudicate; raising it would retroactively extend a refund
already requested.

The record therefore stores **`unlockAt`**, computed once from the delay in
force at the request. A retune governs only later requests. (The reward
horizon precedent handles the same problem with a configuration epoch and
fresh notice on every retune; snapshotting is the simpler form of the same
guarantee, and it needs no notice pipeline because the operator already knows
their own unlock time.)

Values, as a bounded knob with a floor: **7 days** default, **3-day floor**,
**30-day ceiling**.

**Rev 1 said "dark until set" AND "7 days default", which are incompatible**
(rev 3). This repository uses a stored zero to mean feature-disabled wherever
it calls a knob dark — the reward horizon does exactly that — while "default"
normally means an unset zero resolves to the named value. One implementer
would accept a bond with no usable withdrawal clock and strand it until
governance configured the delay; another would activate seven-day unbonding
with no configuration at all.

**The resolution: zero disables the BOND FEATURE, and deposits are rejected.**
`bondDelaySeconds == 0` ⇒ `postBond` reverts. Not "resolves to seven days",
because a refundability guarantee that switches itself on before anyone chose
its length is the kind of default that gets discovered during an incident; and
not "accept and strand", because taking a deposit you cannot promise to return
is the worst of the three. The 7 days is the value governance is expected to
SET at arming, not one that applies in its absence — so the whole bond
surface, like the perk channel, ships dark and is armed deliberately. The floor is the load-bearing half —
without one the delay can be tuned to nothing, which is the slash-and-run
configuration it exists to prevent. The ceiling matters because bonds are
characterised as refundable at will, and a delay long enough to read as a
lockup argues against that characterisation.

**4. Capacity is a CONTINUOUS credit, not a tier.**

Rev 1 said "no minimum bond" and "4× the free tier" without saying how a VPFI
amount becomes capacity. Since match-batch and action-count limits are
discrete, that is not a spec: one implementation rounds a one-wei bond up to
an extra action, another rounds down until there is an implicit minimum —
which would reintroduce the entry barrier the no-minimum rule exists to
prevent.

So capacity is a **rate-limit credit**, which is continuously divisible:

```
multiplier = 1 + 3 × min(1, bond / bondAt4x)      // 1× at zero, 4× at bondAt4x
budget     = freeTierBudget × multiplier           // continuous
```

`bondAt4x` is the governance-set VPFI amount that reaches the ceiling.
Discreteness enters only at the final check, where an action is admitted iff
the remaining budget covers its cost, **rounding DOWN**. A one-wei bond
therefore buys a one-wei-proportional sliver of budget and, at the margin,
no extra action — no rounding-up windfall, and no implicit minimum either.

**The window, refill and accounting key** — rev 2 gave the formula and not the
bucket, which is not a spec: the same multiplier admits wildly different
throughput depending on whether budget resets per call or accrues over time
(rev 3).

| | |
| --- | --- |
| Shape | **Fixed epoch, not a token bucket.** Budget is allocated whole at each epoch boundary and unused credit is **DISCARDED**, never carried |
| Epoch | Governance-set, default **1 hour** |
| Capacity | `freeTierBudget × multiplier`, recomputed at each boundary from the bond balance AT that boundary — so a slash or an unbond takes effect on the next epoch, not retroactively |
| Key | `(role, address)` — the same key the bond record uses |

Carry-over is refused deliberately. A token bucket lets an operator idle and
then burst at many times the steady-state rate, which is the throughput
concentration bonds are not supposed to buy; discarding unused credit makes
the ceiling a real ceiling over every window rather than an average. It also
makes the bound auditable from one boundary, with no accrued state to
reconstruct.

**5. The 4× ceiling bounds an ADDRESS, not an operator — stated as such.**

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

**Open for the owner:** `bondAt4x` per role, and whether the permissionless
roles should keep a per-address ceiling at all now that it is understood not
to bound an operator — an alternative is no ceiling plus the linear cost
curve, which is honest about what the mechanism does and removes a number
that could be mistaken for a guarantee.
