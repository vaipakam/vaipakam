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
   it. So the flag is stored in its own appended mapping under the same key, and it
   is **reset to off by every `setLenderIntent` and cleared by
   `cancelLenderIntent`**; the owner opts a LIVE intent in with a separate setter.
   A replacement intent never inherits an old opt-in. (As built in #2559 —
   `setLenderIntent`'s signature is unchanged; see "Surfaces and scope".) A flag
   with no credits is inert.
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
  (`PerkModeLocked`) into the wrong shape. The refusal applies only when the
  write would ARM the perk: a zero price (disarm) is accepted at any duration,
  so a deployment holding a legacy timed configuration of this id can still
  take its price down, and the deliverability predicate below requires the
  counted shape, so such a legacy configuration is never sold (Codex #2563 r2).
- **No sale while the perk can deliver nothing — one deliverability predicate.**
  `purchasePerk` for the priority id refuses by name unless the perk can be
  delivered RIGHT NOW, and "deliverable" is a single predicate shared with the
  fill path: the Solver capacity curve is lit (otherwise no fill is ever refused for
  capacity, so a credit can unlock nothing) **and** intent matching is live — both
  master gates `partialFillEnabled` and `lenderIntentEnabled` on, since
  `matchIntent` reverts outright while either is off (Codex #2558 r2). Checking at
  the purchase itself covers every LATER transition that breaks deliverability — a
  VPFI token rotation (`LibServiceCapacity.onTokenRotated` clears every curve), an
  admin clearing a curve, or either master gate being switched off — with no
  runbook step to remember and no stale price that can be bought in the gap. Any
  future precondition of the fill joins this one predicate rather than a second
  check.

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

**Starting price (owner, 2026-10-19): 2 VPFI per credit** on the testnets — four
times the 0.5 VPFI default notification fee, since a credit buys a fill that
would otherwise wait — set only after preconditions 3 and 4 hold on that chain,
and revisited before any mainnet pricing.

**Applied 2026-10-19** on Base Sepolia and Arbitrum Sepolia, once the keeper change
was live there and `test/fork/PriorityRoutingPerkLiveForkTest.t.sol` had passed on a
fork of each chain's deployed Diamond. That test runs against the live Solver curve, the
live intent gates and the live oracle, and makes no change on the fork except the arming
write. **BNB testnet stays unpriced.** Its deployment carries no oracle-priced test
assets, so no lender intent can be filled there. Precondition 4 therefore cannot hold on
its live state, and a credit sold there could never be used. Price it only once a
fillable pair exists and the same fork check passes there.

Then `setPerkConfig(PERK_PRIORITY_ROUTING, price, 0)` is the LAST step on that
chain. That write is also the **explicit arming of the effect** (Codex #2563 r5):
the first priced, counted write by this version sets a one-time marker that the
deliverability predicate and the fill's credit check both require, with an event.
So a price or credits for id 1 inherited from before #2550 never activate by
themselves after an upgrade, and the arming write is refused outright while
units of id 1 sold before the effect existed are outstanding — those buyers paid
for something else, so their credits must never acquire a capacity exemption.

## Surfaces and scope of the first PR

- **Contracts (as built, #2559):** the per-intent flag — **reset to off by every
  `setLenderIntent`, cleared by cancel, toggled by the owner on a live intent**, and
  refused for protocol-run owners; the consumer at the fill
  (`LibPriorityRouting.chargeFill`); the shared predicate behind the fill and the
  read view; the two sale guards — counted-only configuration, and **the full
  three-condition deliverability predicate** at purchase (Solver curve lit AND
  `partialFillEnabled` AND `lenderIntentEnabled`; #2559 item 1); a keyed
  `LenderIntentPrioritySet` event on **every** opt-in write and `IntentPriorityFill`
  on every credit spend (#2559 item 4); tests that straddle each condition (flag
  on/off × credits 0/1 × limiter dark/lit × bucket covering/exhausted, and each
  deliverability condition separately) and prove a credit is spent only when the
  fill would otherwise have been refused.
- **`setLenderIntent` keeps its signature** (#2559 item 2). An earlier revision of
  this note gave it a new opt-in parameter, which would have created a new selector
  and required a `Remove` of the old one so a stale client could not rewrite an
  intent without assigning the flag. The built shape avoids the problem at its
  source: every `setLenderIntent` resets the flag, whichever client calls it, and
  the opt-in is a separate call on the live intent. No selector changes, so nothing
  needs retiring, and the adapter, backstop, keeper and app callers are unchanged.
- **The read view is a block-state snapshot** (#2559 item 3).
  `getLenderIntentPriority(owner, pair, solver, initiator)` reports the opt-in, the
  owner's credits, whether the solver's capacity covers the fill and whether a
  credit would unlock it — as of the block read. Capacity accrues, other fills spend
  it, and the owner may spend a credit or change the opt-in before a fill is mined;
  the mined `IntentPriorityFill` event is the authoritative record that a credit was
  spent.
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
