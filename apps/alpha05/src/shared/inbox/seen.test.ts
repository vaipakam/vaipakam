import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markSeen, readSeen, seenKey } from './seen';

const A = '0x00000000000000000000000000000000000000Aa' as const;

describe('the seen record', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });

  it('is per network and wallet, and only moves forward', () => {
    expect(readSeen(84532, A)).toBe(0);
    markSeen(84532, A, 9);
    markSeen(84532, A, 4);
    expect(readSeen(84532, A)).toBe(9);
    expect(readSeen(421614, A)).toBe(0);
    expect(store.get(seenKey(84532, A))).toBe('9');
  });

  it('ignores a stored value it cannot read', () => {
    store.set(seenKey(97, A), 'soon');
    expect(readSeen(97, A)).toBe(0);
  });
});
