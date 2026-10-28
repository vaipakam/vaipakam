import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRpcIdentityCache } from '@vaipakam/lib/rpcIdentity';
import { RPC_PROXY_MAX_BATCH } from '@vaipakam/lib/rpcProxyPolicy';
import type { Env } from '../src/env';
import { handle } from '../src/proxy';

const APP = 'https://app.vaipakam.com';
const KEY = 'sk_live_abcdef0123456789';
const UPSTREAM = `https://base-sepolia.example-rpc.io/v2/${KEY}`;
const DIAMOND = '0x' + 'ab'.repeat(20);

type Call = { jsonrpc: string; id: number; method: string; params?: unknown };

/** An upstream that answers eth_chainId with `chainHex` and each other call
 *  through `answer`, recording every body it was sent. */
function upstream(chainHex = '0x14a34', answer: (c: Call) => unknown = (c) => ({ result: `r:${c.method}` })) {
  const bodies: unknown[] = [];
  const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call | Call[];
    bodies.push(body);
    if (!Array.isArray(body)) {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: chainHex });
    }
    return Response.json(body.map((c) => ({ jsonrpc: '2.0', id: c.id, ...(answer(c) as object) })));
  });
  return { fetchStub: fetchStub as unknown as typeof fetch, bodies, calls: fetchStub };
}

function env(over: Partial<Env> = {}): Env {
  return {
    FRONTEND_ORIGIN: `${APP},https://other.example`,
    RPC_CALLER_RATELIMIT: { limit: async () => ({ success: true }) },
    RPC_PROXY_BASE_SEPOLIA: { get: async () => UPSTREAM },
    ...over,
  };
}

