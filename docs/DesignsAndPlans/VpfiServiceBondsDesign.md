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
ServiceBond { operator; role; amount; unbondRequestedAt; }
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

### Proposed: bond sizes and unbond delay

Nothing here is a new pattern; both follow conventions the repository already
uses for governance-set values.

**Unbond delay — a bounded knob, floored, dark until set.** The nearest
precedent is the reward horizon (default 365 days, never below 180, dark
until governance sets it), and the shape transfers exactly:

| | Value | Why |
| --- | --- | --- |
| Default | **7 days** | The design note's own figure. It must exceed the window in which an offence becomes provable, or an operator can misbehave and exit before the counter crosses its threshold |
| Floor | **3 days** | A floor, not a fixed value, so governance can tune upward for a role that proves slower to adjudicate but can never tune the delay to nothing — which is the slash-and-run configuration |
| Ceiling | **30 days** | An unbond delay is a refundability constraint, and the shape rule says bonds are refundable at will. A delay long enough to feel like a lockup starts to argue against that characterisation |

**Bond sizes — bound the DISCOUNT, not the deposit.** The instinct is to set
a minimum bond in VPFI, and it is the wrong instrument: a VPFI-denominated
floor is a price-varying entry cost, and the design forbids bonds becoming an
entry barrier. Two rules instead:

- **No minimum.** Any bond, including none, is valid. Capacity scales with
  the bond; it is never unlocked by it. This is what keeps the free tier real
  rather than nominal.
- **A capacity CEILING per role**, expressed as a multiple of the free tier
  rather than an absolute — proposed **4×**, so the largest bonded operator
  gets four times the free-tier limits, not unbounded dominance. Bounding the
  multiple is what stops bonds becoming de-facto exclusivity, which is the
  failure mode "no role requires a bond" is protecting against and which a
  minimum-bond rule would not catch.

**Per-offence slash — a bounded bps of the posted bond**, following the
`MAX_*_BPS` ceiling convention in `ConfigFacet`: proposed default **1,000 bps
(10%) per offence**, ceiling **2,500 bps (25%)**. Ten offences to zero at the
default is deliberate: slashing is meant to price misbehaviour, not to
confiscate on a first mistake, and the offence predicate explicitly does not
count honest same-block failures.

**Open sub-question the owner may want to settle with this:** whether the
offence counter DECAYS. Without decay a long-lived honest operator eventually
accumulates enough sparse offences to be slashed for a rate of error that was
never harmful. Recommendation: a rolling window rather than a lifetime
counter, sized to the same knob as the unbond delay so the two cannot be
configured into contradiction.

## Tests

Bond/unbond lifecycle incl. delay; limit enforcement with/without bond;
slash conditions each proven on-chain-verifiable; escrow invariant; slash
→ recycle-bucket event; free-tier operation with zero bond.
