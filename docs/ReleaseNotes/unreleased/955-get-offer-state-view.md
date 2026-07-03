## A single offer's lifecycle state is now readable on-chain (#955)

The plain offer getters (`getOffer` / `getOfferDetails`) return only the raw offer record, which can't tell every terminal apart. In particular, an offer that was **consumed by a position sale** without ever being accepted (a lender listed and sold their position, closing the listing) leaves an offer row that still *looks* open — nonzero creator, not accepted, not expired — so an integrator reading the raw row would wrongly treat it as a live, fillable offer. The alpha02 reference tooling worked around this indirectly by probing whether the offer's position NFT had been burned (an `ownerOf`-reverts liveness heuristic).

This adds a direct **`getOfferState(offerId)`** view that returns the canonical lifecycle state — Open, Accepted, Cancelled, or ConsumedBySale — with the same terminal-precedence the protocol already applies internally (Accepted wins over a later parallel-sale consumption, since the loan exists and that's the primary state). It promotes the previously-internal derivation that the state-filtered paginated views (`getOffersByStatePaginated` / `getUserOffersByStatePaginated`) already used, so the single-id and filtered-list surfaces now agree by construction.

With this view, integrators no longer need the burned-NFT liveness heuristic to detect a consumed-by-sale offer — they read the state directly. A never-existed or cancel-deleted id reports `Cancelled` (callers that must distinguish "never existed" pre-filter via the global counts), matching the existing derivation's legacy-compatible behaviour.

Closes #955.
