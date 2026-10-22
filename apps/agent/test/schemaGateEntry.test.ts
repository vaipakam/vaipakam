/**
 * The agent's shared-D1 schema gate at the scheduled entry point (#2410).
 *
 * The agent auto-deploys on merge, so a build can reach an isolate before the
 * indexer's deploy has applied the migrations it carries. These cases pin the
 * observable consequence: a tick against a database missing a migration
 * launches NO pass and says which migration is missing; a tick against a
 * database that records every migration launches the passes as before.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { SHARED_D1_MIGRATIONS } from '@vaipakam/lib/d1SchemaGate';
import type { WorkerEnv } from '../src/env';

function fakeCtx(): ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> } {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

/** A D1 whose `d1_migrations` holds exactly `names`. Every other statement
 *  answers empty, which is enough for the passes to start and settle. */
function dbRecording(names: readonly string[]): D1Database {
  const stmt = (sql: string) => {
    const s = {
      bind: () => s,
      all: async () => ({
        results: /d1_migrations/.test(sql) ? names.map((name) => ({ name })) : [],
      }),
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
    };
    return s;
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async () => [],
  } as unknown as D1Database;
}

// A minute the agent's five-minute cadence (#2236) acts on. `Date.now()`
// passed only one run in five: on the other four the tick returns before the
// gate is asked, and the cases below would be testing the cadence instead.
const CONTROLLER = { scheduledTime: Date.UTC(2026, 9, 22, 8, 0, 0), cron: '* * * * *' } as ScheduledController;

// The first import transforms the whole Worker; pay that once, outside the
// per-case timeout. Later imports reuse the transform.
beforeAll(async () => {
  await import('../src/index');
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** A fresh module per case: the gate caches `current` for its isolate. */
async function loadWorker() {
  return (await import('../src/index')).default;
}

describe('scheduled, against the shared database schema', () => {
  it('declines the whole tick, by name, while a migration is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missing = SHARED_D1_MIGRATIONS[SHARED_D1_MIGRATIONS.length - 1]!;
    const worker = await loadWorker();
    const ctx = fakeCtx();
    await worker.scheduled(
      CONTROLLER,
      { DB: dbRecording(SHARED_D1_MIGRATIONS.slice(0, -1)) } as WorkerEnv,
      ctx,
    );
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const line = warn.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('declined'));
    expect(line).toContain('[vaipakam-agent] this tick declined');
    expect(line).toContain(missing);
  });

  it('declines when the migration record cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worker = await loadWorker();
    const ctx = fakeCtx();
    const broken = {
      prepare: () => ({
        all: async () => {
          throw new Error('no such table: d1_migrations');
        },
      }),
    } as unknown as D1Database;
    await worker.scheduled(CONTROLLER, { DB: broken } as WorkerEnv, ctx);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(
      'could not confirm this build',
    );
  });

  it('launches the passes once every migration is recorded', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = await loadWorker();
    const ctx = fakeCtx();
    await worker.scheduled(
      CONTROLLER,
      { DB: dbRecording(SHARED_D1_MIGRATIONS) } as WorkerEnv,
      ctx,
    );
    expect(ctx.waitUntil.mock.calls.length).toBeGreaterThan(0);
    // Let the launched passes settle so none outlives the test.
    await Promise.allSettled(ctx.waitUntil.mock.calls.map((c) => c[0]));
  });
});
