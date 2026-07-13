# Lender position sale — price accrued interest to the seller (E-7)

**Status:** design for an **owner economics decision + contract change**.
Card: #1209. Umbrella: #1221. Sequenced with the sale-vehicle chain
(#951 / #974 / #927) and `LenderSaleVehicleRedesign.md`.

## Current rule and why it's wrong

Early-Withdrawal Option 1 forfeits ALL of the selling lender's accrued
interest **to treasury**. Consequences: the seller is punished for exiting
(worse than the borrower's exit paths, which preserve the lender's
economics), positions trade below fair value, and treasury collects
windfall revenue uncorrelated with any service.

The fixed-rate commitment story does NOT require this: a position sale
never changes the borrower's terms — transfer-don't-break
([`UserValueEnhancementOpportunities.md`](UserValueEnhancementOpportunities.md) §1).
Commitment pricing belongs on term-*breaking* paths, not transfers.

## Design

Fair-value transfer pricing on both lender-sale paths (Option 1
sell-to-lender-offer, Option 2 sale vehicle):

```
salePrice = outstandingPrincipal
          + accruedInterestToDate × (10000 − yieldFeeBps_snapshot) / 10000
```

- Buyer pays `salePrice`; seller receives it in full; the position NFT
  transfers. **Treasury collects nothing at sale time.**
- **Single collection point:** the ordinary snapshot yield fee on the full
  interest is collected exactly once, at terminal settlement, from the
  then-holder (the buyer) — the same event and amount as if the position
  had never traded. The par formula nets the accrued slice by
  `(1 − yieldFeeBps)` precisely *because* the buyer will bear that fee at
  terminal; charging any fee at sale time as well would double-charge the
  accrued slice (Codex round-1 finding — earlier wording implying a
  sale-time treasury cut is superseded by this bullet).
- Borrower: zero change — rate, maturity, grace, claims untouched.

Discount/premium remains market-driven: the *listing* price is
seller-chosen (or offer-matched); the formula above defines the **par
reference** the UI displays ("this position's fair value today"), and the
minimum the protocol accounts correctly — it does not price-control.

Actually binding rule: `salePrice` is **gross**. There is no treasury cut
at sale. On a **matched** fill (E-8 sale vehicles), the seller-paid
matcher share (`saleMatcherFeeBps` of sale price, per
`SaleVehicleMatchabilityDesign.md`) is carved out of the seller's
proceeds; on a **direct accept** there is no matcher and the seller
receives the full gross. In both cases the buyer pays `salePrice`, the
buyer is tracked as the yield-entitled holder, and the one yield fee is
collected at terminal. Whether the parties transact above or below par is
theirs.

## Interactions

- **Reward entries:** unchanged — still-open interaction-reward entries
  re-anchor to the buyer at terminal close per TokenomicsTechSpec §4; the
  seller's earned-and-frozen slices stay theirs. (The lender-side reward
  forfeiture on the *sale* path should be revisited in the same owner
  decision: with fair-value pricing, forfeiting the seller's reward slice
  is a second punishment for the same act. Recommendation: seller keeps
  reward slices already frozen; open entries follow the buyer — i.e. the
  default re-anchoring rule with no sale-specific forfeiture.)
- **Sale vehicle (#951/#974):** the temp-loan mechanics don't change; only
  the settlement split does. Must land after the #951 fixes so tests build
  on the corrected lifecycle.
- **VPFI LIF custody:** untouched (borrower-side).

## Owner decision asked

1. Adopt fair-value pricing (treasury collects the ordinary yield fee
   once, at terminal settlement, never at sale) — replaces
   accrued-interest forfeiture on both lender-sale paths.
2. Drop the sale-path lender reward forfeiture in favor of the standard
   re-anchoring rule (recommended), or keep it (status quo).

## Tests

Settlement splits to the wei on both paths; buyer's terminal claim equals
a from-origination holder's; partial-repay-before-sale re-pricing; reward
re-anchoring; treasury receives exactly one snapshot yield fee per loan
(at terminal, never at sale) regardless of how many times the position
traded.

## Spec edit

ProjectDetailsREADME §9 Options 1–2 economics rewritten; release-note
fragment + FunctionalSpecs domain update in the implementing PR.
