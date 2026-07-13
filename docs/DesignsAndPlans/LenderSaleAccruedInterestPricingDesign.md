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

- Buyer pays `salePrice`; seller receives it; the position NFT transfers.
- **Treasury takes only its ordinary snapshot yield fee** on the accrued
  portion — the same cut it would have taken at maturity; no forfeiture.
- From the buyer's perspective the accrued interest purchased is cost
  basis; at settlement the buyer receives principal + full-term interest
  minus the ordinary yield fee, exactly as any current holder would.
- Borrower: zero change — rate, maturity, grace, claims untouched.

Discount/premium remains market-driven: the *listing* price is
seller-chosen (or offer-matched); the formula above defines the **par
reference** the UI displays ("this position's fair value today"), and the
minimum the protocol accounts correctly — it does not price-control.

Actually binding rule: the protocol no longer routes accrued interest to
treasury at sale settlement; it routes `salePrice` seller-ward and tracks
the buyer as the yield-entitled holder. Whether the parties transact above
or below par is theirs.

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

1. Adopt fair-value pricing (treasury keeps ordinary yield fee only) —
   replaces accrued-interest forfeiture on both lender-sale paths.
2. Drop the sale-path lender reward forfeiture in favor of the standard
   re-anchoring rule (recommended), or keep it (status quo).

## Tests

Settlement splits to the wei on both paths; buyer's terminal claim equals
a from-origination holder's; partial-repay-before-sale re-pricing; reward
re-anchoring; treasury receives exactly the snapshot yield fee.

## Spec edit

ProjectDetailsREADME §9 Options 1–2 economics rewritten; release-note
fragment + FunctionalSpecs domain update in the implementing PR.
