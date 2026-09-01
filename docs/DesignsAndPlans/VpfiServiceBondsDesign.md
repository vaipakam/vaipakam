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
4. Marketing language depends on the fork below. Under **(B)** or the
   attested tier — where a slash exists — "operational security deposit".
   Under **(A) OR (C)** — the principal cannot be confiscated in either,
   since C's arming fee is a separate spend and does not put the deposit at
   risk — it MUST be "operational capacity deposit": calling a
   non-slashable deposit a security or performance bond is the
   representation problem this note exists to avoid. Never staking, never
   earning, under any of them.

## Mechanics

```
ServiceBond { operator; role; amount; state; unlockAt; }
OffenceRecorded(operator, role, kind, refId)   // role, not just operator
// v1: `state` is Active only and `unlockAt` is unused — both exist for the
// liveness tier's delayed unbond, which v1 does not have (rev 4).
```

**Events — every bond lifecycle mutation, not just the offence.** This section
defined only `OffenceRecorded`, which leaves an implementation compliant with
the design and unusable in practice: `(role, address)` bond mappings are not
enumerable, so with no deposit event the app and indexer cannot discover a bond
exists or reconstruct its balance, and an operator cannot enumerate their
old-token liabilities during the VPFI rotation procedure. It also conflicts with
the repository requirement that detailed events are emitted for each relevant
state change (`docs/FunctionalSpecs/ProjectDetailsREADME.md` §Event Emission).

Required: posting, raising, withdrawal request, withdrawal completion, and the
slash itself — each carrying the operator, the role, the delta, the
**post-balance**, the token/config identity, and the withdrawal state. Post-
balance rather than delta alone, because a consumer that missed one event can
otherwise never resynchronise against a mapping it cannot enumerate. ABI and
indexer wiring ship with them, with focused tests; a lifecycle event nobody
decodes is the same gap one step later.

