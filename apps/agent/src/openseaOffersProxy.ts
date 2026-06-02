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
};

const OPENSEA_CHAIN_SLUG: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
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

  // Codex P1 review #328 — OpenSea v2 removed the legacy
  // `GET /api/v2/orders/{chain}/seaport/offers?asset_contract_address=...&token_ids=...`
  // endpoint, so the item-specific offers half of the aggregation
  // was returning a non-2xx silently. v1 of Block C ships
  // collection-offers-only for two reasons:
  //   1. Collection offers cover the bulk of incoming bids — most
  //      bidders use OpenSea's "make collection offer" UX, which
  //      applies to ANY token in the collection (including this
  //      specific tokenId).
  //   2. The current v2 surface for item-specific offers is
  //      embedded inside the NFT-detail body
  //      (`/api/v2/chain/{chain}/contract/{addr}/nfts/{id}`); the
  //      response shape isn't pinned in OpenSea's public docs as
  //      a stable list endpoint, so v1 explicitly drops it rather
  //      than misrepresenting the data shape.
  // Follow-up: add item-specific offer pull once the v2 surface
  // stabilises (or once OpenSea republishes a list endpoint).
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
  const collectionOffersUrl = slug
    ? `https://${host}/api/v2/offers/collection/${encodeURIComponent(slug)}`
    : null;
  const collectionRes: { status: number; body: string } | null =
    collectionOffersUrl
      ? await fetch(collectionOffersUrl, { headers })
          .then(r => r.text().then(body => ({ status: r.status, body })))
          .catch(err => ({ status: 0, body: String(err) }))
      : null;

  // Compose the aggregated response. Dapp consumes
  //   { item_offers: null | { status, body? }, collection_offers: { status, body? | null } }
  // and applies the threshold filter + sorts. `item_offers: null`
  // is the v1 "intentionally not fetched" sentinel; the normalizer
  // skips it without surfacing a fetch error.
  const aggregated = {
    item_offers: null,
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
