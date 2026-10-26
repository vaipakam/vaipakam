/**
 * #2755 — one fail-closed rate-limit rule, in front of every limited
 * route, and a credential budget charged per upstream call.
 *
 * The routes that spend an operator-held API key used to each carry their
 * own limiter, and most let a request through when the binding was missing
 * or threw. These cases drive the Worker's own entry point with the
 * bindings on the RAW env, the way Cloudflare delivers them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { callerBudgetFor } from '../src/index';
import type { WorkerEnv } from '../src/env';
import { CREDENTIAL_BUDGETS, slotRefusal, takeSlot, type RateLimitBinding } from '../src/rateLimit';

const ORIGIN = 'https://app.example';
const HERE = dirname(fileURLToPath(import.meta.url));

function ctx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

const allow = (): RateLimitBinding => ({ limit: async () => ({ success: true }) });
const refuse = (): RateLimitBinding => ({ limit: async () => ({ success: false }) });
const broken = (): RateLimitBinding => ({
  limit: async () => {
    throw new Error('namespace unavailable');
  },
});

/** Counts the slots a binding hands out under each key. */
function counting(): RateLimitBinding & { taken: string[] } {
  const taken: string[] = [];
  return {
    taken,
    async limit({ key }) {
      taken.push(key);
      return { success: true };
    },
  };
}

const secret = (v: string) => ({ get: async () => v });

function rawEnv(extra: Record<string, unknown> = {}): WorkerEnv {
  return { DB: {} as D1Database, FRONTEND_ORIGIN: ORIGIN, ...extra } as unknown as WorkerEnv;
}

