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
exact-on-chain-at-execution note. For the generic-offer path, the
forfeit rule is worded as an outcome, never a formula: "you receive
your principal minus the larger of the interest built up so far or the
buyer's rate top-up — never both." A loan-specific position bid does
NOT inherit that sentence automatically: its chooser row and
confirmation copy stay blocked until the bid spec defines gross/net
price, payment asset, any buyer APR or replacement top-up rule, and the
resulting seller receipt. Copy that mentions a buyer-rate top-up on a
bid with no buyer rate is as wrong as omitting the generic-offer
forfeiture.

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
cost a lender at least three distinct things, and the quote must not present the
first as the total.

The word *attempt* is load-bearing. The reward migration runs as a
best-effort self-call whose failure is deliberately swallowed so that
settlement proceeds regardless — so on a deployment where that
bookkeeping reverts or the facet is not cut, the sale still completes,
the seller's entry is NOT forfeited, and the buyer gets no residual
entry. The copy must therefore not describe the outcome as inevitable
while the mechanism is best-effort; **the reward-migration prerequisite
requires the migration be made atomic or durably recoverable**, and
until it is, the wording says what is intended to happen rather than asserting it as
certain. Getting this backwards in either direction is a real cost:
promising a forfeiture that may not occur misprices the sale, and
promising a residual entry the buyer may never receive misprices the
purchase. On Full-stamped loans, the seller-side total may also include
the paid Full entitlement that leaves with the continuing lender position;
the tariff-accounting prerequisite defines whether that entitlement is
transferred, extinguished, or compensated before the quote can claim it
has enumerated every seller cost.

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
  created. Note the asymmetry that the stale-listing prerequisite exists to close:
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
   trade-off — **qualified by which side of the forfeit rule is
   currently binding**, because the seller pays the LARGER of accrued
   interest or the top-up, not their sum:
   - *While accrued interest is the binding cost* (the common case at
     or below the loan's own rate): moving the rate does not change
     what the seller pays at all until the resulting top-up grows past
     the interest already built up. So the form says raising the rate
     makes the position more attractive to buyers **at no extra cost
     to you up to that crossing point**, and says where the crossing
     point is. Presenting a cost that does not exist would push
     sellers toward a less marketable rate for nothing.
   - *While the top-up is the binding cost* (a rate far enough above
     the loan's): raising it further does add to what the seller funds
     at completion, and lowering it genuinely reduces that cost — at
     the price of sitting unsold.

   An unconditional "higher costs you more, lower costs you less" is
   wrong in the first regime and contradicts the regime-aware
   explanation in the decision-guidance section below. The forfeit rule
   is repeated against the live figure either way.
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
  actually ends. Expiry + permissionless teardown is the floor, but it
  has to leave a real borrower action window: teardown must either be
  atomic with the borrower action it unblocks, impose a post-expiry
  relisting cooldown, or enforce equivalent borrower consent /
  cumulative-tenure protection so the seller or an authorized keeper
  cannot immediately recreate the freeze and front-run the borrower one
  listing at a time. Re-sign layers on top. Shipping neither leaves an
  abandoned or malicious listing as an indefinite lever over the borrower.

## Decision guidance the chooser encodes

| Path | When it genuinely fits | Cost shape |
| --- | --- | --- |
| Keep it to the end | No urgent need for the capital | No sale forfeiture, and your reward credit for this position keeps accruing — principal plus the agreed interest if the borrower repays (paid on the loan's schedule where it has one, otherwise at the close); the normal default process (recovery may be less) if they don't |
| Sell now | Need liquidity today; an acceptable offer is on the book | Principal minus the larger of interest-so-far or the buyer rate top-up, paid instantly — plus any money already set aside for you on this loan, which transfers to the buyer — plus your pending reward credit for this position, which is given up — plus the Full entitlement line where the tariff prerequisite makes it transferable, extinguished, or compensated (shown as its own line, or marked unquotable where the value can't be read) |
| List at your chosen buyer rate | Want liquidity but not at today's book rates | The same settlement, transferred set-aside, reward-forfeiture, and conditional Full-entitlement lines at completion, with the same unquotable fallback; your position locked and the borrower's partial-repay/collateral paths held until it sells, expires, or you cancel; no guarantee of a buyer |

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

The adversarial passes on this doc surfaced the gaps below — twenty-seven at
the time of writing, and this section is the ONLY place that number is
stated (see the maintenance rule at the end of the section). They are **not
frontend problems** — no amount of copy, preflight, or quoting in the
app can close them, because the risk lives in the settlement paths
themselves. They are recorded here as blockers rather than assumed
away: a UX design that ships a sale surface over them would be
promising safety the protocol does not provide. Each was verified
against `EarlyWithdrawalFacet` at the commit this doc was reviewed
against.

Items 1–4, 13, 14, 16, 17, 19, 23 and 26 belong to the **listing** path,
5–10, 15, 17 and 18 to the **instant-sell** (direct buy-offer) path,
and 11, 12, 20, 21, 22, 24, 25 and 27 to both. The instant-sell cluster is
large for one structural reason worth naming up front: that path
consumes a *generic standing lender offer* — an instrument authored to
open a fresh loan, never to assume a running one — so every term the
offer's creator authored has to be re-checked by hand against a live
loan the offer never described. Items 5–10, 15 and 18 are each a
missing hand-check or inherited-snapshot consent gap of that kind, and
item 17 is a settlement teardown / buyback-carve-out step. See
"Recommended shape" at the end of this section: the pattern suggests
the durable fix is a dedicated position-sale bid rather
than a growing list of patches on generic-offer consumption.

1. **A listing outlives the loan's maturity.** Completion gates only
   on the loan still being `Active`, which it remains throughout the
   grace window — so a listing created before the due date stays
   takeable after it. Hiding the sale row in the app does not make the
   on-chain offer unsellable: a buyer can still acquire an overdue
   position, and the seller can still be charged post-term accrual.
   *Required*: bound listing expiry at the loan's maturity, permit
   teardown at that boundary, and re-check pre-maturity against the live
   term at fill. If an obligation transfer or extension rewrites the live
   maturity while a listing is outstanding, the listing must be shortened,
   invalidated, or refused at completion rather than relying on the
   creation-time clamp.
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

   **The bound must cover the held balance, not just the settlement.** A
   minimum-net-or-maximum-cost guard constrains the forfeiture side only.
   But a partial or internal settlement can park a NEW `heldForLender`
   amount between listing and acceptance, and completion transfers that
   amount to the buyer — so the seller can end up materially worse off
   with neither bound violated. This document insists elsewhere that held
   funds are their own line and never folded into the net figure, which
   is exactly why a net-only bound cannot catch this: the drift happens
   in the line the net deliberately excludes. Item 6 already closes the
   same race on the direct-sale path by requiring the bound to *count
   transferred held proceeds*; item 4 needs the equivalent — a ceiling on
   the transferring held balance, or a single minimum TOTAL economic
   receipt spanning both lines.

   **And the bound must reach the THIRD cost, not just the first two.**
   This design tells the seller a sale costs them three things:
   the settlement forfeiture, any transferring held balance, and the
   forfeited interaction-reward credit. A bound covering only the first
   two is therefore not "the bound" the document advertises. The reward
   accrual keeps growing while a listing sits open, so on a listing that
   stands for days, acceptance can forfeit materially more than the
   seller reviewed with both other bounds satisfied — and a buyer can
   race a cancellation to capture exactly that, the same shape as the
   accrued-interest race in the paragraph above. Note this becomes
   *sharper*, not moot, once item 12 makes the migration atomic: today
   the forfeiture is best-effort, so the loss is unreliable; made
   reliable, it is a guaranteed uncapped cost. *Required*: extend the
   seller authorization with a maximum reward forfeiture, a value
   snapshot, a maximum cutoff day / eligible-day count, or fresh
   authorization when the bound is exceeded. If no calculable proxy can
   be enforced at acceptance, the sale surface stays unavailable; labeling
   the line "unbounded" is disclosure, not authorization, and this section
   already treats disclosure as insufficient for an uncapped wallet debit
   or reward loss.
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
   transferred held proceeds**, plus a deadline — and, exactly as item 4
   now demands on the listing side, **a bound on the reward forfeiture
   as well**. A direct sale delayed across a reward-accrual boundary
   forfeits more pending credit than the seller reviewed while a
   settlement-plus-held bound still passes, so the two paths must cap the
   same three costs or the asymmetry is arbitrary. If no calculable proxy
   can be enforced at execution, the direct-sale surface stays
   unavailable until the seller supplies fresh bounded authorization;
   labeling the reward loss "unbounded" is disclosure, not consent. The
   same requirement carries onto the position-sale bid's seller-side
   bound.
7. **The direct sale ignores every buyer-authored behavioural term.**
   `allowsPartialRepay`, `useFullTermInterest`,
   `periodicInterestCadence` **and `allowsPrepayListing`** are immutable
   take-it-or-leave-it terms of an offer, and this path compares none of
   them. A buyer who authored the default no-partial-repay can be
   migrated into a loan where partial repayment is enabled; a buyer who
   elected full-term interest can receive a pro-rata loan. The
   prepay-listing flag is the sharpest of the four on an NFT-collateral
   loan: origination snapshots the lender's consent onto immutable loan
   state and the prepay-listing facets read THAT copy, but the direct
   sale neither compares nor updates it — so a buyer whose offer set it
   false can inherit a loan where it is true, and the borrower can then
   list the collateral without the incoming lender's consent. Full-tariff
   authorization is the same class of buyer-authored term with money
   attached: a standing offer may set `creatorFull`, `creatorMaxCStar`,
   and strict downgrade semantics, but the direct-sale path bypasses the
   ordinary tariff resolver while preserving the original loan's lender
   mode. *Required*: compatibility on every buyer-authored loan term
   including `allowsPrepayListing`, plus the offer's Full-tariff
   authorization; or exclude Full-mode offers from direct sales until a
   secondary-market tariff model defines whether `C*` is charged, the
   Full yield-fee benefit is granted, or the fill fails closed. Mandating
   item 8's NFT-collateral exclusion retires the prepay-listing exposure
   along with the token-identity one, but it does not retire the Full
   tariff exposure.
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

   **Fit-within is not automatically the right rule — see item 15.** A
   ceiling fixes the case where the buyer is held LONGER than they
   authored, but leaves the mirror case open: a 30-day offer consumed by
   a loan with one day left earns one day's interest and destroys the
   offer, which is the same "whole single-value instrument spent on a
   smaller exposure" defect item 15 identifies on amount. Ordinary
   acceptance binds duration exactly, so the sale path is the outlier.
   The choice must be made explicitly rather than defaulted into:
   require the remaining term to EQUAL the authored duration — **and if
   so, express it as the loan's maturity timestamp or exact remaining
   seconds, not the integer day field**, because remaining days is
   computed by flooring elapsed time, so for most of any given day an
   equality check on whole days still admits an offer whose nominal
   duration exceeds what the position actually has left; an exact rule
   written against a rounded quantity is not exact — or state
   plainly that duration is a buyer-consented MAXIMUM which shorter fills
   may take — and if the latter, the picker must say so where the buyer
   authors the offer, because that is not what "duration" means anywhere
   else in the protocol. What is not acceptable is treating fit-within as
   obviously correct while item 15 argues the opposite for amount.
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
   the fill — and even there, presence is not consent to the fill-time
   state.** On the listing path the buyer does drive acceptance, so an
   acknowledgement can at least be taken from the right party. But
   "present at the fill" means present at *signing*, and the position
   keeps moving until *inclusion*: the oracle price can fall further in
   between, so a bare acknowledgement succeeds against a materially worse
   — possibly immediately liquidatable — position than the one reviewed.
   Unlike the hard-floor branch, a bare acknowledgement binds no minimum
   health factor and no minimum collateral value, so there is nothing for
   the drift to violate. Surfacing the live figure in the frontend cannot
   repair this: the gap between the last read and inclusion is precisely
   the one no frontend can observe, which is this design's own
   safe-late-drift rule. *So the acknowledgement branch is only
   admissible if its terms carry a fill-time solvency bound alongside
   their deadline* — otherwise keep the hard admission floor.

   **That bound has to be ratio-aware — a collateral-value floor alone
   does not close the race.** Health factor is risk-adjusted collateral
   value divided by current borrow value, and the denominator moves too:
   the principal asset's price can RISE between signing and inclusion,
   and accrued interest grows regardless, so health can fall through the
   reviewed level while collateral value sits comfortably above any
   absolute floor. An implementer reading "health / collateral-value
   bound" as a free choice between the two could therefore pick the one
   that does not work. The requirement is a **minimum health factor**, or
   bounds on BOTH sides of the ratio — not a collateral-value minimum on
   its own. This is the same defect class as item 13: the consent must
   bind the thing it was given for, or it is a signature on a state that
   no longer exists.

   **The admission rule also has to bind the inherited risk snapshots,
   not just the live health read.** A loan can have originated under
   weaker collateral rules than the rules in force when the sale fills;
   migrating the lender position changes the lender, not the loan's
   `minHealthFactorAtInit`, `initLtvCapBpsAtInit` or
   `liquidationLtvBpsAtInit`. A fill-time health check proves the
   position is solvent now, but it does not prove the
   buyer is inheriting the same collateral-withdrawal floor they would
   have received on a fresh loan today. The borrower can later withdraw
   collateral down to the older snapshot, so the incoming lender's
   consent must either bind those inherited snapshots explicitly or
   require compatibility with the current risk parameters.

   On the instant-sell path the buyer is not present at all — the seller fills a
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
   authorization carrying an expiry, minimum health bound and inherited
   risk-snapshot compatibility, including the liquidation threshold** —
   which is the position-sale bid under a different name.

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
   any party can complete).

   **If the recoverable route is chosen, the sale must also freeze the
   reward cutoff.** The transfer closes the old entry against the day it
   is *called*, so a pending migration completed late forfeits extra
   post-sale days from the seller and starts the buyer's residual window
   correspondingly late. Recording the intent to migrate is therefore not
   enough on its own: the sale transaction must persist the effective
   cutoff, and recovery must consume that stored value rather than
   recomputing at completion. It must also freeze or immediately mark the
   seller's old entry as forfeited so `claimInteractionRewards` cannot
   pay finalized days out to the seller while the migration is pending.
   The sale also has to install both sides' reward-denominator cutoff
   deltas, or an equivalent pending placeholder, immediately: if those
   denominator effects wait for recovery, global reward frontiers can
   advance past the cutoff and make the later repair non-retroactive.
   Otherwise who receives which days depends on keeper availability — the
   recoverable path would trade one non-determinism for another rather
   than removing it. Until then the copy states the intent without
   asserting certainty, which is a stopgap, not a resolution — a quote
   cannot be made accurate by hedging the sentence. Like item 11, this
   one applies to **both** sale paths.
13. **Listing acceptance does not bind the borrower the buyer reviewed.**
   The buyer's bound acceptance terms cover the position's economics —
   principal equal to live, collateral at or above their floor, duration,
   rate — but carry **no field for the borrower-position holder**. The
   loan's current borrower IS resolved live at initiation, and the
   comments there say what for: the self-buy guard and the compliance
   recheck. Both are *eligibility* tests. Neither asks whether this is
   the borrower the buyer priced. So if the borrower position changes
   hands between the buyer's review (or signature) and inclusion, a
   different but still-eligible borrower is substituted and the sale
   succeeds — the buyer gets a counterparty they never assessed. That
   contradicts this design's own safe-late-drift rule, which promises
   that drift landing after the final check produces a refusal rather
   than a silent substitution; here it produces neither a refusal nor a
   disclosure. Counterparty identity is not a cosmetic term on a credit
   position: it is most of what a lender underwrites. *Required*: include
   the expected borrower-NFT holder in the buyer's bound terms so the
   substitution reverts. A frontend cannot close this — the drift lands
   inside the gap no frontend can observe, which is exactly why the
   binding has to be on-chain.
14. **The expiry escape must survive a pause.** Items 1 and the Layer-3
   checklist require a mandatory finite listing expiry plus a
   permissionless teardown, and that escape exists to guarantee the
   borrower's held paths cannot be frozen indefinitely. But every entry
   point on the withdrawal facet today — create, cancel, complete — is
   `whenNotPaused`, so an implementer following the established pattern
   will inherit it on the new teardown as well. A pause that begins
   before an expired listing is cleared would then hold the lender-NFT
   lock and the borrower-side holds until governance restores the
   protocol, converting the finite expiry back into the indefinite
   freeze it was introduced to remove — and doing so precisely during an
   incident, when the escape matters most. *Required*: the expired-listing
   cleanup stays callable while paused, or ships with a separate
   emergency unlock. This is defensible because the teardown moves **no
   value**: it releases a lock and clears holds. Pausing exists to stop
   value movement, not to strand third-party assets, so exempting a
   no-value release is consistent with what the pause is for rather than
   a hole in it.

15. **The direct sale does not honour a fixed offer's amount.** The
   admission guard rejects only an offer amount *below* the live
   principal. When a fixed / all-or-nothing lender offer is written for
   MORE than the loan's principal, the path withdraws just the principal,
   refunds the excess, and still marks the entire offer accepted. A buyer
   who authored a single indivisible amount is therefore forced into a
   smaller exposure than they signed for, and their offer is consumed
   whole — they cannot recycle the remainder into the position size they
   actually wanted. This is the same generic-offer mismatch as items 7-9,
   on the one term most obviously central to a lending offer, which is
   why the earlier claim that items 5-10 covered every missing hand-check
   was wrong. *Required*: exact amount compatibility for fixed/AON
   offers, or carry the authored amount explicitly into the
   position-sale-bid consent.
16. **A keeper can author the seller's listing terms.** `createLoanSaleOffer`
   is keeper-callable, and the keeper gate checks only the master switch,
   the per-loan enable, the action bit, and the global keeper pause — it
   enforces no lender-authored economic caps. That was already true of
   the buyer rate; this design makes it worse by adding TWO more
   seller-chosen parameters (the mandatory finite expiry from the Layer-3
   checklist, and item 4's minimum-net bound). An approved keeper could
   therefore pick an extreme rate, the longest permitted expiry, and a
   bound loose enough to strip the protection item 4 exists to provide —
   all while this document describes those values as the seller's
   choices. The FunctionalSpecs rule is that a keeper initiation stays
   within the granting party's configured caps, so the gap is against
   spec, not merely unfortunate. *Required*: stored lender caps enforced
   on-chain for rate, expiry and the economic bound, or a seller
   signature over the listing parameters.

   **If the signature route is chosen it must be single-use.** A bare
   signature over the parameters authorizes the *shape* of a listing, not
   one particular listing, so it stays replayable while it remains
   unexpired: the seller cancels, and the keeper resubmits the same
   payload — recreating the borrower-side freeze and re-exposing the
   position for sale with no renewed consent. Cancellation would stop
   meaning anything. So the authorization must be domain-separated, bound
   to the loan id AND the current lender (a position transfer must void
   it), and consumed via a nonce that cancellation also invalidates. A
   replayable signature is strictly weaker than the stored-caps route,
   not an equivalent alternative — the caps constrain every future call,
   whereas an unconsumed signature authorizes an unbounded number of
   them.

   Until one route exists, this document's "the seller picks" wording is
   only true when the seller is the caller.

17. **Intent exposure release must not strand capacity or create a buyback escape.** For a loan
   originated through a standing lender intent, the listing-completion
   path clears the origin marker and calls the intent-exposure release;
   the direct-sale path does neither — the release appears exactly once
   in the facet, on the listing side. So an intent lender who exits via
   the instant sell gets their capital back but keeps the loan counted
   against their live-principal cap, potentially until the buyer
   eventually claims, which may be far off or never prompted. They have
   sold the position and still cannot redeploy the capacity. This is a
   pure asymmetry between two paths that are supposed to be alternate
   exits from the same position, and the listing side proves the fix is
   already understood. *Required*: release the intent exposure on the
   direct-sale path too, and apply the buyback carve-out below on both sale
   paths.

   **But the release must be conditional on the origin owner actually
   leaving.** Neither sale path stops the intent's own owner being the
   incoming lender — directly, or by buying the position back after an
   NFT transfer. Released unconditionally, that owner ends up holding the
   same live loan with its full amount deleted from their intent
   exposure: a clean route around the live-principal cap the intent
   system exists to enforce. So the guard is not "loan has an origin
   marker" but "the origin owner is no longer the lender": reject an
   incoming lender equal to `intentOrigin.owner`, or preserve /
   re-establish the marker and its exposure in that case. Worth stating
   plainly because the naive form of this fix — mirroring the listing
   path's `owner != address(0)` check onto the direct path — is exactly
   the form that opens the hole.

18. **The direct sale does not bind inherited economic snapshots.**
   A running loan keeps its `treasuryFeeBpsAtInit` after lender migration,
   and settlement continues pricing against that snapshot. It also keeps
   `fallbackLenderBonusBpsAtInit` and `fallbackTreasuryBpsAtInit`, which
   `LibFallback.computeFallbackEntitlements` uses if failed-liquidation
   recovery divides principal and collateral later. If governance has
   lowered the treasury fee or improved the fallback split since
   origination, a standing-offer creator who expected a fresh loan under
   the current schedule can be assigned an older position with a higher
   treasury cut, lower lender fallback bonus, or higher treasury fallback
   share, reducing their net yield or default recovery while every
   compatibility check above still passes. *Required*: compatibility with
   the current treasury-fee and fallback schedules, or loan-specific
   buyer consent to the inherited snapshots.

19. **Listing acceptances do not apply Full-tariff authorization to the
   continuing loan.** A buyer accepting a sale vehicle can supply
   `acceptorFull`, a maximum `C*`, and downgrade choice through ordinary
   acceptance, but the sale branch does not turn that into a Full stamp
   on the migrated lender position: the continuing loan keeps the old
   lender entitlement. A buyer who forbids downgrade can therefore acquire
   the position without paying `C*`, without receiving the Full yield-fee
   benefit, and without the fill failing closed. *Required*: define how
   acceptor-side Full authorization is applied to a continuing lender
   position, or explicitly reject Full listing acceptances until the
   secondary-market tariff model exists.

20. **Lender migration inherits keeper enables that were not authorized by
   the buyer.** The per-loan keeper flag is shared by both position sides
   and survives lender migration. A flag set earlier by the seller or the
   borrower can therefore pair with the buyer's unrelated global keeper
   approval and action bit after the sale, letting that keeper create a
   fresh lender listing for a loan the buyer never enabled. Item 16's
   economic caps constrain the listing terms, but they do not establish
   the missing per-loan consent from the incoming lender. *Required*: a
   side/provenance-aware invalidation that removes only the departing
   lender's authority, or holder / position-epoch binding on each enable.
   Blanket invalidation is not an acceptable shortcut: it would also wipe
   borrower-authored keeper enables for preclose, refinance, and
   extension automation, letting a lender sale the borrower does not
   control silently disable time-sensitive borrower grants.

21. **Sale paths must reject or bind active borrower close-out state.** A
   position already committed to imminent borrower close-out is not the
   term/yield exposure a buyer priced. The current direct-sale guard
   rejects only the selected buy offer being an offset vehicle; it does
   not reject a live `loanToOffsetOfferId` or swap-to-repay intent on the
   loan. Listing creation blocks one existing offset shape, but listing
   completion can still run after a borrower creates a swap-to-repay
   intent, and the same stale-position problem exists for an active
   prepay-collateral listing when NFT-collateral support relies on exact
   binding instead of exclusion. A refinance-tagged offer with
   `refinanceTargetLoanId == loanId` is the same close-out commitment: a
   third-party accept can atomically refinance and terminalize the loan
   without changing the ordinary sale fields. *Required*: every sale
   shape either rejects live preclose offsets, swap-to-repay intents,
   active refinance offers, and applicable prepay-listing order hashes,
   binds their identifiers/state into the buyer's authorization, or
   invalidates the sale when they are created or replaced.

22. **Full-stamped positions need explicit entitlement accounting on sale.**
   A lender who opened or accepted a Full position already paid `C*`, and
   the loan-scoped lender entitlement survives lender migration. Without
   another rule, the buyer receives the remaining Full yield-fee benefit
   while the seller's quote and authorization count only settlement,
   transferred held proceeds, and reward forfeiture. Items 7 and 19 cover
   the incoming buyer's tariff consent; they do not price the seller's
   paid entitlement leaving with the position. *Required*: define whether
   the entitlement is transferred, extinguished, or compensated, and carry
   that decision into both tariff prerequisites and seller-side economic
   bounds before any sale quote claims it has enumerated every seller cost.

23. **Listing acceptance must bind the live loan's behavioural and
   exact maturity state.** The listing vehicle currently presents sale
   terms that are not the live loan's full behavioural state: it copies
   `useFullTermInterest`, but leaves `allowsPartialRepay` and
   `periodicInterestCadence` at their default false / none values. The
   buyer can therefore sign acceptance terms that say no partial
   repayment and no periodic cadence, then receive the unchanged running
   loan where either behaviour is enabled. The same stale-consent class
   applies to maturity: if both position holders enabled auto-extension,
   `extendLoanInPlace` can reset `startTime` and extend the exact
   maturity while reusing the same `durationDays`, so a buyer who bound
   only the integer duration can receive a materially longer position.
   Item 7 closes this class for direct standing-offer consumption; the
   listing path needs equivalent protection. Periodic loans add another
   mutable dimension: an interest-only partial payment or
   `settlePeriodicInterest` can advance `interestPaidSinceLastPeriod`,
   `interestSettled`, or `lastPeriodicInterestSettledAt` after review,
   letting the seller collect yield the buyer priced into the listed
   position. *Required*: the sale vehicle and acceptance authorization
   bind the underlying loan's actual behavioural terms, including partial
   repayment, full-term-interest mode, periodic cadence, applicable
   prepay-listing consent, periodic-settlement checkpoints,
   settled-interest state, and exact maturity / start-time state; or
   extensions and settlement mutations while listed are rejected or
   invalidate the authorization through a shared economic-state epoch.

24. **Sale fills must guard periodic-settlement delinquency at the deadline.**
   Binding cadence, settlement checkpoints, and settled-interest state
   catches mutations, but it does not catch time crossing the periodic
   grace threshold with those fields unchanged. Once
   `lastPeriodicInterestSettledAt + cadence + grace` is reached with a
   shortfall, settlement becomes permissionless and can liquidate or sell
   collateral immediately after the stale sale fill. A buyer who signed a
   listing acceptance, position bid, or generic standing offer before the
   threshold can therefore receive a position that is already
   auto-liquidatable while every named state field still matches.
   *Required*: every sale fill has a fill-time delinquency / shortfall
   guard, or buyer authorization explicitly binds the periodic settlement
   deadline and admissible shortfall state.

25. **Lender migration must preserve position discovery.** Both sale paths
   migrate the lender position by burning the seller's lender NFT and
   minting a new one for the buyer. The reverse lookup that maps position
   token id back to loan id must move atomically with that migration;
   otherwise the buyer's new token resolves to loan id zero in
   chain-authoritative position discovery, and the normal loan-management
   UI treats the acquired position as absent. That is only half the
   discovery surface: dashboard and history views read the append-only
   per-user loan index, so the buyer must also receive the REAL loan id
   there, with the same deduplication used by consolidation. A listing
   buyer otherwise sees only the temporary sale-vehicle id, and a
   direct-sale buyer can see no entry at all. *Required*: replace the
   old reverse-index entry with the new lender-token mapping and append
   the acquired real loan id to the buyer's user-loan index during
   migration before either sale surface ships.

26. **The listing sale vehicle must not pollute public loan accounting.**
   Listing acceptance uses an internal transitional loan shape, but if it
   passes through ordinary loan initialization it can increment public
   loan counters, rate sums, and initiation events before being marked
   repaid without a corresponding terminal event. It can also append the
   temporary loan id to both parties' per-user histories, where count and
   pagination views expose the append-only index even after the vehicle
   is terminal. Indexers, dashboards, and activity consumers can then
   retain a phantom loan the UX says is never visible. *Required*: bypass
   ordinary metrics, events, and per-user indexes for the internal sale
   vehicle, or define an internal lifecycle that fully reverses each of
   those writes and emits enough terminal information for every consumer
   to discard it.

27. **VPFI sale settlement must restamp every affected vault owner.**
   When the held-for-lender balance is denominated in VPFI, sale
   settlement withdraws it from the seller's vault and credits the
   buyer's vault. The direct-sale path can also consume the buyer's VPFI
   principal (plus any excess) from their vault even when there are no
   held proceeds at all. Those balance movements must run the same
   post-balance discount / staking checkpoint routine as any other VPFI
   vault transfer; otherwise the seller can retain fee-tier or staking
   credit on VPFI they no longer hold, the buyer's new held balance may
   not be checkpointed, or the buyer can retain fee-tier / staking credit
   on principal they spent to acquire the position. *Required*: restamp
   every vault owner whose VPFI balance is debited or credited by sale
   settlement, including the direct-sale buyer whenever the payment asset
   is VPFI.

Together with the borrower-escape requirement in the Layer-3
checklist, these gate Phase 1 — **both paths, not just the listing**:

- **The listing surface does not ship until items 1–4, 11, 12, 13, 14,
  16, 17, 19, 20, 21, 22, 23, 24, 25, 26 and 27 are resolved.**
- **The instant-sell surface does not ship until items 5–12, 15, 17, 18,
  20, 21, 22, 24, 25 and 27 are resolved.** An earlier draft of this gate said only that the
  admission filter was "not trustworthy" until item 5 — that was too
  weak: the on-chain path is callable directly, so a frontend filter
  cannot prevent any of items 5–12, and item 5 in particular lets the
  loan's own borrower acquire the lender position and then be unable to
  repay it. A path whose damage a filter cannot prevent must be OFF,
  not filtered.

### Recommended shape for the instant-sell path

Items 5–10, 15, 17, 18, 20, 22, 25 and 27 are the instant-sell
blockers clustered here. Most exist for the same reason: a generic lender offer is a
promise to *open* a loan, and the instant-sell path spends it to
*assume* one. Patching those hand-check gaps one at a time keeps the
mechanism's default wrong — every future term added to the offer struct
becomes a new omission on this path, silently, because the compiler
cannot notice a comparison nobody wrote. Items 17, 20, 22, 25 and 27 are different: they are
settlement, migration-auth, tariff-accounting, discovery, and VPFI
accounting requirements that survive any buyer-consent reshape.

The design recommendation is therefore a **dedicated loan-specific
position-sale bid**: an instrument whose creator names the loan id they
are bidding on and the price they will pay, so their consent is
expressed once against the actual running position instead of being
reconstructed field-by-field from an offer authored for something else.

**What the reshape actually removes — and what it does not.** The items
split into three classes, and the bid only dissolves one of them. Every
instant-sell item is classified below; if a future item is added to that
path it gets classified here in the same diff, because an item absent
from this list reads as dissolved:

- *Term-mismatch items (7, 8 — behavioural terms, NFT identity) and the
  duration-COMPARISON half of item 9* dissolve by construction. Each
  exists purely because an offer authored for a hypothetical loan is
  being matched against a real one; when the bid names the loan, there is
  no second set of terms to disagree with. Item 5 likewise reduces to the
  ordinary current-holder resolution the listing path already does.
- *Item 9's MATURITY half is REPLACED, not removed.* Item 9 carries two
  requirements, and only the first is about comparing terms. A bid
  authored before maturity can carry a buyer-selected expiry that falls
  *after* it, and the loan stays `Active` right through its grace window
  — so naming the loan does not stop the seller filling that bid against
  an overdue position. The explicit pre-maturity check therefore carries
  into the bid path, either as its own guard or by requiring every bid
  deadline to be no later than the loan's maturity.
- *Item 10 (expiry) is REPLACED, not removed.* Naming a loan does
  nothing about a stale consent window: without a stored and enforced
  bid deadline, a bid stays fillable after its creator's window closes —
  exactly the defect item 10 describes, in a new wrapper. So the
  requirement carries over verbatim as a bid-expiry check. (An earlier
  revision listed item 10 among the dissolving items, which contradicted
  this section's own demand for a buyer-authored expiry two paragraphs
  down.)

  The two REPLACED bullets share a lesson worth stating once: an item
  that bundles a term-comparison requirement with a *time* requirement
  only half-dissolves under the reshape, because naming the loan settles
  what the position IS and says nothing about WHEN the consent is still
  good. An earlier revision got item 10 right and left item 9 in the
  dissolving group — the same error on the sibling item. When auditing
  any future item against the bid shape, split it on that axis first.
- *Mutable-state and inherited-snapshot items (6, 11 as policy, and 18)
  do NOT dissolve.* A loan is
  not frozen between a bid and its fill: the borrower can partially
  repay, collateral can be withdrawn or fall in price, a held-for-lender
  payment can arrive, **and the borrower position itself can transfer to
  a different holder**, and on periodic-interest loans the current lender
  can settle a period or receive an interest-only partial payment that
  advances `lastPeriodicInterestSettledAt` or
  `interestPaidSinceLastPeriod` without changing principal, borrower,
  collateral, or held balance; auto-extension can settle the old lender,
  then rewrite `startTime`, `interestRateBps`, and `durationDays` while
  the loan remains active; and partial liquidation can reset
  `interestAccrualStart` and `interestRemainingDays` while leaving the
  nominal start, duration, and exact maturity unchanged; the borrower can
  also create a preclose offset, live swap-to-repay intent, active
  refinance offer, or applicable prepay-collateral listing order that
  commits the position to imminent close-out while the listed bounds stay
  flat.
  So a bid naming a loan id and a price still buys
  a position whose shape has moved — the same stale-consent and
  seller-loss race the reshape was meant to end, just relocated. The bid
  therefore needs a **buyer-authored expiry** and **bounds on the
  mutable loan state** it is priced against — outstanding principal,
  collateral exposure, inherited risk snapshots, inherited economic
  snapshots (treasury fee and fallback split), held balance,
  periodic-settlement checkpoints, settled-interest state, periodic
  settlement deadline / delinquency state, the dedicated interest-accrual
  clock (`interestAccrualStart` and `interestRemainingDays`),
  interest-rate and exact maturity/start-time state, active borrower
  close-out commitments (preclose offset, swap-to-repay intent, active
  refinance offer, and applicable prepay-listing hash/state), **and the
  expected borrower-NFT holder**. That
  last one is a distinct requirement, not a restatement of
  item 5: re-resolving the current holder proves the counterparty is
  compliance-eligible and not the buyer themselves, which is a very
  different claim from the buyer having consented to *that* counterparty.
  A bid reviewed against one borrower must either bind that holder or be
  invalidated (and re-authorized) when the obligation moves. The seller's
  fill still needs a **minimum total receipt and a deadline**. An earlier
  revision of this paragraph claimed items 6–10 all "stop being checks at
  all"; that was wrong, and stated that way it would have let the roadmap
  treat the replacement as safe while carrying the races forward.
- *Item 15 (the buyer's authored amount) is REPLACED, not removed.*
  Naming a loan and a price says what the buyer will PAY; it does not
  say what outstanding-principal exposure they are agreeing to take on,
  and the principal moves with every partial repayment. So the bid must
  carry the buyer's authored relationship to the live principal —
  exactly, or as a bounded range they consent to — in the same way item
  15 demands of the generic-offer path. The mutable-state bullet below
  already asks for a principal bound as anti-drift protection, but that
  is a different requirement wearing a similar name: one keeps the
  position from moving under a consent already given, this one states
  what the consent WAS. An implementer reading only the dissolving class
  could ship a bid that binds neither.
- *Items 17 (the stranded intent exposure), 20 (keeper-enable
  invalidation), 22 (Full-entitlement accounting), 25 (reverse-index
  migration), and 27 (VPFI restamping) are UNTOUCHED
  — the same third class as item 12.* A loan-specific bid still migrates
  the position and returns the exiting lender's capital; it does not by
  itself clear the origin marker or release the originating owner's
  live-principal exposure, supply the origin-owner-buyback carve-out,
  invalidate inherited keeper authority, preserve borrower-authored
  keeper grants, or decide whether a paid Full entitlement transfers,
  expires, or is compensated. The reshape changes how the buyer's consent
  is expressed; these are settlement, migration-auth, and tariff-accounting
  steps. An implementation following the bid path reproduces those defects
  unless it carries items 17, 20, 22, 25, and 27 across explicitly.
- *Item 12 (the best-effort reward migration) is UNTOUCHED — a third
  class of its own.* The first two classes are both about the buyer's
  consent, which is what the bid reshapes. Item 12 is not: it is a
  settlement-atomicity defect in the reward bookkeeping that both sale
  paths route through a failure-swallowing self-call. Naming the loan in
  the bid changes nothing about it — the hook is just as best-effort
  after the reshape as before, so the seller's forfeiture and the buyer's
  residual entry remain effects the protocol may or may not deliver.
  Item 12 already says it applies to both sale paths, and the ship gate
  lists it for both, so a two-class split that quietly dropped it
  contradicted this document twice over. Making the migration atomic (or
  durably recoverable) is a prerequisite the bid does not retire.

  The general point, since the split is the thing implementers will read
  as a to-do list: **the bid reshapes how the buyer's CONSENT is
  expressed, and nothing else.** Items that exist because consent was
  reconstructed from the wrong instrument dissolve or get replaced;
  items that exist because settlement itself is unsound survive
  untouched. Anything added to this list in future gets classified on
  that question first.

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
  prerequisite 2's failure: an apparently-takeable instrument whose fill
  always reverts once the funding is moved or revoked. Independent
  per-loan escrow creates the opposite portfolio problem: a buyer bidding
  across many positions has to lock multiples of the capital they can
  actually deploy, making the replacement market sparse. The spec should
  choose that cost explicitly, or use a shared funded vault with atomic
  per-buyer aggregate reservations. A short-lived RFQ or signature is
  only a substitute when request, funding authorization, and fill are
  atomic at execution, or when a Permit2-style authorization is checked
  against live available funds at fill time; duration alone does not make
  a revocable balance fillable. Otherwise that shape must be labelled
  deliberately unreserved and kept off the advertised takeable-bid
  surface.

  **This is NOT the same requirement as prerequisite 3, and conflating
  them is a trap.** Escrow settles whether the BUYER's side is reliably
  fundable; prerequisite 3 is about whether settlement can debit the
  SELLER beyond the trade's own proceeds, which follows from the
  gross-versus-net formula and the presence of a cost cap. The two are
  independent in both directions: a fully escrowed bid can still sit
  alongside an uncapped seller shortfall, and a capped seller cost does
  not make an unescrowed bid fillable. Stated as one bundled defect, an
  implementer could reasonably add escrow and consider prerequisite 3
  discharged — shipping the uncapped wallet debit that item 3 says
  explicitly has no UI or adjacent-mechanism substitute. So the bid
  needs **fillability reservation** and **seller-side cost
  conservation/capping** specified as two separate requirements.

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
listing expiry with permissionless teardown, and the contract-level
prerequisites section below it, are contract changes. An earlier
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
  maturity while the loan is still `Active`, plus the chosen borrower
  action-window protection (atomic teardown-and-action, relisting
  cooldown, borrower consent, or cumulative-tenure limit), so the
  borrower is never dependent on the seller's cooperation and cannot be
  front-run into repeated freezes.
- *Listing acceptance* gains typed-data / ABI fields for the expected
  borrower holder, exact maturity / start-time state, behavioural terms,
  periodic-settlement checkpoints, settled-interest state, and the
  periodic settlement deadline / delinquency bound; the client wiring and
  generated types need to carry those values through signing and fill.
- *The instant-sell entry point* gains, at minimum, a seller-economics
  bound receipt, a deadline, and the buyer-side inherited-state bounds —
  or is replaced by the position-sale bid above, which carries them
  natively.
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
**the prerequisites the Contract-level prerequisites section lists for
the listing path** must land first — the listing surface does not ship
over them — and **the items that section lists for the instant-sell
path** gate that surface on exactly the same terms. (Item numbers are
deliberately not repeated here; see the maintenance rule below.) Neither path ships over its own
open prerequisites; in particular the stored-borrower guard is not the
sole instant-sale blocker (an earlier revision of this paragraph implied
that, contradicting the prerequisites gate above — the authoritative
reading is the prerequisites section, and this paragraph now matches
it). The
awareness layer is the only part of Phase 1 that is unblocked today,
and it ships with both sale rows reporting as unavailable.

**Maintenance rule — item numbers live in exactly ONE place.** The
Contract-level prerequisites section is authoritative and is the only
section that states item numbers or a total count. Everywhere else —
this Phase-1 gate, the fork-tier schedule below, the not-frontend-only
note above — points at it instead of restating it.

That rule was earned. The restatements drifted three times: one draft
implied a single instant-sale blocker; later listing blockers landed in
the authoritative gate while the Phase-1 and fork-tier copies kept the
stale set; and the scoping note kept an obsolete total after the real
count had moved twice. Each drift left a roadmap an implementer could
follow to ship a surface over a live blocker — and the second one did it
while the text asserted the sections agreed, which is the worst version: a convenience copy that disagrees
with its source reads as confirmation. The previous revision of this
rule said a third drift would replace the numbers with pointers; that
threshold was reached, so the numbers are gone.

**When adding an item**: add it to the prerequisites section and its
per-path gate there. Do not add its number anywhere else in this
document — if a section seems to need one, that section wants a
cross-reference.

Fork-tier spec, scoped to whatever has actually shipped: chooser
renders for the lender in Basic mode, and a quote on a position
carrying a held balance shows that line. The listing post/lock/cancel
drive lands with the listing surface, and the instant-sell on-chain
lender-change drive lands with that surface — each after its own gating
items in the Contract-level prerequisites section (numbers not repeated
here, per the maintenance rule below). Writing a fork-tier drive for a path still gated open would
assert behaviour the design says must not be reachable yet.

**Phase 2 — comparison quotes (with the borrower "help me choose"
wizard).** Opt-in side-by-side: "sell now nets about X" vs "holding
to maturity pays about Y *if the borrower repays on time*" — the
conditional phrasing is mandatory; the projection is never a promise.

**Phase 3 — rentals decision.** Whether rental lender positions get
any early-exit story when the protocol grows one; until then the
chooser stays absent on rentals.

## Open questions

0. The borrower-freeze escape is REQUIRED (mandatory finite expiry,
   permissionless teardown, and a real borrower action window — see the
   Layer-3 checklist); what remains open is its shape: what bounded range
   the expiry may span (and its default), whether the action window is
   atomic teardown-and-action, relisting cooldown, borrower consent, or
   cumulative-tenure protection, and whether the current contracts can
   express that escape or need a contract/API change alongside this
   frontend work. If it needs a contract change, this design's Phase 1
   depends on it — the app cannot manufacture a borrower escape the
   protocol does not expose, and shipping the listing surface without one
   would knowingly hand sellers an indefinite lever. Resolve before
   implementation starts.
0b. Does the instant-sell path get patched (its per-term guards added
   one by one) or reshaped into a loan-specific position-sale bid (see
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
   an unescrowed bid recreates the revocable-funding failure verbatim,
   and the seller-side cost cap must be answered separately (escrow does not
   supply it; see the reservation-lifecycle bullet).
0c. For loans with an illiquid leg, does Phase 1 exclude both sale
   paths or admit them on the existing illiquid-risk consent (the
   unpriceable-position requirement)? A policy is required either way,
   because the risk math reverts rather than returning a conservative figure — so the
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
