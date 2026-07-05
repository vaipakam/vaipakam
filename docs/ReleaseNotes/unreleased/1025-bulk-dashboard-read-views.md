## Thread — Bulk wallet-dashboard read views (#1025 / PR #<n>)

The Diamond gained two Aave-`UiPoolDataProvider`-style bulk read views so a
connected wallet can hydrate its whole dashboard in one or two batched
`eth_call`s instead of a per-position fan-out. Before this change, the
chain-authoritative own-positions view read each enumerated offer with two
calls (fetch the offer, then derive its lifecycle state) and each held loan
with one fat full-record call — a heavy or griefed inventory could spray
hundreds of round trips and, worse, a single oversized response could fail the
entire refresh.

`getOffersWithState(offerIds)` returns one lean, dashboard-shaped record per id
— the exact fields the offer row renders — with each record already carrying
its canonical lifecycle state (Open / Accepted / Cancelled / ConsumedBySale),
so the two-call-per-offer pattern collapses to a single batch call.
`getLoansBatch(loanIds)` does the same for loans, returning the lean loan
summary plus the two counterparty addresses in place of the full 48-field
record. Both views are strictly positional and never de-duplicate their input:
a wallet that holds both sides of the same loan passes that loan id twice and
gets two aligned rows back, so neither role is hidden. An unknown or
already-closed id yields a blank record in place rather than reverting the whole
batch, and each view hard-caps its input length (returning a named
"batch too large" error) so a mis-sized caller sees an actionable failure
instead of silently degrading. Callers chunk their id set to stay under the cap;
the reference frontend's existing 200-id page size sits comfortably within it.

Internally, the offer lifecycle-state derivation that previously lived privately
on one facet was promoted into the shared metrics-types library, so the new bulk
view and the existing single-offer state view now share one definition and can
never disagree about an offer's state. That move is wire-compatible — the state
value is still a `uint8` on the ABI boundary and every selector is unchanged —
but it does shift the exported ABI's human-readable type label for the affected
signatures, which is why the metrics facet's committed ABI JSON shows a
cosmetic, no-runtime-effect diff alongside the new dashboard-facet surface.

The views live on the existing dashboard facet (no new facet, and it stays
within the contract-size limit), and the frontend ABI bundle was re-exported in
the same change so the committed package never lags the deployed surface.
Switching the reference app's own-positions reads onto these batch views (with a
graceful fall-back to the per-id path on older deploys) is a separate follow-up.
Closes #1025.
