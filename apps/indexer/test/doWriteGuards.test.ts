/**
 * Free-plan DO rows_written diet — the trigger/loop-state WRITE GUARDS,
 * pinned. Every DO storage put/delete bills a row (deletes too), and the
 * steady-state cron ping used to spend ~4 unconditional rows per chain
 * per minute writing values that never changed. These tests pin the
 * contract that an IDLE ping performs ZERO storage writes while every
 * genuinely-changed value still lands (batched into one put).
 */
import { describe, expect, it } from 'vitest';
import {
  clearAttempts,
  rearmOrFinishAttempts,
  recordTrigger,
  type AlarmStorage,
} from '../src/chainIngestDO';
import { shouldRunCronTick } from '../src/cronRouting';

/** Map-backed fake that counts billed operations. */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  const ops = { puts: 0, rowsPut: 0, deletes: 0 };
  const alarms: number[] = [];
  const storage: AlarmStorage = {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(entries: Record<string, unknown>) {
      ops.puts += 1;
      for (const [k, v] of Object.entries(entries)) {
        map.set(k, v);
        ops.rowsPut += 1;
      }
    },
    async delete(key: string) {
      ops.deletes += 1;
      return map.delete(key);
    },
    async setAlarm(t: number) {
      alarms.push(t);
    },
  };
  return { map, ops, alarms, storage };
}

describe('recordTrigger (write-guarded trigger state)', () => {
  it('an idle cron ping (target 0, chainId known, attempts absent) writes NOTHING', async () => {
    const { ops, storage } = fakeStorage({ chainId: 84532 });
    await recordTrigger(storage, 84532, 0n, true);
    expect(ops).toEqual({ puts: 0, rowsPut: 0, deletes: 0 });
  });

  it('first contact writes chainId (and nothing else for a zero target)', async () => {
    const { map, ops, storage } = fakeStorage();
    await recordTrigger(storage, 84532, 0n, true);
    expect(map.get('chainId')).toBe(84532);
    // target '0' equals the implicit default — pendingTarget key never
    // materializes; attempts stays absent (absent already reads as 0).
    expect(map.has('pendingTarget')).toBe(false);
    expect(map.has('attempts')).toBe(false);
    expect(ops.puts).toBe(1); // one batched put
  });

  it('a raised webhook target writes pendingTarget; a lower one does not', async () => {
    const { map, ops, storage } = fakeStorage({ chainId: 84532, pendingTarget: '100' });
    await recordTrigger(storage, 84532, 250n, true);
    expect(map.get('pendingTarget')).toBe('250');
    await recordTrigger(storage, 84532, 200n, true); // lower — monotonic, no write
    expect(map.get('pendingTarget')).toBe('250');
    expect(ops.puts).toBe(1);
  });

  it('resets a STALE nonzero attempts counter, batched with other changes', async () => {
    const { map, ops, storage } = fakeStorage({ chainId: 84532, attempts: 7 });
    await recordTrigger(storage, 84532, 50n, true);
    expect(map.get('attempts')).toBe(0);
    expect(map.get('pendingTarget')).toBe('50');
    expect(ops.puts).toBe(1); // both keys in ONE put
  });

  it('never touches attempts while a scan is live (resetAttempts=false)', async () => {
    const { map, ops, storage } = fakeStorage({ chainId: 84532, attempts: 3 });
    await recordTrigger(storage, 84532, 0n, false);
    expect(map.get('attempts')).toBe(3);
    expect(ops.puts).toBe(0);
  });
});

describe('clearAttempts (guarded loop-state clear)', () => {
  it('skips the delete when the key is already absent (the every-quiet-tick path)', async () => {
    const { ops, storage } = fakeStorage();
    await clearAttempts(storage);
    expect(ops.deletes).toBe(0);
  });

  it('deletes when the counter exists', async () => {
    const { map, ops, storage } = fakeStorage({ attempts: 4 });
    await clearAttempts(storage);
    expect(map.has('attempts')).toBe(false);
    expect(ops.deletes).toBe(1);
  });
});

describe('rearmOrFinishAttempts (fast lane → slow lane → cron backstop, Codex #1357 r1)', () => {
  const NOW = 1_000_000;

  it('fast lane: re-arms at 3s while under the fast budget', async () => {
    const { map, alarms, storage } = fakeStorage();
    await rearmOrFinishAttempts(storage, 0, NOW);
    expect(map.get('attempts')).toBe(1);
    expect(alarms).toEqual([NOW + 3_000]);
  });

  it('slow lane: past the fast budget an unmet target keeps self-driving at 30s — never parks a webhook on the 5-min cron', async () => {
    const { map, alarms, storage } = fakeStorage({ attempts: 11 });
    await rearmOrFinishAttempts(storage, 11, NOW); // next = 12 = fast budget spent
    expect(map.get('attempts')).toBe(12);
    expect(alarms).toEqual([NOW + 30_000]);
  });

  it('cron backstop: both budgets spent → clears the counter, arms nothing', async () => {
    const { map, alarms, ops, storage } = fakeStorage({ attempts: 31 });
    await rearmOrFinishAttempts(storage, 31, NOW); // next = 32 = 12 fast + 20 slow
    expect(map.has('attempts')).toBe(false);
    expect(alarms).toEqual([]);
    expect(ops.deletes).toBe(1);
  });
});

describe('shouldRunCronTick (scheduled-time routing — single trigger, 5-per-account cap)', () => {
  // 2026-07-19T03:05:00Z / 03:07:00Z — minute divisible by 5, and not.
  const AT_05 = Date.UTC(2026, 6, 19, 3, 5, 0);
  const AT_07 = Date.UTC(2026, 6, 19, 3, 7, 0);

  it('DO path acts only on minutes divisible by 5', () => {
    expect(shouldRunCronTick(AT_05, true)).toBe(true);
    expect(shouldRunCronTick(AT_07, true)).toBe(false);
    // Scheduled time, not run time: a late-firing :05 tick still acts.
    expect(shouldRunCronTick(AT_05, true)).toBe(true);
  });

  it('legacy rollback acts on EVERY minute tick (N×1min freshness preserved)', () => {
    expect(shouldRunCronTick(AT_05, false)).toBe(true);
    expect(shouldRunCronTick(AT_07, false)).toBe(true);
  });

  it('an absent/unparseable scheduled time runs in BOTH modes (fail-open — a doubled tick is idempotent, a never-running tick is an outage)', () => {
    for (const doPath of [true, false]) {
      expect(shouldRunCronTick(undefined, doPath)).toBe(true);
      expect(shouldRunCronTick(Number.NaN, doPath)).toBe(true);
    }
  });
});
