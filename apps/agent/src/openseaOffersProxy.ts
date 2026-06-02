/**
 * T-086 Round-5 Block C (#309 Mode B) — OpenSea Offers API proxy.
 *
 * GET /opensea/offers/{chainId}/{contract}/{tokenId}
 *
 * Returns the active OpenSea offers (both collection offers + item
 * offers) for a specific NFT. The borrower's dapp polls this
 * endpoint while the loan card is visible and surfaces incoming
 * offers + the "Match offer" action that calls
 * `updatePrepayListing` to rotate the canonical Seaport order to
 * the offer's price.
 *
 * Why a server-side proxy: same reasoning as
 * `openseaCollectionProxy.ts` — OpenSea's `X-API-KEY` header would
 * leak in browser devtools, and their CORS policy doesn't allow
 * arbitrary browser origins.
 *
 * **Two-list aggregation.** OpenSea's v2 API exposes offers across
 * two separate endpoints — collection offers
 * (`/collections/{slug}/offers`) and item-specific offers
 * (`/offers/{chain}/{contract}/{token_id}`). The dapp wants ONE
 * sorted list. The proxy fetches both and concatenates; the dapp
 * applies the threshold filter + sorts by amount client-side.
 *
 * **Collection slug resolution.** The collection offers endpoint
 * is slug-keyed (not contract-address-keyed). We resolve the slug
 * server-side via OpenSea's `/chain/{chain}/contract/{address}/nfts/{id}`
 * lookup (cached header set by upstream so we don't pay the lookup
 * cost every poll for the same NFT). If the lookup fails, we still
 * return the item-specific offers — collection offers are skipped
 * gracefully.
 *
 * **Rate-limit + CORS** (matches the established pattern):
 * per-IP rate-limit via `OPENSEA_OFFERS_RATELIMIT`; CORS echoes
 * the resolved single origin. The dapp polls every ~30s while the
 * loan card is open, so the rate-limit needs reasonable headroom
 * (~60 req/min/IP is the v1 starting value).
 *
 * Mainnet only (matches the existing OpenSea host map — testnet
 * sunset 2025-07-23).
 */

import type { Env } from './env';

const OPENSEA_HOST: Record<number, string> = {
  1: 'api.opensea.io',
  8453: 'api.opensea.io',
  42161: 'api.opensea.io',
  10: 'api.opensea.io',
  137: 'api.opensea.io',
};

const OPENSEA_CHAIN_SLUG: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  // Codex round-10 P2 review #328 — Polygon was missing here even
  // though `apps/agent/src/env.ts` lists it in the chain config
  // and the sibling collection proxy already routes 137.
  137: 'matic',
};

