## Thread — In-place offer modification (PR #__, Closes #193)

Vaipakam offers have always required `cancelOffer` + `createOffer` to
change their terms. That's two transactions, two gas charges, two
vault round-trips, and a window where the offer is off-book. This
thread adds in-place modification so a creator can adjust their open
offer's principal range, rate range, or collateral range without
ever taking it off the book.

The shape is a new `OfferMutateFacet` carved into its own facet
mirroring the OfferCancel / OfferMatch precedent (one facet per
lifecycle concern, EIP-170 budget tracking stays clean). It hosts
three per-field setters and one combined atomic helper:

- `setOfferAmount(offerId, newAmount, newAmountMax)` — principal
  range. Lender ERC-20 offers pull / refund the delta in
  `lendingAsset`. Borrower NFT-rental offers pull / refund the
  prepay delta in `prepayAsset` (the prepay formula
  `amount × durationDays × (1 + bufferBps)` keys on `amount`, so a
  rate change moves the vaulted prepay). Other shapes update
  storage with no vault movement.
- `setOfferRate(offerId, newRateBps, newRateBpsMax)` — rate range.
  Never moves vaulted funds; rate is offer-terms metadata.
- `setOfferCollateral(offerId, newCollateralAmount, newCollateralAmountMax)`
  — collateral range. Borrower ERC-20 offers pull / refund the delta
  in `collateralAsset`. Borrower NFT-rental offers revert
  `CollateralMutationUnsupportedForShape` because that shape vaults
  prepay (in `prepayAsset`), not collateral; allowing storage writes
  without the corresponding escrow movement would create a divergence
  between the offer's stated collateral and what the matching path
  would expect.
- `modifyOffer(offerId, OfferModifyParams)` — combined atomic helper.
  Validates the union of per-setter invariants and settles the union
  of deltas in a single transaction. Emits one `OfferModified` event
  with the post-image of all six fields, so indexers see one mutation
  instead of three.

Invariants enforced on every entry point:

- Only the offer creator can modify their own offer
  (`NotOfferCreator`).
- Already-accepted offers are terminal — modification reverts
  `OfferAlreadyAccepted`, same as cancel.
- The post-mutation offer satisfies the same range invariants
  `createOffer` enforces (`amount > 0`, `amountMax >= amount`,
  `interestRateBpsMax >= interestRateBps`, etc.). The revert types
  are re-used directly from `OfferCreateFacet` so the create and
  modify surfaces speak the same revert ABI.
- Partial-fill bound: `amountMax >= amountFilled` and
  `collateralAmountMax >= collateralAmountFilled`. The portion
  already committed to live loans cannot be shrunk away — those
  loans reference the offer's terms; collapsing the cap below
  what's already filled would orphan real obligations.
- Per-asset pause + sanctions screening on the creator, same as the
  create path.

LIF is NOT charged on a modify — LIF is a loan-init fee, not an
offer-mutation fee. The matcher-fee kickback math also stays
unchanged; modify operates on offers, not loans.

The companion `OfferModified` event carries the full post-image so
indexer / frontend cache merges update from the event payload alone
— no follow-up `getOffer` view-call needed. The "before" snapshot is
intentionally omitted (recoverable from the indexer's prior
`OfferCreated` / `OfferModified` row).

Operational note: the borrower NFT-rental amount-delta math uses the
**current** `rentalBufferBps` for both sides of the diff. A
governance bufferBps change between create and modify would leave a
tiny refund / pull mismatch versus the actually-vaulted prepay,
proportional to the buffer delta. Buffer changes are rare governance
events; the design accepts this drift rather than snapshotting
bufferBps on every offer.

Out of scope and tracked separately:

- The order-book UI for the modify interaction (pencil-icon on the
  user's own-offer rows) — tracked under `#166` as the UX surface.
- The `MIN_OFFER_CANCEL_DELAY` cooldown countdown chip — tracked
  under `#241` (the cooldown predates this thread; surfacing it is
  orthogonal to modify-in-place).
- A GTC user-cancel treasury fee — explicitly rejected in the design
  discussion. Gas alone (create + cancel = ~$0.50-1.00 on Base L2)
  is already a meaningful spam disincentive; adding a protocol fee
  would just stack on top without changing the spam equilibrium.
  The existing `MIN_OFFER_CANCEL_DELAY` cooldown (5 min when
  `partialFillEnabled` is on) covers front-run defence.
