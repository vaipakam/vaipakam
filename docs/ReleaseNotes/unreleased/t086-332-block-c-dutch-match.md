## Thread — T-086 Block C v1.1 — match OpenSea offers against Dutch listings (#332) (PR #<n>)

Closes #332.

Extends T-086 Block C's OpenSea-offers Match flow to listings posted
in Dutch-decay mode (Block B). v1 (PR #328) shipped Match against
fixed-price listings only; Dutch listings rendered an informational
banner in the panel slot.

**Match-shape: single-tx in-place `updatePrepayDutchListing` rotation.**
When the borrower clicks Match on an acceptable offer against a
Dutch listing, the dapp now calls
`updatePrepayDutchListing(loanId, offer.value, offer.value,
live.auctionEndTime, salt, conduit, feeLegs)`. The Dutch order
with `startAskPrice == endAskPrice` collapses Seaport's linear
interpolation to a constant — the order behaves like fixed-price-
at-`offer.value` for the rest of the original Dutch window.
`auctionEndTime` is preserved (gated by the new `dutchRunwayTooShort`
banner so it always satisfies the diamond's 1-hour
`MIN_AUCTION_WINDOW`). One wallet pop-up; the diamond's atomic
execution either commits or reverts the whole call — failure mode
on revert is "nothing happened", live Dutch listing intact.

**Why single-tx and not cancel+post.** An earlier rev of this PR
shipped cancel+post-as-fixed-price as the Dutch Match shape. Codex
review across 4 rounds surfaced a string of state-shift race
windows between the cancel tx and the post tx (kill switch toggle,
buffer-bps change, grace expiry, floor accrual, threshold
headroom, indexer-stale-row). Each finding required a pre-flight
check; even with all of them addressed, the failure mode was
destructive — cancel succeeded + post reverted leaves the borrower
with no live listing. User pushback ("why two transactions?")
prompted the pivot to single-tx, which has the same on-chain
checks but the failure mode collapses to "nothing happened" since
the diamond's atomic execution either commits or reverts both
state changes together. The 4 rounds of pre-flight cruft is gone.

The three Codex round-1 concerns that originally pushed the
implementation toward cancel+post are addressed structurally:

1. **`MIN_AUCTION_WINDOW` (1 hour)** — `dutchRunwayTooShort`
   banner gates the Match panel when
   `live.auctionEndTime - now ≤ 1h + 5min` (the 5-minute safety
   margin covers wallet sign + tx mining propagation). The
   borrower sees "your Dutch listing is in its final hour —
   cancel and re-post to restart the match flow"; the rotation
   tx never fires under those conditions.

2. **`DutchEndAskBelowProjectedFloorPlusFees`** — the section's
   threshold effect now reads `getPrepayContext(loanId,
   live.auctionEndTime)` (the future projected legs) for Dutch
   rows instead of `getPrepayContext(loanId, now)` (current
   legs). `computeAcceptable` classifies against the projected
   floor the facet itself validates, so an offer that clears the
   panel threshold is guaranteed to clear the
   `DutchEndAskBelowProjectedFloorPlusFees` check at tx-mining
   time. Fixed-price listings keep using current-time pctx.

3. **Missing Dutch publish path** — extended
   `publishPrepayListingToOpenSea` (`apps/defi/src/lib/openseaPublish.ts`)
   to accept optional `dutch?: { endAskPrice, auctionEndTime }`
   parameters. When set, it reads the projected pctx at
   `auctionEndTime` and threads the Dutch shape through
   `buildPrepayOrderComponents` (which already supports Dutch
   per Block B's landing). `useNFTPrepayListing.updatePrepayDutchListing`
   + `postPrepayDutchListing` both now call `runOpenSeaPublish`
   with Dutch params after the rotation tx confirms, so the
   bidder sees the rotated order on OpenSea's marketplace within
   seconds — same UX as fixed-price Match. The autonomous
   indexer-side publish stays as a safety net; the frontend
   path is now the primary.

**Fee-enforced support unchanged.** The fee-leg recompute from PR
#339 applies identically — the Match callback fetches the fresh
schedule + computes `feeLegs` before calling the rotation entry,
and the rotation entry threads `feeLegs` through the publish call
too (so the JS-rebuilt canonical orderHash matches the on-chain
hash on fee-enforced collections in Dutch mode).

**Race-window warning unchanged.** The `RaceWindowModal` from PR
#338 fires identically for both modes — any buyer can fulfill the
rotated listing between the borrower's tx and the bidder's
`Seaport.fulfillOrder`. The Dutch-specific 2-tx warning paragraph
that the round-3 cancel+post shape added is removed (single tx,
no 2-tx flow to warn about).

**Malformed-Dutch banner.** A Dutch indexer row missing
`auctionEndTime` or `endAskPrice` (a pre-migration row predating
Block B's publish or a transient indexer issue) renders a "decay
parameters missing" banner — same shape the pre-migration banner
takes for fixed-price.

**No contract surface changes.** `updatePrepayDutchListing` is
existing Block B surface; `publishPrepayListingToOpenSea` +
`runOpenSeaPublish` are dapp-side helpers. No new diamond storage,
no migration, no operator action post-merge. The indexer's
autonomous Dutch publish path is unchanged (it continues to run on
its cron interval as a safety net for posts where the frontend-
direct publish failed transiently — same role it played for
fixed-price posts before this PR).

**Out of scope** (tracked as follow-ups):

- Atomic match-rotation via Seaport `matchOrders` (#333 — the
  v2 shape that eliminates the race window altogether).
- The post-listing flow's empty-default `feeLegs[]` on Dutch
  (`PrepayListingActions.handleDutchPost` for the Dutch path) —
  same shape as the fixed-price post-side gap noted on #331.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
