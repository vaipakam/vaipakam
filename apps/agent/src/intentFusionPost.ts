/**
 * T-090 v1.1 (#389) Sub 3 (#418) + v1.1 GA (#426) — Fusion
 * resolver-pickup proxy.
 *
 * Endpoint: `POST /intent/fusion/post`
 *
 * The dapp calls this after the borrower's commit transaction
 * lands. Body carries:
 *   - `chainId`           — chain the commit lives on
 *   - `orderHash`         — canonical 1inch LOP v4 hash the diamond
 *                           bound via ERC-1271
 *   - `order`             — full structured Fusion order the
 *                           resolver auction needs to fill (read
 *                           back from `GET /loans/:id` →
 *                           `swapToRepayIntent` via the indexer)
 *   - `commitTxHash`      — borrower-side tx that registered the
 *                           commit on-chain (used for telemetry +
 *                           the resolver-side audit trail)
 *
 * Why this lives on the agent rather than the dapp:
 *   - The 1inch Fusion API key stays Vaipakam-side (rate-limit
 *     protection + key rotation without dapp redeploys).
 *   - Centralised observability — every committed intent flows
 *     through one Worker we can monitor for fill-rate + resolver-
 *     set health (governance-tuning signal for future allow-list
 *     curation).
 *
 * GA wiring (#426): validates the payload, posts to 1inch's
 * Fusion resolver-pickup endpoint with the
 * `INTENT_FUSION_API_KEY` secret server-side, and passes the
 * upstream JSON response through to the dapp. If the secret is
 * unset (alpha-era deploys), the handler degrades to the
 * pre-GA queued-ack behaviour so a dapp expecting the
 * forward-compatible response shape still gets a clean
 * success-path resolution — the on-chain commit is the source
 * of truth either way.
 *
 * Stage-3 split note: no funds move through this handler.
 * Compromise of the `INTENT_FUSION_API_KEY` secret rate-limits
 * resolver visibility but can't pull collateral — that lives
 * behind the diamond's ERC-1271 signature on the orderHash,
 * not the agent's auth.
 */

import type { Env } from './env';

// Codex round-2 PR #430 P2 — host is `api.1inch.com`, NOT
// `.dev`. The `.dev` host does not serve the Fusion relayer
// route on the current API portal.
const FUSION_BASE_URL = 'https://api.1inch.com/fusion/relayer/v2.0';

/// Chain IDs 1inch Fusion supports. Codex round-1 PR #430 P2 —
/// without this allow-list, a dapp on Base Sepolia (84532) or any
/// other testnet would forward to a Fusion path that doesn't exist
/// and every commit would silently fail at the upstream level.
/// Source: 1inch Fusion supported-chains documentation. Mainnet
/// only; Vaipakam testnets are gated to the queued-ack fallback
/// regardless of the secret being set.
const FUSION_SUPPORTED_CHAIN_IDS = new Set<number>([
  1,      // Ethereum
  8453,   // Base
  42161,  // Arbitrum One
  10,     // Optimism
  56,     // BNB Chain
  137,    // Polygon PoS
]);

/// Request body shape — matches the structured order projection
/// the indexer's `GET /loans/:id` returns as `payload.swapToRepayIntent`.
interface IntentFusionPostRequest {
  chainId: number;
  orderHash: `0x${string}`;
  order: {
    maker: `0x${string}`;
    receiver: `0x${string}`;
    makerAsset: `0x${string}`;
    takerAsset: `0x${string}`;
    makerAmount: string;
    takerAmount: string;
    deadline: number;
    salt: string;
    makerTraits: string;
    extension: `0x${string}`;
  };
  commitTxHash: `0x${string}`;
}

