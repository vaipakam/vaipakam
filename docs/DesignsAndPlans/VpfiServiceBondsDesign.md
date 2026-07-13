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
   on-chain fact.
4. Marketing describes bonds as "operational security deposits" —
   never staking, never earning.

## Mechanics

```
ServiceBond { operator; role; amount; unbondRequestedAt; }
```

| Role | What the bond unlocks | Slash conditions (objective) |
| --- | --- | --- |
| Solver / matcher | larger match-batch sizes; priority-window access (E-2 perk interplay: bond = capacity, spend = priority) | submitting fills that revert on protocol-verifiable precondition lies (e.g. repeated stale-listing spam past the flagged state); rate: per-offence fixed bps of bond |
| Keeper (opt-in roles) | higher per-pass action counts for granted `KEEPER_ACTION_*` roles | executing outside grant scope (already reverts — slash covers repeated attempts); missing committed liveness windows IF the operator enrolled in a liveness commitment (optional tier) |

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

## Open decisions

1. Do slash conditions v1 include the liveness tier, or objective-lies
   only? (Recommendation: objective-lies only; liveness commitments are a
   later opt-in tier.)
2. Bond size bounds + unbond delay values.
3. Legal glance sign-off on the no-yield refundable-deposit shape.

## Tests

Bond/unbond lifecycle incl. delay; limit enforcement with/without bond;
slash conditions each proven on-chain-verifiable; escrow invariant; slash
→ recycle-bucket event; free-tier operation with zero bond.
