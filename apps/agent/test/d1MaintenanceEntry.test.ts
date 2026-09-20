/**
 * The entry-point half of the D1 maintenance barrier (#2239).
 *
 * The barrier itself is the absent `d1_databases` binding — capability
 * removal, not a check, which is why no test here can prove it. What IS
 * testable, and is what these cases pin, is the Worker's behaviour once the
 * binding is gone: it must refuse at the entrance, in one place, with an
 * answer that says the write did not happen.
 *
 * Both cases would pass trivially if the checks were deleted and the routes
 * simply threw, so each asserts the OBSERVABLE consequence — a 503 rather than
 * an exception, and zero passes launched rather than a dozen that each fail on
 * their own.
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
  it('answers 503 and says nothing was recorded', async () => {
    const res = await worker.fetch(
      new Request('https://agent.example/thresholds', { method: 'PUT' }),
      NO_BINDINGS,
      fakeCtx(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
    const body = await res.text();
    // The part that matters on a funds-adjacent surface: the caller is told
    // the write did not land. A bare 500 leaves them unable to tell a refused
    // write from a half-applied one.
    expect(body).toContain('nothing you sent has been recorded');
  });

  it('refuses a route that touches no database, deliberately', async () => {
    // The aggregator quote proxy reads no D1. It is refused anyway, because
    // the alternative is a hand-maintained list of which routes touch the
    // database — the enumeration the whole mechanism exists to replace. This
    // case exists so that the cost is recorded rather than discovered.
    const res = await worker.fetch(
      new Request('https://agent.example/quote/0x?chainId=84532'),
      NO_BINDINGS,
      fakeCtx(),
    );
    expect(res.status).toBe(503);
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
    // Not "the passes failed" — they never started. A tick that launches a
    // dozen continuations to have each discover the same refusal costs a
    // dozen log lines and tells the operator nothing the first one did not.
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(' ')).toContain('did NOT run');
    expect(warn.mock.calls[0]?.join(' ')).toContain('nothing was written');
  });
});
