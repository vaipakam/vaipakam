## Thread — T-086 Block C — paginate OpenSea Offers beyond ~300 per endpoint (#334) (PR #<n>)

Closes #334.

The OpenSea Offers proxy on `apps/agent`
(`/opensea/offers/{chainId}/{contract}/{tokenId}`) follows OpenSea's
`next` pagination cursor for each leg (collection-wide + item-
specific). Block C v1 (PR #328) capped that at a hard-coded 3 pages
per leg — ≈300 offers per leg, ≈600 total per inbound request. For
hyper-active collections where the dapp-side filters
(chain / contract / payment-token / itemType ∈ {2,3} / identifier
match) drop large fractions of every page, an acceptable offer
sitting on page 4+ would never reach the borrower's panel even after
a manual refresh.

This thread makes the cap **operator-configurable**.

**`OPENSEA_OFFERS_MAX_PAGES`** — new optional string env var on
the agent Worker. Read by `apps/agent/src/openseaOffersProxy.ts`,
coerced to int + clamped to `[1, 24]`. Default 3 (preserves current
behaviour exactly). Parse is strict: only pure-digit strings are
accepted, so `25oops` / `3.5` / `2e3` collapse to the default
rather than silently changing pagination depth on a typo.

The clamp ceiling of 24 is the upstream-cost guardrail. Worst-case
upstream cost per inbound request is `1 + 2 × MAX_PAGES` round-trips
(one NFT-detail slug lookup + paginated collection leg + paginated
item leg). Paired with the existing `OPENSEA_OFFERS_RATELIMIT`
inbound cap (60/min/IP), the per-IP upstream load stays bounded:

| MAX_PAGES | Upstream RTs per inbound | Worst-case upstream/min/IP |
|---|---|---|
| 3 (default) | 7 | 420 |
| 10 | 21 | 1,260 |
| 24 (ceiling) | 49 | 2,940 |

**Aggregate-key bounding** (Codex round-1 P2 on PR #341). The per-IP
cap above doesn't bound aggregate upstream load to the shared
`OPENSEA_API_KEY` — two or more caller IPs polling hot tokens each
under their per-IP cap can in aggregate exceed the OpenSea API tier.
This PR also adds an optional `OPENSEA_OFFERS_UPSTREAM_RATELIMIT`
binding keyed by the constant `'opensea-offers-upstream'`. When
provisioned by the operator in `wrangler.jsonc`, it caps the
aggregate inbound rate across all IPs. When absent the per-IP
gating stays in effect alone (same as before this PR; the binding
is opt-in).

**Operator setup**: add `OPENSEA_OFFERS_MAX_PAGES: "N"` to the
agent's `wrangler.jsonc` `vars` block + `wrangler deploy`. No code
change. Omitting the var preserves the default 3.

**Out of scope** (deferred):

- Cross-page deduplication at the proxy. OpenSea can return the
  same offer order across the collection-wide + item-specific
  legs (and across pagination pages within a leg) under certain
  query shapes. The dapp doesn't currently dedupe by `orderHash`
  — `useOpenSeaOffers.normalize` just concatenates the two
  legs' normalized arrays and sorts by amount — so a
  higher-`MAX_PAGES` deploy can surface duplicate rows in
  `OpenSeaOffersPanel`. The fix can land either at the proxy
  (server-side dedupe, adds proxy-side state) or in the dapp
  normalizer (cheaper but client-side). Defer until production
  signal shows duplicates becoming a visible UX problem.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
