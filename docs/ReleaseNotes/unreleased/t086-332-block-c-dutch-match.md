## Thread — T-086 Block C v1.1 — match OpenSea offers against Dutch listings (#332) (PR #<n>)

Closes #332.

Extends T-086 Block C's OpenSea-offers Match flow to listings posted
in Dutch-decay mode (Block B). v1 (PR #328) shipped Match against
fixed-price listings only; Dutch listings rendered an informational
banner in the panel slot.

**Match-shape decision: cancel + repost as fixed-price.** When the
borrower clicks Match on an acceptable offer against a Dutch
listing, the dapp now runs a two-tx sequence:
`cancelPrepayListing(loanId)` followed by
`postPrepayListing(loanId, offer.value, salt, conduit, feeLegs)`.
The Dutch order is removed; a fresh fixed-price order at the
offer's value takes its place. This is two wallet pop-ups for
the borrower vs the single rotation a fixed-price Match takes,
but it's the only shape that ships clean — see the Codex round-1
findings on PR #340 for the structural reasons. Briefly:

- **In-place rotation via `updatePrepayDutchListing`** trips on
  three Dutch-side facet constraints — `MIN_AUCTION_WINDOW`
  (1 hour) rejects the preserved `auctionEndTime` near the
  original window's end, `DutchEndAskBelowProjectedFloorPlusFees`
  rejects the end-ask against projected-end-time floor not
  current-time floor (interest accrual makes the projected floor
  higher than the panel's classification floor), and the Dutch
  update path doesn't currently call the
  frontend-direct `runOpenSeaPublish` — the bidder would wait on
  the autonomous indexer cron to surface the rotated order on
  OpenSea, which is too slow for the Match flow's
  bidder-notification window.

- **Cancel + repost-as-fixed-price** sidesteps all three. The
  post path uses current-time pctx (no projected-floor concern),
  doesn't go through `_assertDutchWindow` (no 1-hour gate), and
  publishes through the existing `runOpenSeaPublish`. The
  trade-offs the original card's "Cancel + repost" alternative
  flagged (extra gas, mode change) are real but bounded; the
  trade-offs the in-place rotation faces are structural and
  would require extending the Dutch publish path to land
  cleanly. Deferring that publish-path extension keeps #332's
  scope tight + leaves the optimal in-place shape as a v1.2
  follow-up.

The three shapes the Issue #332 card enumerated:

- **Cancel + repost fixed-price** (chosen): two on-chain calls,
  uses existing post path's well-tested publish + floor logic.
- **In-place collapse** (rejected during PR review): one tx but
  three structural Dutch-side constraints to address.
- **Decay-to-offer** (rejected up front): keep the Dutch shape,
  anchor `endAskPrice = offer.value`, let `startAskPrice` decay
  TO the offer. Exposes the rotation to a snipe at the higher
  decay-start price.

**Malformed-Dutch banner**: a Dutch row whose `auctionEndTime` or
`endAskPrice` is missing from the indexer (pre-migration row
predating the Block B publish) now renders a "decay parameters
missing" banner instead of attempting a rotation with bad
parameters. The existing pre-migration banner covered missing
salt / conduit; this adds the Dutch-specific case.

**Race-window warning + fee-enforced support unchanged.** The
`RaceWindowModal` from PR #338 and the fee-leg recompute from PR
#339 both apply identically — the Match callback computes the
fresh schedule + feeLegs first, then branches on
`live.auctionMode` to pick the right write entry. Fee-enforced
Dutch collections settle through the same `feeLegs` calldata path
as fixed-price ones, the only difference being which diamond
selector the rotation hits.

**No contract surface changes.** Both `updatePrepayListing` and
`updatePrepayDutchListing` already accept `feeLegs` per Block A's
landing; this thread is purely the dapp wiring that picks between
them. No new diamond storage, no migration, no operator action
post-merge.

**Out of scope** (intentional, tracked as follow-ups):

- Atomic match-rotation via Seaport `matchOrders` (#333 — the v2
  shape that eliminates the race window altogether).
- The post-listing flow's empty-default `feeLegs[]` on Dutch
  (`PrepayListingActions.handlePost` for the Dutch path) — same
  shape as the fixed-price post-side gap noted on #331.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
