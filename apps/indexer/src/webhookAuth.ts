/**
 * #757 Phase A — `/hooks/chain-event` authentication + payload parsing.
 *
 * Pure, side-effect-free helpers so the route logic stays thin and the security
 * boundary is in one auditable place. The route dispatches these BEFORE the
 * global `resolveEnv`, reading only `ALCHEMY_WEBHOOK_SIGNING_KEY` from the raw
 * env, so an unauthenticated POST never triggers the other Secrets-Store
 * fetches (§3.5 of the design doc).
 *
 * Order on the route: cap body → verify HMAC → parse payload → (dedupe +
 * forward to the DO). Each step fails closed.
 */

/** Alchemy payloads are a few KB; reject anything larger before hashing. */
export const MAX_WEBHOOK_BODY = 64 * 1024;

/**
 * Read the request body as text with a hard size cap, BEFORE any HMAC work, so
 * an unauthenticated caller can't force unbounded allocation/CPU just to be
 * 401'd. Rejects (throws {@link WebhookBodyTooLargeError}) if `Content-Length`
 * exceeds the cap, or — when the length header is absent/lying — if the
 * streamed bytes exceed it.
 */
export class WebhookBodyTooLargeError extends Error {}

export async function readCappedBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY) {
    throw new WebhookBodyTooLargeError(`content-length ${declared} > cap`);
  }
  if (!req.body) return await req.text(); // no stream → tiny/empty body
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY) {
        await reader.cancel();
        throw new WebhookBodyTooLargeError(`streamed ${total} bytes > cap`);
      }
      chunks.push(value);
    }
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Decode a hex string (optionally `0x`-prefixed) to bytes; null if malformed. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0 || h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) return null;
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verify Alchemy's `X-Alchemy-Signature` — HMAC-SHA256 over the RAW request
 * body, hex-encoded — using Web Crypto's constant-time `verify` (no hand-rolled
 * compare). Returns false (never throws) on a missing/empty key, a
 * missing/malformed header, or a mismatch — the caller maps false → 401.
 */
export async function verifyAlchemySignature(
  rawBody: string,
  signatureHex: string | null,
  signingKey: string | undefined,
): Promise<boolean> {
  if (!signingKey || !signatureHex) return false;
  const sigBytes = hexToBytes(signatureHex);
  if (!sigBytes) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(rawBody),
    );
  } catch {
    return false;
  }
}

/**
 * Alchemy network identifier → our chainId. The operator configures the webhook
 * to carry the network; an unmapped/unknown network → the route 200-no-ops
 * (a webhook for a chain we don't index is not an error). Mirrors the chain set
 * in `getChainConfigs`.
 */
const ALCHEMY_NETWORK_TO_CHAIN_ID: Record<string, number> = {
  ETH_MAINNET: 1,
  BASE_MAINNET: 8453,
  ARB_MAINNET: 42161,
  OPT_MAINNET: 10,
  BNB_MAINNET: 56,
  ETH_SEPOLIA: 11155111,
  BASE_SEPOLIA: 84532,
  ARB_SEPOLIA: 421614,
  OPT_SEPOLIA: 11155420,
  BNB_TESTNET: 97,
  MATIC_AMOY: 80002,
  POLYGON_AMOY: 80002,
};

/** A `0x`-hex or decimal block number → bigint; null if not parseable. */
function toBlock(v: unknown): bigint | null {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.floor(v));
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    try {
      return v.startsWith('0x') ? BigInt(v) : BigInt(v.replace(/[^0-9]/g, '') || '0');
    } catch {
      return null;
    }
  }
  return null;
}

/** Walk an arbitrary parsed payload and collect the max block number under any
 *  common Alchemy key (`blockNumber`, `blockNum`, `number` inside a `block`). */
function maxBlockIn(node: unknown, depth = 0): bigint {
  if (depth > 6 || node === null || typeof node !== 'object') return 0n;
  let max = 0n;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'blockNumber' || k === 'blockNum' || k === 'blockNo') {
      const b = toBlock(v);
      if (b && b > max) max = b;
    } else if (k === 'block' && v && typeof v === 'object') {
      const b = toBlock((v as Record<string, unknown>).number);
      if (b && b > max) max = b;
      const nested = maxBlockIn(v, depth + 1);
      if (nested > max) max = nested;
    } else if (v && typeof v === 'object') {
      const nested = maxBlockIn(v, depth + 1);
      if (nested > max) max = nested;
    }
  }
  return max;
}

/** SHA-256 of a string → lowercase hex. Used by the route as the dedupe-key
 *  fallback when a delivery carries no provider id (see {@link ParsedChainEvent.providerId}). */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface ParsedChainEvent {
  /**
   * The provider's own delivery id (`p.id`), or `null` when the payload carries
   * none. The route uses this as the dedupe key when present and otherwise
   * falls back to a hash of the RAW body — NEVER a coarse `<network>:<block>`
   * string, which for block-less Custom Webhooks routed by `?chain=` would
   * collapse to `unknown:0` for every delivery and dedupe them all away (Codex
   * #764 round 4). A body hash collides only on a byte-identical payload, which
   * is exactly a provider retry of the same delivery — the dedup we want.
   */
  providerId: string | null;
  /** Resolved chainId, or null when the network is unknown/unmapped. */
  chainId: number | null;
  /**
   * Max delivered block — the DO's catch-up wait-for-safe TARGET. `0` when the
   * payload carries no block number (a Custom Webhook whose GraphQL selection
   * omits `block { number }`). `0` degrades GRACEFULLY, it is not an error: the
   * DO treats it as "scan to the current safe head once" (`scannedTo >= 0` is
   * always caught-up), so a just-mined event at or below the safe head still
   * lands this tick. An event ABOVE the safe head simply isn't waited for here
   * — the once-a-minute cron ping (and the next delivery) cover it. To get the
   * tightest end-to-end latency (the DO waiting for a specific block to
   * finalize), the operator's Custom Webhook GraphQL MUST include
   * `block { number }`; this field is the only place that hint is consumed.
   */
  maxBlock: bigint;
}

/**
 * Parse the (already HMAC-verified) webhook body. The payload is a HINT — only
 * the network (→ chainId) and the max block (the loop target) are used; the
 * scan range itself stays cursor-derived in the DO and every row is a fresh
 * dRPC re-read. Defensive across Custom-Webhook and Address-Activity shapes.
 */
export function parseChainEventPayload(text: string): ParsedChainEvent | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const event = (p.event ?? {}) as Record<string, unknown>;
  const networkRaw =
    (event.network as string | undefined) ?? (p.network as string | undefined);
  const chainId =
    networkRaw && networkRaw in ALCHEMY_NETWORK_TO_CHAIN_ID
      ? ALCHEMY_NETWORK_TO_CHAIN_ID[networkRaw]
      : null;
  const maxBlock = maxBlockIn(p);
  const providerId = typeof p.id === 'string' && p.id ? p.id : null;
  return { providerId, chainId, maxBlock };
}
