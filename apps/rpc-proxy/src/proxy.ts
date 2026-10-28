/**
 * The read-only JSON-RPC proxy (#1724): `POST /rpc/<chainId>`.
 *
 * What one request goes through, in order, and what each refusal is:
 *
 *   1. The route names a chain the proxy serves (404 otherwise).
 *   2. The page's `Origin` is listed (403 otherwise). A preflight is
 *      answered here, before any budget is spent.
 *   3. The caller's per-IP slot is taken (429, or 503 when the limiter is
 *      missing or failing: the shared rule in `@vaipakam/lib/rateLimit`).
 *   4. The body is read up to the cap (413) and parsed (400).
 *   5. Each call is checked against `@vaipakam/lib/rpcProxyPolicy`. A
 *      refused call gets its own JSON-RPC error; the rest still go.
 *   6. The chain's upstream URL is read from its dedicated secret (503 when
 *      absent), and its chain id is confirmed once per isolate (502 when it
 *      answers for another chain, or cannot be asked).
 *   7. The allowed calls go upstream as one batch under fresh ids, and each
 *      answer is matched back to the caller's own id.
 *
 * Every refusal at the HTTP level (4xx/5xx) is one the app's transport
 * treats as "this endpoint failed", so it moves on to its public fallback;
 * a per-call JSON-RPC error is answered in place.
 *
 * The upstream URL carries the provider key, so it is never written into a
 * response or a log. An upstream error's message is scrubbed of the URL's
 * parts and of anything URL- or credential-shaped before it is passed on,
 * and its `data` is passed on only when it is revert data (hex), which the
 * app needs to name a contract error.
 */
import { redactedError, redactSecrets } from '@vaipakam/lib/errorDescription';
import { isListedOrigin } from '@vaipakam/lib/originAllowList';
import { slotRefusalStatus, takeCallerSlot } from '@vaipakam/lib/rateLimit';
import { readJsonBody } from '@vaipakam/lib/requestBody';
import { verifyRpcChainIdentity } from '@vaipakam/lib/rpcIdentity';
import {
  RPC_PROXY_CHAINS,
  RPC_PROXY_MAX_BATCH,
  RPC_PROXY_MAX_BODY_BYTES,
  checkRpcCall,
} from '@vaipakam/lib/rpcProxyPolicy';
import type { Env } from './env';

/** How long one upstream request may take before it counts as failed. */
export const UPSTREAM_TIMEOUT_MS = 10_000;

const ROUTE = /^\/rpc\/(\d{1,10})$/;
const HEX_DATA = /^0x[0-9a-f]*$/i;
/** Parts of the upstream URL at least this long are scrubbed by value. */
const MIN_SCRUBBED_FRAGMENT = 8;
const MAX_MESSAGE = 500;

type RpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
  data?: string;
}

type RpcReply = { jsonrpc: '2.0'; id: RpcId } & ({ result: unknown } | { error: RpcError });

