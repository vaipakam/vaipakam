# Sale-vehicle listings in the Range-Order book (E-8)

**Status:** design for review; **blocked behind** #951 / #974 (sale-vehicle
on-chain fixes) and #927 (listing UI re-enable). Card: #1210. Umbrella:
#1221. Builds on `LenderSaleVehicleRedesign.md` and E-7
(`LenderSaleAccruedInterestPricingDesign.md`).

## Problem

Sale-vehicle offers are direct-accept-only, all-or-nothing, and reported
non-matchable to matchers/solvers — the thinnest liquidity surface on the
platform, on the path lenders most need liquidity.

## Design

### Matchability

Expose sale vehicles to `matchOffers` / solver preview with a distinct
offer class flag (`LINKED_LOAN_SALE`) so bots opt in knowingly:

- Match validity re-checks the linked loan live at execution: outstanding
  principal ≥ signed floor, collateral ≥ signed floor, loan still Active,
  no competing offset/listing lock — the same live-verification the direct
  accept does today, moved into the match path — **plus a buyer-signed
  minimum HF (or max LTV) for liquid-collateral positions** (Codex
  round-5, mirroring the E-9 bid rule): a pure oracle-price drop changes
  no counts and emits no loan event, so without an HF floor a standing
  buyer offer could be bot-matched into a position far unhealthier than
  previewed. Illiquid positions have no HF; amount floors are the whole
  check there and the accept-review copy says so.
- **Completion ordering (Codex round-5, the #951 D3 hazard):** with
  `partialFillEnabled` on, `OfferAcceptFacet._acceptOffer` defers
  `offer.accepted = true` for `matchOverride` borrower offers, while the
  sale auto-complete (`completeLoanSaleInternal`) requires the sale offer
  to be already accepted — so a naively-matched sale listing would revert
  at completion every time. The implementation must either flip the sale
  offer's accepted flag before the auto-complete step on the matched
  path (safe here: sale vehicles are AON, so the partial-fill deferral
  reason doesn't apply to this offer class), or route matched sales
  through a dedicated matched-sale completion entry that doesn't consult
  the deferred flag. This ordering decision is a hard prerequisite to
  exposing the class to `matchOffers`.
- The recorded matcher earns the configured share per the §5a
  recorded-matcher rule; sale vehicles charge **no fresh LIF** (existing
  rule preserved), and under the paired E-7 design there is **no
  sale-time treasury cut at all**, so the treasury cut cannot fund the
  matcher (Codex round-1 finding). Instead the matcher share is a small
  bounded bps **of the sale price, paid by the seller from sale
  proceeds** — the seller is the party demanding liquidity and pays for
  the fill service. New config `saleMatcherFeeBps` (bounded well below
  `MAX_FEE_BPS`; suggested default 10 bps), deterministic and quotable in
  the matcher preview so bots can rely on it; zero disables matcher
  payment for this class without disabling matchability.

### Partial fills — the hard part, resolved by scoping

A partial fill of a loan position would fractionalize the lender position
NFT — a claim-model and reward-accounting redesign (fraction-aware claims,
re-anchoring splits). **Out of scope.** Instead:

- v1 ships **matchable but AON**: any matcher can fill, exactly-full only.
  This alone moves sale vehicles from "one buyer must find the listing"
  to "every bot routes them".
- "Partial-fillable" is redefined as **tranching at listing time**: the
  seller may split a listing into N fixed tranches ONLY IF/WHEN position
  fractionalization is designed (tracked as a NOT-COMMITTED future note
  inside E-9's order-book design). No fraction math in v1.

### Staleness handling

The known refusal case (partial repayment shrank principal / liquidation
dropped collateral below signed floor → buyer refused, must re-sign) gets:

- an indexer flag on the listing row the moment a `LoanRepaid` /
  liquidation event touches the linked loan (event-driven, no polling),
- book UI shows "listing stale — awaiting seller re-sign",
- matchers receive the stale flag in preview so they skip it without a
  wasted attempt.

## Disclosure

Accepting a linked-loan offer must show the linked loan's live terms
(real collateral, elapsed term, settlement mechanics) — the #927-deferred
"accept review surface" is a **prerequisite**; this design consumes it.

## Tests

Match-path validity parity with direct accept (fuzz equivalence); AON
enforcement; matcher-share routing; stale-flag lifecycle; lock
mutual-exclusion (no match while borrower offset live, and vice versa).

## Spec edit

ProjectDetailsREADME §9 Option 2: remove "non-matchable", specify the
class flag, AON rule, matcher share, and staleness semantics.
