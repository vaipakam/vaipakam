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
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(' ')).toContain('did NOT run');
  });

  it('does NOT reach out to the ingest DOs — the root fix for the r9–r11 seam', async () => {
    // #2252 r11. For one round this branch woke every chain's Durable Object
    // so its alarm would close inherited sockets. Three rounds running found a
    // different path by which that wake missed sockets, and the last of them
    // was the tell: reaching every DO without resolving a secret required a
    // hand-kept list of chain ids beside the real one — the unfinishable
    // enumeration this whole change exists to stop writing, one level down.
    //
    // It bought latency, not correctness. `railHealth` demotes the rail on the
    // client once the last cursor-carrying frame OR the last cursor advance
    // falls outside `cadenceSec × 1.5`, and an auto-answered `ping` refreshes
    // neither — so a held-open socket goes unhealthy on its own, on a bound
    // that is client-side and measured. This case pins the deletion so the
    // wake is not reintroduced as an obvious-looking improvement.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reached: string[] = [];
    const env = {
      CHAIN_INGEST_DO: {
        idFromName: (name: string) => name,
        get: (name: string) => {
          reached.push(String(name));
          return { fetch: () => Promise.resolve(new Response('ok')) };
        },
      },
    } as unknown as WorkerEnv;
    const ctx = fakeCtx();

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '* * * * *' } as ScheduledController,
      env,
      ctx,
    );

    expect(reached).toEqual([]);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