export async function handleOpenSeaOffers(
  req: Request,
  env: Env,
  resolvedOrigin: string,
): Promise<Response> {
  // URL shape: /opensea/offers/{chainId}/{contract}/{tokenId}
  // Trailing-slash tolerant; the segments split below ignores empties.
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);
  // segs = ['opensea', 'offers', chainId, contract, tokenId]
  if (segs.length !== 5) {
    return jsonResponse(
      { error: 'usage: GET /opensea/offers/{chainId}/{contract}/{tokenId}' },
      400,
      resolvedOrigin,
    );
  }
  const [, , chainIdStr, contract, tokenId] = segs;
  const chainId = Number(chainIdStr);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return jsonResponse({ error: 'invalid chainId' }, 400, resolvedOrigin);
  }
  // EVM-address shape — case-insensitive 40-hex.
  if (!/^0x[0-9a-f]{40}$/i.test(contract)) {
    return jsonResponse({ error: 'invalid contract address' }, 400, resolvedOrigin);
  }
  // Token ids are unbounded uint256 — accept any decimal-string.
  if (!/^\d+$/.test(tokenId)) {
    return jsonResponse({ error: 'invalid tokenId' }, 400, resolvedOrigin);
  }
  // Per-IP rate-limit BEFORE the upstream calls, so a scripted
  // iterator can't burn the OpenSea quota even on rejected inputs.
  if (!(await checkRateLimit(req, env.OPENSEA_OFFERS_RATELIMIT))) {
    return jsonResponse({ error: 'rate-limited' }, 429, resolvedOrigin);
  }

  const host = OPENSEA_HOST[chainId];
  const chainSlug = OPENSEA_CHAIN_SLUG[chainId];
  if (!host || !chainSlug) {
    return jsonResponse(
      { error: 'unsupported chain', chainId },
      400,
      resolvedOrigin,
    );
  }
  const apiKey = env.OPENSEA_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: 'opensea-api-key-not-configured' },
      503,
      resolvedOrigin,
    );
  }

  const headers = {
    'X-API-KEY': apiKey,
    Accept: 'application/json',
  };

  // Codex review #328 (rounds 1, 4, 10) — OpenSea's documented
  // v2 surface for offers is slug-keyed and uses these two
  // endpoints:
  //   - Collection offers (apply to ANY token in the
  //     collection):
  //       `GET /api/v2/offers/collection/{slug}/all`
  //     https://docs.opensea.io/reference/list_offers_collection_all
  //   - Best item-specific offer (on a specific tokenId):
  //       `GET /api/v2/offers/collection/{slug}/nfts/{tokenId}/best`
  //     https://docs.opensea.io/reference/get_best_offer_nft
  // The earlier `/offers/collection/{slug}` and
  // `/offers/collection/{slug}/nfts/{tokenId}` paths return
  // non-2xx for any valid slug and the dapp's `extractOrders`
  // would silently treat that as an empty list — see the
  // Codex round-10 P1 finding.
  //
  // We fetch both in parallel after resolving the slug. Slug
  // resolution itself fails closed: if OpenSea's NFT-detail
  // lookup doesn't surface a slug, BOTH offer fetches are
  // skipped and the response carries `null` for each (the panel
  // treats this as an empty list cleanly).
  const slugP = (async () => {
    try {
      const slugRes = await fetch(
        `https://${host}/api/v2/chain/${chainSlug}/contract/${contract.toLowerCase()}/nfts/${tokenId}`,
        { headers },
      );
      if (!slugRes.ok) return null;
      const slugBody = (await slugRes.json()) as {
        nft?: { collection?: string };
      };
      return slugBody?.nft?.collection ?? null;
    } catch {
      return null;
    }
  })();

  const slug = await slugP;
  // Codex round-4 P2 review #328 — item-specific offers ARE
  // available in the v2 surface, at
  // `GET /api/v2/offers/collection/{slug}/nfts/{token_id}` (the
  // slug-based per-NFT endpoint). The previous v1 dropped this
  // leg on the floor; restoring it so bidders who place
  // single-NFT offers show up in the borrower's panel.
  const collectionOffersUrl = slug
    ? `https://${host}/api/v2/offers/collection/${encodeURIComponent(slug)}/all`
    : null;
  const itemOffersUrl = slug
    ? `https://${host}/api/v2/offers/collection/${encodeURIComponent(slug)}/nfts/${tokenId}/best`
    : null;

  const fetchUpstream = async (
    url: string | null,
  ): Promise<{ status: number; body: string } | null> => {
    if (!url) return null;
    return fetch(url, { headers })
      .then(r => r.text().then(body => ({ status: r.status, body })))
      .catch(err => ({ status: 0, body: String(err) }));
  };

  const [collectionRes, itemRes] = await Promise.all([
    fetchUpstream(collectionOffersUrl),
    fetchUpstream(itemOffersUrl),
  ]);

  // Codex round-11 P2 review #328 — the documented
  // `/api/v2/offers/collection/{slug}/nfts/{tokenId}/best`
  // endpoint returns a SINGLE offer object with top-level
  // fields (`order_hash`, `protocol_data`, etc.), NOT a list.
  // The dapp's `extractOrders` accepts arrays or `body.offers` /
  // `body.orders` wrappers; without re-shaping, the item-
  // specific best offer is silently dropped. Wrap it as a one-
  // element `offers` array so the normalizer sees it.
  const itemBody = itemRes ? tryParseUpstream(itemRes) : null;
  let normalizedItemBody = itemBody;
  if (
    itemBody !== null &&
    itemBody.status >= 200 &&
    itemBody.status < 300 &&
    itemBody.body !== null &&
    typeof itemBody.body === 'object' &&
    !Array.isArray(itemBody.body) &&
    !Array.isArray((itemBody.body as { offers?: unknown[] }).offers) &&
    !Array.isArray((itemBody.body as { orders?: unknown[] }).orders)
  ) {
    normalizedItemBody = {
      status: itemBody.status,
      body: { offers: [itemBody.body] },
    };
  }

  // Compose the aggregated response. Dapp consumes
  //   { item_offers: { status, body? } | null, collection_offers: { status, body? } | null }
  // and applies the threshold filter + sorts. Either source is
  // null when the slug couldn't be resolved (rare — falls back to
  // an empty panel, which the panel renders cleanly).
  const aggregated = {
    item_offers: normalizedItemBody,
    collection_offers: collectionRes ? tryParseUpstream(collectionRes) : null,
    slug,
  };

  return jsonResponse(aggregated, 200, resolvedOrigin);
}

function tryParseUpstream(
  res: { status: number; body: string },
): { status: number; body: unknown } {
  try {
    return { status: res.status, body: JSON.parse(res.body) };
  } catch {
    return { status: res.status, body: res.body };
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  resolvedOrigin: string,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': resolvedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function checkRateLimit(
  req: Request,
  binding: undefined | { limit: (args: { key: string }) => Promise<{ success: boolean }> },
): Promise<boolean> {
  if (!binding) return true;
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const r = await binding.limit({ key: ip });
  return r.success;
}
