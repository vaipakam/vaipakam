# ADR — In-place offer modification (Issue #193)

**Status:** Accepted
**Date:** 2026-05-23

## Context

Vaipakam offers have always required a two-transaction `cancelOffer` +
`createOffer` round-trip to change their terms:

- Two gas payments.
- Two vault round-trips (refund the old offer's vaulted assets, then
  pre-vault the new offer).
- A window where the offer is off-book (between cancel-landing and
  create-landing), during which matcher bots see the position go dark.
- A new `offerId` per re-post, breaking external references like the
  position NFT and indexer follow-state.

DEX / CEX limit-order surfaces almost universally support **in-place
modification** — change price, size, or both without taking the order
off the book. This card adds the same affordance to Vaipakam.

## Decision

Add three per-field setters plus one atomic combined helper on a new
`OfferMutateFacet`. The facet is carved into its own runtime-bytecode
slot mirroring the `OfferCancelFacet` / `OfferMatchFacet` precedent
(one facet per lifecycle concern), keeping the EIP-170 review on
`OfferCreateFacet` clean.

**Surface:**

- `setOfferAmount(offerId, newAmount, newAmountMax)`
- `setOfferRate(offerId, newRateBps, newRateBpsMax)`
- `setOfferCollateral(offerId, newCollateralAmount, newCollateralAmountMax)`
- `modifyOffer(offerId, OfferModifyParams)` — atomic combined; one
  event, one transaction.

**Invariants enforced on every entry point:**

1. `msg.sender == offer.creator` (`NotOfferCreator`). The reuse of
   `LibAuth.requireOfferCreator` keeps the gate consistent with
   `cancelOffer`'s legacy creator-only path.
2. `!offer.accepted` (`OfferAlreadyAccepted`). Already-accepted
   offers are terminal — a spawned loan references their terms;
   post-hoc edits would silently change what the borrower agreed to.
3. The post-mutation offer satisfies the same range invariants
   `createOffer` enforces — `amount > 0`, `amountMax >= amount`,
   `interestRateBpsMax >= interestRateBps`, `<= MAX_INTEREST_BPS`,
   `collateralAmount > 0`, `collateralAmountMax > 0`,
   `collateralAmountMax >= collateralAmount`, and the lender
   single-value rule `collateralAmountMax == collateralAmount`. The
   revert types are re-used directly from `OfferCreateFacet` so the
   create and modify surfaces speak the same revert ABI.
4. **Partial-fill bound:** `amountMax >= amountFilled` and
   `collateralAmountMax >= collateralAmountFilled`. The portion
   already committed to live loans cannot be shrunk away — those
   loans reference the offer for their terms, and the matching
   path's `lenderRemaining = amountMax - amountFilled`
   computation underflows on a violating cap. Surfaces
   `ModifyBelowFilledFloor(provided, alreadyFilled)` so the UI
   can render the floor.
5. Per-asset pause on both legs, and sanctions screening on the
   creator. Pause gating is symmetric with `createOffer`'s
   create-time pause check.

**Delta math matrix (creator-side vault movements):**

| Offer type | Asset type   | `setOfferAmount`          | `setOfferRate` | `setOfferCollateral` |
|------------|--------------|---------------------------|----------------|----------------------|
| Lender     | ERC-20       | delta in `lendingAsset`   | no delta       | no delta             |
| Lender     | NFT rental   | no delta                  | no delta       | no delta             |
| Borrower   | ERC-20       | no delta                  | no delta       | delta in `collateralAsset` |
| Borrower   | NFT rental   | delta in `prepayAsset`    | no delta       | reverts `CollateralMutationUnsupportedForShape` |

The `prepayAsset` delta on borrower NFT-rental uses the current
`rentalBufferBps` for both sides of the diff. A governance bufferBps
change between create and modify leaves a tiny pull/refund mismatch
proportional to the buffer delta — accepted rather than snapshotting
bufferBps on every offer (rare governance event, bounded loss).

**LIF is NOT charged on a modify.** LIF is a loan-init fee, not an
offer-mutation fee. The matcher-fee kickback math also stays
unchanged; modify operates on offers, not loans.

**Event:** `OfferModified(offerId, creator, amount, amountMax,
interestRateBps, interestRateBpsMax, collateralAmount,
collateralAmountMax)` — single post-image. The "before" snapshot is
intentionally omitted; recoverable from the indexer's prior
`OfferCreated` / `OfferModified` row.

## Alternatives considered

### A. Per-facet, carved-out `OfferMutateFacet` *(chosen)*

The shape implemented. Keeps the lifecycle facets symmetric (one
per concern), and the runtime-bytecode budget on `OfferCreateFacet`
stays untouched.

### B. Extend `OfferCreateFacet` with the mutate entry points

