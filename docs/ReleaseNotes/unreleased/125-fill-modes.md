## Thread — DEX-style offer fill-mode flavours (PR #__, Closes #125)

Vaipakam offers were implicitly partial-fillable since Range Orders
Phase 1: any match in `[amount, amountMax]` was legal, with the
remainder staying on the book. This thread adds the standard DEX
vocabulary on top — two new fill-mode flavours that a creator can
opt into at offer-create time without disturbing the default Partial
behaviour.

The new shape is a single `Offer.fillMode` enum
(`Partial` / `Aon` / `Ioc`):

- **`Partial`** is the default and the zero-init storage sentinel
  — every legacy offer and every legacy `CreateOfferParams`
  construction site reads as `Partial` without code changes.
- **`Aon`** ("All-or-Nothing") admits exactly one full-size fill,
  sized to `offer.amount`. The create-time invariant `amount ==
  amountMax` keeps the AON-required fill size unambiguous; the
  match-time gate in `LibOfferMatch.previewMatch` rejects any
  partial match against an AON side with a typed
  `AonRequiresFullFill(offerId, required, provided)` revert that a
  matcher's revert decoder can render directly.
- **`Ioc`** ("Immediate-or-Cancel") is partial-fillable inside a
  required time window (`expiresAt > 0`) and lapses into the same
  permissionless-clear path #195 introduced for GTT offers once the
  window elapses. Contract-side, IOC is a metadata wrapper over
  `expiresAt` plus the `fillMode` discrimination flag — no new
  enforcement mechanism, since #195's lazy-expiry gate already
  handles "past the deadline, refuse the offer."

`FOK`, `POST`, and `Iceberg` were considered and either rejected or
deferred. POST is a no-op for Vaipakam — every offer is structurally a
maker on this protocol (acceptors are users or the matcher bot, never
other offers), so POST-only would add a confusing UI option doing
nothing. FOK is strictly stricter than AON ("same block or revert")
which is a poor fit for P2P lending's slower match cadence; AON
serves the same user intent without the tx-ordering brittleness.
Iceberg defers post-mainnet — it adds non-trivial state for a
demand signal that hasn't materialised yet. The enum is append-only
so all three can land in follow-ups without breaking storage.

The companion `OfferCreatedDetails` event carries `fillMode` so
indexers and frontend cache merges can render the offer's mode chip
("AON" / "IOC, 60s left") directly from the event payload — no
follow-up `getOffer` view-call. Bulk-updated 220 `CreateOfferParams`
construction sites in tests + scripts to ship the explicit `Partial`
field; behavioural regression stays bit-for-bit identical because
`Partial` IS the zero-init default.

Out of scope and tracked separately:

- The "Fill mode" dropdown on the CreateOffer form + tooltips —
  follow-up UI card under `#166`.
- FOK / Iceberg / TWAP — append the enum + add the match-time branch
  whenever a user signal warrants it; non-breaking additions.
