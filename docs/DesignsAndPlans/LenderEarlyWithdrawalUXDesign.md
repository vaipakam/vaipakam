# Lender Early-Withdrawal UX Design

Status: proposal (doc-only PR — implement in a follow-up against the
ratified spec). **Merge order**: this document cites its sibling,
`EarlyRepaymentOptionsUXDesign.md`, which lands with PR #1500 — merge
that PR first so the link below resolves on `main` (until then, read
the sibling from #1500's branch). Sibling of
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
open lending offer, list it for sale at a buyer rate of their own
choosing (the purchase amount is always the loan's live outstanding
principal), or simply hold it to maturity. The app exposes the two sale paths as
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
nothing costs nothing in sale forfeitures**, and prices the exits
honestly against it. Waiting is free of SALE costs — it is not
risk-free: the payout depends on the borrower actually repaying, and
a default resolves through the normal recovery process instead. Every
wait-path sentence in this design carries that conditionality; a
"guaranteed payout at maturity" framing is prohibited by the same
never-promise-yield rule the rest of the app follows.

## Vocabulary — plain words before mechanics

| Protocol / spec term | User-facing words |
| --- | --- |
| §9 Option 1 — sell into a lender (buy) offer (`sellLoanViaBuyOffer`) | "Sell your position now" |
| §9 Option 2 — sale-vehicle listing (`createLoanSaleOffer` → buyer accepts) | "List your position at your chosen buyer rate" |
| §9 Option 3 — wait to maturity | "Keep it to the end (nothing to do)" |
| Accrued-interest forfeiture | "the interest built up so far is given up" |
| Rate shortfall (buyer's rate above the loan's) | "buyer rate top-up" |
| Held-for-lender balance migrating to the buyer | "money already set aside for you on this loan goes to the buyer too" |
| Sale vehicle / internal transitional loan | never named — implementation detail |
| Position-NFT transfer lock (live listing) | "your position is transfer-locked while listed" |

Totals are quoted as "about X" in token units with the
exact-on-chain-at-execution note. The forfeit rule is worded as an
outcome, never a formula: "you receive your principal minus the larger
of the interest built up so far or the buyer's rate top-up — never
both."

**The forfeit rule is not the whole cost.** A sale transfers the
position, and with it any amount the protocol has ALREADY set aside
for this loan's lender — the held-for-lender balance that accumulates
from things like an earlier obligation transfer's lender-protection
payment or a partial internal match. Both sale paths migrate that
balance to the incoming lender, so a seller with a non-zero held
balance gives up already-earned claim rights on top of the advertised
forfeiture. Every net quote and confirmation MUST therefore state the
full picture:

> what you receive (principal minus the larger of accrued interest or
> the buyer rate top-up) **and** what transfers with the position
> (any money already set aside for you on this loan)

A quote that silently omits a non-zero held balance is a
mispriced sale, not a rounding difference — it can dwarf the
forfeiture. Where the held balance is non-zero, the sale surfaces it
as its own line (never folded into the net figure), and where it
cannot be read the flow says the total cost is unavailable rather
than quoting a partial one.

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
  marked as the default that costs nothing in sale forfeitures — and
  worded conditionally, never as a promise: "Nothing to do — if the
  borrower repays, you claim the principal plus the agreed interest
  at the end; if they don't, the normal default process applies and
  recovery can be less." The sale rows follow, each with its cost
  stated up front.
- Each sale row carries the §9-mandated cost disclosure in one
  sentence: selling early gives up the larger of the interest built
  up so far or the buyer's rate top-up. The listing row adds its
  structural facts — and they are cross-party, not just the seller's:
  the seller's position is transfer-locked while listed, the sale
  settles only when a buyer accepts, and **while the listing stands
  it also holds the BORROWER's discretionary paths on the underlying
  loan** (partial repayment is held by the app and collateral
  withdrawal is refused by the protocol, both to protect the buyer's
  signed terms). As the protocol stands a listing never expires and
  only the seller cancels it, so the disclosure must say plainly that
  listing freezes those borrower affordances until the sale completes
  or the seller cancels — and this design REQUIRES that gap be closed
  before the surface ships (mandatory finite expiry + permissionless
  teardown; see the Layer-3 checklist and open question 0), after
  which the row states the chosen expiry as part of the disclosure.
- Availability is honest and explanatory: the listing row states when
  the path is unavailable on the current network (the app already
  refuses to render a form whose final signature cannot succeed), for
  loans with NFT collateral (Phase 1 listing is ERC-20-collateral
  only, per §9), when the position carries an unresolved held-VPFI
  balance (§9 refuses to list a position it cannot unify to a single
  settlement identity — the row says the position must be cleared
  first and names the remaining exits meanwhile), and once the loan
  has REACHED OR PASSED its maturity — a fully-elapsed term is
  refused at CREATION, so past maturity the sale rows flip to "the
  loan is past its due date — the borrower repays or the default
  process resolves it" instead of advertising an exit that cannot be
  created. Note the asymmetry that prerequisite 1 exists to close:
  refusing creation does **not** retire a listing that already went
  live before the due date, which stays takeable through the grace
  window — so hiding the row is not the same as closing the sale, and
  a live listing's own surface must keep telling the truth about it
  past maturity rather than disappearing. The same rule holds while the
  BORROWER has a live linked exit on the loan (a preclose offset):
  the protocol refuses a sale listing until that offset completes or
  is cancelled, and the row says which pending flow must clear first
  rather than surfacing the refusal as a revert. The instant-sell row
  states when no compatible offer is on the book right now. NFT
  rentals get no chooser at all — lender early withdrawal excludes
  them entirely in Phase 1.
- Mode behaviour is identical to the borrower chooser: rows never
  submit; Advanced rows jump to the existing cards; Basic mode gets
  one explicit "Show these tools (switches to Advanced view)" action
  whose sub-line says the switch submits nothing.

### Layer 2 — the tools (Advanced mode, existing flows hardened)

Both sale flows already exist **in alpha02** — the instant-sell picker
is `apps/alpha02/src/components/EarlyExitFlow.tsx` (it calls
`sellLoanViaBuyOffer` and quotes net-to-seller from the shared
`sellerEconomics` settlement mirror) and the listing form is
`LoanSaleFlow.tsx` with its `LoanSalePendingCard`. Both already meet
the §9 frontend-warning requirement: net proceeds after
forfeiture/top-up are shown before confirmation, from the same mirror
the submit re-checks. (The older `apps/defi` surface implements only
the listing path — this design targets alpha02, so "harden the
existing flow" is accurate here and would not be for that app.) This
design adds the framing rules, not new mechanics — except where the
Contract-level prerequisites below say a path cannot be made safe by
framing at all:

1. **Cost before commitment.** The instant-sell picker orders
   candidate offers by net-to-seller (best first) and prints "You'd
   receive: about X" on every row; which side of the forfeit rule is
   binding (interest so far vs rate top-up) is stated in words when
   the buyer's rate is the driver, because "a higher-rate buyer costs
   you money" is the least intuitive fact on this surface. When the
   position carries a held-for-lender balance, that transferring
   amount is its OWN line on every row and in the confirmation (see
   the vocabulary section) — the ordering compares like with like
   (net receipt minus what transfers away), and an unreadable held
   balance blocks quoting rather than under-quoting.
2. **The listing form's one economic input is a RATE, not a price.**
   A listing's purchase amount is fixed to the loan's live
   outstanding principal — the seller never chooses what the buyer
   pays; they choose the yearly rate the buyer will earn for the
   remaining term. The form says exactly that, seeds the rate from
   the loan's own rate (the neutral choice), and states the
   trade-off in both directions: a HIGHER buyer rate makes the
   position more attractive to buyers — likelier to sell sooner —
   but raises the rate top-up the seller funds at completion; a
   LOWER rate costs the seller less but can sit unsold. The forfeit
   rule is repeated against the live figure.
3. **Failure is framed as safe — with the race named honestly.**
   Drift the app has DETECTED (a consumed, re-priced, or expired
   candidate) closes the review before any wallet prompt for a fresh
   look; drift that lands in the gap between the final check and the
   transaction's inclusion cannot be caught by any frontend and
   instead produces a safe on-chain refusal, surfaced as a plain
   explanation with a refreshed view — never money moved. The design
   promises pre-prompt detection only for what is detectable.
4. **No stacked exits — across BOTH parties.** One live exit vehicle
   per position: a live listing blocks the instant sell (and
   vice-versa where the contracts enforce it), and a live
   borrower-side linked exit (a preclose offset) blocks creating a
   listing at all — each said in one line naming which pending flow
   must clear first, rather than discovered as a revert.

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
- **The borrower-side freeze is owned, not ignored**: because a live
  listing holds the borrower's partial-repay AND collateral-withdrawal
  affordances indefinitely (no expiry; only the seller cancels), the
  implementation must (a) disclose that cross-party effect on the
  listing form BEFORE confirmation, and (b) ship an escape that
  releases **every** hold, not just one of them. The requirement is
  therefore specific: a **mandatory finite listing expiry** (no
  never-expires option — the seller picks a duration inside a bounded
  range, and the form has no way to opt out) **plus a permissionless
  teardown** once expired, so ANY party — the borrower, a keeper, the
  app — can clear an abandoned listing and release both the lender-NFT
  lock and the borrower-side holds. The FunctionalSpecs buyer-re-sign
  flow (a partial repayment invalidates the old signature and the
  buyer re-signs for the smaller position) is a valuable ADDITION that
  frees partial repayment sooner, but it is not a substitute: it
  leaves collateral withdrawal blocked on-chain until the listing
  actually ends. Expiry + permissionless teardown is the floor;
  re-sign layers on top. Shipping neither leaves an abandoned or
  malicious listing as an indefinite lever over the borrower.

## Decision guidance the chooser encodes

| Path | When it genuinely fits | Cost shape |
| --- | --- | --- |
| Keep it to the end | No urgent need for the capital | No sale forfeiture — principal + agreed interest if the borrower repays; the normal default process (recovery may be less) if they don't |
| Sell now | Need liquidity today; an acceptable offer is on the book | Principal minus the larger of interest-so-far or the buyer rate top-up, paid instantly — plus any money already set aside for you on this loan, which transfers to the buyer |
| List at your chosen buyer rate | Want liquidity but not at today's book rates | Same costs at completion (forfeiture + any transferring set-aside money); your position locked and the borrower's partial-repay/collateral paths held until it sells, expires, or you cancel; no guarantee of a buyer |

The teaching moment (inverse of the borrower side) is REGIME-AWARE,
not absolute, because the seller pays the LARGER of two figures that
move in opposite directions as time passes: the interest built up so
far only grows, while a higher-rate buyer's top-up is proportional to
the remaining term and therefore shrinks. When accrued interest is
the binding cost (same-or-lower buyer rates — the common book case),
waiting cheapens nothing and selling later forfeits more; when the
top-up is binding (a higher-rate buyer), waiting can actually improve
the seller's net until the two figures cross. The chooser therefore
never teaches a blanket "sell early or never" rule — the honest
instrument is the CURRENT net quote on each candidate ("you'd receive
about X today"), which already embeds whichever side is binding, with
the which-side-is-binding note from Layer 2 as the explanation.

## What we deliberately do NOT show

- The forfeit/shortfall formulas, seconds-precision accrual, or bps
  anywhere on these surfaces.
- The sale-vehicle mechanics (§9 Option 2's internal transitional
  structure, consolidation-at-listing, buyer's signed floors) — the
  user-visible truths are only: your chosen buyer rate, the locks
  (yours and the borrower-side holds), the settlement on acceptance,
  and the cancel path.
- A yield projection on the wait row ("you will earn X by maturity")
  in Phase 1 — it reads as a promise; the app-wide rule is that
  lender yield is never presented as guaranteed. Phase 2's comparison
  handles this with repays-on-time conditionality.
- Keeper-delegated listing (Settings territory).
- Anything on rental positions (excluded from lender early
  withdrawal in Phase 1).

## Contract-level prerequisites (Phase-1 blockers)

The adversarial pass on this doc surfaced five gaps that are **not
frontend problems** — no amount of copy, preflight, or quoting in the
app can close them, because the risk lives in the settlement paths
themselves. They are recorded here as blockers rather than assumed
away: a UX design that ships the listing surface over them would be
promising safety the protocol does not provide. Each was verified
against `EarlyWithdrawalFacet` at the commit this doc was reviewed
against.

1. **A listing outlives the loan's maturity.** Completion gates only
   on the loan still being `Active`, which it remains throughout the
   grace window — so a listing created before the due date stays
   takeable after it. Hiding the sale row in the app does not make the
   on-chain offer unsellable: a buyer can still acquire an overdue
   position, and the seller can still be charged post-term accrual.
   *Required*: bound listing expiry at the loan's maturity, and permit
   teardown at that boundary.
2. **The seller's completion cost is neither escrowed nor reserved.**
   Completion pulls the cost from the stored lender by transfer, while
   listing escrows nothing and secures no non-revocable allowance — so
   a seller with no allowance (or who revokes it later) can publish an
   apparently-takeable offer whose every acceptance reverts after
   burning the buyer's gas, while the listing keeps holding the
   borrower's paths. *Required*: net the cost out of the incoming
   principal, or reserve it at listing. A frontend allowance preflight
   cannot prevent later revocation and must not be mistaken for one.
3. **The listing path has no cost cap.** The direct-sale path refuses
   a cost above principal (`RateShortfallTooHigh`); the listing
   completion path has no equivalent guard and pulls the whole cost
   from the seller. On a long-dated loan the accrued interest or rate
   top-up can therefore exceed the principal, leaving the seller
   out of pocket beyond the sale proceeds — which the "principal
   minus a cost" framing does not describe. *Required*: an equivalent
   economic cap; failing that, the UI must render and confirm a
   negative net as an explicit additional payment, never as a receipt.
4. **A listing binds only the buyer's rate, not the seller's
   economics.** The seller confirms a figure at listing time, but
   completion recomputes accrued interest and the top-up at the
   acceptance block, and a cancel can be raced by a buyer. The
   approximate-execution note in this design is *disclosure, not
   consent*. *Required*: an enforceable minimum net (or maximum cost)
   stored with the listing, a tight enough deadline, or fresh seller
   authorization when the bound is exceeded.
5. **The direct sale admits on the stored borrower, not the current
   one.** That path passes the loan's stored borrower to the
   compliance check and never compares the buy-offer creator against
   the current borrower-position holder — so after a borrower-position
   transfer the picker can admit a buyer incompatible with the actual
   borrower, or the actual borrower themselves, which leaves one
   wallet as both lender and borrower and then blocks that borrower's
   ordinary repayment. *Required*: resolve the current borrower-NFT
   holder in the on-chain path (the listing-accept path already does),
   with the frontend filter mirroring it.

Together with the borrower-escape requirement in the Layer-3
checklist, these gate Phase 1: **the listing surface does not ship
until items 1–4 are resolved, and the instant-sell picker's admission
filter is not trustworthy until item 5 is.** The frontend work in this
design is otherwise ready to build against.

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
rules on the two existing flows (including the held-balance line in
every quote), and the Layer-3 parity hardening (fail-closed lock read,
dead-listing teardown state, stale-marker discard). **Gated on the
Contract-level prerequisites section**: the borrower-escape
requirement (mandatory finite expiry + permissionless teardown) and
prerequisites 1-4 must be resolvable with the deployed contracts, or
their contract changes land first — the listing surface does not ship
over them, and prerequisite 5 bounds how far the instant-sell
admission filter can be trusted. Fork-tier spec: chooser
renders for the lender in Basic mode; instant sell drives to an
on-chain lender change; listing posts, locks, and cancels; a quote on
a position carrying a held balance shows that line.

**Phase 2 — comparison quotes (with the borrower "help me choose"
wizard).** Opt-in side-by-side: "sell now nets about X" vs "holding
to maturity pays about Y *if the borrower repays on time*" — the
conditional phrasing is mandatory; the projection is never a promise.

**Phase 3 — rentals decision.** Whether rental lender positions get
any early-exit story when the protocol grows one; until then the
chooser stays absent on rentals.

## Open questions

0. The borrower-freeze escape is REQUIRED (mandatory finite expiry +
   permissionless teardown — see the Layer-3 checklist); what remains
   open is its shape: what bounded range the expiry may span (and its
   default), and whether the current contracts already permit a
   permissionless teardown of an EXPIRED-but-uncancelled listing or
   whether that needs a contract change alongside this frontend work.
   If it needs a contract change, this design's Phase 1 depends on it
   — the app cannot manufacture a borrower escape the protocol does
   not expose, and shipping the listing surface without one would
   knowingly hand sellers an indefinite lever. Resolve before
   implementation starts.
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
