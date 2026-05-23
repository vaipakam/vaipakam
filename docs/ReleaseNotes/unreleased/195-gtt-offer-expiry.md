## Thread — GTT / offer-expiry support (PR #__, Closes #195)

Vaipakam offers have been purely Good-Till-Cancelled (GTC) since day
one: an offer lives in the order book until its creator calls
`cancelOffer`. This thread adds optional **Good-Till-Time** semantics
without changing the GTC default. Creators can now post an offer with
an absolute unix-seconds deadline; once the wall-clock passes the
deadline, the offer can no longer be accepted or matched, and the
permissionless lazy-clear path lets anyone tidy up the storage row
(refund flows to the creator regardless of who calls it).

The shape is intentionally minimal:

- `Offer.expiresAt` (`uint64`) packs into the same storage slot as
  the existing `createdAt`, so the storage layout grows without
  consuming a new slot. Every legacy storage row reads
  `expiresAt == 0` — the GTC sentinel — so pre-#195 offers behave
  exactly as before.
- `CreateOfferParams.expiresAt` is the create-time input. `0` keeps
  the GTC default; any non-zero value must lie strictly after now
  and within a one-year horizon cap (`MAX_OFFER_EXPIRY_HORIZON`).
  Out-of-bound values revert `OfferExpiryInPast` or
  `OfferExpiryAboveCap(provided, cap)`.
- Lazy enforcement: every consumer that binds an offer to a loan —
  `_acceptOffer`, `LibOfferMatch.previewMatch`,
  `OfferMatchFacet.matchOffers` — runs `LibVaipakam.isOfferExpired`
  before any state mutation and reverts `OfferExpired(offerId,
  expiresAt)`. The matching `MatchError.OfferExpired` classifier
  surfaces through `previewMatch` so bots can short-circuit at
  preview-time. `previewAccept` gains the same classifier on
  `AcceptError.OfferExpired` so the connected app can render an
  "expired" badge and disable the Accept button without an extra
  RPC roundtrip.
- `cancelOffer`'s access gate widens: the creator can still cancel
  their own offer unconditionally, AND any caller can cancel an
  offer whose deadline has elapsed. The cleaner pays gas; the
  refund routes to `offer.creator` (never `msg.sender`), so the
  permissionless path can't be used to drain another user's vault.
  The cancel-cooldown bypass for expired offers preserves the
  consistency invariant ("an expired offer is always cleanable")
  even when `partialFillEnabled` is on.

`OfferCreatedDetails` carries `expiresAt` on the companion event so
indexers and the frontend cache can render the GTT decoration
("expires in 3h 12m"; "expired — anyone can clean up") directly from
the event payload — no follow-up `getOffer` view-call.

Why we picked lazy enforcement over a keeper sweep: EIP-3529 caps
gas refunds at 1/5 of the transaction gas, so a protocol-run sweep
would burn ~5× the value of the refunds it captures. Lazy
enforcement + permissionless explicit clear gets correctness without
that economic loss — and avoids the operational burden of running
yet another keeper bot. The full alternatives table lives in
`docs/DesignsAndPlans/OfferExpiryGTTDesign.md`.

Out of scope and tracked separately: other fill modes
(AON / IOC / FOK / POST — `#125`); auto-renew / TWAP-style time-priced
offers; the optional treasury retention on GTC user-cancel for
spam-defense, deferred to `#193`'s in-place-modification thread
because the cancel-vs-modify ratio only becomes meaningful once
modification exists.
