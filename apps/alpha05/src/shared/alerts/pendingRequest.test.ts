import { describe, expect, it } from 'vitest';
import { clearPending, keepPending, loadPending, parsePending, pendingExpiresAt, pendingStorageKey, PENDING_MAX_AGE_S, type PendingAlert, type PendingStore } from './pendingRequest';

const W = '0xAbCdEf0000000000000000000000000000000001' as const;
const KEY = `0x${'ab'.repeat(32)}` as const;

function memory(): PendingStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

describe('a pending alert request (#3836)', () => {
  const p: PendingAlert = { action: { save: { dueDateReminders: false } }, issuedAt: 1_000, requestKey: KEY };

  it('is kept per network and wallet, and read back as kept', () => {
    const s = memory();
    keepPending(84532, W, p, s);
    expect([...s.map.keys()]).toEqual([pendingStorageKey(84532, W.toLowerCase())]);
    expect(loadPending(84532, W, 2_000, s)).toEqual(p);
    expect(loadPending(421614, W, 2_000, s)).toBeNull();
  });

  it('lasts seven days from the time it names, then is dropped', () => {
    const s = memory();
    keepPending(84532, W, p, s);
    expect(PENDING_MAX_AGE_S).toBe(7 * 24 * 60 * 60);
    expect(loadPending(84532, W, pendingExpiresAt(p), s)).toEqual(p);
    expect(loadPending(84532, W, pendingExpiresAt(p) + 1, s)).toBeNull();
    expect(s.map.size).toBe(0);
  });

  it('reads a kept request strictly', () => {
    expect(parsePending(JSON.stringify(p))).toEqual(p);
    expect(parsePending(JSON.stringify({ ...p, requestKey: KEY.toUpperCase() }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...p, action: 'mint' }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...p, action: { save: {}, extra: 1 } }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...p, issuedAt: 1.5 }))).toBeNull();
    expect(parsePending('not json')).toBeNull();
  });

  it('drops an unreadable one, and is forgotten on request', () => {
    const s = memory();
    s.map.set(pendingStorageKey(84532, W), '{}');
    expect(loadPending(84532, W, 2_000, s)).toBeNull();
    expect(s.map.size).toBe(0);
    keepPending(84532, W, p, s);
    clearPending(84532, W, s);
    expect(loadPending(84532, W, 2_000, s)).toBeNull();
  });

  it('runs without storage', () => {
    expect(() => keepPending(84532, W, p, null)).not.toThrow();
    expect(loadPending(84532, W, 2_000, null)).toBeNull();
  });
});