Would add ~3kB to `OfferCreateFacet`'s ~12kB headroom (still under
EIP-170). **Rejected** because it conflates create and modify under
one facet's audit surface, and a future feature on either side
would re-trigger the carve-out decision anyway.

### C. Single `modifyOffer` with sentinel "no change" markers

`modifyOffer` accepts `0` or `max-uint` as sentinels meaning "don't
change this field." Smaller calldata when only one field changes.
**Rejected** — `0` is a legitimate rate value, so the sentinel
collides with a real input; per-setter clarity beats calldata
micro-optimisation.

### D. Three independent setters only, no combined helper

Caller chains three `setOfferX` calls via multicall. **Rejected** —
no atomicity guarantee across the three on the contract side
(multicall achieves it client-side), and a single `OfferModified`
event with the full post-image is easier for indexers than three
separate per-field events.

### E. Treasury fee on GTC user-cancel as spam defense

Was discussed during the design session as a possible add-on once
modify deprecates the legitimate cancel-and-re-post flow.
**Rejected** — gas alone (create + cancel = ~$0.50-1.00 on Base L2
with the vault round-trip) is already a meaningful spam disincentive;
adding a protocol fee would just stack on top without changing the
spam equilibrium, AND the existing `MIN_OFFER_CANCEL_DELAY` cooldown
(5 min when `partialFillEnabled` is on) covers front-run defence.
Documented this decision in the user feedback memory.

## Trade-offs accepted

- **Borrower NFT-rental amount delta uses current bufferBps for both
  sides.** A bufferBps change between create and modify leaves a tiny
  mismatch versus the actually-vaulted prepay — proportional to the
  buffer delta × `amount × durationDays`. Buffer changes are rare
  governance events. The alternative (snapshot bufferBps on every
  offer) adds a permanent storage cost to every offer for a rare
  edge case.
- **`expiresAt` is not modifiable.** Per #195's design notes, the
  expiry is immutable for the offer's lifetime. Extending it would
  require either a separate setter (deferred — no current user
  request) or coupling expiry into `OfferModifyParams` (out of scope
  for this card).
- **Borrower NFT-rental can't `setOfferCollateral`.** That shape
  vaults prepay in `prepayAsset`, not collateral in `collateralAsset`,
  so a collateral-only mutation has no escrow movement to settle.
  Allowing a no-op storage write would diverge the offer's stated
  collateralAmount from what the matching path expects — clean
  revert (`CollateralMutationUnsupportedForShape`) is the right
  default. Modifying the prepay-bearing daily fee (`amount`) is
  supported.

## Failure modes

- **Caller is not the creator** → `NotOfferCreator`. Same gate as
  `cancelOffer`.
- **Offer is already accepted** → `OfferAlreadyAccepted`. Same as
  cancel.
- **`amountMax < amountFilled`** → `ModifyBelowFilledFloor(provided,
  alreadyFilled)`. Tells the UI the floor.
- **Invariant violation (amount, rate, or collateral range)** →
  re-uses the matching `OfferCreateFacet` error
  (`AmountMustBePositive`, `InvalidRateRange`, etc.).
- **Per-asset pause active** → revert via
  `LibFacet.requireAssetNotPaused`, same path as `createOffer`.
- **Sanctions oracle flags caller** → `SanctionedAddress(who)`. The
  Tier-1 sanctions policy applies — creator initiating a protocol
  state change.

## Test coverage

`contracts/test/OfferModificationTest.t.sol` — 21 cases covering:

- `setOfferRate` happy path + invariant reverts + creator gate.
- `setOfferAmount` lender ERC-20 shrink/grow delta math + invariant
  reverts + creator gate + already-accepted gate.
- `setOfferCollateral` borrower ERC-20 shrink/grow delta math +
  lender single-value invariant + lender storage-only update + the
  `CollateralMutationUnsupportedForShape` revert path.
- `modifyOffer` combined atomic — lender all-fields update, borrower
  with collateral delta, idempotent no-op when values unchanged,
  atomicity (one field's violation rolls back the whole tx).
- Sanctions screening on the modify entry.

The partial-fill bound is structurally pinned in
`_assertAmountInvariants`; realistic end-to-end coverage lives in
`BorrowerPartialFillTest` and the matchOffers suite that already
exercise `amountFilled` mutation.

## Out of scope / tracked separately

- The order-book UI for the modify interaction (pencil-icon on the
  user's own-offer rows) — `#166` UX surface.
- The `MIN_OFFER_CANCEL_DELAY` cooldown countdown chip — `#241`.
- A `modifyOfferExpiry` setter — deferred; no current user request.
- A batch `modifyOffers` for multi-offer rebalances — additive
  helper that can land later if a real use case surfaces.