/** A call that passed the shape check. */
interface RpcCall {
  id: RpcId;
  method: string;
  params?: unknown;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function reply(id: RpcId, error: RpcError): RpcReply {
  return { jsonrpc: '2.0', id, error };
}

function isRpcId(v: unknown): v is RpcId {
  return v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** A call's shape, or the reason it has none. A call without an `id` (a
 *  JSON-RPC notification) is refused: the proxy forwards reads, and a read
 *  whose answer nobody receives is only spend. */
function parseCall(raw: unknown): RpcCall | { refusal: RpcReply } {
  const o = raw as Record<string, unknown> | null;
  const id = typeof o === 'object' && o !== null && isRpcId(o.id) ? o.id : null;
  if (
    typeof o !== 'object' ||
    o === null ||
    Array.isArray(o) ||
    o.jsonrpc !== '2.0' ||
    typeof o.method !== 'string' ||
    !('id' in o) ||
    !isRpcId(o.id)
  ) {
    return { refusal: reply(id, { code: -32600, message: 'invalid request' }) };
  }
  return { id: o.id, method: o.method, params: o.params };
}

/** The chain's upstream URL from its dedicated secret, or `null` when the
 *  deployment has none: an absent binding, a read that fails, an empty
 *  value or one that is not an https URL all read as "not configured". */
async function upstreamUrl(env: Env, secretName: string): Promise<string | null> {
  const binding = env[secretName as `RPC_PROXY_${string}`];
  if (!binding) return null;
  let value: string;
  try {
    value = (await binding.get()).trim();
  } catch (err) {
    console.error(`[rpc-proxy] ${secretName}: secret read failed`, redactedError(err));
    return null;
  }
  if (value === '') return null;
  try {
    if (new URL(value).protocol !== 'https:') throw new Error('not https');
  } catch {
    // Never the value itself: it is the key.
    console.error(`[rpc-proxy] ${secretName}: secret is not an https URL; treating the chain as not configured`);
    return null;
  }
  return value;
}

/** The pieces of the upstream URL a provider might echo in an error: host
 *  labels, path segments, query values, user info. */
function urlFragments(url: string): string[] {
  const u = new URL(url);
  const parts = [
    ...u.hostname.split('.'),
    ...u.pathname.split('/'),
    ...[...u.searchParams.values()],
    u.username,
    u.password,
  ].map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return [...new Set(parts.filter((p) => p.length >= MIN_SCRUBBED_FRAGMENT))];
}

function scrub(text: string, fragments: readonly string[]): string {
  let out = text;
  for (const f of fragments) out = out.split(f).join('<redacted>');
  return redactSecrets(out).slice(0, MAX_MESSAGE);
}

/** One upstream answer, rebuilt field by field under the caller's id. */
function passOn(id: RpcId, upstream: unknown, fragments: readonly string[]): RpcReply {
  const o = upstream as Record<string, unknown>;
  if (typeof o.error === 'object' && o.error !== null) {
    const e = o.error as Record<string, unknown>;
    const error: RpcError = {
      code: typeof e.code === 'number' && Number.isInteger(e.code) ? e.code : -32603,
      message: typeof e.message === 'string' ? scrub(e.message, fragments) : 'upstream error',
    };
    if (typeof e.data === 'string' && HEX_DATA.test(e.data)) error.data = e.data;
    return reply(id, error);
  }
  if ('result' in o) return { jsonrpc: '2.0', id, result: o.result };
  return reply(id, { code: -32603, message: 'upstream answer had neither result nor error' });
}

/** POST a JSON-RPC body upstream; the parsed answer, or `null` on any
 *  failure (network, timeout, non-2xx, not JSON). */
async function postUpstream(
  url: string,
  body: unknown,
  chainId: number,
  upstreamFetch: typeof fetch,
): Promise<unknown | null> {
  let res: Response;
  try {
    res = await upstreamFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[rpc-proxy] chain ${chainId}: upstream request failed`, redactedError(err));
    return null;
  }
  if (!res.ok) {
    console.error(`[rpc-proxy] chain ${chainId}: upstream answered HTTP ${res.status}`);
    return null;
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    console.error(`[rpc-proxy] chain ${chainId}: upstream answer was not JSON`);
    return null;
  }
}

/** Handle one request. `upstreamFetch` is the test seam. */
export async function handle(req: Request, env: Env, upstreamFetch: typeof fetch = fetch): Promise<Response> {
  const route = ROUTE.exec(new URL(req.url).pathname);
  if (!route) return json({ error: 'not-found' }, 404);

  const origin = req.headers.get('Origin');
  if (!isListedOrigin(origin, env.FRONTEND_ORIGIN)) return json({ error: 'origin-not-allowed' }, 403);
  const cors = { 'access-control-allow-origin': origin as string, vary: 'Origin' };

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
    });
  }
  if (req.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { ...cors, allow: 'POST, OPTIONS' });

  const chainId = Number(route[1]);
  const secretName = RPC_PROXY_CHAINS[chainId];
  if (!secretName) return json({ error: 'chain-not-served' }, 404, cors);

  const refused = slotRefusalStatus(await takeCallerSlot(req, env.RPC_CALLER_RATELIMIT));
  if (refused) return json({ error: refused.error }, refused.status, cors);

  const body = await readJsonBody(req, RPC_PROXY_MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status, cors);

  const isBatch = Array.isArray(body.value);
  const raw: unknown[] = isBatch ? (body.value as unknown[]) : [body.value];
  if (raw.length === 0 || raw.length > RPC_PROXY_MAX_BATCH) {
    return json(
      reply(null, { code: -32600, message: `a batch holds 1 to ${RPC_PROXY_MAX_BATCH} calls` }),
      400,
      cors,
    );
  }

  // Answer what can be answered here; collect the rest for one upstream batch.
  const replies: (RpcReply | undefined)[] = new Array(raw.length);
  const forward: { index: number; call: RpcCall }[] = [];
  raw.forEach((r, index) => {
    const call = parseCall(r);
    if ('refusal' in call) {
      replies[index] = call.refusal;
      return;
    }
    const check = checkRpcCall(call.method, call.params);
    if (!check.ok) {
      replies[index] = reply(call.id, { code: check.code, message: check.message });
      return;
    }
    if (call.method === 'eth_chainId') {
      // The route already says which chain this is, and the upstream is
      // confirmed to be that chain before anything is forwarded.
      replies[index] = { jsonrpc: '2.0', id: call.id, result: `0x${chainId.toString(16)}` };
      return;
    }
    forward.push({ index, call });
  });

  if (forward.length > 0) {
    const url = await upstreamUrl(env, secretName);
    if (url === null) return json({ error: 'chain-not-configured' }, 503, cors);

    const identity = await verifyRpcChainIdentity(
      {
        getChainId: async () => {
          const answer = (await postUpstream(
            url,
            { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
            chainId,
            upstreamFetch,
          )) as { result?: unknown } | null;
          if (typeof answer?.result !== 'string') throw new Error('no chain id');
          return Number(BigInt(answer.result));
        },
      },
      chainId,
      url,
      'rpc-proxy',
    );
    if (!identity.ok) {
      return json({ error: identity.reason === 'mismatch' ? 'upstream-chain-mismatch' : 'upstream-unavailable' }, 502, cors);
    }

    // Fresh ids upstream: the caller's ids may repeat or collide, and the
    // position in this list is what maps an answer back.
    const answer = await postUpstream(
      url,
      forward.map(({ call }, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: call.method,
        ...(call.params === undefined ? {} : { params: call.params }),
      })),
      chainId,
      upstreamFetch,
    );
    if (!Array.isArray(answer)) return json({ error: 'upstream-unavailable' }, 502, cors);

    const byId = new Map<number, unknown>();
    for (const a of answer) {
      const id = (a as { id?: unknown } | null)?.id;
      if (typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < forward.length) byId.set(id, a);
    }
    const fragments = urlFragments(url);
    forward.forEach(({ index, call }, i) => {
      const a = byId.get(i);
      replies[index] =
        a === undefined
          ? reply(call.id, { code: -32603, message: 'upstream returned no answer for this call' })
          : passOn(call.id, a, fragments);
    });
  }

  return json(isBatch ? replies : replies[0], 200, cors);
}
