/**
 * T-090 v1.1 (#389) Sub 3 (#418) — Fusion resolver-pickup proxy.
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
 * v1.1 launch status: the actual `POST` to 1inch's resolver-pickup
 * endpoint is the follow-up integration step once the 1inch
 * Fusion SDK / direct API is finalised. This handler validates +
 * accepts the payload + returns a `queued` ack so the dapp's hook
 * has a successful resolution path. The real upstream `fetch`
 * lands in a v1.1 GA card; the agent endpoint's request shape
 * stays stable so the dapp doesn't re-deploy.
 *
 * Stage-3 split note (Sub 1 / Sub 2 design): no funds move
 * through this handler. Compromise of the agent's
 * `INTENT_FUSION_API_KEY` secret rate-limits resolver visibility
 * but can't pull collateral — that lives behind the diamond's
 * ERC-1271 signature on the orderHash, not the agent's auth.
 */

import type { Env } from './env';

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

  // Future: post to 1inch Fusion's resolver-pickup endpoint:
  //   const upstream = await fetch('https://api.1inch.dev/fusion/orders/...', {
  //     method: 'POST',
  //     headers: { 'Authorization': `Bearer ${env.INTENT_FUSION_API_KEY}` },
  //     body: JSON.stringify({ orderHash, order: parsed.order }),
  //   });
  //   return passthrough(upstream, corsOrigin);
  //
  // For now: log + acknowledge so the dapp's `useIntentCommit`
  // hook gets a successful resolution path. The on-chain commit
  // is already done; the borrower's collateral is in custody;
  // the agent's failure to forward to Fusion just means the
  // resolver auction never picks the order up and it expires —
  // exactly the cancel-window scenario the on-chain
  // `cancelSwapToRepayIntent` handles.

  console.log('[intent/fusion/post] queued', {
    chainId: parsed.chainId,
    orderHash: parsed.orderHash,
    commitTxHash: parsed.commitTxHash,
    makerAmount: parsed.order.makerAmount,
    takerAmount: parsed.order.takerAmount,
    deadline: parsed.order.deadline,
  });

  return jsonOk(corsOrigin, {
    ok: true,
    status: 'queued',
    orderHash: parsed.orderHash,
    note:
      'T-090 v1.1 Sub 3 placeholder — Fusion resolver-pickup upstream wires in the v1.1 GA card; the dapp polls Fusion directly while the agent telemetry captures the commit.',
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
  if (typeof o.orderHash !== 'string' || !o.orderHash.startsWith('0x'))
    return null;
  if (typeof o.commitTxHash !== 'string' || !o.commitTxHash.startsWith('0x'))
    return null;

  const order = o.order as Record<string, unknown> | undefined;
  if (!order || typeof order !== 'object') return null;
  const addrs = ['maker', 'receiver', 'makerAsset', 'takerAsset', 'extension'];
  for (const f of addrs) {
    if (typeof order[f] !== 'string' || !(order[f] as string).startsWith('0x'))
      return null;
  }
  const uints = ['makerAmount', 'takerAmount', 'salt', 'makerTraits'];
  for (const f of uints) {
    if (typeof order[f] !== 'string') return null;
  }
  if (typeof order.deadline !== 'number' || !Number.isInteger(order.deadline))
    return null;

  return {
    chainId: o.chainId,
    orderHash: o.orderHash as `0x${string}`,
    commitTxHash: o.commitTxHash as `0x${string}`,
    order: order as IntentFusionPostRequest['order'],
  };
}
