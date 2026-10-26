/**
 * The alert-write limiter reaches the routes it guards (#2754, Codex r1).
 *
 * The first cut declared `ALERT_WRITE_RATELIMIT` in wrangler.jsonc and read
 * it in the router, but `resolveEnv` copied bindings field by field and left
 * this one off, so the deployed gate always saw "no limiter" and let every
 * request through. These cases go through the Worker's own entry point with
 * the binding on the RAW env, the way Cloudflare delivers it.
 */
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resolveEnv, type WorkerEnv } from '../src/env';

const ORIGIN = 'https://app.example';

function ctx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function rawEnv(allow: boolean): { env: WorkerEnv; keys: string[] } {
  const keys: string[] = [];
  const env = {
    DB: {} as D1Database,
    FRONTEND_ORIGIN: ORIGIN,
    ALERT_WRITE_RATELIMIT: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: allow };
      },
    },
  } as unknown as WorkerEnv;
  return { env, keys };
}

describe('ALERT_WRITE_RATELIMIT at the entry point', () => {
  for (const [method, path] of [
    ['PUT', '/thresholds'],
    ['POST', '/link/telegram'],
    ['POST', '/unlink/telegram'],
    ['POST', '/telegram/test'],
  ] as const) {
    it(`refuses ${method} ${path} with 429 when the limiter says no, keyed by the caller's IP`, async () => {
      const { env, keys } = rawEnv(false);
      const res = await worker.fetch(
        new Request(`https://agent.example${path}`, {
          method,
          headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7', 'content-type': 'application/json' },
          body: '{}',
        }),
        env,
        ctx(),
      );
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate-limited' });
      expect(keys).toEqual(['203.0.113.7']);
    });
  }

  it('lets the request on to its handler when the limiter allows it', async () => {
    const { env, keys } = rawEnv(true);
    const res = await worker.fetch(
      new Request('https://agent.example/thresholds', {
        method: 'PUT',
        headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7', 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
      ctx(),
    );
    expect(keys).toHaveLength(1);
    // The handler's own answer to an empty body, not the limiter's.
    expect(res.status).toBe(400);
  });
});

describe('resolveEnv', () => {
  it('passes every non-secret binding through, not a hand-kept subset', async () => {
    // A binding the env types do not list yet still arrives; that is what
    // makes a forgotten copy impossible rather than merely unlikely.
    const marker = { limit: async () => ({ success: true }) };
    const resolved = await resolveEnv({
      FRONTEND_ORIGIN: ORIGIN,
      ALERT_WRITE_RATELIMIT: marker,
      SOME_FUTURE_BINDING: 'kept',
    } as unknown as WorkerEnv);
    expect(resolved.ALERT_WRITE_RATELIMIT).toBe(marker);
    expect((resolved as unknown as Record<string, unknown>).SOME_FUTURE_BINDING).toBe('kept');
  });

  it('never passes a secret binding through unresolved', async () => {
    const resolved = await resolveEnv({
      FRONTEND_ORIGIN: ORIGIN,
      TG_BOT_TOKEN: { get: async () => 'resolved-token' },
    } as unknown as WorkerEnv);
    expect(resolved.TG_BOT_TOKEN).toBe('resolved-token');
  });
});
