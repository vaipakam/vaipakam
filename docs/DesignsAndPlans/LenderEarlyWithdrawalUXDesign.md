# Lender Early-Withdrawal UX Design

Status: proposal (doc-only PR — implement in a follow-up against the
ratified spec). Sibling of
[`EarlyRepaymentOptionsUXDesign.md`](EarlyRepaymentOptionsUXDesign.md),
which sets the layered-disclosure method this document applies to the
lender side; the naive-user wording rules and mode boundary come from
[`BasicUserUXSimplification.md`](BasicUserUXSimplification.md). The
intended-behaviour source is
`docs/FunctionalSpecs/ProjectDetailsREADME.md` §9 (Early Withdrawal by
Lender). The platform is prelive: no habits or compatibility to
preserve — the shape can still be corrected freely.

## Purpose

The protocol gives a lender three ways to handle an active ERC-20 loan
position before maturity (§9): sell it instantly into a compatible
open lending offer, list it for sale at a price of their own choosing,
or simply hold it to maturity. The app exposes the two sale paths as
Advanced-mode cards with no awareness layer and no comparison
guidance, and gives the passive path no words at all.

The naive-lender risks mirror the borrower side, with one inversion:

- **Under-exposure**: a lender who needs liquidity never learns an
  exit exists, or discovers the listing card and uses it without
  understanding that *every* early sale costs them the larger of the
  interest built up so far or a rate top-up — money the "wait" path
  keeps.
- **Over-exposure**: putting two sale instruments in front of every
  lender invites exits that lose money for no need. For a lender the
  correct default is usually to do **nothing** — and a design that
  makes selling look like the expected action is worse than the
  status quo.

That inversion is this document's central rule: **the borrower chooser
promotes ways to act; the lender chooser promotes the fact that doing
nothing is free and complete**, and prices the exits honestly against
it.

## Vocabulary — plain words before mechanics

| Protocol / spec term | User-facing words |
| --- | --- |
| §9 Option 1 — sell into a lender (buy) offer (`sellLoanViaBuyOffer`) | "Sell your position now" |
| §9 Option 2 — sale-vehicle listing (`createLoanSaleOffer` → buyer accepts) | "List your position at your price" |
| §9 Option 3 — wait to maturity | "Keep it to the end (nothing to do)" |
| Accrued-interest forfeiture | "the interest built up so far is given up" |
| Rate shortfall (buyer's rate above the loan's) | "buyer rate top-up" |
| Sale vehicle / internal transitional loan | never named — implementation detail |
| Position-NFT transfer lock (live listing) | "your position is transfer-locked while listed" |

Totals are quoted as "about X" in token units with the
exact-on-chain-at-execution note. The forfeit rule is worded as an
outcome, never a formula: "you receive your principal minus the larger
of the interest built up so far or the buyer's rate top-up — never
both."

## The layered disclosure model (lender side)

### Layer 0 — the primary state (Basic mode, unchanged)

A lender on an active loan has no primary action — the page already
answers "what happens if I do nothing" (the borrower repays or the
default process runs; the lender claims at the end). Nothing in this
design adds a primary button, and no surface may ever nudge a lender
toward selling as the expected next step.

### Layer 1 — awareness: the chooser card (both modes)

One card — "Your options as the lender" — on the lender's active-loan
page in both modes, strictly informational:

- **Order is the message.** The wait-to-maturity row renders FIRST,
  marked as the no-cost default: "Nothing to do — you're owed the
  principal plus the agreed interest at the end, and you claim it
  after the borrower repays." The sale rows follow, each with its
  cost stated up front.
- Each sale row carries the §9-mandated cost disclosure in one
  sentence: selling early gives up the larger of the interest built
  up so far or the buyer's rate top-up. The listing row adds its two
  structural facts: the position is transfer-locked while listed, and
  the sale settles only when a buyer accepts.
- Availability is honest and explanatory: the listing row states when
  the path is unavailable on the current network (the app already
  refuses to render a form whose final signature cannot succeed) and
  for loans with NFT collateral (Phase 1 listing is ERC-20-collateral
  only, per §9); the instant-sell row states when no compatible offer
  is on the book right now. NFT rentals get no chooser at all —
  lender early withdrawal excludes them entirely in Phase 1.
- Mode behaviour is identical to the borrower chooser: rows never
  submit; Advanced rows jump to the existing cards; Basic mode gets
  one explicit "Show these tools (switches to Advanced view)" action
  whose sub-line says the switch submits nothing.

### Layer 2 — the tools (Advanced mode, existing flows hardened)

The two sale flows already exist (the instant sell picker and the
listing form) and already meet the §9 frontend-warning requirement:
net proceeds after forfeiture/top-up are shown before confirmation,
computed by the same settlement mirror the submit re-checks. This
design adds the framing rules, not new mechanics:

1. **Cost before commitment.** The instant-sell picker orders
   candidate offers by net-to-seller (best first) and prints "You'd
   receive: about X" on every row; which side of the forfeit rule is
   binding (interest so far vs rate top-up) is stated in words when
   the buyer's rate is the driver, because "a higher-rate buyer costs
   you money" is the least intuitive fact on this surface.
