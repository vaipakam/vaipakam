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
): Promise<Response> {
  const url = new URL(req.url);
  // /opensea/collection/{slug}
  const slug = url.pathname.split('/').pop() ?? '';
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return new Response(
      JSON.stringify({ error: 'invalid collection slug' }),
      { status: 400, headers: corsHeaders(env) },
    );
  }
  // Chain selection: the dapp passes ?chainId=<id> for chains
  // where the collection slug ambiguates across multiple chain
  // deployments. Default to mainnet.
  const chainId = Number(url.searchParams.get('chainId') ?? '1');
  const host = OPENSEA_HOST[chainId];
  if (!host) {
    return new Response(
      JSON.stringify({ error: 'unsupported chain', chainId }),
      { status: 400, headers: corsHeaders(env) },
    );
  }

  const apiUrl = `https://${host}/api/v2/collections/${encodeURIComponent(slug)}`;
  const apiKey = env.OPENSEA_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'opensea-api-key-not-configured' }),
      { status: 503, headers: corsHeaders(env) },
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
      ...corsHeaders(env),
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    },
  });
}

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.FRONTEND_ORIGIN ?? '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
