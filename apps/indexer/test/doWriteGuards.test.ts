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
  recordTrigger,
  type LoopStateStorage,
} from '../src/chainIngestDO';

/** Map-backed fake that counts billed operations. */
function fakeStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed));
  const ops = { puts: 0, rowsPut: 0, deletes: 0 };
  const storage: LoopStateStorage = {
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
  };
  return { map, ops, storage };
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
