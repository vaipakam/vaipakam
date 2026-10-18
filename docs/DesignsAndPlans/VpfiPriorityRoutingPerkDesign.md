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

## The decision: a fill capacity would refuse spends the owner's credit instead

Since #1219, every solver fill is charged one action against the solver's own
capacity bucket (`LibServiceCapacity.chargeSolver`, called last in
`OfferMatchIntentFacet.matchIntent`). When a solver's bucket is empty, the fill is
refused (`ServiceCapacityExhausted`) until it refills.

**A fill the solver's capacity would REFUSE — its bucket cannot cover the one
action — goes through anyway when the intent's owner has opted into priority
routing and holds a credit: the OWNER's credit is spent instead.** Whenever the
solver's capacity does cover the fill, it is charged exactly as today and no credit
is spent (Codex #2558 r1: a credit spent on a fill the solver could already afford
buys its owner nothing, and would only preserve capacity for others).

Why this satisfies the rule:

- **No one is reordered.** Nothing about matching order, rates, eligibility or the
  book changes. Other intents are filled exactly as before.
- **No one pays more.** A credit only ever replaces a charge the solver could not
  have paid; every other fill is charged as it is today.
- **The buyer gets exactly what they paid for:** a fill that capacity exhaustion
  would otherwise have refused — the condition under which an ordinary intent waits.
- **It is consumed on-chain**, at the point of service, by the facet that delivers
  it, through `PerkFacet.consumePerkCredit` (already `address(this)`-gated for
  exactly this use).

While the capacity limiter is dark (no curve for the Solver role — the deploy
default), no fill is ever refused for capacity, so no credit is ever spent.

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
2. **Opt-in belongs to the specific intent, not the pair** (Codex #2558 r1). The
   intent row (`lenderIntent[owner][lendingAsset][collateralAsset]`) is reused:
   `cancelLenderIntent` marks it inactive and a later `setLenderIntent` overwrites
   it. So the flag is stored in its own appended mapping under the same key, but it
   is **written by `setLenderIntent` from an explicit parameter every time the
   intent is (re)written, and cleared by `cancelLenderIntent`**. A replacement
   intent never inherits an old opt-in. A separate owner setter toggles it on a
   live intent. Keeping it out of the `LenderIntent` struct leaves that struct and
   its getters' ABI unchanged; `setLenderIntent` itself gains the parameter (a
   deliberate pre-live ABI change, co-updated with its consumers). A flag with no
   credits is inert.
   **Contract-owned intents are out of scope in v1.** Intents owned by
   `AggregatorAdapterImplementation` or `BackstopVaultImplementation` cannot opt in:
   those are protocol-run vehicles, not perk buyers, and neither exposes a forwarding
   path. The setter refuses a contract owner by name rather than leaving a flag that
   could never be used.
3. **At fill** (`matchIntent`), in place of `chargeSolver()` and at the same
   position (last, so a refused fill spends nothing):
   - the solver's capacity covers the action (or the Solver limiter is dark) →
     `chargeSolver()` exactly as today; **no credit is spent**;
   - the solver's capacity would refuse it, AND the intent is flagged, AND its owner
     holds ≥ 1 credit → consume one credit
     (`consumePerkCredit(owner, PERK_PRIORITY_ROUTING)`), emit a dedicated event
     naming the intent key and the fill, and let the fill proceed with no capacity
     charge;
   - otherwise → the ordinary refusal (`ServiceCapacityExhausted`).
   A credit can never be spent on a fill that then reverts: the consume and the
   fill are one transaction.
4. **Previews agree with the fill.** `previewIntent` (the solver's own pre-check of
   capacity) answers exactly as the fill will, from one shared predicate ("make the
   check be the operation"): capacity-clear when the bucket covers it, also clear
   when exhaustion would be lifted by a credit, and refused otherwise — and it says
   which of the two clear cases applies, so a solver knows whether a credit will be
   spent.
5. **Reads.** A view returns, for an intent, whether it is flagged and how many
   priority credits its owner holds, so a solver can see before filling that the
   fill will not cost it capacity.
6. **Events.** `PerkCreditConsumed` already fires from `PerkFacet`; the fill adds an
   event linking the consumed credit to the intent and the resulting loan, so the
   indexer and the owner can audit every credit's use.

## What does not change

- Sanctions, the permissioned-solver gate, the intent's own limits (exposure, rate
  floor, LTV, duration, minimum fill), the LIF and every settlement rule.
