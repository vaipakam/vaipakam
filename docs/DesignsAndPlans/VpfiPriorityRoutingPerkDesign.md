# Priority solver routing — the first spend-gated perk's effect (#2550)

**Status:** owner decision 2026-10-18 — **capacity-free fills** (option 1 of the
four put to the owner on #2550). This note fixes the mechanism before code.
Card: #2550. Parent: #1204 (perks; the absorption channel is built — `PerkFacet`,
`RecycleSource.SpendGatedPerk`). Related: #1219 (service capacity, whose limiter
this perk acts on). Design rules inherited from
[`VpfiUsagePerksAndReferralDesign.md`](VpfiUsagePerksAndReferralDesign.md).

## The problem this solves

`PerkFacet` sells consumable entitlements, but nothing reads one. So the first perk
— "priority solver routing for intents" — cannot be priced: `purchasePerk` moves
the buyer's VPFI into recycling at once and irreversibly, and a priced perk with no
consumer sells nothing for real money. The design's fund-safety rule makes the
effect a precondition of arming: **a non-zero price only after the effect is
deployed and verified on that chain.**

The catalog named the perk but never said what "priority" does. Its obvious reading
— a buyer's intent is filled ahead of competing intents — breaks the rule ratified
on 2026-08-31: **a perk may change what its buyer gets, never what other
participants see.** Reordering who gets filled first is exactly a change other
participants see.

## The decision: a priority fill does not use the solver's capacity

Since #1219, every solver fill is charged one action against the solver's own
capacity bucket (`LibServiceCapacity.chargeSolver`, called last in
`OfferMatchIntentFacet.matchIntent`). When a solver's bucket is empty, the fill is
refused (`ServiceCapacityExhausted`) until it refills.

**A fill of an intent whose owner has opted into priority routing, and holds a
credit, spends the OWNER's credit instead of the SOLVER's capacity.** The solver can
therefore always afford to fill it, even when its limit is reached.

Why this satisfies the rule:

- **No one is reordered.** Nothing about matching order, rates, eligibility or the
  book changes. Other intents are filled exactly as before.
- **No one pays more.** A priority fill consumes no capacity, so it leaves *more*
  capacity in the solver's bucket for everyone else, never less.
- **The buyer gets a real, bounded benefit:** fill reliability when solvers are
  capacity-constrained — the condition under which an ordinary intent would wait.
- **It is consumed on-chain**, at the point of service, by the facet that delivers
  it, through `PerkFacet.consumePerkCredit` (already `address(this)`-gated for
  exactly this use).

While the capacity limiter is dark (no curve for the Solver role — the deploy
default), no fill is charged and no credit is consumed: the perk has nothing to
exempt, so it must not spend the owner's credit. A credit is spent **only** when it
actually replaced a capacity charge.

## Unit: one credit = one capacity-free fill

The owner chose "per intent" in principle. A lender intent is a **standing** order
that can be filled many times, so "one purchase covers the intent forever" would
make one credit an unbounded capacity exemption. The faithful reading is **one
credit = one fill of the owner's flagged intent**: for a one-shot intent that is the
same thing, and for a standing intent the owner buys as many priority fills as they
want. The perk is configured as a **counted** perk (`durationSeconds = 0`), so
`PerkFacet` already tracks it as a credit count; the consumer refuses a timed
configuration of this perk id.

## Mechanism

1. **Perk id.** A named constant `PERK_PRIORITY_ROUTING` (the first id the protocol
   assigns meaning to). Its price stays zero — "not for sale" — until arming.
2. **Opt-in per intent.** The intent owner flags a specific intent
   (`lenderIntent[owner][lendingAsset][collateralAsset]`) for priority routing.
   Stored in its own appended mapping keyed by the intent's key, not as a new
   field of `LenderIntent`, so the intent struct, its getters and their ABIs are
   untouched. Clearing the flag is always allowed. A flag with no credits is inert.
3. **At fill** (`matchIntent`), in place of `chargeSolver()` and at the same
   position (last, so a refused fill charges nothing):
   - flagged, the Solver limiter lit, and the owner holds ≥ 1 credit of the perk →
     consume one credit (`consumePerkCredit(owner, PERK_PRIORITY_ROUTING)`), emit a
     dedicated event naming the intent key and the fill, and **skip** the
     capacity charge;
   - otherwise → `chargeSolver()` exactly as today.
   A credit can never be spent on a fill that then reverts: the consume and the
   fill are one transaction.
4. **Previews agree with the fill.** `previewIntent` (the solver's own pre-check of
   capacity) must answer the same way the fill will: a flagged intent whose owner
   holds a credit previews as capacity-clear. One shared predicate decides both
   ("make the check be the operation").
5. **Reads.** A view returns, for an intent, whether it is flagged and how many
   priority credits its owner holds, so a solver can see before filling that the
   fill will not cost it capacity.
6. **Events.** `PerkCreditConsumed` already fires from `PerkFacet`; the fill adds an
   event linking the consumed credit to the intent and the resulting loan, so the
   indexer and the owner can audit every credit's use.

## What does not change

- Sanctions, the permissioned-solver gate, the intent's own limits (exposure, rate
  floor, LTV, duration, minimum fill), the LIF and every settlement rule.
- The capacity limiter for every non-flagged fill and every other route
  (`matchOffers`, `matchSignedOffer`, keeper actions).
- No refunds: an unused credit stays with its owner; credits are not transferable.

## Pricing and arming (owner/admin, last)

The price is set with `setPerkConfig(PERK_PRIORITY_ROUTING, price, 0)` as the LAST
step, on each chain, only after the effect is deployed there and verified to consume
the entitlement. Pricing is meaningful only once the Solver capacity limiter is lit
on that chain (#1219); while it is dark the perk exempts nothing, so selling it then
would sell nothing — the activation runbook orders capacity before this price.

## Surfaces and scope of the first PR

- **Contracts:** the flag, the consumer at the fill, the shared predicate behind
  fill and preview, the read view, the event; tests that straddle each condition
  (flag on/off × credits 0/1 × limiter dark/lit × bucket empty/full) and prove a
  credit is spent only when it replaced a charge.
- **App:** none in the first PR — the app has no lender-intent or perk-purchase
  screens today. When intents get a UI, it gains the opt-in toggle, the credit
  balance and a purchase step, under the RL-6 copy rules (a convenience the buyer
  pays for, never yield, return or price).
- **Keeper / solver:** nothing is required for correctness — the fill itself
  applies the exemption. A solver may optionally read the view to budget capacity;
  that belongs to the keeper track.
- **Indexer:** handle (or consciously allowlist) the new event per the
  event-coverage guardrail.

## Considered and rejected

- **Fill-ordering priority** — breaks the neutral-book rule (others' intents wait).
- **Faster keeper service** — off-chain only, and the keeper's own queue order
  still disadvantages others it serves.
- **One credit per intent, all fills exempt** — an unbounded exemption on standing
  intents.
- **A timed priority window** — would exempt fills the owner never needed, and
  couples the perk to wall-clock rather than to the service delivered.