export async function handleIntentFusionPost(
  req: Request,
  env: Env,
  /** CORS origin to echo on the response. Resolved by
   *  `resolveAllowedOrigin(req, env)` upstream — the request's own
   *  Origin iff in `FRONTEND_ORIGIN`, else the first allow-list
   *  entry for non-browser callers. Same pattern every dapp-facing
   *  endpoint on this Worker uses. */
  corsOrigin: string,
): Promise<Response> {
  // Codex round-4 PR #423 P2 — frontend-origin gate. CORS-echo
  // (`corsOrigin`) is not authentication: a simple POST from
  // any site or non-browser caller still reaches this handler.
  // Without an Origin allow-list check, arbitrary callers could
  // inject fake `queued` telemetry today + burn the server-side
  // Fusion-pickup quota once the upstream `fetch` lands.
  //
  // Mirror the OpenSea listing route's gate (per docstring: CORS
  // origin is resolved by `resolveAllowedOrigin` which falls back
  // to FRONTEND_ORIGIN's first entry when the request has no
  // matching Origin header — meaning anything with a foreign /
  // missing Origin is implicitly mismatch-flagged here).
  const reqOrigin = req.headers.get('Origin');
  const allowed = (env as unknown as { FRONTEND_ORIGIN?: string })
    .FRONTEND_ORIGIN ?? '';
  const allowList = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  if (!reqOrigin || !allowList.includes(reqOrigin)) {
    return jsonErr(corsOrigin, 403, 'origin-not-allowed');
  }

  // Codex round-1 PR #430 P2 — per-IP rate limit bounds the
  // request rate that can spend the shared Fusion API key. The
  // Origin gate above stops the browser-misconfigured noise; the
  // rate-limit stops a malicious caller from spoofing Origin +
  // burning the Vaipakam-side quota.
  if (!(await checkRateLimit(req, env.INTENT_FUSION_POST_RATELIMIT))) {
    return jsonErr(corsOrigin, 429, 'rate-limited');
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonErr(corsOrigin, 400, 'invalid-json');
  }
  const parsed = validateBody(raw);
  if (!parsed) return jsonErr(corsOrigin, 400, 'invalid-payload');

  // Sanity: the diamond's commit emitted this exact orderHash; the
  // ERC-1271 binding stored it on-chain. Forwarding a SHAPE-VALID
  // but UNREGISTERED orderHash to Fusion would just fail downstream
  // — the resolver-pickup endpoint's signature-verification
  // staticcalls our ERC-1271 and gets `0xffffffff` for unregistered
  // hashes. We don't pre-flight that here because the dapp already
  // ran the commit tx successfully to get the orderHash; an
  // attacker faking the request still hits the same on-chain
  // rejection.

  // Codex round-1 PR #430 P2 — gate to chains 1inch Fusion
  // supports. A Base Sepolia commit (chainId 84532) would
  // otherwise spend an API call on a path that doesn't exist; the
  // upstream returns 404 and the dapp surfaces a misleading
  // "Fusion upstream failed" error. Cleaner to short-circuit to
  // the queued-ack with an unsupported-chain note so the user
  // knows the on-chain commit is the source of truth + that
  // resolver discovery isn't expected on this chain.
  if (!FUSION_SUPPORTED_CHAIN_IDS.has(parsed.chainId)) {
    console.log('[intent/fusion/post] queued (chain unsupported by Fusion)', {
      chainId: parsed.chainId,
      orderHash: parsed.orderHash,
    });
    return jsonOk(corsOrigin, {
      ok: true,
      status: 'queued',
      orderHash: parsed.orderHash,
      note: `Chain ${parsed.chainId} is not supported by 1inch Fusion. Your collateral is in protocol custody as recorded by the on-chain commit; cancel after the auction deadline to return it to your vault — do not wait for a fill that will not arrive.`,
    });
  }

  // T-090 v1.1 GA (#426) — post to 1inch Fusion's resolver-pickup
  // endpoint with the operator-held API key. The dapp gets back
  // whatever Fusion replied (success → resolvers see the order;
  // 4xx/5xx → dapp surfaces the upstream error so the borrower
  // knows to cancel after deadline). If the secret is unset
  // (e.g. an alpha-era staging environment that never rotated
  // it in), fall back to the queued-ack behaviour so the dapp's
  // forward-compatible response shape still resolves cleanly.
  if (!env.INTENT_FUSION_API_KEY) {
    console.log('[intent/fusion/post] queued (no API key configured)', {
      chainId: parsed.chainId,
      orderHash: parsed.orderHash,
      commitTxHash: parsed.commitTxHash,
    });
    return jsonOk(corsOrigin, {
      ok: true,
      status: 'queued',
      orderHash: parsed.orderHash,
      note:
        'INTENT_FUSION_API_KEY is not configured on this Worker (operator-pre-activation state). No Fusion solver discovery happens until the secret is bound + the worker redeploys. Your collateral is in protocol custody as recorded by the on-chain commit; cancel after the auction deadline to return it to your vault — do not wait for a fill that will not arrive.',
    });
  }

  // Codex round-1 PR #430 P1 — Fusion v2 relayer expects the
  // `SignedOrderInput` shape:
  //   { order: LimitOrderV4, signature: bytes, extension: bytes,
  //     quoteId: string }
  //
  // For ERC-1271 contract makers (which the Vaipakam diamond is),
  // the on-chain `isValidSignature` resolves the signature server-
  // side — Fusion's server staticcalls into the diamond's ERC-1271
  // hook with the canonical orderHash. The dapp does not produce
  // a borrower EIP-712 signature for these orders; we pass an
  // empty bytes string in the signature field.
  //
  // Codex round-3 PR #430 P1 — `quoteId` is sourced from 1inch's
  // quote/build round-trip and is REQUIRED by Fusion's relayer.
  // Vaipakam's commit flow constructs the order shape from
  // on-chain context rather than from a 1inch quote, so we have
  // no quoteId to pass. Fusion will likely reject this submission
  // upstream. The dapp's panel surfaces the upstream rejection via
  // the response-status surfacing the round-2 fix added, so the
  // borrower's recovery path is the standard cancel-after-deadline.
  //
  // A v1.2 follow-up will either (a) drive the order shape through
  // 1inch's quote/build step at commit time so we have a real
  // quoteId, or (b) switch to 1inch's Limit Order Protocol relayer
  // endpoint (which doesn't require a quoteId) instead of Fusion's
  // resolver-pickup endpoint. Until that lands, the GA bridge is
  // load-bearing for the architectural shape (request reaches
  // Fusion, ERC-1271 binding holds, fills atomic with custody)
  // but every commit's upstream response is expected to be a
  // 4xx until the quoteId surface ships.
  const signedOrderInput = {
    order: {
      maker: parsed.order.maker,
      receiver: parsed.order.receiver,
      makerAsset: parsed.order.makerAsset,
      takerAsset: parsed.order.takerAsset,
      makingAmount: parsed.order.makerAmount,
      takingAmount: parsed.order.takerAmount,
      salt: parsed.order.salt,
      makerTraits: parsed.order.makerTraits,
    },
    signature: '0x',
    extension: parsed.order.extension,
    quoteId: '',
  };

  const upstreamUrl = `${FUSION_BASE_URL}/${parsed.chainId}/order/submit`;
  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.INTENT_FUSION_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(signedOrderInput),
    });
    return passthrough(upstream, corsOrigin);
  } catch (err) {
    console.error('[intent/fusion/post] upstream fetch failed', err);
    return jsonErr(corsOrigin, 502, 'fusion-upstream-failed');
  }
}

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

