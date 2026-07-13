# Borrower standing intents (E-5)

**Status:** design for review before build. Card: #1207. Umbrella: #1221.
Related: `HybridIntentLayer.md`, `LenderIntentVaultV1Design.md`.

## Problem

Lenders have standing intents, solver fills, and auto-roll; borrowers have
nothing equivalent ("Borrowers have no equivalent intent list" —
ProjectDetailsREADME §3). Demand-side liquidity is manual-only.

## Design

Borrower registers a standing intent:

```
BorrowerIntent {
  lendAsset; maxPrincipal; minPrincipal;
  collateralAsset; collateralCapAmount;
  maxRateBps; durationRange;         // bucketed durations
  fillMode;                          // PARTIAL | AON
  expiry;                            // GTT optional, GTC default
  consentAnchor;                     // risk-and-terms ack hash (commit-reveal, reuse progressive-risk anchor)
}
```

A solver fills it against a compatible lender offer/intent; the loan
initiates with the borrower as acceptor-equivalent.

## The one genuinely new design surface: collateral readiness

Lender intents lock *working capital* (principal). The borrower equivalent
must guarantee collateral at an unknown future fill time. Options:

1. **Pre-lock (recommended v1):** registering the intent locks
   `collateralCapAmount` in the vault as an intent working-capital lock —
   the exact mechanism lender intents already use, same encumbrance class,
   same withdraw-blocking. Partial fills consume the lock pro-rata.
   Deterministic fills, no fill-time reverts. Cost: borrower capital
   parked while unfilled (mitigated by easy cancel + GTT).
2. Pull-authorization at fill (wallet allowance) — rejected for v1:
   fill-time revert risk makes solver work speculative, and standing
   wallet allowances are the drainer-UX shape we avoid elsewhere.

## Fill flow

1. Solver calls `matchIntent(borrowerIntentId, lenderOfferId, amount)`.
2. Protocol validates compatibility exactly as the existing matcher does
   (rate ≤ maxRate, duration bucket, assets, KYC/sanctions gates,
   self-trade prevention, progressive-risk tier gates on both sides).
3. Collateral moves from the intent lock into the loan lien; principal
   flows per the normal initiation path; LIF + matcher share unchanged
   (matcher = `msg.sender` at match, per the §5a recorded-matcher rule).
4. HF admission check runs as on any initiation — an intent fill can never
   bypass it.

Rate improvement rule: fills execute at the *lender's* offered rate when
below the borrower's `maxRateBps` (price improvement to the borrower),
mirroring the range-order midpoint logic only when both sides are ranged.

## Consent

The intent registration carries the full typed risk-and-terms
acknowledgement (commit-reveal terms anchor, as progressive risk-access
already does) so a solver fill does not need a fresh borrower signature.
Any disclosure-driving parameter edit re-requires the ack (consistent with
the platform consent rule).

## Out of scope (v1)

NFT collateral intents (valuation-consent flow is inherently interactive);
auto-roll on the borrow side; cross-chain intents.

## Tests

Registration/lock/cancel/expiry; partial-fill lock consumption; fill-time
gate parity with acceptOffer (fuzz same-inputs equivalence); price
improvement; consent-anchor mismatch rejection; encumbrance interplay with
withdraw and other flows.

## Spec edit

ProjectDetailsREADME §3: new "Standing borrowing intents" subsection
mirroring the lender-intent section's structure.
