/**
 * Phase 7a — server-side quote proxy for the liquidation flow.
 *
 * Two HTTP entry points:
 *   POST /quote/0x      — proxies the 0x v2 Swap API quote endpoint
 *   POST /quote/1inch   — proxies the 1inch v6 Swap API quote endpoint
 *
 * Both inject the operator-held API key server-side so the keys never
 * ship to a browser client. The frontend's `useLiquidationQuotes` hook
 * calls these routes from the user's wallet origin; the worker rejects
 * any other origin via the existing `isAllowedOrigin` gate in index.ts.
 *
 * Request body (identical for both endpoints):
 *   {
 *     chainId:    number;   // e.g. 8453 (Base), 1 (Ethereum)
 *     sellToken:  string;   // ERC-20 collateral asset
 *     buyToken:   string;   // ERC-20 principal asset
 *     sellAmount: string;   // Decimal string (no "0x", no scientific)
 *     taker:      string;   // The diamond address that will execute
 *     slippageBps?: number; // Default 600 (6% — matches on-chain ceiling)
 *   }
 *
 * Response: pass-through of the aggregator's JSON body. Frontend reads
 * `transaction.data` (0x) or `tx.data` (1inch) for the calldata to pack
 * into an `AdapterCall`, and `buyAmount` for the expected output used
 * to rank the try-list.
 *
 * Rate-limit: not enforced here yet — Cloudflare Workers' built-in IP-
 * based rate-limit binding is the next step. For testnet bring-up the
 * caller's own request budget governs.
 */

import type { Env } from './env';

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

export async function handle0xQuote(req: Request, env: Env): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return jsonErr(env, 400, 'invalid-payload');
  if (!env.ZEROEX_API_KEY) return jsonErr(env, 503, 'zeroex-not-configured');

  // 0x v2 endpoint shape: query-param chainId + tokens + sell amount.
  const url = new URL('https://api.0x.org/swap/allowance-holder/quote');
  url.searchParams.set('chainId', String(body.chainId));
  url.searchParams.set('sellToken', body.sellToken);
  url.searchParams.set('buyToken', body.buyToken);
  url.searchParams.set('sellAmount', body.sellAmount);
  url.searchParams.set('taker', body.taker);
  // 0x expresses slippage as a decimal string ("0.06" = 6%).
  const slippageBps = body.slippageBps ?? 600;
  url.searchParams.set('slippageBps', String(slippageBps));

  const upstream = await fetch(url.toString(), {
    headers: {
      '0x-api-key': env.ZEROEX_API_KEY,
      '0x-version': 'v2',
      Accept: 'application/json',
    },
  });
  return passthrough(upstream, env);
}

export async function handle1inchQuote(req: Request, env: Env): Promise<Response> {
  const body = await parseBody(req);
  if (!body) return jsonErr(env, 400, 'invalid-payload');
  if (!env.ONEINCH_API_KEY) return jsonErr(env, 503, 'oneinch-not-configured');

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

  const upstream = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.ONEINCH_API_KEY}`,
      Accept: 'application/json',
    },
  });
  return passthrough(upstream, env);
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

async function passthrough(
  upstream: Response,
  env: Env,
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
      'Access-Control-Allow-Origin': env.FRONTEND_ORIGIN.split(',')[0] ?? '*',
    },
  });
}

function jsonErr(env: Env, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': env.FRONTEND_ORIGIN.split(',')[0] ?? '*',
    },
  });
}
