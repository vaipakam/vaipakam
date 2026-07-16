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
  it('orders by block, then logIndex, then id', () => {
    expect(isNewer({ block: 200, logIndex: 0, id: 1 }, { block: 100, logIndex: 9, id: 9 })).toBe(true);
    expect(isNewer({ block: 100, logIndex: 2, id: 1 }, { block: 100, logIndex: 1, id: 9 })).toBe(true);
    // Same (block, logIndex) — the id breaks the tie (Codex #1295 r1).
    expect(isNewer({ block: 100, logIndex: 1, id: 5 }, { block: 100, logIndex: 1, id: 4 })).toBe(true);
    expect(isNewer({ block: 100, logIndex: 1, id: 4 }, { block: 100, logIndex: 1, id: 4 })).toBe(false);
    expect(isNewer({ block: 100, logIndex: 1, id: 3 }, { block: 100, logIndex: 1, id: 4 })).toBe(false);
  });

  it('treats every row as unread when there is no cursor yet', () => {
    expect(isUnread({ blockNumber: 1, logIndex: 0, id: 1 }, null)).toBe(true);
  });

  it('marks a row unread only when strictly newer than the cursor', () => {
    const seen: SeenCursor = { block: 100, logIndex: 1, id: 4 };
    expect(isUnread({ blockNumber: 100, logIndex: 2, id: 1 }, seen)).toBe(true); // newer log
    expect(isUnread({ blockNumber: 100, logIndex: 1, id: 4 }, seen)).toBe(false); // equal → read
    expect(isUnread({ blockNumber: 99, logIndex: 9, id: 9 }, seen)).toBe(false); // older block
  });

  it('pages a same-log fan-out by id (an InternalMatchExecuted leg group)', () => {
    // Cursor sits on leg id=5 at (500,7); a sibling leg id=6 at the SAME
    // (block, logIndex) must still read as unread — the whole point of the
    // id tiebreak, matching the indexer feed's keyset.
    const seen: SeenCursor = { block: 500, logIndex: 7, id: 5 };
    expect(isUnread({ blockNumber: 500, logIndex: 7, id: 6 }, seen)).toBe(true);
    expect(isUnread({ blockNumber: 500, logIndex: 7, id: 4 }, seen)).toBe(false);
  });

  it('treats a row with no chain-order key as read (cannot inflate the badge)', () => {
    expect(isUnread({ blockNumber: null, logIndex: 5, id: 1 }, null)).toBe(false);
    expect(isUnread({ blockNumber: 5, logIndex: null, id: 1 }, null)).toBe(false);
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
    storeLastSeen(CHAIN, WALLET, { block: 200, logIndex: 1, id: 42 });
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 200, logIndex: 1, id: 42 });
    // Case-insensitive on the wallet — a checksummed vs lowercased address
    // must resolve to the same cursor.
    expect(loadLastSeen(CHAIN, WALLET.toLowerCase())).toEqual({ block: 200, logIndex: 1, id: 42 });
    // Scoped per chain — another chain is independent.
    expect(loadLastSeen(1, WALLET)).toBeNull();
  });

  it('never regresses the cursor to an older position (incl. same-log id)', () => {
    storeLastSeen(CHAIN, WALLET, { block: 200, logIndex: 1, id: 10 });
    storeLastSeen(CHAIN, WALLET, { block: 100, logIndex: 0, id: 99 }); // older block → ignored
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 200, logIndex: 1, id: 10 });
    storeLastSeen(CHAIN, WALLET, { block: 200, logIndex: 1, id: 9 }); // same log, lower id → ignored
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 200, logIndex: 1, id: 10 });
    storeLastSeen(CHAIN, WALLET, { block: 200, logIndex: 1, id: 11 }); // same log, higher id → advances
    expect(loadLastSeen(CHAIN, WALLET)).toEqual({ block: 200, logIndex: 1, id: 11 });
  });

  it('ignores a malformed or id-less stored value', () => {
    const key = `alpha02.notif.lastseen.${CHAIN}.${WALLET.toLowerCase()}`;
    store.set(key, 'not-json');
    expect(loadLastSeen(CHAIN, WALLET)).toBeNull();
    // A pre-id-tiebreak cursor (no `id`) is rejected — it can't order a
    // same-log group, so treat it as "never seen" rather than trust it.
    store.set(key, JSON.stringify({ block: 1, logIndex: 0 }));
    expect(loadLastSeen(CHAIN, WALLET)).toBeNull();
  });
});