function post(body: unknown, opts: { chain?: number; origin?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.origin !== null) headers.Origin = opts.origin ?? APP;
  return new Request(`https://rpc.example/rpc/${opts.chain ?? 84532}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.method === 'OPTIONS' || opts.method === 'GET' ? undefined : JSON.stringify(body),
  });
}

const call = (id: number | string, method: string, params: unknown = []) => ({ jsonrpc: '2.0', id, method, params });

beforeEach(() => _resetRpcIdentityCache());
afterEach(() => vi.restoreAllMocks());

describe('rpc-proxy: origin, route and preflight', () => {
  it('refuses an unlisted or missing Origin before anything else', async () => {
    const u = upstream();
    for (const origin of ['https://evil.example', null]) {
      const res = await handle(post(call(1, 'eth_blockNumber'), { origin }), env(), u.fetchStub);
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(u.calls).not.toHaveBeenCalled();
  });

  it('answers a preflight without spending a slot', async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const res = await handle(post(null, { method: 'OPTIONS' }), env({ RPC_CALLER_RATELIMIT: { limit } }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(limit).not.toHaveBeenCalled();
  });

  it('serves only POST /rpc/<served chain>', async () => {
    expect((await handle(new Request('https://rpc.example/health'), env())).status).toBe(404);
    expect((await handle(post(null, { method: 'GET' }), env())).status).toBe(405);
    expect((await handle(post(call(1, 'eth_blockNumber'), { chain: 5 }), env())).status).toBe(404);
  });
});

describe('rpc-proxy: budgets and body', () => {
  it('refuses when the caller is over budget, or the limiter is missing', async () => {
    const u = upstream();
    const over = await handle(post(call(1, 'eth_blockNumber')), env({ RPC_CALLER_RATELIMIT: { limit: async () => ({ success: false }) } }), u.fetchStub);
    expect(over.status).toBe(429);
    const missing = await handle(post(call(1, 'eth_blockNumber')), env({ RPC_CALLER_RATELIMIT: undefined }), u.fetchStub);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: 'rate-limit-binding-missing' });
    expect(u.calls).not.toHaveBeenCalled();
  });

  it('refuses an empty or oversized batch', async () => {
    expect((await handle(post([]), env())).status).toBe(400);
    const big = Array.from({ length: RPC_PROXY_MAX_BATCH + 1 }, (_, i) => call(i, 'eth_blockNumber'));
    expect((await handle(post(big), env())).status).toBe(400);
  });

  it('refuses a body that is not JSON', async () => {
    const req = new Request('https://rpc.example/rpc/84532', { method: 'POST', headers: { Origin: APP }, body: '{nope' });
    expect((await handle(req, env())).status).toBe(400);
  });
});

describe('rpc-proxy: per-call policy', () => {
  it('refuses a method outside the list in place and forwards the rest', async () => {
    const u = upstream();
    const res = await handle(
      post([call('a', 'eth_sendRawTransaction', ['0x00']), call('b', 'eth_blockNumber'), { jsonrpc: '2.0', method: 'eth_blockNumber' }]),
      env(),
      u.fetchStub,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { jsonrpc: '2.0', id: 'a', error: { code: -32601, message: 'method not served by this proxy' } },
      { jsonrpc: '2.0', id: 'b', result: 'r:eth_blockNumber' },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } },
    ]);
    // The forwarded batch carried only the allowed call.
    expect(u.bodies.at(-1)).toEqual([{ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }]);
  });

  it('refuses a log scan wider than the cap without forwarding it', async () => {
    const u = upstream();
    const res = await handle(
      post(call(7, 'eth_getLogs', [{ address: DIAMOND, fromBlock: '0x0', toBlock: '0x186a0' }])),
      env(),
      u.fetchStub,
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
    expect(u.calls).not.toHaveBeenCalled();
  });

  it('answers eth_chainId from the route without asking upstream', async () => {
    const u = upstream();
    const res = await handle(post(call(1, 'eth_chainId')), env(), u.fetchStub);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x14a34' });
    expect(u.calls).not.toHaveBeenCalled();
  });
});

describe('rpc-proxy: upstream', () => {
  it('maps answers back to the caller ids, even repeated or out of order', async () => {
    const u = upstream('0x14a34', (c) => ({ result: `n${c.id}` }));
    const fetchStub = (async (url: unknown, init?: RequestInit) => {
      const res = await u.fetchStub(url as string, init);
      const body = (await res.json()) as unknown;
      return Response.json(Array.isArray(body) ? [...body].reverse() : body);
    }) as typeof fetch;
    const res = await handle(post([call(5, 'eth_blockNumber'), call(5, 'eth_gasPrice'), call('x', 'eth_call', [{ to: DIAMOND }, 'latest'])]), env(), fetchStub);
    expect(await res.json()).toEqual([
      { jsonrpc: '2.0', id: 5, result: 'n0' },
      { jsonrpc: '2.0', id: 5, result: 'n1' },
      { jsonrpc: '2.0', id: 'x', result: 'n2' },
    ]);
  });

  it('answers a single call with a single reply', async () => {
    const u = upstream();
    const res = await handle(post(call(9, 'eth_blockNumber')), env(), u.fetchStub);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 9, result: 'r:eth_blockNumber' });
  });

  it('checks the upstream chain once per isolate, and refuses a mis-pointed secret', async () => {
    const wrong = upstream('0x1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handle(post(call(1, 'eth_blockNumber')), env(), wrong.fetchStub);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream-chain-mismatch' });
    expect(wrong.bodies).toHaveLength(1); // the identity probe, nothing forwarded
    expect(JSON.stringify(error.mock.calls)).not.toContain(KEY);

    const right = upstream();
    await handle(post(call(1, 'eth_blockNumber')), env(), right.fetchStub);
    await handle(post(call(2, 'eth_blockNumber')), env(), right.fetchStub);
    expect(right.bodies.filter((b) => !Array.isArray(b))).toHaveLength(1);
  });

  it('reports an absent, empty or non-https secret as not configured', async () => {
    const u = upstream();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const secret of [undefined, { get: async () => '  ' }, { get: async () => 'http://plain.example/key' }, { get: async () => Promise.reject(new Error(UPSTREAM)) }]) {
      const res = await handle(post(call(1, 'eth_blockNumber')), env({ RPC_PROXY_BASE_SEPOLIA: secret }), u.fetchStub);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'chain-not-configured' });
    }
    expect(u.calls).not.toHaveBeenCalled();
  });

  it('turns an upstream failure into a 502 that names no URL', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = [
      (async () => {
        throw new TypeError(`fetch failed: ${UPSTREAM}`);
      }) as typeof fetch,
      (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
    ];
    for (const f of failing) {
      _resetRpcIdentityCache();
      const res = await handle(post(call(1, 'eth_blockNumber')), env(), f);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toBe(JSON.stringify({ error: 'upstream-unavailable' }));
    }
    expect(JSON.stringify(error.mock.calls)).not.toContain(KEY);
  });

  it('treats a batch answered with one error object as an upstream failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = upstream();
    const f = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      if (Array.isArray(body)) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'limit' } });
      return u.fetchStub(url as string, init);
    }) as typeof fetch;
    expect((await handle(post(call(1, 'eth_blockNumber')), env(), f)).status).toBe(502);
  });

  it('passes revert data on and scrubs the key out of an error message', async () => {
    const u = upstream('0x14a34', (c) =>
      c.method === 'eth_call'
        ? { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }
        : { error: { code: -32000, message: `quota exceeded for ${KEY} at ${UPSTREAM}`, data: { url: UPSTREAM } } },
    );
    const res = await handle(post([call(1, 'eth_call', [{ to: DIAMOND }, 'latest']), call(2, 'eth_blockNumber')]), env(), u.fetchStub);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('example-rpc.io');
    const body = JSON.parse(text) as { id: number; error: { code: number; message: string; data?: string } }[];
    expect(body[0].error).toEqual({ code: 3, message: 'execution reverted', data: '0x08c379a0' });
    expect(body[1].error.code).toBe(-32000);
    expect(body[1].error.data).toBeUndefined();
  });

  it('answers a call the upstream left out with its own error', async () => {
    const u = upstream();
    const f = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Call | Call[];
      if (Array.isArray(body)) return Response.json([{ jsonrpc: '2.0', id: 0, result: 'only-first' }]);
      return u.fetchStub(url as string, init);
    }) as typeof fetch;
    const res = await handle(post([call(1, 'eth_blockNumber'), call(2, 'eth_gasPrice')]), env(), f);
    const body = (await res.json()) as { result?: string; error?: { code: number } }[];
    expect(body[0].result).toBe('only-first');
    expect(body[1].error?.code).toBe(-32603);
  });
});
