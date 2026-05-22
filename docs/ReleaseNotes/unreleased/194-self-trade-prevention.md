## Self-trade prevention on direct-accept + matchOffers (Issue #194)

A single address can no longer occupy both sides of a loan at initiation. The protocol rejects any acceptance whose resulting loan would have the same address as both lender and borrower, with a typed `SelfTradeForbidden(address party)` revert that names the colliding address. The check covers every accept path — direct `acceptOffer` and bot-driven `matchOffers` — through a single load-bearing gate in `_acceptOffer` that fires after role resolution and before any state mutation.

Bots running the public `previewMatch` API see the same condition surfaced as a structured `MatchError.SelfTrade` classifier (a new variant on the existing enum), so they short-circuit before submitting a transaction that would revert. The classifier is a UX nicety on top of the contract gate, not a separate enforcement point — the contract revert is the authority.

The policy closes three risk vectors the card called out: a user paying themselves the matcher kickback portion of the Loan Initiation Fee (free yield on a low-gas chain), a user pumping their share of the cross-chain reward denominator with manufactured activity, and the protocol's active-loan analytics being polluted by positions a single user already owns. Legitimate position-mutation flows go through `PrecloseFacet` (preclose / offset / transfer-obligation) and `RefinanceFacet`, which are dedicated entry points and unaffected by this change.

The full policy rationale — including the two rejected branches (Allow-but-tax the matcher kickback, Allow unchanged) and why Branch A (Enforce) was chosen — is recorded in `docs/DesignsAndPlans/SelfTradePreventionADR.md`. The Functional Spec (`docs/FunctionalSpecs/ProjectDetailsREADME.md` §5) records the new invariant: "no single address may occupy both sides of a loan at initiation."

Scope notes:

- Multi-account self-dealing — a user with two wallets W1 and W2 posting offers from each — is out of reach for a contract-side gate (the protocol has no on-chain identity layer beyond `address`). The invariant is about the loan's two sides collapsing onto a single address; Sybil-style wallet pairs are an off-chain analytics concern.
- Approved-keeper self-trade still fires the revert. If a user authorizes a keeper to act on their behalf and that keeper matches the user's lender and borrower offers, the resulting loan still has `lender == borrower == userAddress`. Keepers don't bypass the gate.

Test coverage in `contracts/test/SelfTradePreventionTest.t.sol`: five cases — direct-accept of own lender offer, direct-accept of own borrower offer, matchOffers between two same-creator offers (third-party submitter; revert still fires), `previewMatch` surfaces the classifier without reverting, plus a happy-path negative-control with two distinct creators to catch any regression that inverts the gate. Full regression at 2046 / 0 / 0 (5 new tests, 2041 baseline pre-#194).

Wiring:

- `OfferAcceptFacet` declares the new `SelfTradeForbidden(address)` error; its ABI gains the selector via the standard frontend + bot ABI re-export.
- `LibOfferMatch.MatchError` gains the `SelfTrade` variant; `previewMatch` returns it early when `L.creator == B.creator`.
- `OfferMatchFacet.matchOffers` re-raises `SelfTradeForbidden` from the classifier so the matchOffers caller sees the same revert ABI the direct-accept path returns.

The bot-side matcher (`apps/keeper/src/matcher.ts`, public reference `vaipakam-keeper-bot/src/detectors/offerMatcher.ts`) should add `MatchError.SelfTrade` to its preview-result switch alongside the other typed errors it already short-circuits on. Until that update lands, bots will still submit the matchOffers transaction and burn gas on the revert — a follow-up to harden the off-chain matchers against the new classifier is tracked outside this card.

Closes #194.
