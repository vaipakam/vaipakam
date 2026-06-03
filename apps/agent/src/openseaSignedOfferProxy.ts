/**
 * T-086 Round-6 / Block D (#345) — OpenSea SIGNED-offer fetch
 * proxy. Sibling of {handleOpenSeaOffers} (T-086 Round-5 Block C).
 *
 * GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}
 *
 * The dapp hits this endpoint at Match-button click time to fetch
 * the BIDDER's full signed OpenSea Offer (the
 * `OrderComponents + signature + SIP-7 SignedZone extraData +
 * CriteriaResolver[]` payload) so the on-chain
 * `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` can re-derive the
 * orderHash, validate the §17.5-bis shape invariant, and pass the
 * bytes to `Seaport.matchAdvancedOrders` in one atomic tx.
 *
 * Distinct top-level path prefix (`/opensea/signed-offer/` vs
 * `/opensea/offers/`) so the existing
 * `url.pathname.startsWith('/opensea/offers/')` GET branch in
 * `apps/agent/src/index.ts` doesn't accidentally swallow this
 * route — design doc §17.3 + §17.18 D.2.
 *
 * **Per-IP rate-limit** (60 req/min/IP via
 * `OPENSEA_SIGNED_OFFER_RATELIMIT`): matches the per-IP shape the
 * other agent proxies use. Volume is small in practice — one fetch
 * per Match click — but the cap defends against scripted iteration.
 *
 * **No upstream-aggregate rate-limit binding here** — the
 * single-request lookup is 1 RTT per inbound, so the per-IP cap
 * directly bounds aggregate upstream load. Distinct from the
 * paginated offers-list endpoint where the
 * `1 + 2 × MAX_PAGES` upstream cost necessitates a global cap.
 *
 * Mainnet only. The OpenSea API does not surface testnets after
 * the 2025-07-23 sunset.
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
  137: 'matic',
};

export async function handleOpenSeaSignedOffer(
  req: Request,
  env: Env,
  resolvedOrigin: string,
): Promise<Response> {
  // URL shape: /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}
  // Trailing-slash tolerant.
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);
  // segs = ['opensea', 'signed-offer', chainId, contract, tokenId, orderHash]
  if (segs.length !== 6) {
    return jsonResponse(
      {
        error:
          'usage: GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}',
      },
      400,
      resolvedOrigin,
    );
  }
  const [, , chainIdStr, contract, tokenId, orderHash] = segs;
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
  // OrderHash MUST be a 32-byte hex string. The on-chain facet's
  // §17.5 hash re-derive will REJECT any drift, but rejecting
  // garbage at the agent boundary saves an OpenSea RT for an
  // obviously-malformed input.
  if (!/^0x[0-9a-f]{64}$/i.test(orderHash)) {
    return jsonResponse({ error: 'invalid orderHash' }, 400, resolvedOrigin);
  }

  // Per-IP rate-limit BEFORE the upstream call.
  if (!(await checkRateLimit(req, env.OPENSEA_SIGNED_OFFER_RATELIMIT))) {
    return jsonResponse({ error: 'rate-limited' }, 429, resolvedOrigin);
  }

  // Unsupported-chain + API-key gates BEFORE the OpenSea fetch, so a
  // distributed flood of valid-shape-but-wrong-chain requests can't
  // burn the upstream quota (same ordering rationale Codex round-2
  // P2 #341 laid out for the offers-list proxy).
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

  // OpenSea's v2 "fetch order by hash" surface returns the full
  // protocol_data + extraData blob. The endpoint takes a chain
  // slug + order_hash + side=offer query params.
  //
  // Docs: https://docs.opensea.io/reference/get_order
  // GET /api/v2/orders/{chain}/seaport?order_hash=...&side=offer
  const upstreamUrl =
    `https://${host}/api/v2/orders/${encodeURIComponent(chainSlug)}/seaport/offers` +
    `?order_hash=${encodeURIComponent(orderHash.toLowerCase())}` +
    `&include_invalid=false`;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        'X-API-KEY': apiKey,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    // Network-level upstream failure (DNS, TCP, etc.). Surface as
    // 502 to distinguish from OpenSea-returned 4xx/5xx (which we
    // pass through below). DO NOT include the raw error in the
    // response body — leaking stack traces is a CodeQL "Information
    // exposure through a stack trace" finding. The dapp doesn't
    // need the detail; operators can read it from the Worker's
    // observability log.
    // eslint-disable-next-line no-console
    console.warn('[signed-offer] upstream fetch failed', err);
    return jsonResponse(
      { error: 'upstream-unreachable' },
      502,
      resolvedOrigin,
    );
  }

  if (!upstream.ok) {
    // OpenSea returned a non-2xx. Pass through the status + parsed
    // body so the dapp's error UX can distinguish "offer not found"
    // (404) from "rate-limited at OpenSea" (429) from generic 5xx.
    const body = await safeReadJson(upstream);
    return jsonResponse(
      { error: 'opensea-upstream', status: upstream.status, body },
      upstream.status,
      resolvedOrigin,
    );
  }

  const raw = await safeReadJson(upstream);
  if (raw === null) {
    return jsonResponse(
      { error: 'opensea-malformed-response' },
      502,
      resolvedOrigin,
    );
  }

  // OpenSea's response carries:
  //   orders: [{
  //     order_hash, protocol_data: { parameters, signature },
  //     ...
  //     // For SignedZone (fee-enforced collections):
  //     // protocol_data.extraData carries the SIP-7 blob.
  //   }]
  // We surface the first matching order's protocol_data fields.
  // If no orders are returned the hash isn't on OpenSea (cancelled,
  // expired, or hash typo) — surface as 404 so the dapp can show
  // "this offer is no longer available".
  const orders = (raw as { orders?: unknown[] }).orders;
  if (!Array.isArray(orders) || orders.length === 0) {
    return jsonResponse({ error: 'opensea-offer-not-found' }, 404, resolvedOrigin);
  }
  const first = orders[0] as {
    order_hash?: string;
    protocol_data?: {
      parameters?: unknown;
      signature?: string;
      extraData?: string;
    };
    criteria_proof?: unknown[];
  };
  // Defense-in-depth: confirm OpenSea returned the orderHash we
  // requested. If they returned a different hash for any reason
  // (api drift, mis-routing), the on-chain §17.5 hash-rederive
  // would reject the bytes anyway — but rejecting at the agent
  // boundary is more informative.
  if (
    typeof first.order_hash !== 'string' ||
    first.order_hash.toLowerCase() !== orderHash.toLowerCase()
  ) {
    return jsonResponse(
      { error: 'opensea-orderhash-mismatch', requested: orderHash, returned: first.order_hash },
      502,
      resolvedOrigin,
    );
  }
  if (!first.protocol_data || typeof first.protocol_data.signature !== 'string') {
    return jsonResponse(
      { error: 'opensea-missing-protocol-data' },
      502,
      resolvedOrigin,
    );
  }

  // Surface the dapp-facing payload — the dapp will ABI-encode
  // `protocol_data.parameters` into the BidderOrder.components
  // struct, pass through `signature` + `extraData`, and supply
  // `resolvers` from `criteria_proof` when present.
  return jsonResponse(
    {
      orderHash: first.order_hash,
      parameters: first.protocol_data.parameters,
      signature: first.protocol_data.signature,
      extraData: first.protocol_data.extraData ?? '0x',
      criteriaResolvers: first.criteria_proof ?? [],
    },
    200,
    resolvedOrigin,
  );
}

// ─── Shared helpers (mirror openseaOffersProxy patterns) ─────────────

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
  binding:
    | undefined
    | { limit: (args: { key: string }) => Promise<{ success: boolean }> },
): Promise<boolean> {
  if (!binding) return true;
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const r = await binding.limit({ key: ip });
  return r.success;
}

async function safeReadJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
