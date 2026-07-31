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
> the buyer rate top-up), **and** what transfers with the position
> (any money already set aside for you on this loan), **and** what is
> given up outright (your pending reward credit for holding this
> position)

A quote that silently omits a non-zero held balance is a
mispriced sale, not a rounding difference — it can dwarf the
forfeiture. Where the held balance is non-zero, the sale surfaces it
as its own line (never folded into the net figure), and where it
cannot be read the flow says the total cost is unavailable rather
than quoting a partial one.

**The third line is a forfeiture, not a transfer — and today it is not
even guaranteed.** Alongside the settlement, both sale paths *attempt*
to close the exiting lender's accrued interaction-reward entry as
*forfeited* — the accrual routes to treasury, and the incoming lender is
opened a fresh entry covering only the window from the day after the
sale to the original end. The seller does not hand this credit to the
buyer; they lose it, and the buyer starts a shorter one. So a sale can
cost a lender three distinct things, and the quote must not present the
first as the total.

The word *attempt* is load-bearing. The reward migration runs as a
best-effort self-call whose failure is deliberately swallowed so that
settlement proceeds regardless — so on a deployment where that
bookkeeping reverts or the facet is not cut, the sale still completes,
the seller's entry is NOT forfeited, and the buyer gets no residual
entry. The copy must therefore not describe the outcome as inevitable
while the mechanism is best-effort; **prerequisite 12 requires the
migration be made atomic or durably recoverable**, and until it is, the
wording says what is intended to happen rather than asserting it as
certain. Getting this backwards in either direction is a real cost:
promising a forfeiture that may not occur misprices the sale, and
promising a residual entry the buyer may never receive misprices the
purchase.

