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
 *     parameters:       OrderComponents; // canonical, incl. `counter`
 *     signature:        "0x";           // the vault signs by ERC-1271
 *     protocol_address: string;         // Seaport address on the chain
 *   }
 *
 * #2755 — the order must be a live Vaipakam listing before the key is
 * spent on it: `openseaListingBinding.ts` has Seaport hash the parsed
 * components and the Diamond's listing executor confirm the hash, and
 * only the parsed components (never the raw body) are forwarded. The
 * signature must be the empty `0x`: a Vaipakam listing is authorised by
 * the vault's ERC-1271 check, so a body carrying a real signature is an
 * order of someone else's.
 *
 * Response: pass-through of the OpenSea API's JSON body, plus our
 * own CORS header. Consumers care about:
 *   - `order.order_hash` — confirms the order OpenSea sees matches
 *     what the diamond locked
 *   - the listing URL — composed from chain slug + token id + asset
 *     contract; the frontend builds it (cheaper than parsing the
 *     OpenSea response shape)
 *
 * Rate-limit (#2755, `rateLimit.ts`): the router takes the per-IP caller
 * budget (`OPENSEA_LISTING_RATELIMIT`) before this runs, and one slot of
 * the shared OpenSea credential budget is taken right before the
 * upstream call. Both fail closed. The natural call rate is one POST per
 * `postPrepayListing` / `updatePrepayListing` tx.
 *
 * No consumer today, stated: OpenSea serves mainnets only and Vaipakam
 * has no mainnet deployment, and the connected app has not ported the
 * publish step from the retired `apps/defi`. So every post is refused at
 * the chain checks for now; the route is kept, bound, for that port.
 */

import type { Address } from 'viem';
import type { Env } from './env';
import {
  bindListingToProtocol,
  openSeaParameters,
  parseOrderComponents,
  type OrderComponents,
} from './openseaListingBinding';
import { slotRefusal, takeCredentialSlot } from './rateLimit';

interface OpenSeaListingRequest {
  chainId: number;
  components: OrderComponents;
  protocol_address: Address;
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * OpenSea chain slug + API host per supported chain id. Mainnet
 * only — OpenSea sunset the testnet API + marketplace UI on
 * 2025-07-23 (`support.opensea.io/en/articles/11833955-farewell-testnets`).
 * Testnet borrowers' publish attempts now fail-fast with the
 * `unsupported-chain` error here instead of timing out against a
 * dead endpoint or surfacing OpenSea's 404 as a generic publish
 * failure. The on-chain order still stands on every testnet —
 * just no marketplace-UI discoverability there.
 *
 * Adding a new mainnet chain means landing both the deployment
 * artifact AND a new entry here.
 */
const OPENSEA_CHAINS: Record<number, { host: string; slug: string }> = {
  1: { host: 'api.opensea.io', slug: 'ethereum' },
  8453: { host: 'api.opensea.io', slug: 'base' },
  42161: { host: 'api.opensea.io', slug: 'arbitrum' },
  10: { host: 'api.opensea.io', slug: 'optimism' },
  // Codex round-15 P2 review #328 — keep this listing-publish
  // chain set aligned with the offers proxy's
  // `OPENSEA_CHAIN_SLUG` map. Without 137 here, a Polygon match
  // would rotate on-chain but the publish step (this surface)
  // would return `unsupported-chain` — the bidder would see no
  // OpenSea listing despite the borrower being told to notify
  // them.
  137: { host: 'api.opensea.io', slug: 'matic' },
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
  // The caller budget was taken at the router (#2755).
  const body = await parseBody(req);
  if (!body) return jsonErr(corsOrigin, 400, 'invalid-payload');
  if (!env.OPENSEA_API_KEY) {
    return jsonErr(corsOrigin, 503, 'opensea-not-configured');
  }

  const chain = OPENSEA_CHAINS[body.chainId];
  if (!chain) return jsonErr(corsOrigin, 400, 'unsupported-chain');

  const binding = await bindListingToProtocol(env, body.chainId, body.components, body.protocol_address);
  if (binding.kind === 'refused') return jsonErr(corsOrigin, binding.status, binding.error);

  // Charged as spent: one slot of the OpenSea budget for this one call.
  const refused = slotRefusal(await takeCredentialSlot(env, 'opensea'), corsOrigin, 'upstream-quota');
  if (refused) return refused;
  const url = `https://${chain.host}/api/v2/orders/${chain.slug}/seaport/listings`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-KEY': env.OPENSEA_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      parameters: openSeaParameters(body.components),
      signature: '0x',
      protocol_address: binding.seaport,
    }),
  });
  return passthrough(upstream, corsOrigin);
}

// ─── Helpers ───────────────────────────────────────────────────────────

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
  if (o.signature !== '0x') return null;
  if (
    typeof o.protocol_address !== 'string' ||
    !HEX_ADDR.test(o.protocol_address)
  ) {
    return null;
  }
  const components = parseOrderComponents(o.parameters);
  if (!components) return null;
  return {
    chainId: o.chainId,
    components,
    protocol_address: o.protocol_address as Address,
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
