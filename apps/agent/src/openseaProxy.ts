/**
 * T-086 step 14 — server-side OpenSea Listings API proxy.
 *
 * One HTTP entry point today (cancel is intentionally NOT exposed —
 * see the bottom of this file for why):
 *
 *   POST /opensea/listing — submit a borrower's prepay-listing
 *                           order to OpenSea's off-chain order book
 *                           so casual NFT buyers find it from the
 *                           OpenSea collection page.
 *
 * Why this proxy exists at all (and not a direct browser → OpenSea
 * call): OpenSea's Listings API requires an `X-API-KEY` header.
 * Shipping that key in browser JS would leak it instantly via
 * devtools. Their API also doesn't allow arbitrary browser origins
 * via CORS. So we sit between the dapp and OpenSea, holding the key
 * server-side, applying the same `FRONTEND_ORIGIN` CORS gate the
 * existing `/quote/*` proxies use, and forwarding the order
 * verbatim.
 *
 * The dapp posts the canonical Seaport OrderComponents the diamond
 * just locked on-chain (T-086 `LibPrepayOrder.buildAndHash`
 * reconstruction) plus an empty signature `"0x"` — OpenSea accepts
 * empty signature for ERC-1271 offerers and calls the contract's
 * `isValidSignature(orderHash, "0x")` at validation time. The
 * vault's ERC-1271 returns the magic value for exactly the
 * orderHash that was bound by `postPrepayListing`, so OpenSea's
 * authorization check passes without any private-key signing.
 *
 * Request body:
 *   {
 *     chainId:          number;         // EVM chain id (e.g. 8453)
 *     parameters:       OpenSeaOrderParameters; // canonical OrderComponents
 *     signature:        string;         // "0x" for ERC-1271 vault offerer
 *     protocol_address: string;         // Seaport address on the chain
 *   }
 *
 * Response: pass-through of the OpenSea API's JSON body, plus our
 * own CORS header. Consumers care about:
 *   - `order.order_hash` — confirms the order OpenSea sees matches
 *     what the diamond locked
 *   - the listing URL — composed from chain slug + token id + asset
 *     contract; the frontend builds it (cheaper than parsing the
 *     OpenSea response shape)
 *
 * Rate-limit: same Cloudflare built-in `RateLimitBinding` pattern as
 * `/quote/*`. The frontend's natural call rate is one POST per
 * `postPrepayListing` / `updatePrepayListing` tx, so the budget
 * doesn't need to be tight — the IP-keyed limit is a safety net
 * against an attacker scripting the endpoint, not against normal
 * use.
 */

import type { Env } from './env';

interface OpenSeaListingRequest {
  chainId: number;
  parameters: Record<string, unknown>;
  signature: string;
  protocol_address: string;
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_ANY = /^0x[0-9a-fA-F]*$/;

/**
 * OpenSea chain slug + API host per supported chain id. The
 * mainnet API and testnet API are separate domains; the slug is the
 * path component the Listings endpoint expects. Chains not in this
 * map are rejected at the proxy with a 400 — adding a new chain
 * means landing both the deployment artifact AND a new entry here.
 */
const OPENSEA_CHAINS: Record<number, { host: string; slug: string }> = {
  1: { host: 'api.opensea.io', slug: 'ethereum' },
  8453: { host: 'api.opensea.io', slug: 'base' },
  42161: { host: 'api.opensea.io', slug: 'arbitrum' },
  10: { host: 'api.opensea.io', slug: 'optimism' },
  // Testnets.
  11155111: { host: 'testnets-api.opensea.io', slug: 'sepolia' },
  84532: { host: 'testnets-api.opensea.io', slug: 'base_sepolia' },
  421614: { host: 'testnets-api.opensea.io', slug: 'arbitrum_sepolia' },
  11155420: { host: 'testnets-api.opensea.io', slug: 'optimism_sepolia' },
};

export async function handleOpenSeaListingPost(
  req: Request,
  env: Env,
  /** CORS origin to echo on the response. Caller resolves via
   *  `resolveAllowedOrigin(req, env)` — the request's own Origin
   *  iff it's in `FRONTEND_ORIGIN`, else the first allow-list entry
   *  for non-browser callers. Codex round-1 P2 fix on PR #312. */
  corsOrigin: string,
): Promise<Response> {
  if (!(await checkRateLimit(req, env.OPENSEA_LISTING_RATELIMIT))) {
    return jsonErr(corsOrigin, 429, 'rate-limited');
  }
  const body = await parseBody(req);
  if (!body) return jsonErr(corsOrigin, 400, 'invalid-payload');
  if (!env.OPENSEA_API_KEY) {
    return jsonErr(corsOrigin, 503, 'opensea-not-configured');
  }

  const chain = OPENSEA_CHAINS[body.chainId];
  if (!chain) return jsonErr(corsOrigin, 400, 'unsupported-chain');

  const url = `https://${chain.host}/api/v2/orders/${chain.slug}/seaport/listings`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-KEY': env.OPENSEA_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      parameters: body.parameters,
      signature: body.signature,
      protocol_address: body.protocol_address,
    }),
  });
  return passthrough(upstream, corsOrigin);
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function checkRateLimit(
  req: Request,
  binding:
    | { limit(input: { key: string }): Promise<{ success: boolean }> }
    | undefined,
): Promise<boolean> {
  if (!binding) return true;
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    const { success } = await binding.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

async function parseBody(req: Request): Promise<OpenSeaListingRequest | null> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.chainId !== 'number' ||
    !Number.isInteger(o.chainId) ||
    o.chainId <= 0
  ) {
    return null;
  }
  if (!o.parameters || typeof o.parameters !== 'object') return null;
  if (typeof o.signature !== 'string' || !HEX_ANY.test(o.signature)) return null;
  if (
    typeof o.protocol_address !== 'string' ||
    !HEX_ADDR.test(o.protocol_address)
  ) {
    return null;
  }
  return {
    chainId: o.chainId,
    parameters: o.parameters as Record<string, unknown>,
    signature: o.signature,
    protocol_address: o.protocol_address,
  };
}

async function passthrough(
  upstream: Response,
  corsOrigin: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    body = { error: 'upstream-non-json', status: upstream.status };
  }
  return new Response(JSON.stringify(body), {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

function jsonErr(corsOrigin: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

// ─── Why there's no /opensea/listing/cancel here ───────────────────
//
// OpenSea's marketplace UI validates orders by calling
// `isValidSignature(orderHash, …)` on the offerer (our vault) before
// surfacing fills. The diamond's `cancelPrepayListing` revokes the
// orderHash binding from the vault — so on the very next OpenSea
// re-validation pass (a few minutes), `isValidSignature` returns
// invalid and OpenSea drops the listing from the catalogue
// automatically. Posting an explicit cancel to OpenSea's API would
// shave that latency from minutes to seconds but add nothing else.
//
// We surface the marketplace-lag in the cancel-confirm UI instead
// (PrepayListingActions's i18n string), which is clearer than
// promising sub-second sync. If marketplace-lag turns out to be
// painful in practice we can add a `POST /opensea/listing/cancel`
// proxy as a follow-up — the asymmetry is intentional, not an
// oversight.
