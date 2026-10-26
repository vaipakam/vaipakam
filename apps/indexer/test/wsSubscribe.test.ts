/**
 * #2756 — the browser push channel (`GET /ws/chain/:chainId`) is bounded.
 *
 * A WebSocket upgrade is not subject to CORS, so the Worker admits only the
 * app's own origins, then takes a per-IP subscribe slot under the shared
 * fail-closed rule. The chain's ingest object then caps how many sockets it
 * holds, for the whole chain and per client IP, because `broadcast()` writes
 * to every one of them inside the object that also runs the chain's scan.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { WorkerEnv } from '../src/env';
import {
  ChainIngestDO,
  MAX_SUBSCRIBERS_PER_CHAIN,
  MAX_SUBSCRIBERS_PER_IP,
  MAX_TRIGGER_BODY_BYTES,
} from '../src/chainIngestDO';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = 'https://app.example';
const IP = '203.0.113.9';

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

/** A Worker env with the push channel live and a DO that records reaches. */
function liveEnv(extra: Record<string, unknown> = {}) {
  const doFetch = vi.fn(async () => new Response('reached-do'));
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({ fetch: doFetch }),
  };
  const env = {
    DB: {} as D1Database,
    CHAIN_INGEST_VIA_DO: 'true',
    CHAIN_INGEST_DO: ns,
    FRONTEND_ORIGIN: APP,
    WS_SUBSCRIBE_RATELIMIT: { limit: async () => ({ success: true }) },
    ...extra,
  } as unknown as WorkerEnv;
  return { env, doFetch };
}

function subscribe(origin: string | null): Request {
  const headers: Record<string, string> = { Upgrade: 'websocket', 'CF-Connecting-IP': IP };
  if (origin !== null) headers.Origin = origin;
  return new Request('https://indexer.example/ws/chain/84532', { headers });
}

describe('the Worker gates a subscribe before reaching the DO', () => {
  it('admits a listed origin with a slot', async () => {
    const { env, doFetch } = liveEnv();
    const res = await worker.fetch(subscribe(APP), env, ctx());
    expect(await res.text()).toBe('reached-do');
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a foreign origin', 'https://elsewhere.example'],
    ['no origin', null],
  ])('refuses %s with 403', async (_label, origin) => {
    const { env, doFetch } = liveEnv();
    const res = await worker.fetch(subscribe(origin), env, ctx());
    expect(res.status).toBe(403);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('refuses every origin when FRONTEND_ORIGIN is unset', async () => {
    const { env, doFetch } = liveEnv({ FRONTEND_ORIGIN: undefined });
    const res = await worker.fetch(subscribe(APP), env, ctx());
    expect(res.status).toBe(403);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('refuses 503 when the subscribe limiter is not bound', async () => {
    const { env, doFetch } = liveEnv({ WS_SUBSCRIBE_RATELIMIT: undefined });
    const res = await worker.fetch(subscribe(APP), env, ctx());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('rate-limit-binding-missing');
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('refuses 429 when the slot is refused, keyed by the caller IP', async () => {
    const keys: string[] = [];
    const { env, doFetch } = liveEnv({
      WS_SUBSCRIBE_RATELIMIT: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const res = await worker.fetch(subscribe(APP), env, ctx());
    expect(res.status).toBe(429);
    expect(keys).toEqual([IP]);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('the indexer and the agent admit the same app origins', () => {
  // The push channel's origin list and the agent's are one product list;
  // a deploy that adds an app host to one and not the other leaves that
  // host either without push or without the agent.
  const frontendOrigin = (worker: string): string => {
    const text = readFileSync(resolve(HERE, '..', '..', worker, 'wrangler.jsonc'), 'utf8');
    const m = text.match(/"FRONTEND_ORIGIN":\s*"([^"]*)"/);
    if (!m) throw new Error(`${worker}/wrangler.jsonc declares no FRONTEND_ORIGIN`);
    return m[1]!;
  };

  it('declares the same FRONTEND_ORIGIN as apps/agent', () => {
    expect(frontendOrigin('indexer')).toBe(frontendOrigin('agent'));
  });

  it('declares the subscribe limiter the route reads', () => {
    const text = readFileSync(resolve(HERE, '..', 'wrangler.jsonc'), 'utf8');
    expect(text).toMatch(/"name":\s*"WS_SUBSCRIBE_RATELIMIT"/);
  });
});

describe('the ingest DO caps the sockets it holds', () => {
  /** A DO state holding `total` sockets, `sameIp` of them under IP's tag. */
  function doWith(total: number, sameIp: number) {
    const accepted: Array<{ tags: string[] }> = [];
    const state = {
      setWebSocketAutoResponse: () => {},
      getWebSockets: (tag?: string) =>
        new Array(tag === undefined ? total : tag === `ip:${IP}` ? sameIp : 0).fill({}),
      acceptWebSocket: (_ws: unknown, tags: string[]) => accepted.push({ tags }),
    };
    vi.stubGlobal('WebSocketRequestResponsePair', class {});
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = {};
        1 = { send: () => {} };
      },
    );
    const obj = new ChainIngestDO(state as unknown as DurableObjectState, {} as WorkerEnv);
    return { obj, accepted };
  }

  const upgrade = () =>
    new Request('https://chain-ingest-do/ws?chain=84532', {
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': IP },
    });

  it('refuses 503 once the chain holds its cap', async () => {
    const { obj, accepted } = doWith(MAX_SUBSCRIBERS_PER_CHAIN, 0);
    const res = await obj.fetch(upgrade());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('subscriber-limit');
    expect(accepted).toEqual([]);
  });

  it('refuses 429 once one IP holds its cap', async () => {
    const { obj, accepted } = doWith(MAX_SUBSCRIBERS_PER_IP, MAX_SUBSCRIBERS_PER_IP);
    const res = await obj.fetch(upgrade());
    expect(res.status).toBe(429);
    expect(await res.text()).toBe('subscriber-limit-per-ip');
    expect(accepted).toEqual([]);
  });

  it('accepts under both caps and tags the socket with its IP', async () => {
    const { obj, accepted } = doWith(MAX_SUBSCRIBERS_PER_IP, MAX_SUBSCRIBERS_PER_IP - 1);
    // Node's Response refuses status 101, which the Workers runtime allows,
    // so the handshake's final Response throws here after the accept.
    await obj.fetch(upgrade()).catch(() => undefined);
    expect(accepted).toEqual([{ tags: [`ip:${IP}`] }]);
  });
});

describe('the ingest DO reads its trigger body capped', () => {
  it.each([
    ['over the cap', 'x'.repeat(MAX_TRIGGER_BODY_BYTES + 1)],
    ['not JSON', '{nope'],
    ['not an object', '42'],
  ])('refuses a trigger body %s with 400 before any storage read', async (_label, body) => {
    const storage = vi.fn();
    vi.stubGlobal('WebSocketRequestResponsePair', class {});
    const state = {
      setWebSocketAutoResponse: () => {},
      storage: new Proxy({}, { get: () => storage }),
    };
    const obj = new ChainIngestDO(state as unknown as DurableObjectState, {} as WorkerEnv);
    const res = await obj.fetch(
      new Request('https://chain-ingest-do/trigger', { method: 'POST', body }),
    );
    expect(res.status).toBe(400);
    expect(storage).not.toHaveBeenCalled();
  });
});
