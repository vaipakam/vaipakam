## Thread — Consolidate-before-listing on the Dutch / atomic / auto-list paths (PR #<n>)

Part of #698 → tracked to completion under #700 (#656c); closes out the
consolidate-before-listing family (#656). Builds on the #697 (#656a)
`LibPrepayOrder` lean and the #701 (#656b) fixed-price + parallel-sale hooks.

When a borrower position is transferred on the secondary market and the new
holder lists the collateral for sale, the listing-creation path must
consolidate the borrower side to the current holder *before* it caches the
holder's vault — otherwise the listing binds the departed borrower's vault and,
once the listing hash is set, every later borrower-side consolidation is
`_isExcludedLive`-skipped (the position locks out of consolidation). #656b
wired the two paths that fit within the recovered whole-unit stack slack; this
wires the remaining three listing-creation entries, each of which sat at its
own per-function viaIR stack ceiling and so needed a dedicated per-entry stack
lean before the one-line hook would fit:

- **`NFTPrepayDutchListingFacet.postPrepayDutchListing`** — consolidate after
  the holder check, before the Dutch order is built + the vault cached.
- **`NFTPrepayListingAtomicFacet.matchOpenSeaOffer`** — consolidate after STEP 0
  auto-clears any pre-existing v1 listing (so the borrower side is no longer
  excluded) and before the counter-order is built.
- **`NFTPrepayAutoListFacet.autoListAtFloorOnGrace`** — consolidate on the
  Case-A (fresh-post) path only, before the holder's vault is cached. Case B
  (rotation of an existing listing) needs no consolidation: a live listing
  locks the borrower NFT, so the position cannot have been transferred since
  the listing was created — whichever creation path posted it already
  consolidated.

All three use the few-byte cross-facet `ConsolidationFacet.eagerConsolidateToHolder`
(Tier-2 skip-not-block); no-op when the position hasn't been transferred or the
loan is terminal.

**Stack leans applied to fit the hooks (no external ABI change; the Seaport
orderHash each path produces is byte-identical):**

- Dutch — the post + update builders were unified into one private
  `_buildAndRecordDutch(..., bool lockNft)` called from both entries; the
  two-call-site shape stops the optimizer from inlining the heavy `recordOrder`
  marshalling back into either entry frame, and the order scalars now ride
  through a small `DutchParams` memory struct.
- Atomic — the canonical `PrepayListingMatched` event is now emitted BEFORE the
  `_settle` (`matchAdvancedOrders`) interaction rather than after. This is
  CEI-compliant (every field is already established by the counter-order
  record) and keeps the event payload off the stack across the heavy `_settle`
  marshalling. On revert the whole tx reverts, so observers only ever see the
  event on success; the topic-hash-keyed indexer is insensitive to intra-tx log
  ordering.
- Auto-list — the `_orderProtocolLegs` + `OrderContext` reads (consumed only by
  the B-cond rotation gate) were moved from `_caseBRotate` into
  `_pickBCondReason`, confining them to that frame so they no longer sit live
  across the snapshot→gate→rotation span. Both reads still run before
  `clearOrder`, so the pre-clear snapshot semantics are unchanged.

**Test coverage** — new transferred-position integration tests assert the
end-to-end mechanism (borrower side re-anchors to the current holder, the
collateral physically moves into the holder's vault, and the listing is bound
to that vault) for the fixed-price (`postPrepayListing`, #698), Dutch
(`postPrepayDutchListing`), and auto-list Case-A (`autoListAtFloorOnGrace`)
paths. The atomic `matchOpenSeaOffer` success path is fork-only (the unit
`MockSeaport` does not implement `matchAdvancedOrders`; the happy path lives in
`SeaportAtomicMatchForkTest`), so its transferred-position assertion is a
follow-up in that fork suite; the hook itself is placed identically to the
other paths (before the counter-order's vault read) and the shared
consolidation primitive is exhaustively covered by `CollateralConsolidation`.
The full prepay/Dutch/atomic/auto-list/parallel-sale suites stay green,
confirming the per-path leans leave the Seaport orderHash byte-identical.

No diamond cut, no selector/error/event signature change, so no ABI re-export.

Part of #656.
