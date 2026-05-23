# ADR — Offer expiry / GTT support (Issue #195)

**Status:** Accepted
**Date:** 2026-05-23

## Context

Vaipakam's offers have been purely **Good-Till-Cancelled (GTC)** since
day one: the `Offer` struct has no expiry field, so an offer lives in
the order book indefinitely until the creator calls `cancelOffer`. CEXs
and DEXs typically also expose **GTT** (Good-Till-Time) and **GTD**
(Good-Till-Date) as separate fill-mode flavours. Adding optional
per-offer expiry is a small, high-value UX win:

- Lenders / borrowers who want a price-discoverable offer for a
  bounded window (e.g. "this rate is only good for an hour") don't
  have to remember to manually cancel.
- Stale offers don't clog the open-book scan after their creator's
  intent has changed.
- A creator who walks away from their position has a natural
  protocol-level expiration rather than having abandoned-but-active
  offers linger.

The deferred questions were: (a) which storage shape keeps the change
layout-additive; (b) where to enforce expiry on read; (c) how to clean
up the storage rows after a deadline lapses — keeper sweep, in-band
cleanup on adjacent writes, or fully lazy.

## Decision

**Three contract changes, all purely additive:**

1. **Pack a `uint64 expiresAt` into the Offer's slot 17.** Slot 17 was
   `uint64 createdAt + 24 bytes headroom` pre-#195 — co-locating the
   new field there avoids consuming a new slot AND means every legacy
   storage row reads `expiresAt == 0` from the zero-filled headroom,
   which is exactly the GTC sentinel we want. The bound checks at
   `createOffer` enforce `0 < expiresAt - block.timestamp <=
   MAX_OFFER_EXPIRY_HORIZON` (one year).

2. **Lazy enforcement at every offer-read consumer.** `_acceptOffer`,
   `LibOfferMatch.previewMatch`, `OfferMatchFacet.matchOffers`,
   `OfferAcceptFacet.previewAccept` all route through the shared
   `LibVaipakam.isOfferExpired(offer)` predicate. The actual revert
   (`OfferExpired(offerId, expiresAt)`) lives on the accept paths;
   the preview paths surface typed classifiers
   (`MatchError.OfferExpired` / `AcceptError.OfferExpired`) so bots
   and the frontend can short-circuit before submission.

3. **`cancelOffer` widens its access gate.** Previously creator-only;
   now creator-or-anyone-when-expired. The refund still routes to
   `offer.creator`, never `msg.sender` — the cleaner pays gas and
   earns only the SSTORE-clear gas-refund discount on their own tx
   (EIP-3529 caps that at 1/5 of gas used). The same widening
   applies to the cancel-cooldown bypass, so an expired offer is
   always cleanable even when `partialFillEnabled` is on.

The companion `OfferCreatedDetails` event carries `expiresAt` so the
indexer + frontend cache can render the GTT decoration directly from
the event payload — no follow-up `getOffer` view-call needed.

## Alternatives considered

### A. Lazy enforcement + permissionless explicit clear *(chosen)*

The shape implemented. Storage hygiene is opportunistic — the creator
calls `cancelOffer` when they realize their offer expired (refund +
SSTORE-clear gas discount on their own tx), or a frontend nudges any
connected wallet to "tidy up your N expired offers". Correctness is
load-bearing on rule 2 (lazy enforcement) alone; storage cleanup is a
nice-to-have driven by user incentive.

### B. Protocol-run keeper sweep

A separate Cloudflare Worker periodically scans expired offers and
calls `cancelOffer` in batch. **Rejected** for two reasons:

1. **EIP-3529 economics.** Gas refunds are capped at 1/5 of tx gas
   used. A sweep clearing N expired offers burns ~5× the value of the
   refunds it captures. The protocol pays gas in real units; the
   refund is a discount, never free money. Daily-sweep math on an L2
   comes out to ~$4/day spent to recover ~$1/day in refunds, plus the
   Worker + RPC quota costs. Structurally negative-EV.
2. **Operational burden.** Vaipakam already runs three Cloudflare
   Workers (indexer, keeper, agent). Adding a fourth — that exists
   solely to do work the user-incentive path can do for free —
   doesn't pull its weight.

### C. Bundled cleanup on adjacent writes