// ─── Helpers (kept local; mirrors the existing per-handler style
//     across this Worker — `openseaProxy.ts` / `quoteProxy.ts` both
//     define their own helpers rather than reaching for a shared
//     util module) ─────────────────────────────────────────────

function jsonErr(corsOrigin: string, status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

function jsonOk(corsOrigin: string, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
}

function validateBody(raw: unknown): IntentFusionPostRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0)
    return null;
  // Codex round-3 PR #430 P2 — tighten payload validation so a
  // non-browser caller that spoofs an allowed Origin can't push
  // through arbitrary strings that 1inch will spend our shared
  // API quota rejecting. Hex addresses are 0x + 40 hex chars,
  // hashes / bytes32 are 0x + 64 hex chars, uint256 string
  // decimals are bounded, and the extension is a known canonical
  // length the diamond's `canonicalExtension` view returns.
  if (!isBytes32Hex(o.orderHash) || !isBytes32Hex(o.commitTxHash)) return null;

  const order = o.order as Record<string, unknown> | undefined;
  if (!order || typeof order !== 'object') return null;
  const addrs = ['maker', 'receiver', 'makerAsset', 'takerAsset'] as const;
  for (const f of addrs) {
    if (!isAddressHex(order[f])) return null;
  }
  if (!isExtensionHex(order.extension)) return null;
  const uints = ['makerAmount', 'takerAmount', 'salt', 'makerTraits'] as const;
  for (const f of uints) {
    if (!isUint256DecString(order[f])) return null;
  }
  if (typeof order.deadline !== 'number' || !Number.isInteger(order.deadline) ||
      order.deadline <= 0)
    return null;

  return {
    chainId: o.chainId,
    orderHash: o.orderHash as `0x${string}`,
    commitTxHash: o.commitTxHash as `0x${string}`,
    order: order as IntentFusionPostRequest['order'],
  };
}

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
// Canonical extension: 32-byte offsets header + 40 bytes content
// (two 20-byte addresses per the v1.1 contract's
// `canonicalExtension`); total 0x + 144 hex chars.
const HEX_EXTENSION_RE = /^0x[0-9a-fA-F]{144}$/;
const UINT256_DEC_RE = /^[0-9]{1,78}$/;

function isAddressHex(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && HEX_ADDR_RE.test(v);
}
function isBytes32Hex(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && HEX_BYTES32_RE.test(v);
}
function isExtensionHex(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && HEX_EXTENSION_RE.test(v);
}
function isUint256DecString(v: unknown): v is string {
  if (typeof v !== 'string' || !UINT256_DEC_RE.test(v)) return false;
  try {
    return BigInt(v) < BigInt(2) ** BigInt(256);
  } catch {
    return false;
  }
}
