## Thread — Consolidate-before-listing on the fixed-price + parallel-sale paths (PR #<n>)

Part of #698 (#656b), unblocked by the #697 (#656a) `LibPrepayOrder` lean.

When a borrower position is transferred on the secondary market and the new
holder lists the collateral for sale, the listing-creation path must consolidate
the borrower side to the current holder *before* it caches the holder's vault —
otherwise the listing binds the departed borrower's vault and, once the listing
hash is set, every later borrower-side consolidation is `_isExcludedLive`-skipped
(the position locks out of consolidation).

This wires the #594 borrower-side eager consolidation into the two paths that fit
within the recovered whole-unit stack slack:

- **`NFTPrepayListingFacet.postPrepayListing`** (the dominant fixed-price path) —
  after the holder check, before the order is built + the vault cached. No live
  listing hash exists there (the lock-check guarantees it), so the consolidation
  fires.
- **`OfferParallelSaleFacet.releaseParallelSaleLock`** — after the offer-keyed
  listing lock is cleared (so the borrower side is no longer excluded), if the
  offer has become a loan, consolidate it to the current holder.

Both use the few-byte cross-facet `ConsolidationFacet.eagerConsolidateToHolder`
(Tier-2 skip-not-block); no-op when not transferred or terminal.

**Deferred to #656c** (each needs its own entry-function stack lean, analogous to
#656a, because those entry functions sit at their own per-function viaIR
ceilings): `postPrepayDutchListing` (the 12-arg Dutch builder call), the atomic
`matchOpenSeaOffer` rotation, and `autoListAtFloorOnGrace` (the `_caseBRotate`
marshalling). The lock-out remains mitigated for all paths by the close-out
clear-then-consolidate (`precloseDirect`, #690) until those land.

Part of #698.