- The capacity limiter for every fill the solver's capacity covers (flagged or not),
  every non-flagged fill, and every other route (`matchOffers`, `matchSignedOffer`,
  keeper actions).
- No refunds: an unused credit stays with its owner; credits are not transferable.

## Guards that hold before any money moves (Codex #2558 r1)

The consumer refusing a bad configuration at fill time would be too late: a buyer
would already have paid irreversibly. So the sale itself is guarded:

- **The priority perk is counted-only, enforced at configuration.** `setPerkConfig`
  refuses a non-zero `durationSeconds` for `PERK_PRIORITY_ROUTING` by name. No timed
  unit can ever be sold, and no timed sale can lock the id's mode
  (`PerkModeLocked`) into the wrong shape.
- **No sale while the perk can deliver nothing.** `purchasePerk` for the priority id
  refuses by name while the Solver capacity curve is dark. This is checked at the
  purchase itself, so it also covers every LATER transition that clears the curve —
  a VPFI token rotation (`LibServiceCapacity.onTokenRotated` clears every curve) or
  an admin clearing it — with no runbook step to remember and no stale price that
  can be bought in the gap.

## Pricing and arming (owner/admin, last)

**Preconditions, per chain, all required:**
1. the contract slice deployed on that chain;
2. the Solver capacity curve lit there (#1219);
3. **the keeper/solver change deployed** (Codex #2558 r1). The shipped matcher treats
   a capacity refusal as pass-wide and stops at the first intent that reports it, so
   it would never reach a later flagged intent that a credit could fill. The keeper
   must keep scanning past ordinary capacity refusals for credit-backed priority
   intents. Without that, the perk's benefit is not delivered, so it must not be
   sold;
4. **verification on a fork, not a live sale** (Codex #2558 r1). On a fork of that
   chain running the deployed bytecode, set the price, buy a credit, exhaust a
   solver's bucket, and confirm a flagged fill succeeds and spends exactly one
   credit while an unflagged one is refused. This proves the effect without ever
   offering a live sale before it is proven, and needs no privileged credit-mint
   surface.

Then `setPerkConfig(PERK_PRIORITY_ROUTING, price, 0)` is the LAST step on that
chain.

## Surfaces and scope of the first PR

- **Contracts:** the per-intent flag (written by `setLenderIntent`, cleared by
  cancel, toggled by the owner, refused for contract owners), the consumer at the
  fill, the shared predicate behind fill and preview, the two sale guards
  (counted-only configuration; no purchase while the Solver curve is dark), the read
  view, the event; tests that straddle each condition (flag on/off × credits 0/1 ×
  limiter dark/lit × bucket covering/exhausted) and prove a credit is spent only when
  the fill would otherwise have been refused.
- **App:** none in the first PR — the app has no lender-intent or perk-purchase
  screens today. When intents get a UI, it gains the opt-in toggle, the credit
  balance and a purchase step, under the RL-6 copy rules (a convenience the buyer
  pays for, never yield, return or price).
- **Keeper / solver: REQUIRED before pricing** (see the arming preconditions). The
  matcher must not treat a capacity refusal as terminal for the pass when a later
  intent is flagged and credit-backed; it reads the shared preview to tell the two
  apart. That change belongs to the keeper track and gates arming, not the
  contract slice.
- **Indexer:** handle (or consciously allowlist) the new event per the
  event-coverage guardrail.

## Considered and rejected

- **Fill-ordering priority** — breaks the neutral-book rule (others' intents wait).
- **Faster keeper service** — off-chain only, and the keeper's own queue order
  still disadvantages others it serves.
- **One credit per intent, all fills exempt** — an unbounded exemption on standing
  intents.
- **Spend a credit on every flagged fill while the limiter is lit** (this note's
  first draft) — a credit spent on a fill the solver could already afford buys the
  owner nothing.
- **A timed priority window** — would exempt fills the owner never needed, and
  couples the perk to wall-clock rather than to the service delivered.
