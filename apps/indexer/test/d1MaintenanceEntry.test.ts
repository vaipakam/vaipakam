/**
 * The indexer's half of the D1 maintenance barrier (#2239).
 *
 * The barrier is the absent `d1_databases` binding — capability removal, which
 * no test can prove. This pins the consequence at this Worker's two entry
 * points, and this Worker is the one where the blunt rule earns itself: its
 * read-API answers FROM the database, so during a binding move there is
 * nothing truthful for it to serve.
 *
 * There is a test per Worker rather than one shared case, because each Worker
 * carries its own entry check and the failure worth catching is ONE of them
 * losing it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index';
import type { WorkerEnv } from '../src/env';

/** An env with every binding absent — which is what a maintenance build has. */
const NO_BINDINGS = {} as WorkerEnv;

function fakeCtx(): ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> } {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetch, on a build with no D1 binding', () => {
  it('answers 503 on a read route rather than serving rows from a database being moved', async () => {
    const res = await worker.fetch(
      new Request('https://indexer.example/loans?chain=84532'),
      NO_BINDINGS,
      fakeCtx(),
    );
    expect(res.status).toBe(503);
    // NO `Retry-After` (#2252 r10) — the Worker cannot know how long a
    // maintenance window lasts, so it does not pretend to.
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.text()).toContain('nothing you read here would be current');
  });

  it('carries the CORS policy, so a browser can actually READ the refusal', async () => {
    // #2252 r3 P1. Same reasoning as the agent's case; this Worker's CORS is
    // open (T-041), so the header is `*` whatever the route.
    const res = await worker.fetch(
      new Request('https://indexer.example/loans?chain=84532', {
        headers: { Origin: 'https://app.example' },
      }),
      NO_BINDINGS,
      fakeCtx(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const pre = await worker.fetch(
      new Request('https://indexer.example/loans?chain=84532', {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example' },
      }),
      NO_BINDINGS,
      fakeCtx(),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses the routes dispatched BEFORE resolveEnv too', async () => {
    // The chain-event webhook and the WebSocket upgrade both run ahead of the
    // env resolution, which is exactly why the check sits above them: they
    // were the paths that would otherwise reach an absent binding directly.
    const hook = await worker.fetch(
      new Request('https://indexer.example/hooks/chain-event?chain=84532', {
        method: 'POST',
        body: '{}',
      }),
      NO_BINDINGS,
      fakeCtx(),
    );
    expect(hook.status).toBe(503);

    const ws = await worker.fetch(
      new Request('https://indexer.example/ws/chain/84532', {
        headers: { Upgrade: 'websocket' },
      }),
      NO_BINDINGS,
      fakeCtx(),
    );
    // A socket accepted now would be fed by an ingest lane that is not
    // running — the "live socket, stale data" state that route guards against
    // for its own reasons.
    expect(ws.status).toBe(503);
  });
});

describe('scheduled, on a build with no D1 binding', () => {
  it('launches NO passes and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = fakeCtx();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '* * * * *' } as ScheduledController,
      NO_BINDINGS,
      ctx,
    );
    // No DO namespace on this env, so nothing is woken either — the only
    // `waitUntil` work this branch can schedule is the socket wake below.
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(' ')).toContain('did NOT run');
  });

  it('WAKES each chain DO so it drops its sockets, even with no alarm pending', async () => {
    // #2252 r10. The alarm closes its sockets when it declines — but only if
    // an alarm is pending, and after a caught-up scan there is none. That is
    // the common idle state, and this tick is what would normally have pinged
    // them. Without the wake, inherited sockets keep auto-answering `ping` and
    // a client goes on presenting a stopped ingest rail as healthy until its
    // 450s cursor timeout.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetches: string[] = [];
    const stub = {
      fetch: (_u: string, init?: { body?: string }) => {
        fetches.push(String(init?.body));
        return Promise.resolve(new Response('ok'));
      },
    };
    const env = {
      CHAIN_INGEST_DO: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    } as unknown as WorkerEnv;
    const ctx = fakeCtx();

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '* * * * *' } as ScheduledController,
      env,
      ctx,
    );

    // One wake per known chain id — deliberately the full superset rather
    // than the configured set, because learning which chains are configured
    // would mean resolving the secrets this branch exists to skip.
    expect(ctx.waitUntil).toHaveBeenCalled();
    await Promise.all(ctx.waitUntil.mock.calls.map((c) => c[0]));
    expect(fetches.length).toBeGreaterThan(0);
    // A trigger POST is what arms the immediate alarm that does the closing,
    // so the shape matters: target 0, the chain's own id.
    expect(JSON.parse(fetches[0]!)).toMatchObject({ targetBlock: '0' });
  });
});
