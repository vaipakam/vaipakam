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
  adds a new table keyed on `tx_hash` (rotation txes are unique;
  each gets one breadcrumb). `loan_id` is separately indexed so
  the loan-history join is cheap. No FK to `prepay_listings` or
  `loans` — the indexer's reorg-windowed feed can serve the
  pre-rotation row right up until the post tx lands, and a
  strict FK at insert time would race the indexer's
  materialisation; the query-time join handles it.
- New `POST /loans/:loanId/prepay-listing/match-source` endpoint
  in `apps/indexer/src/loanRoutes.ts`. Strict hex validation on
  every field, idempotent on `tx_hash` (`INSERT OR IGNORE`), no
  authentication (the breadcrumb is non-financial analytics data;
  conservative-on-absence query semantics mean an attacker
  spamming false breadcrumbs would be detectable via tx-hash →
  on-chain-event correlation).
- New `postPrepayMatchSource` helper in `apps/defi/src/lib/indexerClient.ts`
  — best-effort POST that returns a boolean for telemetry/tests but
  callers don't branch on it (the rotation tx is already on-chain
  by the time this fires).
- `useNFTPrepayListing` extends `updatePrepayListing` +
  `updatePrepayDutchListing` with an optional `matchSource?:
  MatchSourceBreadcrumb` parameter. When set, after the rotation
  tx confirms (and the OpenSea publish step finishes), the hook
  POSTs the breadcrumb. Manual repricings
  (`PrepayListingActions`) omit the param and stay unchanged.
- `OpenSeaOffersSection`'s Match callback passes
  `{ orderHash: offer.orderHash, bidder: offer.bidder }` as
  `matchSource` on every Match — covering both fixed-price and
  Dutch rotations through the same path.

**Why hook-side and not section-side**

The Match-rotation tx receipt (which carries the `transactionHash`
the breadcrumb keys on) is exposed inside `useNFTPrepayListing`'s
`runWrite` callback, not as a React render-state field. Firing the
POST from the section would either require a hook API change to
return the receipt or a `useRef`-based tx-hash tracker — both
worse split-of-responsibility shapes than just having the hook
fire the breadcrumb when it has the receipt directly.

**No contract surface changes.** No new diamond storage, no
migration on contract storage, no operator action — just the D1
migration to apply (`wrangler d1 migrations apply vaipakam-archive
--remote` from inside `apps/indexer/`).

**Operator action post-merge**: apply the D1 migration.

**Out of scope** (tracked for follow-ups):

- Wiring the breadcrumb into the loan-by-id surface so the
  dapp can render "matched via OpenSea offer X" on the loan
  details page (the data is captured here; the JOIN + UI
  presentation is a separate UX card).
- An analytics dashboard view that surfaces the
  offer-driven-vs-manual ratio (also separate UX work).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
