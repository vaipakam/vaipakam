## OpenSea testnet endpoints removed

OpenSea sunset their testnet API and marketplace UI on 2025-07-23
([Farewell, Testnets](https://support.opensea.io/en/articles/11833955-farewell-testnets)). The T-086 step-14 publish surface from PR #312
still referenced four testnet chains (Sepolia, Base Sepolia, Arb
Sepolia, Op Sepolia) against the dead `testnets-api.opensea.io` host;
the same chains were also listed for the banner's "View on OpenSea"
deep-link via `testnets.opensea.io`. Both endpoints now return 404
or redirect, which would surface as a generic "OpenSea publish
failed" on testnet borrowers' loan-details pages instead of the
clearer "this chain isn't supported by OpenSea".

This change strips the four testnet entries from the three places
they were duplicated:

- `apps/agent/src/openseaProxy.ts` — `OPENSEA_CHAINS`. Testnet
  borrowers' proxy POST now fails fast with `unsupported-chain`
  before the upstream call.
- `apps/indexer/src/openseaPublish.ts` — `OPENSEA_CHAINS`. The
  autonomous republish path for testnet rows returns
  `unsupported-chain-<id>` immediately; the row's
  `opensea_published_at` stays NULL forever (no quota burn).
- `packages/lib/src/prepayOrderShape.ts` — `OPENSEA_CHAIN_SLUGS`.
  `openSeaAssetUrl(chainId, …)` returns `null` for testnet chain
  ids, which `PrepayListingBanner` already handles cleanly by
  suppressing the "View on OpenSea ↗" deep-link without breaking
  the rest of the banner.

The cross-cutting `nftLink.ts` helper (used by `AssetLink` for
generic NFT "open externally" links — not just the prepay-listing
banner) was also updated: testnet NFTs now fall straight through
to the chain explorer instead of generating a broken
`testnets.opensea.io` URL.

The on-chain prepay-listing order remains valid + fillable on every
testnet just as before — only the OpenSea-marketplace UI surface
goes away there. The on-chain order can still be fulfilled directly
via `Seaport.fulfillOrder` by anyone holding the orderHash +
canonical components, which is what sophisticated buyers do today.

No contract changes. No new dependencies. Frontend and Workers
typecheck clean.
