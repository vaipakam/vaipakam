/**
 * T-086 Round-5 Block A (#313) — OpenSea Collection API proxy.
 *
 * GET /opensea/collection/{slug}
 *
 * Returns the full Collection API response body verbatim. The
 * borrower's dapp reads the `fees` array from inside the body to
 * build the canonical `FeeLeg[]` it passes to `postPrepayListing`.
 *
 * Why a server-side proxy: same reasoning as `openseaProxy.ts` —
 * OpenSea's `X-API-KEY` header would leak in browser devtools, and
 * their CORS policy doesn't allow arbitrary browser origins.
 *
 * **NOT a /fees sub-route** (Round-5.1 errata Codex P2 line 414):
 * the fees live inside the Collection API body. There is no
 * separate `/collections/{slug}/fees` endpoint on OpenSea's v2 API.
 *
 * **Rate-limit + CORS** (Codex P2 line 75 + line 193 on PR #324):
 * the proxy MUST rate-limit per-IP (otherwise anyone can spoof an
 * allowed Origin and iterate slugs/chains to drain the
 * `OPENSEA_API_KEY` quota). The CORS response MUST echo the
 * RESOLVED single origin from the request, NOT the raw
 * `FRONTEND_ORIGIN` CSV (browsers reject a CSV
 * `Access-Control-Allow-Origin`).
 *
 * The sim-transfer pre-flight (per §14.4 of the merged design +
 * the Round-5.1 errata) lives on a SEPARATE endpoint
 * (`POST /opensea/feeRecipientPreflight`) so this proxy stays
 * narrow + stateless. See `feeRecipientPreflight.ts`.
 */

import type { Env } from './env';

const OPENSEA_HOST: Record<number, string> = {
  1: 'api.opensea.io',
  8453: 'api.opensea.io',
  42161: 'api.opensea.io',
  10: 'api.opensea.io',
  137: 'api.opensea.io',
  56: 'api.opensea.io',
};

export async function handleOpenSeaCollection(
  req: Request,
  env: Env,
  resolvedOrigin: string,
): Promise<Response> {
  const url = new URL(req.url);
  // /opensea/collection/{slug}
  const slug = url.pathname.split('/').pop() ?? '';
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse(
      { error: 'invalid collection slug' },
      400,
      resolvedOrigin,
    );
  }
  // Per-IP rate-limit BEFORE the upstream call, otherwise a
  // scripted iterator could drain our OpenSea quota even though
  // the response would be a 400. Same Cloudflare RateLimitBinding
  // pattern as /opensea/listing.
  if (!(await checkRateLimit(req, env.OPENSEA_COLLECTION_RATELIMIT))) {
    return jsonResponse(
      { error: 'rate-limited' },
      429,
      resolvedOrigin,
    );
  }
  // Chain selection: the dapp passes ?chainId=<id> for chains
  // where the collection slug ambiguates across multiple chain
  // deployments. Default to mainnet.
  const chainId = Number(url.searchParams.get('chainId') ?? '1');
  const host = OPENSEA_HOST[chainId];
  if (!host) {
    return jsonResponse(
      { error: 'unsupported chain', chainId },
      400,
      resolvedOrigin,
    );
  }

  const apiUrl = `https://${host}/api/v2/collections/${encodeURIComponent(slug)}`;
  const apiKey = env.OPENSEA_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: 'opensea-api-key-not-configured' },
      503,
      resolvedOrigin,
    );
  }

  const upstream = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'X-API-KEY': apiKey,
      Accept: 'application/json',
    },
  });
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Access-Control-Allow-Origin': resolvedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    },
  });
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

/**
 * Pattern from quoteProxy.ts: Cloudflare's RateLimitBinding
 * exposes `limit({ key })` returning `{ success: boolean }`.
 * Key by client IP (`CF-Connecting-IP`). If the binding isn't
 * configured the limit defaults to allow (the binding is the only
 * defense; the deploy adds it intentionally and a missing binding
 * is an operator-config issue rather than a per-request fail-closed).
 */
async function checkRateLimit(
  req: Request,
  binding: undefined | { limit: (args: { key: string }) => Promise<{ success: boolean }> },
): Promise<boolean> {
  if (!binding) return true;
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const r = await binding.limit({ key: ip });
  return r.success;
}