function call(method: string, path: string, opts: { origin?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '203.0.113.7', 'content-type': 'application/json' };
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  return new Request(`https://agent.example${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  });
}

/** Every key-spending route, with the caller budget the router takes for it. */
const KEY_SPENDING: { method: string; path: string; budget: string }[] = [
  { method: 'POST', path: '/quote/1inch', budget: 'QUOTE_1INCH_RATELIMIT' },
  { method: 'POST', path: '/intent/fusion/post', budget: 'INTENT_FUSION_POST_RATELIMIT' },
  { method: 'POST', path: '/opensea/listing', budget: 'OPENSEA_LISTING_RATELIMIT' },
  { method: 'GET', path: '/opensea/collection/some-slug', budget: 'OPENSEA_COLLECTION_RATELIMIT' },
  { method: 'GET', path: `/opensea/offers/8453/0x${'11'.repeat(20)}/1`, budget: 'OPENSEA_OFFERS_RATELIMIT' },
  {
    method: 'GET',
    path: `/opensea/signed-offer/8453/0x${'11'.repeat(20)}/1/0x${'22'.repeat(32)}`,
    budget: 'OPENSEA_SIGNED_OFFER_RATELIMIT',
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('takeSlot — the one rule', () => {
  it('takes a slot only when the binding exists and answers yes', async () => {
    expect(await takeSlot(allow(), 'k')).toBe('taken');
    expect(await takeSlot(refuse(), 'k')).toBe('refused');
    expect(await takeSlot(undefined, 'k')).toBe('unconfigured');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await takeSlot(broken(), 'k')).toBe('unavailable');
  });

  it('answers each refusal by name, and nothing for a taken slot', async () => {
    expect(slotRefusal('taken', ORIGIN)).toBeNull();
    const cases = [
      ['refused', 429, 'rate-limited'],
      ['unconfigured', 503, 'rate-limit-binding-missing'],
      ['unavailable', 503, 'rate-limit-unavailable'],
    ] as const;
    for (const [outcome, status, error] of cases) {
      // The app reads a quote-proxy 503 ending in `-not-configured` as "no
      // key here"; a limiter refusal must never be mistaken for that.
      expect(error.endsWith('-not-configured')).toBe(false);
      const res = slotRefusal(outcome, ORIGIN)!;
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    }
  });
});

describe('every key-spending route at the entry point', () => {
  for (const r of KEY_SPENDING) {
    it(`${r.method} ${r.path.split('/').slice(0, 3).join('/')} is metered by ${r.budget}`, () => {
      expect(callerBudgetFor(r.method, r.path)).toBe(r.budget);
    });

    it(`${r.method} ${r.path} refuses a caller with no allowed Origin before any budget`, async () => {
      const limiter = counting();
      const res = await worker.fetch(call(r.method, r.path, { origin: null }), rawEnv({ [r.budget]: limiter }), ctx());
      expect(res.status).toBe(403);
      expect(limiter.taken).toEqual([]);
      const foreign = await worker.fetch(
        call(r.method, r.path, { origin: 'https://evil.example' }),
        rawEnv({ [r.budget]: limiter }),
        ctx(),
      );
      expect(foreign.status).toBe(403);
    });

    it(`${r.method} ${r.path} fails CLOSED on a missing or failing caller budget`, async () => {
      const missing = await worker.fetch(call(r.method, r.path), rawEnv(), ctx());
      expect(missing.status).toBe(503);
      expect(await missing.json()).toEqual({ error: 'rate-limit-binding-missing' });

      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = await worker.fetch(call(r.method, r.path), rawEnv({ [r.budget]: broken() }), ctx());
      expect(failing.status).toBe(503);
      expect(await failing.json()).toEqual({ error: 'rate-limit-unavailable' });

      const over = await worker.fetch(call(r.method, r.path), rawEnv({ [r.budget]: refuse() }), ctx());
      expect(over.status).toBe(429);
    });
  }

  it('keys the caller budget by the client IP', async () => {
    const limiter = counting();
    await worker.fetch(call('POST', '/quote/1inch'), rawEnv({ QUOTE_1INCH_RATELIMIT: limiter }), ctx());
    expect(limiter.taken).toEqual(['203.0.113.7']);
  });

  it('serves no /quote/0x: the route had no caller and was removed', async () => {
    const res = await worker.fetch(call('POST', '/quote/0x'), rawEnv({ QUOTE_1INCH_RATELIMIT: allow() }), ctx());
    expect(res.status).toBe(404);
  });

  it('meters the support ticket and the alert writes from the same table', () => {
    expect(callerBudgetFor('POST', '/support/ticket')).toBe('SUPPORT_TICKET_RATELIMIT');
    for (const [m, p] of [
      ['PUT', '/thresholds'],
      ['POST', '/link/telegram'],
      ['POST', '/unlink/telegram'],
      ['POST', '/telegram/test'],
    ]) {
      expect(callerBudgetFor(m, p)).toBe('ALERT_WRITE_RATELIMIT');
    }
    expect(callerBudgetFor('GET', '/quote/readiness')).toBeNull();
  });
});

describe('the 1inch credential budget', () => {
  const quote = {
    chainId: 8453,
    sellToken: `0x${'aa'.repeat(20)}`,
    buyToken: `0x${'bb'.repeat(20)}`,
    sellAmount: '1000',
    taker: `0x${'cc'.repeat(20)}`,
  };

  it('takes one slot per upstream call, under the one key-wide bucket', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ dstAmount: '1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const budget = counting();
    const res = await worker.fetch(
      call('POST', '/quote/1inch', { body: quote }),
      rawEnv({ QUOTE_1INCH_RATELIMIT: allow(), ONEINCH_UPSTREAM_RATELIMIT: budget, ONEINCH_API_KEY: secret('k') }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(budget.taken).toEqual(['oneinch']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('spends nothing upstream when the budget refuses or is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const spent = await worker.fetch(
      call('POST', '/quote/1inch', { body: quote }),
      rawEnv({ QUOTE_1INCH_RATELIMIT: allow(), ONEINCH_UPSTREAM_RATELIMIT: refuse(), ONEINCH_API_KEY: secret('k') }),
      ctx(),
    );
    expect(spent.status).toBe(429);
    expect(await spent.json()).toEqual({ error: 'upstream-quota' });
    const missing = await worker.fetch(
      call('POST', '/quote/1inch', { body: quote }),
      rawEnv({ QUOTE_1INCH_RATELIMIT: allow(), ONEINCH_API_KEY: secret('k') }),
      ctx(),
    );
    expect(missing.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the OpenSea offers walk is charged as spent', () => {
  const path = `/opensea/offers/8453/0x${'11'.repeat(20)}/7`;

  it('charges one slot for an NFT OpenSea does not know, not the worst case', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    const budget = counting();
    const res = await worker.fetch(
      call('GET', path),
      rawEnv({ OPENSEA_OFFERS_RATELIMIT: allow(), OPENSEA_UPSTREAM_RATELIMIT: budget, OPENSEA_API_KEY: secret('k') }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(budget.taken).toEqual(['opensea']);
  });

  it('stops a walk the budget cannot pay for and says the list is truncated', async () => {
    // Slug lookup, then page 1 of each leg with a `next` cursor; the
    // budget admits three calls and refuses the rest.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/contract/')
          ? new Response(JSON.stringify({ nft: { collection: 'c' } }), { status: 200 })
          : new Response(JSON.stringify({ offers: [{ id: url }], next: 'more' }), { status: 200 }),
      ),
    );
    let left = 3;
    const budget: RateLimitBinding = { limit: async () => ({ success: left-- > 0 }) };
    const res = await worker.fetch(
      call('GET', path),
      rawEnv({ OPENSEA_OFFERS_RATELIMIT: allow(), OPENSEA_UPSTREAM_RATELIMIT: budget, OPENSEA_API_KEY: secret('k') }),
      ctx(),
    );
    const body = (await res.json()) as Record<string, { status: number; truncated: boolean } | null>;
    expect(body.collection_offers?.truncated).toBe(true);
    expect(body.item_offers?.truncated).toBe(true);
    expect(body.collection_offers?.status).toBe(200);
    expect(body.collection_offers).toMatchObject({ stoppedBy: 'upstream-quota' });
  });

  it('marks every partial walk truncated, not only a budget refusal', async () => {
    // Every slot taken. The collection leg hits the page ceiling (3 by
    // default) with a cursor still left; the item leg's second page fails.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/contract/')) return new Response(JSON.stringify({ nft: { collection: 'c' } }), { status: 200 });
        if (url.includes('/nfts/') && url.includes('next=')) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ offers: [{ id: url }], next: 'more' }), { status: 200 });
      }),
    );
    const res = await worker.fetch(
      call('GET', path),
      rawEnv({ OPENSEA_OFFERS_RATELIMIT: allow(), OPENSEA_UPSTREAM_RATELIMIT: allow(), OPENSEA_API_KEY: secret('k') }),
      ctx(),
    );
    const body = (await res.json()) as Record<string, { status: number; truncated: boolean; stoppedBy?: string } | null>;
    expect(body.collection_offers).toMatchObject({ status: 200, truncated: true });
    expect(body.item_offers).toMatchObject({ status: 200, truncated: true });
    expect(body.collection_offers?.stoppedBy).toBeUndefined();
  });

  it('does not mark a walk that reached the last page truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/contract/')
          ? new Response(JSON.stringify({ nft: { collection: 'c' } }), { status: 200 })
          : new Response(JSON.stringify({ offers: [], next: null }), { status: 200 }),
      ),
    );
    const res = await worker.fetch(
      call('GET', path),
      rawEnv({ OPENSEA_OFFERS_RATELIMIT: allow(), OPENSEA_UPSTREAM_RATELIMIT: allow(), OPENSEA_API_KEY: secret('k') }),
      ctx(),
    );
    const body = (await res.json()) as Record<string, { truncated: boolean } | null>;
    expect(body.collection_offers?.truncated).toBe(false);
    expect(body.item_offers?.truncated).toBe(false);
  });

  it('reports a limiter that cannot count on a leg as 503, never as a spent budget', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ nft: { collection: 'c' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    // The slug lookup's slot is taken; every slot after it throws.
    let calls = 0;
    const budget: RateLimitBinding = {
      limit: async () => {
        if (calls++ === 0) return { success: true };
        throw new Error('limiter down');
      },
    };
    const res = await worker.fetch(
      call('GET', path),
      rawEnv({ OPENSEA_OFFERS_RATELIMIT: allow(), OPENSEA_UPSTREAM_RATELIMIT: budget, OPENSEA_API_KEY: secret('k') }),
      ctx(),
    );
    const body = (await res.json()) as Record<string, { status: number; stoppedBy?: string } | null>;
    for (const leg of [body.collection_offers, body.item_offers]) {
      expect(leg).toMatchObject({ status: 503, stoppedBy: 'rate-limit-unavailable', truncated: false });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('wrangler.jsonc declares every limiter the code reads', () => {
  // A missing binding refuses its route, so a binding named in code and
  // absent from the config is a route that is always down; one declared
  // and never read is a budget that guards nothing.
  const wrangler = readFileSync(resolve(HERE, '..', 'wrangler.jsonc'), 'utf8');
  const declared = new Set([...wrangler.matchAll(/"name":\s*"([A-Z0-9_]+_RATELIMIT)"/g)].map((m) => m[1]));
  const envSrc = readFileSync(resolve(HERE, '..', 'src', 'env.ts'), 'utf8');
  const typed = new Set([...envSrc.matchAll(/^\s+([A-Z0-9_]+_RATELIMIT)\?: RateLimitBinding;/gm)].map((m) => m[1]));

  it('the two sets are the same', () => {
    expect(typed.size).toBeGreaterThan(5);
    expect([...declared].sort()).toEqual([...typed].sort());
  });

  it('covers every caller and credential budget the router and handlers take', () => {
    for (const r of KEY_SPENDING) expect(declared).toContain(r.budget);
    for (const b of Object.values(CREDENTIAL_BUDGETS)) expect(declared).toContain(b);
    for (const b of ['ALERT_WRITE_RATELIMIT', 'SUPPORT_TICKET_RATELIMIT', 'DIAG_RECORD_RATELIMIT', 'SIG_VERIFY_RATELIMIT']) {
      expect(declared).toContain(b);
    }
  });

  it('no source file keeps a limiter of its own', () => {
    // The only `.limit(` call in the Worker is the one in rateLimit.ts.
    const src = resolve(HERE, '..', 'src');
    const files = readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'rateLimit.ts');
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      expect(readFileSync(resolve(src, f), 'utf8'), f).not.toMatch(/\.limit\(\s*\{/);
    }
  });
});
