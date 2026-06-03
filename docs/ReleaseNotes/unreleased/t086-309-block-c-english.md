## T-086 #309 Block C — pragmatic English via OpenSea Offers (fee-free)

Adds the borrower-facing surface for the pragmatic English-auction
flow described in design §15.3. Closes Issue #309's "Mode B —
English via OpenSea Offers" leg for fee-free collections.

The flow is **dapp-only on the contract side** — it reuses the
existing `updatePrepayListing` (and `updatePrepayDutchListing` when
Block C-on-Dutch lands) entry points to rotate the canonical
Seaport order to an offer's price. No new contract surface, no new
selectors, no new facets. The platform's English-auction story
ships entirely as polling + UI + a thin agent proxy.

### What this PR ships

**Agent proxy — `GET /opensea/offers/{chainId}/{contract}/{tokenId}`.**
Aggregates OpenSea's two slug-keyed offers endpoints (item-specific
at `/api/v2/offers/collection/{slug}/nfts/{tokenId}` + collection-
wide at `/api/v2/offers/collection/{slug}`) in a single round-trip.
Per-IP rate-limited via the new `OPENSEA_OFFERS_RATELIMIT` binding
(60 req/min/IP — matches the dapp's 30 s poll cadence with
headroom). CORS-locked to the resolved single origin from
`FRONTEND_ORIGIN`. The dapp does the threshold filter + sort
client-side; the proxy is intentionally stateless. Both legs are
slug-keyed, so a slug-resolution failure skips both fetches and
the proxy returns `null` for each — the panel renders the
empty-offers state cleanly.

**`useOpenSeaOffers` hook.** Polls the agent proxy every 30 s while
mounted, normalizes the OpenSea v2 response shape, and classifies
each offer as **acceptable** when `offer.value >= (lenderLeg +
treasuryLeg) × (1 + bufferBps/10000)` (the fee-free threshold from
§15.3 step 4). Offers below threshold OR in the wrong payment
token OR expired are surfaced with greyed-out rows so the borrower
sees market interest without being able to click Match on a
listing that would revert at re-sign.

**`OpenSeaOffersPanel` component.** Renders the offers list +
"Match offer" buttons per acceptable row + a **race-window warning
modal** (§15.3's v1 dapp-side mitigation: between
`updatePrepayListing` and the bidder's `Seaport.fulfillOrder`, any
buyer can snipe the rotated price). The borrower must
acknowledge the warning before the rotation tx fires. Includes a
diagnostics collapse-section + manual "Refresh now" affordance.

**`OpenSeaOffersSection` wrapper.** Mounted on `LoanDetails` right
after `PrepayListingActions`. Owns:
  1. Its own pctx fetch (`getPrepayContext` + `getPrepayListingBufferBps`)
     for the threshold calculation.
  2. The `useOpenSeaOffers` polling instance.
  3. The `matchOffer` callback that calls
     `prepayListing.updatePrepayListing` with `(offer.value, salt,
     conduitKey, feeLegs=[])` — fee-free path.

**Indexer API extension.** `GET /loans/by-id` now surfaces
`conduitKey`, `salt`, `executor`, `endAskPrice`, `auctionEndTime`,
`auctionMode` on the `prepayListing` block. These columns existed
in D1 (migrations 0016 + 0018) but weren't routed to the dapp;
the Match flow needs `salt` + `conduitKey` to call
`updatePrepayListing` with the live order's sign-time inputs.

### Pre-live framing

The platform is pre-live on every chain. The agent's
`OPENSEA_API_KEY` and `OPENSEA_OFFERS_RATELIMIT` bindings must be
provisioned in the operator's Secrets Store before the offers panel
becomes useful; until then the panel renders a graceful disabled
state (`agentOrigin === null` short-circuit returns null in the
mounting wrapper).

### What's NOT in this PR (intentional)

- **Fee-enforced collection support.** Per §15.3's "re-fetch on
  every match-offer click" rule, fee-enforced collections need the
  dapp to re-fetch the OpenSea schedule against the offer's gross
  value at the moment of Match + thread the recomputed `FeeLeg[]`
  through. v1 ships the fee-free path; for fee-enforced
  collections the section returns an informational banner BEFORE
  the offers panel renders. No offers list + no Match buttons —
  the banner explicitly says incoming offers stay visible on
  OpenSea's marketplace UI but dapp-side matching is gated until
  v1.1. Follow-up card.
- **Dutch-listing match flow.** Offers can be matched against a
  fixed-price listing today; matching against a live Dutch listing
  would need `updatePrepayDutchListing` with the offer's value +
  fresh `(startAskPrice, endAskPrice, auctionEndTime)` parameters.
  Same surface; deferred to keep the v1 ship narrow.
- **Atomic match-rotation via Seaport `matchOrders`** — the v2
  escape hatch §15.3 names. v1 explicitly accepts the race window.
- **Indexer breadcrumb on accepted offers** — `apps/indexer/...
  PrepayListingUpdated` already logs every rotation; analytics
  on "which offer was matched" can be added without a contract
  change. Deferred.
- **Pagination beyond ~300 offers per endpoint.** The agent
  proxy follows OpenSea's `next` cursor for up to 3 pages
  (≈300 offers per leg). For hyper-active collections where
  there are still more acceptable offers beyond page 3, the
  borrower sees the top portion only. The 3-page cap was
  chosen to bound the proxy's upstream call budget (worst case
  6 round-trips per poll: 3 collection + 3 item); higher
  caps land as a v1.1 follow-up if production signal shows
  the cap matters.

### Verification

- `apps/defi` typecheck: green.
- `apps/agent` typecheck: green.
- `apps/indexer` typecheck: green.
- `apps/keeper` typecheck: green.
- No contract changes; no forge regression needed.

### Operator action post-merge

1. Provision `OPENSEA_API_KEY` in the agent's account-level Secrets
   Store entry (`vaipakam-credentials`, store id
   `1e66429d0fa24aa38a27bc05b7bcf63e`). Already needed for the
   existing `/opensea/listing` proxy; no new secret.
2. Verify the wrangler.jsonc adds the `OPENSEA_OFFERS_RATELIMIT`
   binding (namespace_id `1007`, 60 / 60s per IP). Cloudflare picks
   it up on next `wrangler deploy`.
3. Verify `VITE_AGENT_ORIGIN` is set on the dapp's deploy. Already
   needed for the existing offers flow on the listing surface; no
   new env.

### Closes

Issue #309 Mode B (English via OpenSea Offers) — fee-free track.
Fee-enforced collection support is the remaining follow-up.

### Related

- Round 5 design + Round 5.1 errata: #322 + #323.
- Block A (fee-legs atomic): #324 (merged).
- Block B (Dutch decay): #326 (merged).
- Block B Codex post-merge polish: #327 (merged).
- **Block C (this PR): English via OpenSea Offers** — closes
  #309 Mode B (fee-free track).
- Multi-marketplace fan-out: #281.