`createOffer` / `acceptOffer` / `matchOffers` opportunistically clear
M expired offers before doing their main work. **Rejected:** punishes
active users with a hidden gas tax to clean up after abandoners, and
the cleanup work is unbounded (M is variable per tx).

### D. Bounty-paid cleanup

Cleaner gets a fraction of the LIF treasury share, or a flat VPFI
kickback. **Rejected:** reintroduces keeper-bot economics; diverts
treasury revenue; adds per-offer accounting state to track the bounty
ledger. The user-incentive path is simpler and the bounty isn't
needed to motivate it.

### E. Auto-cancel on the creator's next interaction

Sweep the creator's expired offers when they next call
`createOffer` / `getOrCreateUserVault`. **Rejected:** only fires when
the creator returns; doesn't help with creators who actually wal
away (which is the high-value case).

### F. Permissionless `cancelOffer` on ANY offer (no expiry gate)

Drop creator-only entirely. **Rejected:** removes the creator's
exclusive right to cancel non-expired offers — anyone could grief by
front-running a fresh offer with a cancel of their own.

## Trade-offs accepted

- **Storage doesn't get garbage-collected unless someone proactively
  pays gas.** For Vaipakam's per-`offerId` storage keying (not packed
  bitmaps), inert storage rows are harmless — the open-book scan
  filters on `s.offers[id].accepted == false` so cancelled / expired
  rows are skipped, and the indexer marks them terminal off-chain via
  the `OfferCanceled` event.
- **`expiresAt` is immutable for the life of the offer.** No setter
  to extend or shorten the deadline post-create. The "extend" use
  case is served by `#193`'s in-place modification work (the same
  thread that adds `setOfferAmount` / `setOfferRate` would naturally
  add `setOfferExpiry` if user demand surfaces). Keeping `expiresAt`
  immutable in this PR keeps the access-control surface small.

## Failure modes

- **Caller passes `expiresAt = 0`.** This is the GTC sentinel and the
  documented default behaviour — accepted; the offer never expires.
- **Caller passes `expiresAt = block.timestamp` (or earlier).** Reverts
  `OfferExpiryInPast`. The boundary uses `<=` so an offer that's
  "expired on arrival" can't exist.
- **Caller passes `expiresAt > now + 1 year`.** Reverts
  `OfferExpiryAboveCap(provided, cap)`. Caps the grief window for the
  permissionless-clear path.
- **`block.timestamp == expiresAt`.** `isOfferExpired` uses `>=`, so
  this is already expired. Same convention on both write and read.
- **Future `block.timestamp` overflow.** `uint64` holds Unix-seconds
  through year 2554; not a 21st-century failure mode.

## Out of scope

- Other fill modes (AON / IOC / FOK / POST) — tracked under `#125`.
- Auto-renew / TWAP-style time-priced offers — separate roadmap if
  ever pursued.
- An optional treasury retention on GTC user-cancel as spam defense
  — deferred to `#193`'s in-place-modification thread, where the
  cancel-vs-modify ratio becomes meaningful. GTT/GTD expiry stays
  free of any treasury cut regardless of how the cancel-fee decision
  lands there.
- A permissionless batch `cancelExpiredOffers(uint256[])` — additive
  helper that can be added later if storage hygiene ever genuinely
  matters; the single-offer path covers correctness today.

## Test coverage

`contracts/test/OfferExpiryTest.t.sol` — 19 cases covering:

- createOffer bounds: GTC default, future-expiry stamping,
  past-expiry revert (`<=` boundary), above-cap revert, at-cap
  boundary acceptance.
- Direct accept: revert at `block.timestamp == expiresAt` (strict),
  revert past expiry, success one second before expiry.
- `previewAccept`: returns `OfferExpired` classifier when expired,
  clean when unexpired.
- `previewMatch`: returns `OfferExpired` classifier when either side
  (lender or borrower) is expired.
- `cancelOffer` access matrix:
  - Creator can cancel their own GTC offer (legacy behaviour).
  - Non-creator cannot cancel a GTC offer (legacy behaviour).
  - Non-creator cannot cancel a GTT offer before expiry.
  - Anyone can cancel an expired offer; refund routes to creator;
    cleaner receives no asset.
  - Creator can cancel their own expired offer.
- Cancel-cooldown bypass: expired offer cancellable even when
  cooldown window is notionally active.
