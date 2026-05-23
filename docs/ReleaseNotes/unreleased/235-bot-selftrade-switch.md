## apps/keeper matcher — self-trade pre-filter + classifier log (Issue #235)

PR vaipakam/vaipakam#234 added `MatchError.SelfTrade` to the on-chain `LibOfferMatch.MatchError` enum and the `SelfTradeForbidden(party)` revert in `OfferAcceptFacet._acceptOffer`. The bot-side matchers — `apps/keeper/src/matcher.ts` (the protocol's own keeper Worker) and the public reference `vaipakam-keeper-bot/src/detectors/offerMatcher.ts` — kept submitting `matchOffers` for same-creator pairs and burning gas on the revert until they read the new classifier.

This release closes that gap on the protocol's own keeper. Two changes:

- A client-side pre-filter compares `L.creator` and `B.creator` before issuing the `previewMatch` `eth_call`. Same-creator pairs are skipped without an RPC roundtrip — one fewer call per colluding pair per tick. The `OfferLite` interface gains a `creator: Address` field; the `liftOffer` mapper picks it up from `getOffer`'s existing return shape, no ABI change.
- A defence-in-depth log at the post-`previewMatch` site fires when the classifier surfaces `MatchError.SelfTrade` despite the pre-filter. The intended steady state has zero of these logs; a non-zero count means the local `getOffer` snapshot raced an in-flight ownership transfer or a future refactor dropped `creator` from `OfferLite`. Per-pair logs for other typed errors stay off (too noisy on a busy book); per-tick `submits` / `previewCalls` counters carry the rest of the observability story.

Companion change in the public reference `vaipakam-keeper-bot` repo (PR there) carries the same pre-filter + log alongside its own `MATCH_ERR_SELF_TRADE` constant. Both matchers share the structural shape of the inner loop, so the diff is symmetric.

Out of scope:

- Any contract-side change to the self-trade policy — the `_acceptOffer` gate and the `previewMatch` classifier are the authoritative pair, both shipped in #234.
- Off-chain analytics for multi-account self-dealing (a user with two wallets) — that's fundamentally out of reach for a contract-side gate and remains an off-chain Sybil-detection concern.

Closes #235.
