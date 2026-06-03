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
  // #334 Codex round-1 P2 — global upstream rate-limit keyed by
  // a constant. This caps aggregate calls to the shared
  // `OPENSEA_API_KEY` across all caller IPs (the per-IP gate
  // below caps each caller individually but doesn't bound the
  // sum). When the binding isn't provisioned (operator hasn't
  // added it yet) this is a no-op; per-IP gating still applies.
  if (
    env.OPENSEA_OFFERS_UPSTREAM_RATELIMIT &&
    !(
      await env.OPENSEA_OFFERS_UPSTREAM_RATELIMIT.limit({
        key: 'opensea-offers-upstream',
      })
    ).success
  ) {
    return jsonResponse({ error: 'upstream-quota' }, 429, resolvedOrigin);
  }
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
  // Codex review #328 (rounds 4 + 12) — use the LIST endpoint
  // for item-specific offers, not `/best`. The `/best` endpoint
  // returns only the top item offer, so the panel would miss
  // lower offers that might still pass the threshold when the
  // best one is filtered (wrong payment token, expired, etc.).
  // The list endpoint returns all NFT offers and natively
  // returns the `{ offers: [...] }` shape the dapp's
  // normalizer expects, so no special wrapping is needed.
  // Docs: https://docs.opensea.io/reference/get_offers_nft
  const collectionOffersUrl = slug
    ? `https://${host}/api/v2/offers/collection/${encodeURIComponent(slug)}/all`
    : null;
  const itemOffersUrl = slug
    ? `https://${host}/api/v2/offers/collection/${encodeURIComponent(slug)}/nfts/${tokenId}`
    : null;

  // Codex round-15 P2 review #328 — follow OpenSea's `next`
  // pagination cursor for up to N pages (≈100 × N offers per leg
  // at `limit=100`). The new chain/contract/criteria/payment-token
  // filters on the dapp side can drop large fractions of any
  // single page; without pagination an acceptable offer sitting
  // on page 2+ would never reach the panel even if the borrower
  // refreshes. Concatenates all returned offers into one synthetic
  // `{ offers: [...] }` body so the dapp normalizer doesn't
  // need a paginated shape.
  //
  // #334 — page cap is configurable via the wrangler-vars
  // `OPENSEA_OFFERS_MAX_PAGES` env (string). Default 3 covers
  // hot-but-not-degenerate collections (≈300 offers per leg);
  // operators on hyper-active collections can raise. Worst-case
  // upstream cost per inbound request is `2 × MAX_PAGES`
  // round-trips (collection + item legs); paired with the
  // `OPENSEA_OFFERS_RATELIMIT` inbound cap (60/min/IP) the
  // total upstream cost stays bounded. Clamp to `[1, 25]` so a
  // misconfigured value can't blow the OpenSea API quota
  // (`MAX_PAGES = 25` ⇒ worst-case 50 round-trips per inbound,
  // 60 inbound/min/IP ⇒ 3,000 upstream/min/IP — still within
  // the typical OpenSea API tier).
  const MAX_PAGES = parseMaxPages(env.OPENSEA_OFFERS_MAX_PAGES);
  const fetchPaginated = async (
    initialUrl: string | null,
  ): Promise<{ status: number; body: string } | null> => {
    if (!initialUrl) return null;
    const all: unknown[] = [];
    let lastStatus = 0;
    // Codex round-16 P2 review #328 — track whether ANY page
    // succeeded. If page 1 succeeds and page 2 fails, we want
    // to return the page-1 offers + a synthetic 200 status so
    // the dapp's `extractOrders` doesn't drop them as "non-2xx
    // upstream". Only set the failure status when NO page
    // succeeded.
    let anyPageSucceeded = false;
    let url: string | null = initialUrl.includes('?')
      ? `${initialUrl}&limit=100`
      : `${initialUrl}?limit=100`;
    for (let i = 0; i < MAX_PAGES && url; i++) {
      const page = await fetch(url, { headers })
        .then(r => r.text().then(body => ({ status: r.status, body })))
        .catch(err => ({ status: 0, body: String(err) }));
      if (page.status < 200 || page.status >= 300) {
        // Page failed. If no page has succeeded yet, surface
        // the failure status; otherwise keep `lastStatus` at
        // whatever page-1's 200 was.
        if (!anyPageSucceeded) lastStatus = page.status;
        break;
      }
      anyPageSucceeded = true;
      lastStatus = page.status;
      let parsed: unknown;
      try {
        parsed = JSON.parse(page.body);
      } catch {
        break;
      }
      const offers = (parsed as { offers?: unknown[] }).offers;
      if (Array.isArray(offers)) all.push(...offers);
      const next = (parsed as { next?: string | null }).next;
      if (typeof next === 'string' && next.length > 0) {
        const sep = initialUrl.includes('?') ? '&' : '?';
        url = `${initialUrl}${sep}limit=100&next=${encodeURIComponent(next)}`;
      } else {
        url = null;
      }
    }
    return {
      status: lastStatus,
      body: JSON.stringify({ offers: all }),
    };
  };

  const [collectionRes, itemRes] = await Promise.all([
    fetchPaginated(collectionOffersUrl),
    fetchPaginated(itemOffersUrl),
  ]);

  // Compose the aggregated response. Dapp consumes
  //   { item_offers: { status, body? } | null, collection_offers: { status, body? } | null }
  // and applies the threshold filter + sorts. Either source is
  // null when the slug couldn't be resolved (rare — falls back to
  // an empty panel, which the panel renders cleanly).
  // Both endpoints return `{ offers: [...] }` shapes (round-12
  // switched the item endpoint from `/best` to the list path),
  // so no per-source wrapping is needed.
  const aggregated = {
    item_offers: itemRes ? tryParseUpstream(itemRes) : null,
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

/** #334 — parse the `OPENSEA_OFFERS_MAX_PAGES` wrangler var into a
 *  bounded integer. Default 3; clamp to `[1, 24]` so a misconfigured
 *  value can't blow the OpenSea API quota.
 *
 *  **Strict parse** (Codex round-1 P3): the raw value must match
 *  `/^\d+$/` to be accepted. `Number.parseInt('25oops', 10)` returns
 *  25, which would silently change pagination depth on a wrangler
 *  typo — exactly the foot-gun the configurable surface is supposed
 *  to prevent. Any non-pure-digit string collapses to the default.
 *
 *  **Ceiling math** (Codex round-1 P3): the per-inbound worst-case
 *  upstream cost is `1 + 2 × MAX_PAGES` round-trips (one NFT-detail
 *  slug lookup + paginated collection leg + paginated item leg).
 *  With the 60/min/IP inbound cap, ceiling 24 yields
 *  `60 × (1 + 48) = 2,940` upstream/min/IP — under the 3,000-call
 *  guardrail. Bumping the ceiling means either reducing the
 *  inbound cap or accepting a wider upstream budget.
 *
 *  **Aggregate-key concern** (Codex round-1 P2): the per-IP cap
 *  doesn't bound aggregate upstream load to the shared
 *  `OPENSEA_API_KEY`. The new optional
 *  `OPENSEA_OFFERS_UPSTREAM_RATELIMIT` binding (consumed below)
 *  caps the global upstream rate; when present it gates the
 *  proxy in addition to the per-IP rate-limit.
 */
const MAX_PAGES_DEFAULT = 3;
const MAX_PAGES_CEILING = 24;
const STRICT_DIGITS_RE = /^\d+$/;
function parseMaxPages(raw: string | undefined): number {
  if (raw === undefined || raw === null || raw === '') return MAX_PAGES_DEFAULT;
  if (!STRICT_DIGITS_RE.test(raw)) return MAX_PAGES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return MAX_PAGES_DEFAULT;
  if (parsed < 1) return 1;
  if (parsed > MAX_PAGES_CEILING) return MAX_PAGES_CEILING;
  return parsed;
}
