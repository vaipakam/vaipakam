/**
 * The keeper's half of the D1 maintenance barrier (#2239).
 *
 * The barrier is the absent `d1_databases` binding — capability removal, which
 * no test can prove. This pins the consequence: the tick declines at the
 * entrance instead of launching every pass to discover the refusal separately.
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduled, on a build with no D1 binding', () => {
  it('launches NO passes and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: '* * * * *' } as ScheduledController,
      NO_BINDINGS,
      ctx,
    );

    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(' ')).toContain('did NOT run');
    // The check sits ABOVE the per-tick chain roll-call, so a maintenance
    // tick does not also print a chain list for work it is not going to do —
    // and it never reaches `resolveEnv`, so it spends no Secrets Store reads.
    expect(log).not.toHaveBeenCalled();
  });
});
