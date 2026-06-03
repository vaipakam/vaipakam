## Thread — T-086 Block C — indexer breadcrumb on accepted offers (analytics) (#335) (PR #<n>)

Closes #335.

Adds an analytics breadcrumb that records which OpenSea offer
triggered each prepay-listing Match-rotation. T-086 Block C
(PR #328) reuses the existing `updatePrepayListing` /
`updatePrepayDutchListing` entry points for OpenSea-offer matches,
so the on-chain event surface is unchanged — every Match emits
the same `PrepayListingUpdated` the indexer already handles. As
a result the indexer can't distinguish between **a
Match-from-OpenSea-offer rotation** and **a manual repricing** by
reading on-chain history alone.

The card's option (1) — dapp-side breadcrumb POST — wins on
reliability and simplicity over the alternatives. The other
options were:
- **(2) Indexer correlation pass** (query the agent proxy for
  offers around the rotation timestamp + price + infer the
  matched offer). Heuristic; misses unusual-price matches or
  ties.
- **(3) Dedicated on-chain event** (`PrepayListingMatchedFromOffer`
  with the offer ID indexed). Most accurate but requires a
  contract change + audit pass — overscope for analytics
  metadata.

**What changed**

- `apps/indexer/migrations/0019_prepay_listing_match_breadcrumbs.sql`
  adds a new table keyed on `(chain_id, tx_hash)` (loan IDs are
  scoped per chain in this codebase, matching how
  `prepay_listings` keys rows; a tx_hash without chain_id would
  conflate breadcrumbs across configured chains). `(chain_id,
  loan_id)` is separately indexed so the loan-history join is
  cheap. No FK to `prepay_listings` or `loans` — the indexer's
  reorg-windowed feed can serve the pre-rotation row right up
  until the post tx lands, and a strict FK at insert time would
  race the indexer's materialisation; the query-time join
  handles it.
- New `POST /loans/:loanId/prepay-listing/match-source?chainId=N`
  endpoint in `apps/indexer/src/loanRoutes.ts`. Strict hex
  validation on every field. **Conflict policy: `INSERT OR
  REPLACE`** (Codex round-1 P2 #343). Lets the legitimate dapp
  retry override an attacker's first-arrival spoof; emits an
  operator-visible warning whenever a row is overwritten with a
  payload that differs from what's stored — that includes a
  `loan_id` mismatch (Codex round-3 P2 #343), since the REPLACE
  also overwrites the `loan_id` column and a spoofer POSTing to
  a different `/loans/<wrong>/` URL with the same public
  `(orderHash, bidder)` would otherwise silently move the
  breadcrumb to another loan and corrupt the loan-history join.
  A sustained spoof attack now shows up in the indexer logs as a
  tx_hash receiving multiple distinct `(loan_id, orderHash,
  bidder)` writes. Full prevention would need EIP-712 signed
  claims from the borrower; documented as a v2 follow-up. For
  non-financial analytics metadata the replace-and-warn shape is
  the right v1.1 trade-off.
- New `OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT` rate-limit binding
  on the indexer Worker (60 req/min/IP). Matches the per-IP
  rate-limit shape `apps/agent` uses; the indexer's existing
  read surface stays uncapped (read-only, cached, low cost) but
  the new POST surface is opt-in to the same defensive posture.
- New `postPrepayMatchSource(chainId, loanId, body)` helper in
  `apps/defi/src/lib/indexerClient.ts` — best-effort POST that
  returns a boolean for telemetry/tests but callers don't
  branch on it (the rotation tx is already on-chain by the
  time this fires). Sets `keepalive: true` on the fetch (Codex
  round-3 P3 #343) so the small JSON POST survives a tab close
  or full-page navigation immediately after the receipt arrives
  — exactly the close-the-tab case the early-fire callback in
  `useNFTPrepayListing` is trying to cover. Non-2xx responses
  (rate-limit 429, D1 500, payload-rejection 400) log a console
  warning before returning `false` (Codex round-3 P3 #343), so
  the failure mode promised by the UI ("failures are logged") is
  actually delivered rather than swallowed when the response
  body is well-formed but the status code isn't.
- `useNFTPrepayListing` extends `updatePrepayListing` +
  `updatePrepayDutchListing` with an optional `matchSource?:
  MatchSourceBreadcrumb` parameter. When set, after the
  rotation tx confirms, the hook fires the breadcrumb POST
  **before** awaiting the OpenSea publish step and **without
  awaiting the POST itself** (`void` instead of `await`).
  Codex round-1 P2 + P3 #343: a stalled publish can no longer
  block the breadcrumb, and the breadcrumb's own RTT can no
  longer block the Match-button's `onClick` from resolving.
  Manual repricings (`PrepayListingActions`) omit the
  `matchSource` param and stay unchanged.
- `OpenSeaOffersSection`'s Match callback passes
  `{ orderHash: offer.orderHash, bidder: offer.bidder }` as
  `matchSource` on every Match — covering both fixed-price and
  Dutch rotations through the same path.
- `apps/indexer/src/index.ts`'s header comment updated to note
  the Worker now accepts the one breadcrumb POST in addition to
  its public-read GETs.

**Why hook-side and not section-side**

The Match-rotation tx receipt (which carries the `transactionHash`
the breadcrumb keys on) is exposed inside `useNFTPrepayListing`'s
`runWrite` callback, not as a React render-state field. Firing the
POST from the section would either require a hook API change to
return the receipt or a `useRef`-based tx-hash tracker — both
worse split-of-responsibility shapes than just having the hook
fire the breadcrumb when it has the receipt directly.

**No contract surface changes.** No new diamond storage, no
migration on contract storage. Operator action: apply the D1
migration (`wrangler d1 migrations apply vaipakam-archive
--remote` from inside `apps/indexer/`) AND provision the new
`OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT` binding via the
`wrangler.jsonc` `unsafe.bindings` block (auto-deployed on next
`wrangler deploy`).

**Out of scope** (tracked for follow-ups):

- Wiring the breadcrumb into the loan-by-id surface so the
  dapp can render "matched via OpenSea offer X" on the loan
  details page (the data is captured here; the JOIN + UI
  presentation is a separate UX card).
- An analytics dashboard view that surfaces the
  offer-driven-vs-manual ratio (also separate UX work).
- EIP-712-signed claims to fully prevent the spoofing window
  the replace-and-warn shape only mitigates.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