2. **The listing form seeds no misleading defaults.** The asking rate
   seeds from the loan's own rate (the neutral choice); the form
   states that a higher ask makes the position cheaper for buyers to
   ignore, and repeats the forfeit rule against the live figure.
3. **Failure is framed as safe.** A drifted candidate (consumed,
   re-priced, expired) stops before any wallet prompt for a fresh
   review; a buyer's failed acceptance never moves the seller's
   position.
4. **No stacked exits.** One live exit vehicle per position: a live
   listing blocks the instant sell (and vice-versa where the
   contracts enforce it), said in one line rather than discovered as
   a revert.

### Layer 3 — the live listing's standing surface (existing, hardened)

The listing's pending card already renders on the chain's own lock
record. This design imports the hardening rules the borrower-side
review round proved necessary, as a parity checklist for the
implementation PR:

- **Fail closed while unknown**: until the lock read answers, the
  surfaces a live listing would interlock hold in a visible checking
  state — an unresolved read must not expose a conflicting action.
- **Never present a dead listing as completable**: when the
  underlying loan has settled (repaid, defaulted, liquidated), the
  card flips to the §9 teardown story — the listing can be cleaned up
  and the position unlocked — instead of implying a buyer can still
  accept. The teardown is permissionless on-chain; the card offers it
  to the seller directly.
- **Discard stale device memory**: a remembered listing id the chain
  no longer knows is dropped, not offered for cancellation.
- **Full unwind means full unwind**: cancelling a listing releases
  everything the listing set up, and anything that cannot be released
  automatically is said plainly with its remedy.

## Decision guidance the chooser encodes

| Path | When it genuinely fits | Cost shape |
| --- | --- | --- |
| Keep it to the end | No urgent need for the capital | None — full principal + agreed interest at maturity |
| Sell now | Need liquidity today; an acceptable offer is on the book | Principal minus the larger of interest-so-far or the buyer rate top-up, paid instantly |
| List at your price | Want liquidity but not at today's book prices | Same forfeit rule at completion; position locked while listed; no guarantee of a buyer |

The teaching moment (inverse of the borrower side): **time works FOR
a waiting lender and AGAINST a selling one** — the longer the loan
has run, the more accrued interest a sale forfeits, while waiting
converts that same accrual into the payout. The chooser's cost lines
make this readable without a formula.

## What we deliberately do NOT show

- The forfeit/shortfall formulas, seconds-precision accrual, or bps
  anywhere on these surfaces.
- The sale-vehicle mechanics (§9 Option 2's internal transitional
  structure, consolidation-at-listing, buyer's signed floors) — the
  user-visible truths are only: your price, the lock, the settlement
  on acceptance, and the cancel path.
- A yield projection on the wait row ("you will earn X by maturity")
  in Phase 1 — it reads as a promise; the app-wide rule is that
  lender yield is never presented as guaranteed. Phase 2's comparison
  handles this with repays-on-time conditionality.
- Keeper-delegated listing (Settings territory).
- Anything on rental positions (excluded from lender early
  withdrawal in Phase 1).

## Prelive posture

Same as the borrower doc: no migration debt, contract redeploys
expected, and the live-review DoD applies to the implementation PR
(drive the chooser and both sale paths on the deployed testnet with
the dev wallets once the redeploy lands). The implementation reuses
the existing flows and settlement mirrors — this design adds the
awareness layer and the hardening checklist, not new contract calls.

## Roadmap

**Phase 1 — implementation PR after this doc ratifies.** The lender
chooser card (both modes, wait-first ordering), the Layer-2 framing
rules on the two existing flows, and the Layer-3 parity hardening
(fail-closed lock read, dead-listing teardown state, stale-marker
discard). Fork-tier spec: chooser renders for the lender in Basic
mode; instant sell drives to an on-chain lender change; listing
posts, locks, and cancels.

**Phase 2 — comparison quotes (with the borrower "help me choose"
wizard).** Opt-in side-by-side: "sell now nets about X" vs "holding
to maturity pays about Y *if the borrower repays on time*" — the
conditional phrasing is mandatory; the projection is never a promise.

**Phase 3 — rentals decision.** Whether rental lender positions get
any early-exit story when the protocol grows one; until then the
chooser stays absent on rentals.

## Open questions

1. Should the instant-sell row hide entirely when the book has no
   compatible offer, or show with "no matching offer right now"?
   Leaning show-with-reason — an option that appears only sometimes
   reads as a bug (same rule as the borrower chooser).
2. Should the wait row surface the loan's due date inline (it is
   already in the summary receipt above)? Leaning no — duplication,
   and the chooser must stay short.
3. When both sale paths are simultaneously available and the book's
   best net exceeds the user's likely ask, should the listing row say
   "the instant sale currently nets more"? Deferred to Phase 2 — it
   requires the comparison quote machinery and risks nudging.
