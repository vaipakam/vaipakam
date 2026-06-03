## Thread — T-086 Block C v1.1 — match OpenSea offers against Dutch listings (#332) (PR #<n>)

Closes #332.

Extends T-086 Block C's OpenSea-offers Match flow to listings posted
in Dutch-decay mode (Block B). v1 (PR #328) shipped Match against
fixed-price listings only; Dutch listings rendered an informational
banner in the panel slot.

**Match-shape decision: collapse the decay window in place.** When
the borrower clicks Match on an acceptable offer against a Dutch
listing, the dapp now calls
`updatePrepayDutchListing(loanId, offer.value, offer.value,
live.auctionEndTime, salt, conduit, feeLegs)`. The Dutch order
with `startAskPrice == endAskPrice` collapses Seaport's linear
interpolation to a constant value — the order behaves like a
fixed-price-at-`offer.value` for the rest of the window. The
**`auctionEndTime` is preserved** rather than reset to a fresh
short window: the original Dutch order's end was set against
`loan.gracePeriodEnd` per §15.5, and the same window remains valid
for the rotated order. The bidder gets the full remaining window
to fulfill — same race-window UX as fixed-price Match, no harder
deadline.

This is the simplest of the three shapes the Issue #332 card
enumerated:

- **Collapse in place** (chosen): one Dutch order rotation, no
  mode change, no extra on-chain calls.
- **Decay-to-offer**: keep the Dutch shape, anchor
  `endAskPrice = offer.value`, let `startAskPrice` decay TO the
  offer. Rejected — exposes the rotation to a snipe at the higher
  decay-start price.
- **Cancel + repost fixed-price**: cleaner semantically; two
  on-chain calls. Rejected for v1.1 — adds gas + complexity to a
  Match flow that already accepts the §15.3 race window.

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
