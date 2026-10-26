/**
 * Phase 7a — server-side quote proxy for the forced-close flow.
 *
 * One HTTP entry point, `POST /quote/1inch`, which proxies the 1inch v6
 * Swap API with the operator-held key injected server-side, so the key
 * never ships to a browser. The connected app's forced-close card
 * (`apps/app/src/data/closeOutRoute.ts`) is its only caller.
 *
 * There is no `/quote/0x` (#2755). It existed with no caller: the app
 * never asks 0x through this proxy, because a 0x quote can bind to the
 * transaction's originating account, which the app cannot name for every
 * wallet (`origin-bound` in `@vaipakam/lib/routeBuilder`), and the keeper
 * quotes 0x with its own key. A route nobody calls that spends an API key
 * is only an attack surface, so it was removed rather than hardened.
 *
 * Gating (#2755), in order:
 *   1. the router's Origin gate (`FRONTEND_ORIGIN`), which stops another
 *      site's page from spending the key through a visitor's browser;
 *   2. the caller budget `QUOTE_1INCH_RATELIMIT`, per client IP, taken at
 *      the router;
 *   3. the 1inch credential budget (`rateLimit.ts`), one slot taken right
 *      before the upstream call, shared with `/intent/fusion/post`.
 * Every limiter fails closed. The Origin header can be forged outside a
 * browser, so for a scripted caller the two budgets are the bound, and
 * this Worker states that rather than calling the route authenticated.
 *
 * Request body:
 *   {
 *     chainId:    number;   // e.g. 8453 (Base), 1 (Ethereum)
 *     sellToken:  string;   // ERC-20 collateral asset
 *     buyToken:   string;   // ERC-20 principal asset
 *     sellAmount: string;   // Decimal string (no "0x", no scientific)
 *     taker:      string;   // The swap ADAPTER that will call the swap target
 *     slippageBps?: number; // Default 600 (6% — matches on-chain ceiling)
 *   }
 *
 * Response: pass-through of the aggregator's JSON body. Consumers read
 * `tx.to` + `tx.data` (packaged by the on-chain `AggregatorAdapterBase`
 * as `abi.encode(address swapTarget, bytes swapCalldata)`; the adapter
 * approves a separate immutable `allowanceTarget` and validates
 * `swapTarget` against an owner-managed allowlist, see the Deployment
 * Runbook's "Aggregator adapter construction — allowanceTarget split")
 * and `dstAmount` / `toAmount` for the expected output used to rank the
 * try-list.
 */

import type { Env } from './env';
import { slotRefusal, takeCredentialSlot } from './rateLimit';

interface QuoteRequest {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  slippageBps?: number;
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[1-9][0-9]{0,77}$/;

/**
 * #2463 round 15 — readiness, so the app can say before the lender acts
 * whether 1inch can be asked at all: it can when this Worker holds the
 * key. It reports only what the proxy serves (#2755 removed `zeroex`).
 * The allow-list is disclosed by the response itself: an origin outside `FRONTEND_ORIGIN` gets a CORS header
 * naming another origin, the browser refuses to read the body, and the app
 * reports readiness as unread rather than guessing.
 */
export function handleQuoteReadiness(env: Env, corsOrigin: string): Response {
  return new Response(
    JSON.stringify({ oneinch: Boolean(env.ONEINCH_API_KEY) }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function handle1inchQuote(
  req: Request,
  env: Env,
  corsOrigin: string,
): Promise<Response> {
  // The caller budget was taken at the router (#2755).
  const body = await parseBody(req);
  if (!body) return jsonErr(corsOrigin, 400, 'invalid-payload');
  if (!env.ONEINCH_API_KEY) return jsonErr(corsOrigin, 503, 'oneinch-not-configured');

  // 1inch v6 endpoint shape: chainId in path, tokens + slippage as query.
  const url = new URL(
    `https://api.1inch.dev/swap/v6.0/${body.chainId}/swap`,
  );
  url.searchParams.set('src', body.sellToken);
  url.searchParams.set('dst', body.buyToken);
  url.searchParams.set('amount', body.sellAmount);
  url.searchParams.set('from', body.taker);
  // 1inch expresses slippage as a decimal percent ("6" = 6%).
  const slippagePct = (body.slippageBps ?? 600) / 100;
  url.searchParams.set('slippage', String(slippagePct));
  // disableEstimate skips the on-chain simulation 1inch normally runs,
  // since the diamond — not the keeper EOA — will be the executor at
  // settlement time and the simulation rejects the EOA caller.
  url.searchParams.set('disableEstimate', 'true');

  // Charged as spent: one slot of the 1inch budget for this one call.
  const refused = slotRefusal(await takeCredentialSlot(env, 'oneinch'), corsOrigin, 'upstream-quota');
  if (refused) return refused;
  const upstream = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.ONEINCH_API_KEY}`,
      Accept: 'application/json',
    },
  });
  return passthrough(upstream, corsOrigin);
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function parseBody(req: Request): Promise<QuoteRequest | null> {
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
  if (typeof o.sellToken !== 'string' || !HEX_ADDR.test(o.sellToken)) return null;
  if (typeof o.buyToken !== 'string' || !HEX_ADDR.test(o.buyToken)) return null;
  if (typeof o.sellAmount !== 'string' || !DECIMAL.test(o.sellAmount)) return null;
  if (typeof o.taker !== 'string' || !HEX_ADDR.test(o.taker)) return null;
  if (
    o.slippageBps !== undefined &&
    (typeof o.slippageBps !== 'number' ||
      !Number.isInteger(o.slippageBps) ||
      o.slippageBps < 0 ||
      o.slippageBps > 10_000)
  ) {
    return null;
  }
  return {
    chainId: o.chainId,
    sellToken: o.sellToken,
    buyToken: o.buyToken,
    sellAmount: o.sellAmount,
    taker: o.taker,
    slippageBps: typeof o.slippageBps === 'number' ? o.slippageBps : undefined,
  };
}

/**
 * `corsOrigin` is the request's own Origin when it is on the
 * `FRONTEND_ORIGIN` allow-list (the index's shared `resolveAllowedOrigin`).
 * The browser rejects a response whose `Access-Control-Allow-Origin` is any
 * other value, even another allowed origin — which is what echoing the
 * first list entry did to every app origin after it.
 */
async function passthrough(
  upstream: Response,
  corsOrigin: string,
): Promise<Response> {
  // Decode the JSON body once so we can re-serialize with our CORS
  // header set. Some aggregator endpoints use chunked encoding which
  // would otherwise need extra header massaging.
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
