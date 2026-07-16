import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isNewer,
  isUnread,
  loadLastSeen,
  storeLastSeen,
  type SeenCursor,
} from './notifSeen';

/**
 * #1213 — the notification read-state comparator + per-wallet cursor
 * store. These are the load-bearing bits of the client-side read model:
 * a wrong comparison mis-counts the unread badge, and a regressing write
 * would re-surface already-seen rows.
 */

describe('isNewer / isUnread (chain-order comparison)', () => {
  it('orders by block first, then logIndex', () => {
    expect(isNewer({ block: 200, logIndex: 0 }, { block: 100, logIndex: 9 })).toBe(true);
    expect(isNewer({ block: 100, logIndex: 2 }, { block: 100, logIndex: 1 })).toBe(true);
    expect(isNewer({ block: 100, logIndex: 1 }, { block: 100, logIndex: 1 })).toBe(false);
    expect(isNewer({ block: 100, logIndex: 1 }, { block: 100, logIndex: 2 })).toBe(false);
  });

  it('treats every row as unread when there is no cursor yet', () => {
    expect(isUnread({ blockNumber: 1, logIndex: 0 }, null)).toBe(true);
  });

  it('marks a row unread only when strictly newer than the cursor', () => {
    const seen: SeenCursor = { block: 100, logIndex: 1 };
    expect(isUnread({ blockNumber: 100, logIndex: 2 }, seen)).toBe(true); // newer
    expect(isUnread({ blockNumber: 100, logIndex: 1 }, seen)).toBe(false); // equal → read
    expect(isUnread({ blockNumber: 99, logIndex: 9 }, seen)).toBe(false); // older
  });

  it('treats a row with no chain-order key as read (cannot inflate the badge)', () => {
    expect(isUnread({ blockNumber: null, logIndex: 5 }, null)).toBe(false);
    expect(isUnread({ blockNumber: 5, logIndex: null }, null)).toBe(false);
  });
});

describe('storeLastSeen / loadLastSeen (per-wallet cursor)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const CHAIN = 84532;
  const WALLET = '0x00000000000000000000000000000000000000AA';

  it('round-trips a cursor scoped to (chain, wallet-lowercased)', () => {
    expect(loadLastSeen(CHAIN, WALLET)).toBeNull();
    storeLastSeen(CHAIN, WALLET, { block: 200, logIndex: 1 });
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 200, logIndex: 1 });
    // Case-insensitive on the wallet — a checksummed vs lowercased address
    // must resolve to the same cursor.
    expect(loadLastSeen(CHAIN, WALLET.toLowerCase())).toEqual({ block: 200, logIndex: 1 });
    // Scoped per chain — another chain is independent.
    expect(loadLastSeen(1, WALLET)).toBeNull();
  });

  it('never regresses the cursor to an older position', () => {
    storeLastSeen(CHAIN, WALLET, { block: 200, logIndex: 1 });
    storeLastSeen(CHAIN, WALLET, { block: 100, logIndex: 0 }); // older → ignored
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 200, logIndex: 1 });
    storeLastSeen(CHAIN, WALLET, { block: 201, logIndex: 0 }); // newer → advances
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 201, logIndex: 0 });
  });

  it('ignores a malformed stored value', () => {
    store.set(`alpha02.notif.lastseen.${CHAIN}.${WALLET.toLowerCase()}`, 'not-json');
    expect(loadLastSeen(CHAIN, WALLET)).toBeNull();
  });
});
