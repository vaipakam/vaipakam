/**
 * Phase 8b.2 — server-side Blockaid Transaction Scanner proxy.
 *
 * One HTTP entry point:
 *   POST /scan/blockaid    — proxies Blockaid's evm/transaction/scan endpoint
 *
 * The operator's Blockaid API key is held as a Worker secret and
 * injected server-side here; the frontend's `useTxSimulation` hook
 * calls this route and never sees the key. The frontend origin gate
 * (`isAllowedOrigin` in index.ts) restricts callers to the operator's
 * vaipakam.com origin, and a per-IP rate-limit binding caps abuse.
 *
 * Request body (forwarded as-is to Blockaid after validation):
 *   {
 *     chainId:    number;   // EVM chain id, e.g. 8453 (Base), 1 (Ethereum)
 *     from:       string;   // user's wallet (the simulating EOA)
 *     to:         string;   // tx target (typically the Diamond)
 *     data:       string;   // calldata, hex-prefixed
 *     value?:     string;   // optional hex-prefixed wei value, default "0x0"
 *   }
 *
 * Response: pass-through of Blockaid's JSON body. The frontend hook
 * extracts `validation.result_type` (Benign / Warning / Malicious)
 * and `simulation.assets_diffs` for the inline preview card.
 *
 * Failure modes:
 *   - missing API key → 503 `blockaid-not-configured` (frontend
 *     downgrades to "preview-unavailable" subtle footer).
 *   - rate-limited     → 429 `rate-limited`.
 *   - bad payload      → 400 `invalid-payload`.
 *   - upstream error   → status mirrored, body pass-through.
 */

import type { Env } from './env';

interface ScanRequest {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value?: string;
}

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_BLOB = /^0x[0-9a-fA-F]*$/;

export async function handleBlockaidScan(
  req: Request,
  env: Env,
): Promise<Response> {
  // Resolve the allowed CORS origin **per request** rather than always
  // returning the first entry of FRONTEND_ORIGIN. The preflight
  // (`index.ts:preflight`) already reflects the requesting origin if it
  // matches the allow-list; the actual response must match, otherwise
  // the browser passes preflight but blocks the body for any allowed
  // origin after the first (e.g. the staging entry when
  // `FRONTEND_ORIGIN = "https://vaipakam.com,https://staging.vaipakam.com"`).
  const corsOrigin = resolveAllowedOrigin(req, env);
  if (!(await checkRateLimit(req, env.SCAN_BLOCKAID_RATELIMIT))) {
    return jsonErr(429, 'rate-limited', corsOrigin);
  }
  const body = await parseBody(req);
  if (!body) return jsonErr(400, 'invalid-payload', corsOrigin);
  if (!env.BLOCKAID_API_KEY) {
    return jsonErr(503, 'blockaid-not-configured', corsOrigin);
  }
  // Phase 8b.2 / #00015 — refuse unsupported chain IDs explicitly
  // instead of silently rebadging them as Ethereum and scanning the
  // user's calldata against a totally different chain's state. The
  // frontend's `useTxSimulation` fail-soft branch maps `proxy 503`
  // to `{status:'unavailable'}` so the user sees the documented
  // "preview unavailable" footer rather than a misleading green card.
  const chainName = blockaidChainName(body.chainId);
  if (chainName === null) {
    return jsonErr(503, 'chain-unsupported', corsOrigin);
  }

  const blockaidBody = {
    chain: chainName,
    account_address: body.from,
    data: {
      from: body.from,
      to: body.to,
      data: body.data,
      value: body.value ?? '0x0',
    },
    metadata: { domain: 'app.vaipakam.com' },
    options: ['simulation', 'validation'],
  };

  const upstream = await fetch(
    'https://api.blockaid.io/v0/evm/transaction/scan',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': env.BLOCKAID_API_KEY,
        Accept: 'application/json',
      },
      body: JSON.stringify(blockaidBody),
    },
  );
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

async function parseBody(req: Request): Promise<ScanRequest | null> {
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
  if (typeof o.from !== 'string' || !HEX_ADDR.test(o.from)) return null;
  if (typeof o.to !== 'string' || !HEX_ADDR.test(o.to)) return null;
  if (typeof o.data !== 'string' || !HEX_BLOB.test(o.data)) return null;
  if (
    o.value !== undefined &&
    (typeof o.value !== 'string' || !HEX_BLOB.test(o.value))
  ) {
    return null;
  }
  return {
    chainId: o.chainId,
    from: o.from,
    to: o.to,
    data: o.data,
    value: typeof o.value === 'string' ? o.value : undefined,
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

function jsonErr(status: number, code: string, corsOrigin: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

/**
 * Echo the requesting `Origin` header back if and only if it is in the
 * comma-separated `FRONTEND_ORIGIN` allow-list. Returns the first
 * allow-list entry as a safe fallback when the request lacks an Origin
 * (non-browser callers) or the origin doesn't match — that fallback
 * keeps debug curl calls and same-origin worker tests working without
 * granting cross-origin access to unlisted callers.
 */
function resolveAllowedOrigin(req: Request, env: Env): string {
  const origin = req.headers.get('Origin') ?? '';
  const allow = env.FRONTEND_ORIGIN.split(',').map((s) => s.trim());
  if (origin && allow.includes(origin)) {
    return origin;
  }
  return allow[0] ?? '*';
}

/**
 * Resolve the Blockaid chain identifier for a given EVM chain id.
 * Returns `null` when the chain is not on the operator's allow-list —
 * the caller MUST fail soft (503 `chain-unsupported`) instead of
 * defaulting to a different chain. Per #00015, silently rebadging an
 * unmapped chain as Ethereum would scan calldata against the wrong
 * chain's state and surface an irrelevant safety verdict.
 *
 * Add new chains here only after confirming Blockaid supports them
 * for the Transaction Scanner endpoint.
 */
function blockaidChainName(chainId: number): string | null {
  switch (chainId) {
    case 1:
      return 'ethereum';
    case 8453:
      return 'base';
    case 42161:
      return 'arbitrum';
    case 10:
      return 'optimism';
    case 56:
      return 'bsc';
    case 137:
      return 'polygon';
    case 1101:
      return 'polygon-zkevm';
    case 11155111:
      return 'sepolia';
    case 84532:
      return 'base-sepolia';
    default:
      return null;
  }
}
