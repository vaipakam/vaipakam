import { describe, expect, it } from 'vitest';
import { CLOSED_RETENTION_SECONDS, LOCK_RETENTION_SECONDS, TelegramStateStore } from '../src/telegramState/store';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';
const w = W.toLowerCase();

function fresh() {
  const h = sqliteDo();
  return { ...h, store: new TelegramStateStore(h.sql, h.tx) };
}

describe('telegram state store (#1722)', () => {
  it('migrates once and again idempotently', () => {
    const h = sqliteDo();
    new TelegramStateStore(h.sql, h.tx);
    new TelegramStateStore(h.sql, h.tx);
    const v = h.db.prepare('SELECT version FROM schema_version').all();
    expect(v).toEqual([{ version: 1 }]);
  });

  it('a handshake code is good once and not after it expires', () => {
    const { store } = fresh();
    expect(store.issueLinkCode('c1', W, 84532, 100)).toBe(true);
    expect(store.issueLinkCode('c1', W, 84532, 100)).toBe(false);
    expect(store.consumeLinkCode('c1', 50)).toEqual({ wallet: w, chainId: 84532 });
    expect(store.consumeLinkCode('c1', 50)).toBeNull();
    store.issueLinkCode('c2', W, 84532, 100);
    expect(store.consumeLinkCode('c2', 101)).toBeNull();
    store.issueLinkCode('c3', W, 84532, 10);
    store.issueLinkCode('c4', W, 84532, 1000);
    expect(store.sweepExpiredCodes(500)).toBe(1);
  });

  it('commit writes only while the rows the caller read are unchanged', () => {
    const { store } = fresh();
    const linked = store.commit(W, 84532, [], [{ op: 'link', chainId: 84532, chatId: '7' }], 1);
    expect(linked).toEqual({ ok: true, ids: [] });
    expect(store.linkedRows(W, null)).toEqual([{ chainId: 84532, chatId: '7' }]);
    // A stale read (the caller saw no rows) is refused, and nothing is written.
    expect(store.commit(W, 84532, [], [{ op: 'clear', chainId: 84532 }], 2)).toEqual({ ok: false });
    expect(store.chatsOf([{ wallet: W, chainId: 84532 }])).toEqual(['7']);
    expect(store.commit(W, 84532, [{ chainId: 84532, chatId: '7' }], [{ op: 'clear', chainId: 84532 }], 3).ok).toBe(true);
    expect(store.linkedRows(W, null)).toEqual([]);
  });

  it('a pending removal waits for the notice and its delay, and CANCEL closes it', () => {
    const { store } = fresh();
    store.commit(W, 84532, [], [{ op: 'link', chainId: 84532, chatId: '7' }], 1);
    const r = store.commit(
      W,
      84532,
      [{ chainId: 84532, chatId: '7' }],
      [{ op: 'pend', chainId: 84532, kind: 'unlink', oldChatId: '7', newChatId: null, delaySeconds: 100 }],
      10,
    );
    expect(r.ok && r.ids.length).toBe(1);
    const id = r.ok ? r.ids[0]! : 0;
    expect(store.unnotifiedChanges(10, 10).map((c) => c.id)).toEqual([id]);
    // Not due before the notice is accepted.
    expect(store.dueChanges(10_000, 10)).toEqual([]);
    expect(store.applyChange(id, 10_000)).toBeNull();
    store.markNotified([id], 20);
    expect(store.dueChanges(119, 10)).toEqual([]);
    expect(store.dueChanges(120, 10).map((c) => c.id)).toEqual([id]);
    // CANCEL from a chat the change would not silence does nothing.
    expect(store.cancelPendingForChat('8', 121)).toEqual([]);
    expect(store.cancelPendingForChat('7', 121)).toEqual([{ wallet: w, chainId: 84532, kind: 'unlink' }]);
    expect(store.applyChange(id, 200)).toBeNull();
    expect(store.chatsOf([{ wallet: W, chainId: 84532 }])).toEqual(['7']);
  });

  it('a due removal clears the chat and the codes; a move applies only from the old chat', () => {
    const { store } = fresh();
    store.commit(W, null, [], [{ op: 'link', chainId: 1, chatId: '7' }, { op: 'link', chainId: 2, chatId: '7' }], 1);
    const r = store.commit(
      W,
      null,
      [
        { chainId: 1, chatId: '7' },
        { chainId: 2, chatId: '7' },
      ],
      [
        { op: 'pend', chainId: 1, kind: 'unlink', oldChatId: '7', newChatId: null, delaySeconds: 5 },
        { op: 'pend', chainId: 2, kind: 'replace', oldChatId: '7', newChatId: '9', delaySeconds: 5 },
      ],
      2,
    );
    const [a, b] = r.ok ? r.ids : [];
    store.markNotified([a!, b!], 3);
    store.issueLinkCode('cx', W, 1, 1000);
    expect(store.applyChange(a!, 8)?.applied).toBe(true);
    expect(store.consumeLinkCode('cx', 9)).toBeNull();
    // Chain 2's chat moved meanwhile: the old-chat guard leaves it alone.
    store.commit(W, 2, [{ chainId: 2, chatId: '7' }], [{ op: 'link', chainId: 2, chatId: '5' }], 8);
    expect(store.applyChange(b!, 9)?.applied).toBe(false);
    expect(store.linkedRows(W, null)).toEqual([{ chainId: 2, chatId: '5' }]);
  });

  it('a new pending change supersedes the old one, which can no longer apply', () => {
    const { store } = fresh();
    store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
    const pend = { op: 'pend', chainId: 1, kind: 'unlink', oldChatId: '7', newChatId: null, delaySeconds: 1 } as const;
    const first = store.commit(W, 1, [{ chainId: 1, chatId: '7' }], [pend], 2);
    const second = store.commit(W, 1, [{ chainId: 1, chatId: '7' }], [pend], 3);
    const idA = first.ok ? first.ids[0]! : 0;
    const idB = second.ok ? second.ids[0]! : 0;
    store.markNotified([idA, idB], 4);
    expect(store.applyChange(idA, 10)).toBeNull();
    expect(store.applyChange(idB, 10)?.applied).toBe(true);
  });

  it('records LOCK only on chains a keeper is polling, once per update', () => {
    const { store } = fresh();
    store.commit(W, null, [], [{ op: 'link', chainId: 1, chatId: '7' }, { op: 'link', chainId: 2, chatId: '7' }], 1);
    expect(store.keeperPoll(1, 100, 20)).toEqual([]);
    const links = store.recordLockRequests('7', 555, 150, 50);
    expect(links).toEqual([
      { wallet: w, chainId: 1, recorded: true },
      { wallet: w, chainId: 2, recorded: false },
    ]);
    // Redelivery records nothing new.
    store.recordLockRequests('7', 555, 150, 50);
    const polled = store.keeperPoll(1, 200, 20);
    expect(polled).toHaveLength(1);
    expect(polled[0]!.wallet).toBe(w);
    expect(store.pendingLockWallets(1, 100)).toEqual([w]);
    // A stale or undated request records nothing.
    expect(store.recordLockRequests('7', 556, null, 50).every((l) => !l.recorded)).toBe(true);
    expect(store.markLockHandled(1, W, polled[0]!.id, 'locked', 210)).toEqual({ chatId: '7' });
    expect(store.markLockHandled(1, W, polled[0]!.id, 'locked', 211)).toBeUndefined();
    expect(store.keeperPoll(1, 220, 20)).toEqual([]);
  });

  it('warns each unanswered LOCK once, and prunes old records', () => {
    const { store } = fresh();
    store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
    store.keeperPoll(1, 100, 20);
    store.recordLockRequests('7', 1, 100, 50);
    expect(store.takeUnansweredLocks(99, 200, 10)).toEqual([]);
    const warned = store.takeUnansweredLocks(100, 200, 10);
    expect(warned).toEqual([{ chainId: 1, wallet: w, upToId: warned[0]!.upToId, chatId: '7' }]);
    expect(store.takeUnansweredLocks(100, 201, 10)).toEqual([]);
    store.markLockHandled(1, W, warned[0]!.upToId, 'locked', 300);
    store.pruneClosed(300 + LOCK_RETENTION_SECONDS + 1);
    expect(store.keeperPoll(1, 400, 20)).toEqual([]);
    expect(CLOSED_RETENTION_SECONDS).toBeGreaterThan(LOCK_RETENTION_SECONDS);
  });
});