Where the pending credit's value cannot be read on the client,
the line says so explicitly ("your pending reward credit for this
position is given up — amount not shown here") rather than being
omitted: an unquotable cost that the user is told about is honest,
whereas silence reads as "there is no such cost". This applies to
every row in the instant-sell picker, the listing form, and both
confirmations.

## The layered disclosure model (lender side)

### Layer 0 — the primary state (Basic mode, unchanged)

A lender on an active loan has no primary action — the page already
answers "what happens if I do nothing" (the borrower repays or the
default process runs; the lender is paid on the loan's schedule where
it has one, and claims the remainder at the close). Nothing in this
design adds a primary button, and no surface may ever nudge a lender
toward selling as the expected next step.

### Layer 1 — awareness: the chooser card (both modes)

One card — "Your options as the lender" — on the lender's active-loan
page in both modes, strictly informational:

- **Order is the message.** The wait-to-maturity row renders FIRST,
  marked as the default that costs nothing in sale forfeitures — and
  worded conditionally, never as a promise — and **cadence-aware**,
  because on a loan with a periodic interest schedule the lender is
  paid interest DURING the term, not only at the end (a partial
  repayment can also settle interest early). Two shapes, chosen from
  the loan's own schedule rather than assumed:
  - *No schedule (interest settles at the close)*: "Nothing to do — if
    the borrower repays, you claim the principal plus the agreed
    interest at the end; if they don't, the normal default process
    applies and recovery can be less."
  - *Periodic schedule*: "Nothing to do — interest is paid to you on
    the loan's own schedule as the borrower settles it, and you claim
    the principal plus whatever interest is still outstanding at the
    end; if they don't repay, the normal default process applies and
    recovery can be less."

  A single end-of-term sentence on a periodically-settling loan
  misstates WHEN the lender gets paid, which is exactly the fact this
  row exists to convey. The sale rows follow, each with its cost
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
4. **Candidate admission covers the ACCESS gates, not just the
   economics.** On a risk-gated or permissioned deployment the sale
   paths re-check the incoming buyer's risk tier / per-pair consent,
   jurisdiction and KYC, and the sanctions movement gates. The existing
   picker filters offer shape and economics only, and its pre-sign
   simulation is advisory — it never disables signing — so an
   economically perfect candidate can still be one whose acceptance is
   already certain to revert. *Required hardening*: run the live
   access/consent, jurisdiction, and sanctions preflights and either
   exclude such candidates or hard-block the confirm, rather than
   routing the user into a guaranteed revert. Where a gate has no
   exposed read, the design says so plainly rather than implying the
   filter is complete (the same honesty rule the borrower-side
   compliance deferral follows).
5. **A zero buyer rate must be offerable.** The neutral seed for the
   listing form is the loan's own rate — which is `0` for a valid
   zero-interest loan — but the existing form rejects a rate that is
   not strictly greater than zero, even though offer creation permits a
   zero APR. As it stands the promised neutral default is unusable on
   exactly those loans, pushing the seller to either fund a needless
   top-up at a positive rate or abandon listing. *Required hardening*:
   accept zero as a valid buyer rate.
6. **No stacked exits — across BOTH parties.** One live exit vehicle
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
| Keep it to the end | No urgent need for the capital | No sale forfeiture, and your reward credit for this position keeps accruing — principal plus the agreed interest if the borrower repays (paid on the loan's schedule where it has one, otherwise at the close); the normal default process (recovery may be less) if they don't |
| Sell now | Need liquidity today; an acceptable offer is on the book | Principal minus the larger of interest-so-far or the buyer rate top-up, paid instantly — plus any money already set aside for you on this loan, which transfers to the buyer — plus your pending reward credit for this position, which is given up (shown as its own line, or marked unquotable where the value can't be read) |
| List at your chosen buyer rate | Want liquidity but not at today's book rates | The same three costs at completion (settlement forfeiture + any transferring set-aside money + the given-up reward credit, with the same unquotable fallback); your position locked and the borrower's partial-repay/collateral paths held until it sells, expires, or you cancel; no guarantee of a buyer |

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

The adversarial passes on this doc surfaced twelve gaps that are **not
frontend problems** — no amount of copy, preflight, or quoting in the
app can close them, because the risk lives in the settlement paths
themselves. They are recorded here as blockers rather than assumed
away: a UX design that ships a sale surface over them would be
promising safety the protocol does not provide. Each was verified
against `EarlyWithdrawalFacet` at the commit this doc was reviewed
against.

Items 1–4 belong to the **listing** path, 5–10 to the **instant-sell**
(direct buy-offer) path, and 11 and 12 to both. The instant-sell cluster is
large for one structural reason worth naming up front: that path
consumes a *generic standing lender offer* — an instrument authored to
open a fresh loan, never to assume a running one — so every term the
offer's creator authored has to be re-checked by hand against a live
loan the offer never described. Items 5–10 are each a missing hand-check
of that kind. See "Recommended shape" at the end of this section: the
pattern suggests the durable fix is a dedicated position-sale bid rather
than a growing list of patches on generic-offer consumption.

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
   minus a cost" framing does not describe. *Required*: the equivalent
   economic cap on the listing path. **There is no UI alternative.**
   An earlier draft of this section offered "or render a negative net
   as an explicit additional payment" as a fallback; that is withdrawn,
   because it contradicts this section's own premise and would let an
   implementer treat disclosure as resolution while the uncapped wallet
   debit ships intact. Disclosure is not a cap.
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

6. **The direct sale cannot express the seller's reviewed economics.**
   The entry point takes only a loan id and an offer id. It recomputes
   the forfeiture at execution and snapshots whatever held-for-lender
   balance exists *then* — so even when the offer itself has not
   drifted, a delayed transaction, or any operation that parks a new
   held payment in the meantime, can leave the seller receiving
   materially less than they reviewed or surrendering a payment that
   arrived after their preview. Prerequisite 4 requires this binding
   for the listing path; the direct path needs it too. *Required*: an
   enforceable minimum total receipt (or maximum cost) that **counts
   transferred held proceeds**, plus a deadline.
7. **The direct sale ignores every buyer-authored behavioural term.**
   `allowsPartialRepay`, `useFullTermInterest` and
   `periodicInterestCadence` are immutable take-it-or-leave-it terms of
   an offer, and this path compares none of them. A buyer who authored
   the default no-partial-repay can be migrated into a loan where
   partial repayment is enabled; a buyer who elected full-term interest
   can receive a pro-rata loan. *Required*: compatibility on every
   buyer-authored loan term.
8. **The direct sale does not bind NFT collateral identity.** For an
   ERC-20-principal loan backed by an NFT, the admission guard compares
   the collateral collection, asset type, and amount — but neither
   `collateralTokenId` nor `collateralQuantity`. A seller can therefore
   consume a lender offer authored for a *different token in the same
   collection* and force that offer's creator into an exposure they
   never chose. *Required*: exact token-id (and quantity) binding
   on-chain, mirrored in the picker — or exclude NFT-collateral loans
   from instant selling, as the listing path already does.
9. **The direct sale ignores the buyer's authored duration as a
   floor.** The guard rejects only an offer *longer* than the loan's
   remaining term. Since the sale does not re-term the live loan, a
   one-day lender offer can be consumed into a position that stays
   locked for another thirty — the buyer is committed far past the term
   they authored, and the picker compounds it by displaying the offer's
   shorter duration. *Required*: the loan's live remaining exposure
   must fit *within* the buyer-authored duration (or a dedicated
   position-sale bid whose signed terms cover the running loan) —
   **plus an explicit pre-maturity requirement on this path**. That
   second half is load-bearing: a fit-within rule ALONE would make
   overdue direct sales newly consumable, because an `Active` loan
   inside its grace window has zero remaining days and therefore fits
   every positive-duration offer. Item 1 supplies the maturity cutoff
   only for listings, and this path has no maturity check of its own,
   so the fix must add one rather than inherit it. Layer 1 states that
   BOTH sale rows go unavailable at maturity; the contract must
   actually enforce that on this path, not merely have the UI hide it.
10. **The direct sale never checks offer expiry.** A GTT lender offer
   whose deadline has passed but which has not yet been
   permissionlessly cancelled is still consumable: the path checks the
   offer type and its accepted flag, and never consults the
   is-expired helper. A seller can take the creator's still-vaulted
   principal *after* their stated consent window closed. This also
   corrects a promise made earlier in this design — an expired
   candidate does **not** produce a safe on-chain refusal today, and a
   frontend expiry filter cannot protect an offer creator from a direct
   caller. *Required*: the expiry guard before any lien release or vault
   movement.
11. **Neither sale path checks the position's live solvency.** Opening
   an ordinary loan requires a health factor at or above the protocol
   minimum, and a position that falls under the liquidation threshold is
   permissionlessly liquidatable. A sale checks neither: both paths gate
   on the loan being `Active` and nothing more. A lender watching
   collateral fall can therefore hand an already-underwater position to
   a counterparty who authored terms on the assumption that a new
   position starts comfortably over-collateralized — the incoming lender
   inherits a loan that may be liquidatable in the same block, at a
   price set from principal and accrued interest that says nothing about
   the collateral shortfall. This is the one item that is *not*
   instant-sell-specific: the listing path admits the same trade, and
   there a buyer at least sees the loan id and can check it, which is
   why it is stated once here for both. *Required*: an explicit
   solvency admission floor on both sale paths — either the loan's live
   health factor at or above a stated sale threshold, or (the honest
   alternative) an on-chain acknowledgement from the incoming lender
   that they are knowingly buying a sub-threshold position, with the
   frontend surfacing the live figure either way.

   **The acknowledgement branch only works where the buyer is present at
   the fill.** On the listing path they are: the buyer drives acceptance,
   so consent to *this* position in *this* state can be taken at that
   moment. On the instant-sell path they are not — the seller fills a
   standing offer the buyer authored earlier, for no particular loan. A
   blanket "I accept distressed positions" flag on a generic offer
   therefore proves nothing about the position actually assigned, and
   would be strictly worse than no acknowledgement at all: it would let
   sellers route *subsequently* underwater loans onto standing-offer
   creators while pointing at a consent they never gave for this trade.
   Surfacing the health figure in the SELLER's frontend does not repair
   that — it informs the wrong party. So for the generic-offer shape the
   choice narrows to two real options: keep a **hard admission floor**
   (no acknowledgement escape), or require a **loan-specific buyer
   authorization carrying an expiry and minimum health/collateral
   bounds** — which is the position-sale bid under a different name.

   **The unpriceable case needs its own answer, not the same one.**
   Where either leg of the loan is illiquid, the risk math refuses to
   produce a figure at all — it reverts rather than returning a
   conservative number — so neither branch above is implementable as
   written: a health-factor floor would strand every illiquid position
   permanently (the read can never pass), and an acknowledgement has no
   threshold for the buyer to knowingly acknowledge. The policy must
   therefore be stated explicitly for these positions rather than
   inherited. Two defensible options, in the contract owners' hands:
   exclude illiquid-leg loans from both sale paths in Phase 1 (the
   narrower choice, and consistent with the listing path already being
   ERC-20-collateral-only), or admit them on the protocol's existing
   illiquid-risk consent — the incoming lender's standing
   acknowledgement that this pair carries no price-based safety net.
   What is NOT acceptable is either extreme by default: silently
   admitting an unpriceable position because the guard could not run, or
   silently blocking one because the guard reverted. Whichever is
   chosen, the surface says which case the user is in and never shows a
   health figure for a position that has none — "this position has no
   price-based safety check" is the honest line, not a blank or a zero.
12. **The reward migration is best-effort, so the third cost line
   describes an intention rather than an outcome.** Both sale paths route
   the interaction-reward transfer through a self-call whose failure is
   deliberately not bubbled — if that bookkeeping reverts, or a deploy
   omits the facet, the sale settles anyway with the seller's entry
   un-forfeited and no residual entry for the buyer. The design requires
   every quote to disclose that forfeiture (see the vocabulary section),
   and a mandatory disclosure of a best-effort effect is a promise the
   protocol does not keep — in *either* direction: the seller may be told
   they lose a credit they keep, or the buyer may be told they receive a
   residual entry that never opens. *Required*: make the migration atomic
   with settlement, or durably recoverable (a recorded pending migration
   any party can complete). Until then the copy states the intent without
   asserting certainty, which is a stopgap, not a resolution — a quote
   cannot be made accurate by hedging the sentence. Like item 11, this
   one applies to **both** sale paths.

Together with the borrower-escape requirement in the Layer-3
checklist, these gate Phase 1 — **both paths, not just the listing**:

- **The listing surface does not ship until items 1–4, 11 and 12 are
  resolved.**
- **The instant-sell surface does not ship until items 5–12 are
  resolved.** An earlier draft of this gate said only that the
  admission filter was "not trustworthy" until item 5 — that was too
  weak: the on-chain path is callable directly, so a frontend filter
  cannot prevent any of items 5–12, and item 5 in particular lets the
  loan's own borrower acquire the lender position and then be unable to
  repay it. A path whose damage a filter cannot prevent must be OFF,
  not filtered.

### Recommended shape for the instant-sell path

Items 5–10 are six independent re-checks that all exist for the same
reason: a generic lender offer is a promise to *open* a loan, and the
instant-sell path spends it to *assume* one. Patching them one at a
time keeps the mechanism's default wrong — every future term added to
the offer struct becomes a new omission on this path, silently, because
the compiler cannot notice a comparison nobody wrote.

The design recommendation is therefore a **dedicated loan-specific
position-sale bid**: an instrument whose creator names the loan id they
are bidding on and the price they will pay, so their consent is
expressed once against the actual running position instead of being
reconstructed field-by-field from an offer authored for something else.

**What the reshape actually removes — and what it does not.** The ten
items split into two classes, and the bid only dissolves one of them:

- *Term-mismatch items (7, 8, 9 — behavioural terms, NFT identity,
  duration as a floor)* dissolve by construction. Each exists purely
  because an offer authored for a hypothetical loan is being matched
  against a real one; when the bid names the loan, there is no second set
  of terms to disagree with. Item 5 likewise reduces to the ordinary
  current-holder resolution the listing path already does.
- *Item 10 (expiry) is REPLACED, not removed.* Naming a loan does
  nothing about a stale consent window: without a stored and enforced
  bid deadline, a bid stays fillable after its creator's window closes —
  exactly the defect item 10 describes, in a new wrapper. So the
  requirement carries over verbatim as a bid-expiry check. (An earlier
  revision listed item 10 among the dissolving items, which contradicted
  this section's own demand for a buyer-authored expiry two paragraphs
  down.)
- *Mutable-state items (6, and 11 as policy) do NOT dissolve.* A loan is
  not frozen between a bid and its fill: the borrower can partially
  repay, collateral can be withdrawn or fall in price, a held-for-lender
  payment can arrive, **and the borrower position itself can transfer to
  a different holder**. So a bid naming a loan id and a price still buys
  a position whose shape has moved — the same stale-consent and
  seller-loss race the reshape was meant to end, just relocated. The bid
  therefore needs a **buyer-authored expiry** and **bounds on the
  mutable loan state** it is priced against — outstanding principal,
  collateral exposure, held balance, **and the expected borrower-NFT
  holder**. That last one is a distinct requirement, not a restatement of
  item 5: re-resolving the current holder proves the counterparty is
  compliance-eligible and not the buyer themselves, which is a very
  different claim from the buyer having consented to *that* counterparty.
  A bid reviewed against one borrower must either bind that holder or be
  invalidated (and re-authorized) when the obligation moves. The seller's
  fill still needs a **minimum total receipt and a deadline**. An earlier
  revision of this paragraph claimed items 6–10 all "stop being checks at
  all"; that was wrong, and stated that way it would have let the roadmap
  treat the replacement as safe while carrying the races forward.

**The bid's settlement model has to be specified — it is not inherited.**
A generic lender offer supplies two things this design leans on
throughout: a principal amount that funds settlement, and a buyer APR
from which the seller's rate top-up is derived. A bid carrying only a
loan id and a price supplies neither, so the conservation arithmetic the
rest of this document assumes has no definition under the new shape.
Before the bid can be treated as implementation-safe, the spec must say:

- **Payment asset and denomination** — what the buyer pays in, and
  whether it must match the loan's principal asset.
- **Gross or net** — whether the named price is what the seller receives
  or what the buyer pays before the settlement forfeiture, and therefore
  where the accrued-interest forfeiture and any rate top-up are funded
  from for a discounted or premium bid. "Principal minus a cost" is a
  statement about the *generic-offer* path; it is not automatically true
  of a bid at an arbitrary price.
- **Reservation lifecycle** — whether the bid amount is escrowed or
  merely approved, and how it is cancelled. An unescrowed bid recreates
  both defects the listing prerequisites already forbid: prerequisite 2's
  apparently-takeable-but-always-reverting instrument, and prerequisite
  3's debit from a wallet balance beyond the trade's own proceeds.

Leaving these open would let the reshape ship as "the safe alternative"
while reintroducing exactly the failures items 2 and 3 exist to close.

So the honest summary is: the reshape removes the *comparison* burden,
not the *freshness* burden, and it brings a settlement-model burden of
its own. Both shapes need bounded consent on both sides; only one needs
a field-by-field compatibility audit that silently rots whenever a term
is added.

This is a contract-side recommendation, offered because the UX cost of
the alternative lands on users: a picker over generic offers has to
explain, per row, why an offer that looks takeable is not, and that
explanation is exactly the list above. A loan-specific bid needs no such
explanation — though it still needs its bounds shown. The same
detected-versus-late distinction from Layer 2 applies here and is not
weakened by the bid shape: drift the app has already detected closes the
review before any wallet prompt, while drift landing between the final
read and inclusion cannot be caught by any frontend and instead hits the
bid's on-chain bounds, producing a safe explained revert and a refreshed
view. The bounds exist precisely because a pre-sign check cannot cover
that window; requiring every drift to fail before signing would be the
impossible guarantee this design already rejected once.

Which shape ships is the contract owners' call; this design works
against either, and the chooser reports the instant-sell row as
unavailable until one of them exists **with its bounds and a defined
settlement model**.

Everything else in this design — the chooser, the wait-first framing,
the vocabulary, the quote rules including the held-balance line — is
ready to build against, and the chooser simply reports each sale path
as unavailable while its prerequisites are open (the honest-availability
rule already in Layer 1).

## Prelive posture

Same as the borrower doc: no migration debt, contract redeploys
expected, and the live-review DoD applies to the implementation PR
(drive the chooser and whichever sale paths have shipped on the deployed
testnet with the dev wallets once the redeploy lands).

**This design is not frontend-only.** The awareness layer — the chooser,
the wait-first ordering, the vocabulary, the quote rules including the
held-balance line — builds against the deployed contracts as they stand.
The two sale surfaces do not: the Layer-3 checklist's mandatory finite
listing expiry with permissionless teardown, and the eleven
contract-level prerequisites below it, are contract changes. An earlier
revision of this section claimed the implementation "adds the awareness
layer and the hardening checklist, not new contract calls" — that was
wrong on its own terms, since a bound expiry, a permissionless teardown,
a cost cap and a seller-economics bound are all new on-chain behaviour.
Prelive is what makes that affordable: there is no migration debt, so
the sale paths can be reshaped (see "Recommended shape") rather than
patched around.

**Interface changes the sale surfaces imply** — scoped here so they are
not left out of the implementation PR as "reuse":

- *Listing creation* gains a seller-chosen finite expiry (the create
  entry point accepts none today) and a seller-economics bound — a
  minimum net or maximum cost stored with the listing.
- *Listing teardown* gains a permissionless path callable at expiry or
  maturity while the loan is still `Active`, so the borrower is never
  dependent on the seller's cooperation.
- *The instant-sell entry point* gains, at minimum, a bound receipt and
  a deadline (items 6 and 11) — or is replaced by the position-sale bid
  above, which carries them natively.
- *Client wiring* for each of those: a facet ABI re-export, a
  deployments sync after redeploy, and the consumer typechecks — the
  monorepo's standing rule for any selector or struct-shape change.
  Chain-shape and copy work do not substitute for it.

None of that is scheduled by this document; it is named so the estimate
for whichever sale surface ships first includes it.

## Roadmap

**Phase 1 — implementation PR after this doc ratifies.** The lender
chooser card (both modes, wait-first ordering), the Layer-2 framing
rules on the two existing flows (including the held-balance line in
every quote), and the Layer-3 parity hardening (fail-closed lock read,
dead-listing teardown state, stale-marker discard). **Gated on the
Contract-level prerequisites section**: the borrower-escape
requirement (mandatory finite expiry + permissionless teardown) and
prerequisites **1-4 plus 11 and 12** must land first — the listing surface does
not ship over them — and prerequisites **5-12** gate the instant-sell
surface on exactly the same terms. Neither path ships over its own
open items; in particular item 5 is NOT the sole instant-sale blocker
(an earlier revision of this paragraph implied that, contradicting the
prerequisites gate above — the authoritative reading is the
prerequisites section, and this paragraph now matches it). The
awareness layer is the only part of Phase 1 that is unblocked today,
and it ships with both sale rows reporting as unavailable.

Fork-tier spec, scoped to whatever has actually shipped: chooser
renders for the lender in Basic mode, and a quote on a position
carrying a held balance shows that line. The listing post/lock/cancel
drive lands with the listing surface (after items 1-4, 11 and 12); the
instant-sell on-chain lender-change drive lands with that surface (after
items 5-12). Writing a fork-tier drive for a path still gated open would
assert behaviour the design says must not be reachable yet.

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
0b. Does the instant-sell path get patched (items 5–10 as six separate
   guards) or reshaped into a loan-specific position-sale bid (see
   "Recommended shape")? This design works against either, but the
   answer changes what the picker shows: a generic-offer picker must
   explain per row why a takeable-looking offer is refused, whereas a
   bid book has nothing to explain. Note that either answer still owes
   bounded consent on both sides — a bid needs its own expiry and bounds
   on the mutable loan state, and the fill needs a minimum receipt and
   deadline; the reshape removes the comparison burden, not the
   freshness one. Contract owners' call; resolve before the instant-sell
   surface is scheduled.
0d. If the bid shape is chosen: is the named price gross or net, what
   asset is it denominated in, where is the settlement forfeiture funded
   from at a discounted or premium price, and is the amount escrowed at
   bid time? The generic-offer path answers all four implicitly (its
   principal funds settlement and its APR derives the top-up); a bid
   answers none of them, so they must be decided rather than assumed —
   an unescrowed bid recreates prerequisites 2 and 3 verbatim.
0c. For loans with an illiquid leg, does Phase 1 exclude both sale
   paths or admit them on the existing illiquid-risk consent (item 11's
   unpriceable case)? A policy is required either way, because the risk
   math reverts rather than returning a conservative figure — so the
   default that falls out of "just add the guard" is a permanent block
   on those positions, which may not be the intent.
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
