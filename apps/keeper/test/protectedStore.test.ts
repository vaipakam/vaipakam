/**
 * #3088 — the protected account pass's reads and its writes in the shared
 * database, run against the indexer's own migrations: the unhandled LOCK
 * requests (with the owner's locale), the record of a handled one and the
 * LOCK readiness heartbeat under the epoch guard, the wallets with an open
 * request, and an owner's subscription.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { disarmEpochFence, EpochFenceRefusal } from '../src/epochFence';
import { d1ProtectedStore } from '../src/protectedTelegram';
import { settleIndexer } from './helpers/epochFence';
import { createSharedD1 } from './helpers/schemas';

const CHAIN = 84532;
const OLD = '0x' + '1'.repeat(40);
const NEW = '0x' + '2'.repeat(40);
const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b2';

describe('d1ProtectedStore', () => {
  let shared: ReturnType<typeof createSharedD1>;
  let store: ReturnType<typeof d1ProtectedStore>;

  const addRequest = (chainId: number, wallet: string, updateId: number, at = 100) =>
    shared.db
      .prepare('INSERT INTO protected_lock_requests (chain_id, wallet, update_id, requested_at) VALUES (?, ?, ?, ?)')
      .run(chainId, wallet, updateId, at);
  const subscribe = (wallet: string, chat: string | null, push: string | null, locale: string) =>
    shared.db
      .prepare(
        `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, tg_chat_id, push_channel, locale, created_at, updated_at)
         VALUES (?, ?, 1.5, 1.2, 1.05, ?, ?, ?, 1, 1)`,
      )
      .run(wallet, CHAIN, chat, push, locale);

  beforeEach(() => {
    disarmEpochFence();
    shared = createSharedD1();
    store = d1ProtectedStore(shared.d1 as D1Database);
  });

  it('reads one entry per wallet with open requests on one chain, oldest wallet first, with the chat and locale it has now', async () => {
    subscribe(ALICE, '42', null, 'ta');
    addRequest(CHAIN, ALICE, 1);
    addRequest(CHAIN, BOB, 1);
    addRequest(97, ALICE, 2);
    addRequest(CHAIN, ALICE, 3, 150);
    const reqs = await store.lockRequests(CHAIN, 10);
    // Alice's two requests are one entry: the newest id and the newest time.
    expect(reqs.map((q) => [q.wallet, q.locale, q.requestedAt, q.chatId])).toEqual([
      [ALICE, 'ta', 150, '42'],
      [BOB, null, 100, null],
    ]);
    const ids = shared.db.prepare('SELECT id FROM protected_lock_requests WHERE chain_id = ? AND wallet = ? ORDER BY id').all(CHAIN, ALICE) as { id: number }[];
    expect(reqs[0]!.id).toBe(ids[ids.length - 1]!.id);
    expect((await store.lockRequests(CHAIN, 1)).map((q) => q.wallet)).toEqual([ALICE]);
    // The owner unlinks Telegram: the waiting requests are still read, with
    // no chat to answer in.
    shared.db.prepare('UPDATE user_thresholds SET tg_chat_id = NULL WHERE wallet = ?').run(ALICE);
    expect((await store.lockRequests(CHAIN, 10)).map((q) => [q.wallet, q.chatId])).toEqual([
      [ALICE, null],
      [BOB, null],
    ]);
  });

  it("handles every one of a wallet's open requests up to the newest read, and none after it", async () => {
    settleIndexer(shared, CHAIN, OLD);
    addRequest(CHAIN, ALICE, 1);
    addRequest(CHAIN, ALICE, 2);
    addRequest(CHAIN, BOB, 3);
    const [q] = await store.lockRequests(CHAIN, 10);
    addRequest(CHAIN, ALICE, 4, 200); // sent after the read
    await store.markHandled(CHAIN, q!.wallet, q!.id, 'locked', 500);
    const rows = shared.db.prepare('SELECT wallet, update_id, outcome FROM protected_lock_requests ORDER BY id').all();
    expect(rows).toEqual([
      { wallet: ALICE, update_id: 1, outcome: 'locked' },
      { wallet: ALICE, update_id: 2, outcome: 'locked' },
      { wallet: BOB, update_id: 3, outcome: null },
      { wallet: ALICE, update_id: 4, outcome: null },
    ]);
    // Bob's is now the oldest open wallet; Alice's later request comes after it.
    expect((await store.lockRequests(CHAIN, 10)).map((q) => [q.wallet, q.requestedAt])).toEqual([
      [BOB, 100],
      [ALICE, 200],
    ]);
  });

  it('records a handled request once, under the epoch guard, and never reads it again', async () => {
    addRequest(CHAIN, ALICE, 1);
    const [q] = await store.lockRequests(CHAIN, 10);
    // Unarmed: no epoch to hold to.
    await expect(store.markHandled(CHAIN, q!.wallet, q!.id, 'locked', 500)).rejects.toBeInstanceOf(EpochFenceRefusal);
    // Armed for OLD, but the indexer has since moved to NEW: the statement writes nothing.
    settleIndexer(shared, CHAIN, OLD);
    shared.db.prepare('UPDATE indexer_deployment SET diamond = ? WHERE chain_id = ?').run(NEW, CHAIN);
    await expect(store.markHandled(CHAIN, q!.wallet, q!.id, 'locked', 500)).rejects.toThrow(/refused by its statement's guard/);
    expect(await store.lockRequests(CHAIN, 10)).toHaveLength(1);
    // Settled back on the configured Diamond: it lands, and the row leaves the queue.
    settleIndexer(shared, CHAIN, OLD);
    await store.markHandled(CHAIN, q!.wallet, q!.id, 'locked', 500);
    expect(shared.db.prepare('SELECT handled_at, outcome FROM protected_lock_requests').get()).toEqual({ handled_at: 500, outcome: 'locked' });
    expect(await store.lockRequests(CHAIN, 10)).toEqual([]);
    // A second record of the same request changes nothing and says so.
    await expect(store.markHandled(CHAIN, q!.wallet, q!.id, 'expired', 600)).rejects.toBeInstanceOf(EpochFenceRefusal);
    expect(shared.db.prepare('SELECT outcome FROM protected_lock_requests').get()).toEqual({ outcome: 'locked' });
  });

  it('publishes the LOCK readiness under the epoch guard, one row a chain', async () => {
    const seen = () => shared.db.prepare('SELECT chain_id, seen_at FROM protected_lock_readiness').all();
    await expect(store.publishLockReadiness(CHAIN, 500)).rejects.toBeInstanceOf(EpochFenceRefusal);
    settleIndexer(shared, CHAIN, OLD);
    shared.db.prepare('UPDATE indexer_deployment SET diamond = ? WHERE chain_id = ?').run(NEW, CHAIN);
    await expect(store.publishLockReadiness(CHAIN, 500)).rejects.toThrow(/refused by its statement's guard/);
    expect(seen()).toEqual([]);
    settleIndexer(shared, CHAIN, OLD);
    await store.publishLockReadiness(CHAIN, 500);
    await store.publishLockReadiness(CHAIN, 560);
    expect(seen()).toEqual([{ chain_id: CHAIN, seen_at: 560 }]);
  });

  it('names the wallets with an open LOCK request made since a time', async () => {
    addRequest(CHAIN, ALICE, 1, 100);
    addRequest(CHAIN, BOB, 1, 50); // too old
    addRequest(97, BOB, 2, 200); // another chain
    addRequest(CHAIN, ALICE, 3, 300);
    expect([...(await store.pendingLockWallets(CHAIN, 100))]).toEqual([ALICE]);
    settleIndexer(shared, CHAIN, OLD);
    for (const q of await store.lockRequests(CHAIN, 10)) if (q.wallet === ALICE) await store.markHandled(CHAIN, q.wallet, q.id, 'locked', 400);
    expect(await store.pendingLockWallets(CHAIN, 100)).toEqual(new Set());
    expect([...(await store.pendingLockWallets(CHAIN, 0))]).toEqual([BOB]);
  });

  it("reads an owner's chat, Push opt-in and locale, and nothing for a wallet with no row", async () => {
    subscribe(ALICE, '42', 'subscribed', 'fr');
    subscribe(BOB, null, null, 'en');
    expect(await store.subscriber(CHAIN, '0x00000000000000000000000000000000000000A1')).toEqual({ tgChatId: '42', push: true, locale: 'fr' });
    expect(await store.subscriber(CHAIN, BOB)).toEqual({ tgChatId: null, push: false, locale: 'en' });
    expect(await store.subscriber(97, ALICE)).toBeNull();
  });
});
