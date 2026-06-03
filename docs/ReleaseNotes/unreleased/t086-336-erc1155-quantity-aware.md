## Thread — T-086 Block C v1.1 — ERC1155 quantity-aware offer normalization (#336) (PR #<n>)

Closes #336.

Extends T-086 Block C's OpenSea-offers Match flow to NFT collateral
in ERC1155 form. v1 (PR #328) banner-gated ERC1155 collateral
entirely — the `OpenSeaOffersSection` short-circuited to a
"v1.1-deferred" alert before the offers panel rendered.

**What changed**

- `useOpenSeaOffers` now takes a `collateralQuantity: bigint`
  parameter and threads it into the per-row normalizer. ERC721
  collateral passes `1n` (and the normalizer's quantity check
  collapses to a no-op); ERC1155 collateral passes the loan's
  on-chain `collateralQuantity` from the loan reader.
- The normalizer reads each offer's `consideration[0].startAmount`
  for ERC1155 rows (`itemType === 3`). Only offers whose decoded
  quantity equals `collateralQuantity` exactly pass — partial-fill
  collection offers (quantity ≠ locked) and over-quantity offers
  both get filtered out at the normalize step. Concrete-shape
  ERC1155 offers that do match flow through to the panel with the
  same per-row acceptability classification as ERC721.
- `NormalizedOffer` carries a new `quantity: bigint` field. The
  panel surfaces "× N units" alongside the offer's value on rows
  where `quantity > 1`, so the borrower sees the per-unit
  breakdown for matchable ERC1155 offers without cluttering
  ERC721 rows.
- The panel's footer carries a one-line note explaining that
  partial-fill offers stay on OpenSea's marketplace but aren't
  surfaced in the Match panel — closes the loop on "why is my
  OpenSea inbox larger than what the dapp shows".
- `OpenSeaOffersSection` drops the now-unused `collateralAssetType`
  prop (only `2` mattered, and that case is now handled inside
  the hook). `LoanDetails` updated to pass `collateralQuantity`
  instead.

**Why exact-quantity match for v1.1**

The canonical Seaport order the diamond rotates against pins the
FULL vaulted `collateralQuantity`. An offer for a partial fill
would let the panel mark the row Match-able then revert at fill
time when the buyer pays the unit-priced offer for the
whole-quantity NFT. Per-fill partial-collateral-sale would need
a separate path (sell-N-of-M with the loan staying open against
the residual collateral); design it deserves its own card.
Filtering at the normalizer keeps the surface honest until that
card lands.

**No contract surface changes.** `updatePrepayListing` /
`updatePrepayDutchListing` already settle against the full
collateralQuantity for ERC1155 — this PR is purely the dapp's
normalizer + UI catching up.

**Out of scope** (tracked for follow-ups):

- Partial-collateral-sale flow (sell N of M units, leave the
  loan open against the residual). Needs its own design — the
  protocol's collateral-locking model is currently
  whole-lot-at-a-time.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
