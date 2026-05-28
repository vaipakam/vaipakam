## T-086 step 14 — OpenSea Listings API integration

Closes the last user-facing gap T-086 had been carrying: the on-chain
Seaport order the diamond constructs is now automatically published to
OpenSea's marketplace UI so casual NFT buyers find the listing through
their normal collection-page browsing flow. Borrower clicks one
button, the on-chain post confirms, and within seconds the listing
appears on OpenSea.

### What this PR ships

**Contract event change** —
`NFTPrepayListingFacet.PrepayListingPosted` and `PrepayListingUpdated`
now also emit `conduitKey` and `salt` (and `newConduitKey` / `newSalt`
on the update path). The two values are everything that wasn't
otherwise recoverable from chain state — without them, an off-chain
consumer reconstructing the canonical Seaport `OrderComponents` can't
reach the same orderHash and OpenSea would reject the
`isValidSignature` check on the vault. Backward-incompatible for an
already-deployed event subscriber; pre-live the rotation is free.

**Cloudflare Worker proxy** —
`POST /opensea/listing` on `apps/agent`. The dapp reconstructs the
canonical components client-side and POSTs them to this proxy, which
forwards to OpenSea's Listings API with the server-held
`OPENSEA_API_KEY`. Same shape as the existing `/quote/0x` and
`/quote/1inch` proxies — CORS-locked to `FRONTEND_ORIGIN`, IP-keyed
rate-limit via a new `OPENSEA_LISTING_RATELIMIT` binding. No
`/cancel` proxy: the vault's ERC-1271 stops authorising the orderHash
on `cancelPrepayListing`, so OpenSea's next re-validation pass drops
the listing on its own.

**Indexer-side autonomous fallback** —
The `PrepayListingPosted` and `PrepayListingUpdated` handlers in
`apps/indexer/src/chainIndexer.ts` now ALSO reconstruct the canonical
`OrderComponents` and POST to OpenSea. The two producers
(frontend-direct via the agent proxy, indexer-autonomous via the
event handler) race harmlessly — OpenSea dedupes by orderHash. The
frontend path is the UX-latency win (listing on OpenSea in seconds);
the indexer path is the canonical safety net that covers the
close-browser case the dapp's POST couldn't reach by itself (see
#311 for the design rationale).

**Shared `@vaipakam/lib/prepayOrderShape`** — the canonical
`OrderComponents` reconstruction lives in `@vaipakam/lib` so the
frontend (`apps/defi`) and the indexer Worker share one source of
truth. Field order, item-type mapping, and consideration ordering
are load-bearing — any divergence would hash to a different
orderHash and OpenSea would reject the signature. The defensive
recompute via Seaport's own `getOrderHash` runs on both call sites
before the POST: a mismatch aborts the publish with a clear error
instead of letting OpenSea reject the signature later.

**D1 schema extension** —
`apps/indexer/migrations/0016_prepay_listings_opensea.sql` adds three
columns on `prepay_listings`:
- `conduit_key` — the raw `bytes32` key (we already stored the
  resolved conduit address)
- `salt` — borrower's chosen uint256 salt
- `opensea_published_at` — Unix seconds set when the autonomous
  republish was accepted by OpenSea; NULL means "still needs a push"
  (the cron retry loop tracked as #311 will sweep these)

**Frontend banner deep-link** —
`PrepayListingBanner` surfaces a "View on OpenSea ↗" button whenever
a listing is live + the active chain is on OpenSea's supported set.
The URL is deterministic from `collateralAsset + collateralTokenId +
chainId` (computed via the new `openSeaAssetUrl` helper), so it
works regardless of which publish path actually delivered the order
to OpenSea.

### What's NOT in this PR (intentional)

- **Explicit retry loop for `opensea_published_at IS NULL` rows** —
  the column exists; a periodic scan to retry is tracked as #311
  follow-up. The synchronous publish-on-event path covers the
  expected case; the cron is the long-tail backstop.
- **Mirror-cancel via OpenSea API** — the vault's ERC-1271
  invalidation propagates within minutes. Adding an explicit cancel
  POST would only shave latency, not correctness.
- **Multi-marketplace fan-out** — Reservoir / Blur / LooksRare
  tracked separately as #281.
- **Auction modes** (Dutch / English) — #309.

### Operator action post-merge

1. Apply the D1 migration:
   ```
   cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote
   ```
2. Provision `OPENSEA_API_KEY` in the account-level Secrets Store
   (binding name + secret name both `OPENSEA_API_KEY`, store id
   `1e66429d0fa24aa38a27bc05b7bcf63e`). Both `apps/agent` and
   `apps/indexer` wrangler configs reference it.
3. Set `VITE_AGENT_ORIGIN` on the dapp's deployed environment so the
   frontend-direct push hits the proxy.

Until the operator runs the above, the autonomous publish + dapp
push both no-op gracefully (the proxy returns 503
`opensea-not-configured`, the indexer logs and skips). The on-chain
order stays valid + fillable throughout.

### Verification

- `nice -n -10 ionice -c 2 -n 0 forge build` clean
- `pnpm --filter @vaipakam/{defi,agent,indexer,keeper} exec tsc -*` —
  all four ABI consumers green
- `pnpm --filter @vaipakam/indexer check-event-coverage` —
  26 handled / 15 allowlisted; no drift

### Closes

T-086 sequencing step 14. Step 15 (ERC1155 collateral) was folded into
the step-6 round-2 PR (#307). Steps 16-17 are follow-ups
(documentation polish + audit-prep).

### Related

- Step 6 (contracts foundational): #300 + round 2 #307
- Step 12 (indexer + D1): #304
- Step 13 (frontend): #308 + post-merge tick #310
- **Step 14 (this PR): OpenSea integration**
- Step 14 follow-up: autonomous republish retry loop (#311)
- Auction-mode extension (Dutch / English): #309
