/**
 * T-086 Round-6 / Block D (#345) — OpenSea SIGNED-offer fetch
 * proxy. Sibling of {handleOpenSeaOffers} (T-086 Round-5 Block C).
 *
 * GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}
 *     ?fulfiller=<vaultAddress>&quantity=<lotSize>
 *
 * The dapp hits this endpoint at Match-button click time to fetch
 * the BIDDER's full signed OpenSea Offer (the
 * `OrderComponents + signature + SIP-7 SignedZone extraData +
 * CriteriaResolver[]` payload) so the on-chain
 * `NFTPrepayListingAtomicFacet.matchOpenSeaOffer` can re-derive the
 * orderHash, validate the §17.5-bis shape invariant, and pass the
 * bytes to `Seaport.matchAdvancedOrders` in one atomic tx.
 *
 * **#348 — converged on OpenSea Fulfillment Data.** The proxy now
 * POSTs to `/api/v2/offers/fulfillment_data` (instead of the legacy
 * single-order GET) because the single-order endpoint doesn't return
 * SIP-7 `extraData` for fee-enforced (SignedZone) collections or a
 * properly-shaped `CriteriaResolver[]` for criteria offers. The
 * Fulfillment Data response is a superset, so retiring the
 * single-order path collapses the proxy to one code branch. The
 * required `?fulfiller=<vaultAddress>` query param carries the
 * borrower's vault address — the dapp resolves that before the
 * Match button is reachable.
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

// Seaport 1.6 protocol address — deterministic CREATE2 deploy by the
// Seaport team; same on every supported chain.
const SEAPORT_PROTOCOL_ADDRESS =
  '0x0000000000000068F116a894984e2DB1123eB395';

export async function handleOpenSeaSignedOffer(
  req: Request,
  env: Env,
  resolvedOrigin: string,
): Promise<Response> {
  // URL shape:
  //   GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}
  //       ?fulfiller=<vaultAddress>
  // Trailing-slash tolerant.
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);
  // segs = ['opensea', 'signed-offer', chainId, contract, tokenId, orderHash]
  if (segs.length !== 6) {
    return jsonResponse(
      {
        error:
          'usage: GET /opensea/signed-offer/{chainId}/{contract}/{tokenId}/{orderHash}?fulfiller=<vaultAddress>',
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
  // T-086 Block D follow-up (#348): the proxy now POSTs to OpenSea's
  // Fulfillment Data endpoint, which REQUIRES the fulfiller's
  // address in the request body. For the prepay-listing flow the
  // fulfiller is the borrower's vault — the dapp resolves that
  // before the Match button is reachable. Without it we can't fetch
  // SIP-7 extraData for fee-enforced collections or the canonical
  // CriteriaResolver[] for criteria offers.
  const fulfiller = url.searchParams.get('fulfiller');
  if (!fulfiller || !/^0x[0-9a-f]{40}$/i.test(fulfiller)) {
    return jsonResponse(
      {
        error: 'missing-or-invalid-fulfiller',
        hint:
          'The signed-offer proxy now wraps OpenSea fulfillment_data, which ' +
          'needs the fulfiller (borrower vault) address. Pass ' +
          '`?fulfiller=<vaultAddress>` on the URL.',
      },
      400,
      resolvedOrigin,
    );
  }
  // T-086 Block D / Codex round-1 P2 on PR #349 — ERC1155 loans
  // with `collateralQuantity > 1` need `units_to_fill` to match the
  // locked lot. OpenSea defaults the field to 1 when omitted, so a
  // multi-unit ERC1155 Match would otherwise get SignedZone /
  // criteria fulfillment data signed for ONE unit and revert when
  // the contract submits the full-lot `AdvancedOrder`. ERC721 +
  // single-unit ERC1155 callers can either pass `?quantity=1` or
  // omit the param entirely.
  const quantityRaw = url.searchParams.get('quantity');
  let unitsToFill = '1';
  if (quantityRaw !== null) {
    if (!/^\d+$/.test(quantityRaw) || quantityRaw === '0') {
      return jsonResponse(
        {
          error: 'invalid-quantity',
          hint:
            '`quantity` must be a positive decimal integer matching the ' +
            'collateral lot size (ERC721: 1; ERC1155: the locked ' +
            '`collateralQuantity`).',
        },
        400,
        resolvedOrigin,
      );
    }
    unitsToFill = quantityRaw;
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

  // T-086 Block D follow-up (#348) — converge on OpenSea Fulfillment
  // Data. The response is a superset of the single-order endpoint:
  // it carries the canonical `advancedOrder.parameters`, `signature`,
  // SIP-7 `extraData` (for fee-enforced collections), AND
  // properly-shaped `criteriaResolvers` (for criteria offers).
  // Switching to this endpoint as the sole upstream:
  //   - retires the single-order `{ order: {...} }` GET that PR #346
  //     round-1 corrected from the legacy `{ orders: [...] }` shape;
  //   - retires the round-4 SignedZone 422 fail-closed (now reachable
  //     iff OpenSea itself can't produce extraData for the order);
  //   - gives criteria offers a real `CriteriaResolver[]` instead of
  //     the raw `criteria_proof` the single-order endpoint exposes.
  //
  // Docs: https://docs.opensea.io/reference/generate_offer_fulfillment_data_v2
  // POST https://{host}/api/v2/offers/fulfillment_data
  // body: {
  //   offer: { hash, chain, protocol_address },
  //   fulfiller: { address },
  //   consideration: { asset_contract_address, token_id }
  //   // consideration is REQUIRED for criteria offers; harmless to
  //   // always send for concrete offers (OpenSea matches the
  //   // identifier against the order's offer item).
  // }
  const upstreamUrl = `https://${host}/api/v2/offers/fulfillment_data`;
  const upstreamBody = {
    offer: {
      hash: orderHash.toLowerCase(),
      chain: chainSlug,
      protocol_address: SEAPORT_PROTOCOL_ADDRESS,
    },
    fulfiller: { address: fulfiller.toLowerCase() },
    consideration: {
      asset_contract_address: contract.toLowerCase(),
      token_id: tokenId,
    },
    units_to_fill: unitsToFill,
  };

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
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

  // OpenSea Fulfillment Data response. Per the opensea-js SDK's
  // `src/utils/case.ts` the wire format is snake_case ("Used by the
  // API fetcher to expose camelCase responses to SDK consumers
  // regardless of the snake_case wire format."), but Codex round-1
  // on PR #349 flagged that some surfaces of the docs show
  // camelCase (e.g. `input_data.advancedOrder`). Accept both shapes
  // defensively rather than risk a wire-shape drift breaking every
  // Match. The shape we ultimately use:
  //   protocol,
  //   fulfillment_data | fulfillmentData: {
  //     transaction: {
  //       input_data | inputData: {
  //         advanced_order | advancedOrder: {
  //           parameters: <OrderParameters — counter STRIPPED>,
  //           signature, extra_data | extraData,
  //         },
  //         criteria_resolvers | criteriaResolvers: [...],
  //       },
  //     },
  //     orders: [
  //       {
  //         parameters: <OrderComponents — counter PRESENT>,
  //         signature,
  //       },
  //     ],
  //   }
  // §17.5's on-chain hash re-derive needs OrderComponents (counter
  // included). The transaction's `advanced_order.parameters` is
  // `OrderParameters` (counter stripped, `totalOriginalConsiderationItems`
  // added) so we MUST read `parameters` from `orders[0]` instead —
  // Codex round-1 P1 #2.
  const fulfillment =
    pickKey(raw, ['fulfillment_data', 'fulfillmentData']) ?? {};
  const transaction =
    pickKey(fulfillment, ['transaction']) ?? {};
  const inputData =
    pickKey(transaction, ['input_data', 'inputData']) ?? {};
  const advancedOrder =
    pickKey(inputData, ['advanced_order', 'advancedOrder']) ?? {};
  const ordersArray = pickKey(fulfillment, ['orders']);
  const firstOrder = Array.isArray(ordersArray) ? ordersArray[0] : undefined;
  // §17.5-driven shape: the components MUST carry `counter` so the
  // facet's `seaport.getOrderHash(orderComponents)` re-hash matches
  // the pinned `expectedBidderOrderHash`. `orders[0].parameters`
  // carries OrderComponents-with-counter; the transaction-level
  // `advanced_order.parameters` is OrderParameters-without-counter.
  const components = pickKey(firstOrder, ['parameters']);
  const signatureRaw =
    pickKey(advancedOrder, ['signature']) ??
    pickKey(firstOrder, ['signature']);
  const extraDataRaw = pickKey(advancedOrder, ['extra_data', 'extraData']);
  const criteriaResolversRaw =
    pickKey(inputData, ['criteria_resolvers', 'criteriaResolvers']);

  if (
    !components ||
    typeof components !== 'object' ||
    typeof signatureRaw !== 'string'
  ) {
    return jsonResponse(
      { error: 'opensea-malformed-fulfillment-data' },
      502,
      resolvedOrigin,
    );
  }

  // Surface the dapp-facing payload — the dapp will ABI-encode
  // `parameters` into the BidderOrder.components struct, pass
  // through `signature` + `extraData`, and forward `criteriaResolvers`
  // verbatim for the on-chain Seaport call.
  return jsonResponse(
    {
      orderHash: orderHash.toLowerCase(),
      parameters: components,
      signature: signatureRaw,
      extraData:
        typeof extraDataRaw === 'string' ? extraDataRaw : '0x',
      criteriaResolvers: Array.isArray(criteriaResolversRaw)
        ? criteriaResolversRaw
        : [],
    },
    200,
    resolvedOrigin,
  );
}

/**
 * Read the first present key from `obj` against an aliases list.
 * Used for the snake_case ↔ camelCase wire-shape drift defense in
 * the Fulfillment Data response parser. Treats `null` / `undefined`
 * obj as "no match" so callers can chain `pickKey(...) ?? {}` to
 * walk nested shapes without explicit null-checking at each step.
 */
function pickKey(
  obj: unknown,
  aliases: readonly string[],
): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  for (const key of aliases) {
    if (key in (obj as Record<string, unknown>)) {
      return (obj as Record<string, unknown>)[key];
    }
  }
  return undefined;
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