| Role | What the bond unlocks | Slash conditions (objective) |
| --- | --- | --- |
| Solver / matcher | larger match-batch sizes ONLY. **Priority-window access is NOT a bond entitlement** — it is E-2's spend-gated perk with its own flat VPFI fee, and bonds neither gate it nor grant it. An earlier revision listed it here, which would let an implementation either require a bond ON TOP of the E-2 purchase or hand priority out for bonding alone; both change the perk's gate and its permanent absorption. Bond buys capacity; spend buys priority; the two never substitute | precondition lies recorded via the offence dispatcher below **ATTESTED TIER ONLY — v1 has no matcher slash predicate at all** (see the offence-recording bullet and the fork). The surviving in-call contradictions should REVERT rather than record an offence, so an implementation must not build a v1 slash path from this row; **immediate** debit of a fixed bps of the OFFENDING ROLE's bond, per recorded offence — the threshold is one; see the decisions below |
| Keeper (opt-in roles) | higher per-pass action counts for granted `KEEPER_ACTION_*` roles. **A liveness commitment must be suspended, cancelled or extended — without an offence — whenever the protocol itself blocks performance**: a guardian pause, a role kill switch or a selector-level switch makes the required call revert while the commitment's clock keeps running, so every enrolled operator with a live window misses it and is slashed *for the protocol's own incident*. That is objectively detectable (the switch state is on-chain), so it belongs in the predicate rather than in an operator's appeal. A pause spanning a deadline is the acceptance case, and missing-liveness must not be admitted as a slash predicate until it passes | ~~repeated out-of-grant-scope attempts~~ — **LEAVES v1 for the same reason staleness did**: `setKeeperActions` / `revokeKeeper` can remove a grant after a keeper broadcasts an authorized call but before it executes, so an honest pending action is out-of-scope at execution, and worse with several queued. Grant state is not carried by the submission. Returns with the attested tier, alongside missing committed liveness windows IF the operator enrolled in a liveness commitment (optional tier) |

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
  on the spot. ~~Honest failures are excluded by a SUBMITTED-AGAINST
  SNAPSHOT.~~ **REJECTED — do not implement this.** It survives here only
  because the WAY it fails is the argument for everything below it. An
  earlier revision exempted only same-block changes and required the
  predicate to reference state committed before the operator's submission;
  that does not hold: a transaction can sit
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

  **AND THAT LEAVES v1 WITH NO SLASHABLE PREDICATE — which is the finding,
  not a gap to fill.** Apply the same test to the other v1 candidate and it
  fails too: a keeper's out-of-grant-scope call can be produced by a
  revocation landing between broadcast and execution, and grant state is not
  carried by the submission either.

  What survives the test is only a submission whose OWN arguments contradict
  a precondition it asserted — and such a call should simply REVERT. The
  offence dispatcher exists for failures that must commit because reverting
  would cost the protocol something; an internally inconsistent call costs
  nothing to reject. So the class that is objective, in-call, AND must not
  revert is empty for v1.

  Three predicate attempts have now collapsed under review, in three
  different directions. That is evidence about the problem rather than about
  the attempts: slashing needs an adjudicable notion of what the operator
  knew, and v1 deliberately has no attestation to supply one. Staleness,
  grant scope and liveness all return with the attested tier.

  **But an expiry-bounded protocol commitment does NOT make "knew" decidable,
  and an earlier revision of this bullet claimed it did.** A protocol-issued
  snapshot authenticates what the operator observed *at issuance*. It says
  nothing about what they learned afterwards. An operator can take a
  live-listing commitment, watch the listing cancel one second later, and
  knowingly submit while the commitment is still unexpired — and the chain sees
  evidence identical to an honest operator who never saw the cancellation. The
  window narrows the gap; it does not close it, and a predicate that is only
  probabilistically right is not an objective one.

  So the attested tier has its own fork, and it should be recorded here rather
  than discovered during its design:

  1. **Make the commitment an AUTHORIZATION rather than evidence** — a temporary
     protocol grant whose use stays valid despite intervening state changes. The
     operator is then never lying about the world; they are exercising a
     permission the protocol issued. Nothing needs to be adjudicated, because
     nothing is being alleged.

     **This collides with cancellation, and the collision has to be resolved
     before the option is viable.** "Valid despite intervening state" includes a
     creator's cancellation: `OfferCancelFacet.cancelOffer` releases the locked
     principal or collateral (`:117-124`), and standing-intent capital is
     likewise withdrawable after cancellation (`LenderIntentFacet.sol:370-394`).
     So an implementation faces three choices and all three are bad as stated —
     override a completed cancellation, try to spend assets already returned, or
     reject the authorized use and break the option's own guarantee.

     The only coherent readings are: **issuance RESERVES the exact assets until
     the authorization expires** (cancellation then cannot release them, and the
     creator's capital is locked for the window — a real cost to them), **or
     cancellation REVOKES outstanding authorizations** (which re-admits
     intervening state and so re-opens the knowledge question this option exists
     to close). Neither is free, and the choice belongs to whoever designs the
     attested tier — but the option must not be presented as viable until one is
     taken.
  2. **Keep knowledge-based predicates out of the slash tier entirely** — accept
     that staleness and grant scope revert rather than slash, permanently.

  **Neither option recovers a slash, and an earlier revision claimed option 1
  did.** That claim contradicted option 1's own definition one paragraph
  above it: if every use inside the window is valid despite intervening state,
  and nothing is being alleged, then there is no offence to slash for. What
  remains is a missing or expired authorization — an objective in-call
  precondition failure, which this document already says should REVERT rather
  than record an offence. A revert is not a slash.

  So the honest statement is stronger and worse than the one it replaces:
  **staleness and grant scope have no slashable form in either branch of the
  attested tier.** Option 1 makes them safe by construction, which is a good
  outcome and not a punitive one; option 2 admits the same thing without the
  mechanism.

  **This is the main fork one level down**: five predicate attempts have now
  collapsed, and every one of them collapsed on the same question. Recovering a
  slash for the attested tier requires a predicate that does not depend on what
  the operator KNEW at all — a strict liveness obligation or an equivocation
  (two conflicting signed statements), where the offence is visible in the
  artifacts themselves. Anything else keeps landing here.

  Consequently, **any later statement that option B "completes the performance
  security objective" is withdrawn**: B completes it only if such a
  knowledge-free predicate is found, and none has been.
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
   any unbond delay in force. NAMING IS CONDITIONAL on the fork below and
   this paragraph must not be read as ratifying one term: "operational
   security deposit" only under (B) or the attested tier, where the
   principal can actually be confiscated. Under (A) and (C) the principal
   is never at risk, so it is an "operational capacity deposit" — and C's
   separate arming fee does not change that, since a fee purchased
   alongside a deposit does not make the DEPOSIT security. Never
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

**Each proof is consumed before it debits.** Under attested-tier delayed
adjudication the offence arrives as a submitted proof rather than as an in-call
observation, and nothing in this design or in the code beneath it stops the same
proof being submitted twice: the lifetime counter is expressly observational,
and `LibVpfiRecycle.credit` performs no `refId` deduplication despite taking one
(`:174-217`). An unbounded replay of one valid proof drains the role bond to
zero.

So: a canonical **domain-separated offence ID** over chain, contract, operator,
role, offence kind, the action, and the commitment; marked consumed **before**
the debit, not after; with duplicate submission and cross-role replay both
tested. v1's immediate in-call recording does not need this — the observation
and the debit are the same call — which is exactly why it is easy to omit when
the attested tier lands, and why it is written down here rather than there.

**Which `slashBps`, when adjudication is delayed.** Immediate recording makes
this moot in v1, but the attested tier records an offence only after its
observation or adjudication window closes, and governance can retune `slashBps`
inside that gap. Unbound, an operator acting at 10% can lose 25% because
governance raised the rate before the evidence resolved — and a reduction in the
same window would discount an offence already committed. Both are the rule
changing after the act.

**Bind the rate to the action, not to the commitment.** An earlier revision said
to stamp the epoch into the commitment, which does not work: the commitment is
issued BEFORE the action — that is the entire point of it — so an immutable
commitment can only carry the ISSUANCE-time rate. A retune between issuance and
submission then lets an operator hold an older favourable rate, or exposes them
to a stale unfavourable one. Either way it is not the rule in force when the
action was accepted, which is the rule that should apply.

So the rate is stamped in the **action-consumption record** written when the
submission is accepted, or the action rejects a commitment whose epoch no longer
matches the live one. The first is better — a rejection makes an ordinary retune
invalidate every outstanding commitment, which is a liveness problem for honest
operators.

The acceptance case is the ordering itself: **issue → retune → submit**, and it
must resolve to the rate at SUBMIT. Same snapshot-at-init discipline as the loan
fee stamps, applied at the right moment.

**Keyed by role, not by address.** One address may hold solver, matcher and
keeper bonds at once, and an offence recorded through a matcher entry point
must debit the matcher bond — not another role's, and not all of them. The
offence record and its counter therefore carry the role alongside the
operator, or the same event admits three materially different losses. That is the
whole rule:

- Geometric, not linear — 10% of what remains, so the bond falls away rather
  than hitting zero at a fixed count. "Ten offences to zero" in rev 1 was
  wrong arithmetic as well as an ambiguous rule.
- **Rounding is UP.** `balance * 1_000 / 10_000` FLOORS to zero once the
  balance drops under ten units, leaving a permanently unslashable positive
  bond that still buys capacity; an earlier revision described that
  asymptote as a feature, when in Solidity it is a floor at which slashing
  silently stops. Ceiling division alone fixes it — any positive balance
  yields a debit of at least one unit, so the bond strictly decreases and
  reaches zero.

  A previous revision ALSO said a balance below the minimum is consumed
  entirely. That case cannot arise under ceiling division and the two rules
  contradicted: no positive balance is below a one-unit debit. The sweep
  rule is dropped rather than the rounding.
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
of **4× the free tier per `(role, address)`** — the same key the bond record and the buckets use, where ADDRESS is the charged actor defined by an exhaustive selector→(role, actor) table that implementation must produce. That table is not optional and not inferable: `BackstopFacet.backstopFill` routes through `BackstopVaultImplementation.executeFill` into `OfferMatchFacet.matchIntent`, so the inner `msg.sender` is a SHARED vault rather than the initiator, and adapter fills likewise replace the keeper or principal with the adapter. Keying on the inner caller would pool unrelated activity and let one contract's bond subsidise every routed caller; charging wrappers without a closed mapping risks bypass or double-charging instead. Direct and routed paths both have to appear in it. Not per address across roles: an address holding solver, matcher and keeper bonds gets an independent ceiling for each, because their action units are not commensurable and a shared cap would let one role suppress another's capacity.

**Any CHANGE in capacity — up or down — must settle elapsed credit under the
OLD capacity before the new one takes effect.**

Downward is the obvious half: a withdrawal, a slash, or a retune that lowers
the curve, `bondAt4x` or the free tier must reconcile outstanding credit down
before that bucket's next admission.

Upward matters just as much and an earlier revision missed it. With lazy
refill, an address can leave an empty unbonded bucket untouched, post
`bondAt4x` after a long idle stretch, and have its next admission accrue that
whole interval at the new 4× rate — elevated throughput for time during which
the capital was not locked. An upward governance retune does the same to every
stale bucket at once. So an increase checkpoints first: settle accrual to the
change timestamp at the old rate, then activate the new capacity.

Bond-decrease-only is not sufficient, and the gap is easy to miss: raising
`bondAt4x` leaves every bond BALANCE untouched while buying less capacity,
so an unvisited bucket keeps credit above the new ceiling indefinitely.
Config changes cannot walk every bucket, so the reconciliation is lazy — but
a stored epoch alone is NOT enough, which an earlier revision stopped at. Two
or more retunes before a bucket is touched cannot be reconstructed from one
stale epoch plus the current config, so reconciliation would either accrue
the whole gap at the latest rate or discard credit legitimately earned under
an intermediate one.

> ⚠️ **The cumulative index described in this paragraph is WITHDRAWN.** It is
> retained because two later findings are about it and the reasoning matters,
> but do not build it — the corrected mechanism is at the end of this section.
> A global rate-seconds index cannot serve a per-bond curve at all, and each
> revision of it fixed one symptom and exposed the next.

Use a **cumulative accrual index**: a monotonically increasing rate-seconds
total that governance settles at the OLD rate before writing each new one. A
bucket stores the index it last sampled, and its accrual over any span is
`index[now] − index[sampled]` — correct across any number of intervening
retunes, with no per-epoch history to retain. It is the same shape as a
borrow index, and this is the problem borrow indices exist for. A bucket
spanning multiple retunes before its first admission is the acceptance case.

**The index settles the RATE and not the CEILING, and that is a second
problem, not a footnote to the first.** An earlier revision of this paragraph
claimed correctness "across any number of intervening retunes" without
qualification. It is correct across any number of intervening *rate* retunes.
A capacity retune is a different operation: it changes the **clamp**, and a
clamp is applied at a moment, not accrued over a span.

The case that breaks it — and it should be an acceptance case, because it is
the one a plausible governance sequence produces:

> An untouched bucket is full at 4×. Governance lowers capacity to 1×, then
> restores it to 4× before that bucket is next admitted.

Sequential settlement clamps at the first retune and the bucket keeps 1×; the
later increase grants nothing retroactively, because capacity is a ceiling and
not a credit. Applying an accumulated index against the *final* ceiling instead
preserves the original 4× — reinstating capacity the clamp was supposed to have
destroyed, and doing it invisibly, because no record of the intermediate
ceiling survives to contradict it.

So the index must **either** retain intermediate ceiling/clamp information
alongside the rate-seconds total, **or** conservatively reset the buckets a
capacity decrease affects at the moment it is written. The second is cruder and
strictly safe: a reset can only under-credit, and under-crediting an operator
costs them throughput they can re-earn, where over-crediting hands back capacity
governance deliberately withdrew. Absent a reason to pay for the first, take the
second.

Note the two are settled by different actors at different times — the rate by
governance at each retune, the clamp by whoever touches the bucket next — which
is precisely why one index cannot carry both.

**And a third problem, which invalidates the global index outright: there is no
single "OLD rate" to settle.** The curve is continuous and per-`(role, address)`
— that is the point of it, and the reason the threshold was removed — so a
governance retune of a curve PARAMETER moves different bonds by different
factors, not all bonds by one factor.

Raising `bondAt4x` from 100 to 200 takes a 50-token bond from 2.5× to 1.75×
while a 200-token bond stays capped at 4× and does not move at all. A single
global rate-seconds total cannot settle both of those stale buckets, because
they did not accrue at a common rate to begin with. This is not fixed by the
ceiling handling above; it is a defect in the index's premise, and an earlier
revision introduced it while fixing the epoch problem.

So the accrual mechanism has to either **retain enough curve history to
integrate each bond's OWN rate over its own span**, or **conservatively
invalidate the affected buckets on every curve retune** — the same
under-credit-is-safe reasoning as the ceiling case.

**And that is still not enough, which is what finally condemns the index.** An
earlier revision concluded "reset on retune is the mechanism, and the index is
only an optimization while the curve is untouched". Wrong: the index is not
correct even *within* an untouched epoch. A zero-bonded, a partly-bonded and a
fully-bonded bucket all accrue **simultaneously at different rates**, so one
scalar difference credits them equally — which is the original defect, present
with no retune involved at all.

A global value can only be shared by buckets that share a rate, and on a
continuous per-`(role, address)` curve none of them do.

#### The corrected mechanism — no global index

Each bucket accrues from **its own** last-touch timestamp at **its own**
snapshotted rate:

```
accrued = min(ceiling(bond), balance + rate(bond) × (now − lastTouch))
```

`rate(bond)` is read from the curve at touch time and `lastTouch` is per bucket,
so nothing is shared and nothing needs settling globally. A curve retune resets
the affected buckets (per the ceiling finding above); between retunes each
bucket integrates its own rate over its own span, which is the quantity that was
wanted from the start.

This is simpler than any version of the index, and the index's whole appeal —
"settle once globally, sample cheaply per bucket" — was an optimization for a
problem the per-bond curve does not have. Three revisions were spent rescuing a
primitive borrowed from a system where every borrower DOES share one rate. This is a decision, not an
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
  ceiling require `N × bondAt4x` bonded and idle — **and that claim does not
  survive the free tier either.** It is withdrawn.

  The free tier is mandatory and unbonded by design, so a controller can run
  `4N` fresh addresses on their free allowance and reach the same aggregate
  throughput as `N` addresses bonded at the ceiling, for no VPFI at all.
  Preventing an initially-full bucket delays that; it does not price it.
  There is no aggregate cost curve without non-Sybil identity or friction on
  the free tier, and this note deliberately adds neither.

  So the honest statement is narrow: **a bond is an optional PER-ADDRESS
  convenience** — it raises one address's throughput up to 4×, and buys the
  operator fewer addresses to manage rather than capacity nobody else can
  have. It is not an aggregate bound and not an aggregate cost. This is the
  third revision of this claim; the first two said it bounded an operator,
  then that it priced one. **It holds only if a fresh
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

### THE DECISION THIS NOTE NOW NEEDS — v1 has no slashable predicate

Three predicate attempts have collapsed under review, in three different
directions, and the third took the last candidate with it. Staleness needs an
unobservable "knew"; a timing rule slashes honest operators; a caller-supplied
snapshot exculpates dishonest ones; keeper grant-scope fails identically. What
survives is only the internally-inconsistent call, which should revert rather
than record an offence.

**So v1 as specified is a bond with nothing to slash.** That is not a gap to
fill with a fourth attempt — it is what the evidence says, and the owner should
choose between two coherent shapes rather than have me keep trying:

**(A) Ship v1 WITHOUT slashing.** Bonds buy capacity continuously, are
refundable at will, and nothing is confiscated — an operational CAPACITY
deposit, named as such. `ServiceBondSlash` stays reserved and unused.

*Two costs, both of which review surfaced and neither of which an earlier
draft of this fork admitted:*

- **It drops half this card's objective.** The stated goal at the top is a
  *temporal + permanent* VPFI sink. A refundable deposit is only the temporal
  half; the permanent route is the slash, and (A) leaves it unused. So (A) is
  not "the useful half shipped early" — it is a deliberate deferral of
  permanent absorption, and choosing it should be recorded as an objective
  change rather than a scoping detail.
- **Revocation does not answer every covered operator.** An earlier draft of
  this fork said misbehaviour is answered by role revocation. That holds only
  for DELEGATED keeper access. `OfferMatchFacet.matchSignedOffer` has no
  per-matcher authorization to revoke, and `matchIntent` is open whenever
  `requiresKeeperAuth` is false — so a permissionless matcher simply
  continues, from the same address or another. Under (A) those paths have no
  operator-specific response at all.

**The attested tier's unbond delay must cover the full EVIDENCE HORIZON**,
not a round number. Revoking privileges at the request stops new actions; it
does not preserve collateral for evidence already pending. So an operator
who acts immediately before requesting unbond, with an observation
commitment or adjudication window that outlives the snapshotted `unlockAt`,
walks away before the offence can be proven — slash-and-run restored by a
delay that looked generous. The floor must therefore be bound to the maximum
commitment plus adjudication window, or unlock must wait until every
pre-request commitment has expired or resolved. Test the boundary, not the
middle.

**Enrolment is required if the attested tier later arrives**, and "no
migration" was wrong. Activating predicates against balances deposited under
capacity-only terms would make them confiscatable by the activation
transaction itself, which immediate withdrawal does not protect against —
the owner never had a chance to exit. So the tier must require explicit
per-operator enrolment, or version deposits and only debit enrolled ones,
or give a withdrawal grace period before any new predicate can debit an
existing balance.

**(B) Ship nothing until the attested tier — and (B) IS NOW UNRESOLVED, not a
third path.** This option previously read "wait for the observation commitment
that makes 'knew' adjudicable, and land capacity, bonds and slashing together",
which survived the correction above and directly contradicts it: §2 establishes
that no commitment reveals later knowledge, that neither branch of the attested
fork recovers a slash, and that no knowledge-free predicate has been found.

So B has **no defined predicate**, and "wait for the attested tier" is waiting
for something nobody has specified. It cannot be selected as a single decision,
because selecting it decides nothing — the later table's promise of confiscation
under B is a promise about a mechanism that does not exist.

B becomes selectable only when a **concrete knowledge-free predicate** is
written down — a strict liveness obligation, or an equivocation (two conflicting
signed statements), where the offence is visible in the artifacts themselves and
no inference about the operator's state of mind is required. Until then B means
"defer the whole feature indefinitely", and the owner should be choosing it on
that basis rather than on the expectation of eventual slashing.

**(C) Ship (A) plus a non-refundable ARMING FEE.** A fee charged when a bond
is posted or raised, credited through the recycle chokepoint and never
returned. It needs no adjudication of anything — a spend is objectively a
spend — which is exactly why the perk channel works, and it is the same
shape: spend is permanent absorption, deposit is temporal.

**Selecting (A) or (C) also changes the programme's definition of done, and
that consequence has to be recorded rather than discovered.**
`VpfiRecyclingCompletionPlan.md` §6 defines #1219 as decided when *either* the
legal glance passed **and** the slash path `credit(ServiceBondSlash, …)` is
"built and live", **or** an explicit owner deferral is recorded — and it says
"pending" is not a done state.

A live A or C implementation is **neither**: it ships, so it is not a deferral,
and it has no slash path, so the first branch is unsatisfiable by construction.
The M7 completion gate would stay permanently unmet while the feature is
finished — the worst combination, because nothing in the programme would ever
signal that it is waiting on something impossible.

So whichever of A or C is selected, the plan's §6 clause is amended in the same
change: a **third done state — shipped without a slash path**, on the reasoning
in this note, with `ServiceBondSlash` remaining an unused enum slot reserved for
the attested tier. That amendment is part of the fork decision, not a follow-up
to it.

*What C restores, precisely:* the **permanent SINK**, not the performance
bond. An earlier draft said it "restores the objective" and that overclaimed
— the principal is still never at risk for misbehaviour, and the permanent
payment purchases capacity rather than securing performance. C carries the
same operator-response loss as A; what it adds back is absorption, not
deterrence.

*What C needs specified before build, and these belong in the owner
decisions rather than to an implementer's discretion:*

- **Formula and transfer.** Flat per arming, or proportional to the raise?
  Paid IN ADDITION to the deposit, or deducted from it? A floor-rounded
  proportional charge lets sufficiently small raises contribute nothing,
  which defeats the property C exists to restore — so proportional needs
  ceiling rounding and a minimum, or the fee should simply be flat.
  Proposed: **flat per arming, paid in addition, governance-set with a
  ceiling**, because it is the variant with no rounding hole.
- **The arming call must BIND the fee it accepted** — `maxArmingFee`, or an
  expected fee, or a config epoch, reverting on adverse drift. Governance can
  re-price while an arming transaction is pending, and if the implementation
  debits a preapproved allowance or an internal balance, an upward retune
  charges more than the operator agreed to. This is the same defect the perk
  channel had and fixed (`purchasePerk` binds `maxTotalVpfi` and the exact
  entitlement); a fee invented in this note should not have to relearn it.
- **Its own `RecycleSource`.** `LibVpfiRecycle.credit` needs a concrete
  member and the enum is append-only. `ServiceBondSlash` must NOT be used —
  C performs no slash, and reporting fee purchases as offences would
  corrupt the metric that member exists for. Borrowing a perk or generic
  class merges distinct absorption. So C appends **`ServiceBondArmingFee`**,
  with its own event and test.

**Recommendation: (C), else (A)** — but read the fork for what it is. Both
abandon performance security; the real question is whether v1 ships capacity
now and gains deterrence later, or waits for the tier that can adjudicate.
Everything in this note that survived review is about capacity; everything
that collapsed is about slashing.

**Open for the owner.** The fork is the **first** blocking decision, and under
one branch it is not the last: choosing **(C)** immediately raises item 2, which
§3 states is not buildable without a number. So (A) and (B) are single-decision
paths and (C) is a two-decision path.

Saying "exactly ONE decision blocks a build" — as an earlier revision did — is
wrong in exactly the case the recommendation points at, and its failure mode is
an owner who selects C, believes the fork discharged, and leaves the
implementation underspecified.

**1. Select the fork: (A) or (C).** Not "does v1 ship" — that question was in an
earlier revision of this list and a "yes" to it leaves an implementer unable to
tell whether anything is confiscated.

**(B) IS NOT ON THIS LIST, and an earlier revision offered it here while §2 was
establishing that it cannot be selected.** B has no defined predicate; ratifying
it would hand an implementer a choice between deferring indefinitely and
inventing a slash condition this document spent five attempts rejecting. It
returns to the list when a concrete knowledge-free predicate exists — strict
liveness, or equivocation — and not before.

The two selectable forks differ in what a deposit IS:

| | confiscates? | permanent sink? | deposit is called |
| --- | --- | --- | --- |
| **A** | no | no | operational capacity deposit |
| **C** | no | yes (arming fee) | operational capacity deposit |
| ~~**B**~~ | ~~yes, once attested~~ | ~~yes (slash)~~ | **unavailable — no predicate** |

Recommendation **(C), else (A)**. Both abandon performance security. Note this
is no longer a choice about *when* deterrence arrives, because no route to it
has been specified — see item 3.

**2. If (C): the arming fee's value, floor and ceiling — and the FLOOR MUST BE
POSITIVE.** Flat per arming, paid in addition to the deposit, per §3. Without a
number (C) is not buildable, and its permanent-sink property is exactly what the
number sets.

**A zero floor collapses C into A silently.** Governance could later tune the
flat fee to zero while bond posting and raising stayed enabled — no absorption,
no permanent sink, and nothing anywhere would notice, because the programme
would still record C as shipped. That is the same zero-value failure this note
already guards against for `slashBps`, where §2 imposes a positive floor for
precisely this reason; leaving C's floor unconstrained applies the lesson in one
place and not the other.

So: **the floor and the active fee are both positive**, or zero is defined as
DARK — the channel disarmed, posting and raising refused — so that fee-free
arming cannot occur by omission. The first is simpler; the second is only worth
it if governance needs a way to pause arming without a redeploy.

**3. UNRESOLVED — the liveness tier's PREDICATE, not its timing.** An earlier
revision of this item said the liveness tier "makes 'knew' adjudicable" and that
the choice was *when*, not *whether*. §2 refutes both halves: no commitment
reveals knowledge acquired after issuance, and neither attested branch recovers
a slash. Scoping this item as written would let an implementation revive exactly
the knowledge-based slash this document rejects — the retracted claim surviving
in the owner-facing list is how that happens.

What is genuinely open is **whether a knowledge-free predicate can be defined at
all**. Two candidates, neither yet specified:

- **Strict liveness** — a committed window, missed. Objective, but only once the
  kill-switch suspension rule in §1 is part of it, or an incident slashes every
  enrolled operator at once.
- **Equivocation** — two conflicting signed statements from one operator. The
  offence is visible in the artifacts themselves and requires no inference about
  what anyone knew, which is what makes it the strongest candidate.

Until one is written down, **there is no route to deterrence under any fork**,
and the unbond delay, revocation rule and `unlockAt` snapshot from revs 2–3 are
machinery waiting on a predicate rather than a tier waiting on a schedule.

**NOT for the owner, deliberately — deferred to implementation:**

`bondAt4x` and `refillWindow` were listed here as owner numbers, and that was
wrong. The same `refillWindow` yields materially different throughput
depending on bucket size, initialization and whether a cost is charged per
fill, per action or per admission — none of which is settled (§3's checklist
is exactly that list). Ratifying numbers whose operational meaning is
undefined would produce two conforming implementations with different limits.
The implementation pass defines the units and the envelope, then brings the
numbers back with their actual throughput meaning attached.

**Already ratified, recorded here so nothing re-opens them:** the no-yield
refundable-deposit shape; objective-lies-only for v1 (which collapsed to no
predicate at all — see the fork); the 4× ceiling per `(role, address)` as an
invariant rather than a suggestion; no minimum bond; no v1 unbond delay; and
clamp-on-any-capacity-reduction.

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
- **SANCTIONS, on every value-moving bond selector.** VPFI deposits and
  withdrawals are Tier-1 BLOCK in the repository's sanctions matrix, and the
  gate is per SELECTOR — each entry point screens the value's owner or
  recipient itself. So `postBond`, `unbond`, any deposit-on-behalf or permit
  variant, and (under C) the arming-fee payer each need
  `LibVaipakam._assertNotSanctioned` and a focused test. Omitted from an
  earlier revision of this list entirely, which would have let a flagged
  operator post, withdraw or pay a fee through an unscreened path.
- **PAUSE AND REENTRANCY GUARDS, on the inflow and fee selectors.** The
  repository's own coding standard (`docs/FunctionalSpecs/TokenomicsTechSpec.md`)
  requires every new VPFI vault-deposit, fee-deduction and treasury-receipt
  function to carry the project-standard reentrancy guard and the global
  pausable mechanism unless it is a pure/view helper. This list previously
  required sanctions screening and stopped there, which would have satisfied
  the design while leaving `postBond`, any permit / deposit-on-behalf variant,
  and (under C) the arming fee callable during an incident, or exposing an
  unguarded external token-transfer path.

  **`unbond` is the deliberate exception and must stay one.** It is the exit,
  and an exit that a pause can close is a freeze on operator capital rather
  than a containment lever — the same asymmetry that took `whenNotPaused` off
  the perk setter. So: guard and pause the inflows; guard the exit, never
  pause it. Two focused tests, one per direction, because a single test that
  only proves the pause blocks something would pass on an implementation that
  pauses everything.

  **Omitting `whenNotPaused` is necessary and not sufficient — the app has a
  SECOND gate.** `apps/app/src/contracts/tosWriteGate.ts` closes every write
  for an operator who has not accepted a newly published Terms version, and it
  is an allowlist: only selectors in `EXIT_WRITES` stay reachable. A contract
  that cannot be paused is still unreachable through the official client if the
  gate does not list it, so a Terms update would freeze operator capital exactly
  as a pause would — with the note still promising the exit is open.

  So `unbond` goes in `EXIT_WRITES` and on an exempt route, while `postBond`,
  any deposit-on-behalf or permit variant and (under C) the arming fee stay
  gated — the same inflow/exit split as the pause. The stale-Terms case needs
  its own test: it is a different mechanism from the pause and passes none of
  the pause's tests.

- **SHIPPING PREREQUISITE, not a test: reward-funding isolation (#1566).**
  `RewardClaimFacet` takes `backingRoom` from `LibVpfiRecycle.backingPosition`,
  which treats every VPFI outside `recycleBucket` as reward backing — so a
  refundable bond deposited into the Diamond becomes available for transfer
  to reward claimants. Bonds cannot ship before that is closed.

  An earlier revision listed only the escrow accounting invariant here, as
  though extending the enumerated Diamond-balance check were the remedy. It
  is not, and `TokenomicsTechSpec` records why: per-custody subtraction was
  REJECTED, because related reward clocks can advance while payouts are
  blocked, and it says outright that new custody classes must wait for the
  delivered-for-rewards bound. A bond is exactly such a class. #1566's own
  design note says the same thing from the other side — "new custody classes
  should wait for this".

  The escrow accounting invariant still applies once that lands: bonds are a
  fourth tracked balance class alongside user LIF custody, unclaimed budgets
  and the recycle bucket, and the Diamond-balance invariant must cover it
  (#892 / L13). It is necessary and it was never sufficient.
- **(B) / attested tier only** — Slash → recycle: the debit credits
  `LibVpfiRecycle.credit(RecycleSource.ServiceBondSlash, …)` through the
  chokepoint, with the event carrying that source and not a new generic one.
  Under (A) there is no production call that can satisfy this, so it is
  deferred rather than left unwritable.
- **(B) / attested tier only** — each objective slash predicate proven
  on-chain-verifiable and proven to fire on committed state rather than a
  revert. Under (A) and (C) the predicate set is empty by construction, and
  the acceptance case inverts: **only an owner-authorized deposit or
  withdrawal may change the principal, and NO path transfers it to
  recycling.** Stated that way rather than as "every entry point leaves the
  balance unchanged", which is not writable — bond and unbond necessarily
  change it, so that phrasing forces an ad-hoc exclusion or fails the
  lifecycle requirement. Under (C) the arming fee is the one permitted
  transfer to recycling, and it is charged at arming rather than by an
  operational path.
- **No v1 predicate depends on external state moving between broadcast and
  execution** — the acceptance case is the ABSENCE of such a predicate. An
  earlier revision required testing a caller-supplied snapshot, which is the
  mechanism this note rejects, so that test could not have been written
  honestly.
- **(B) / attested tier only** — dust slashing: a 1-unit balance still
  debits 1 unit under ceiling division and reaches zero, so no positive
  balance survives a slash unchanged. Under (A) and (C) there is no slash
  path for this to exercise, so it is deferred with the others; the ceiling
  -division helper itself can still be unit-tested in isolation, which is
  where the rounding property actually lives.
- Free-tier operation at ZERO bond, for every role. This is the
  permissionless baseline the whole design is built to preserve, and it is
  the case a capacity bug silently breaks.
- Dark mode preserves withdrawals and the free tier: disabling the feature
  must not strand escrowed VPFI or block unbonded operation.

**Limiter shape** — deferred with the mechanism, per §3's checklist, but its
acceptance criteria are:

- **No implicit minimum, tested DISCRIMINATINGLY.** "A small bond eventually
  affords an action" is vacuous: the mandatory zero-bond free tier eventually
  affords the same action, so an implementation that rounds every small bond's
  incremental capacity to zero passes it — while violating the continuous
  curve it is meant to prove. The test must hold the free allowance constant
  or exhausted and show measurable additional admission, or a measurably
  shorter wait, ATTRIBUTABLE TO the small bond. Same rule this programme
  applies elsewhere: reachability is not discrimination.
- The stated envelope holds over a rolling window.
- A capacity change of any cause — up or down — settles elapsed credit under
  the old capacity before the new one takes effect **where the mechanism
  preserves that credit at all.** The corrected mechanism explicitly permits the
  conservative branch — invalidate the affected buckets on a curve or capacity
  retune — which DISCARDS pre-retune credit by design rather than settling it.
  Written unconditionally, this criterion and that branch cannot both be
  satisfied, and an earlier revision left them contradicting each other.

  So the criterion is: **either** the old accrual is settled under the old
  capacity, **or** the bucket is invalidated and its pre-retune credit
  deliberately forfeited — never silently re-credited under the new capacity,
  which is the actual failure both wordings exist to exclude. A reset-based
  implementation satisfies this by showing the invalidation; a history-retaining
  one satisfies it by showing the settlement.
