import { describe, expect, it } from 'vitest';
import {
  CLOSED_RETENTION_SECONDS,
  LOCK_RETENTION_SECONDS,
  ORDER_RETENTION_SECONDS,
  TelegramStateStore,
} from '../src/telegramState/store';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';
const w = W.toLowerCase();
/** The agent's own deployments in these tests: chain 1 and chain 2. */
const DA = '0x00000000000000000000000000000000000000a1';
const DIAMONDS: Record<number, string> = { 1: DA, 2: '0x00000000000000000000000000000000000000a2' };
const dep1 = { chainId: 1, diamond: DA };

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
    expect(v).toEqual([{ version: 3 }]);
  });

  it('a handshake code is good once and not after it expires', () => {
    const { store } = fresh();
    expect(store.issueLinkCode('c1', W, 84532, 100, 1)).toBe('issued');
    expect(store.issueLinkCode('c1', W, 84532, 100, 1)).toBe('taken');
    expect(store.consumeLinkCode('c1', 50)).toEqual({ wallet: w, chainId: 84532 });
    expect(store.consumeLinkCode('c1', 50)).toBeNull();
    store.issueLinkCode('c2', W, 84532, 100, 1);
    expect(store.consumeLinkCode('c2', 101)).toBeNull();
    store.issueLinkCode('c3', W, 84532, 10, 1);
    store.issueLinkCode('c4', W, 84532, 1000, 1);
    expect(store.sweepExpiredCodes(500)).toBe(1);
  });

  it('commit writes only while the rows the caller read are unchanged', () => {
    const { store } = fresh();
    const linked = store.commit(W, 84532, [], [{ op: 'link', chainId: 84532, chatId: '7' }], 1);
    expect(linked).toEqual({ ok: true, ids: [], noticeIds: [] });
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
    store.issueLinkCode('cx', W, 1, 1000, 1);
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
    expect(store.keeperPoll(dep1, 100, 20)).toEqual([]);
    const links = store.recordLockRequests('7', 555, 150, 50, DIAMONDS);
    expect(links).toEqual([
      { wallet: w, chainId: 1, recorded: true },
      { wallet: w, chainId: 2, recorded: false },
    ]);
    // Redelivery records nothing new.
    store.recordLockRequests('7', 555, 150, 50, DIAMONDS);
    const polled = store.keeperPoll(dep1, 200, 20);
    expect(polled).toHaveLength(1);
    expect(polled[0]!.wallet).toBe(w);
    expect(store.pendingLockWallets(dep1, 100)).toEqual([w]);
    // A stale or undated request records nothing.
    expect(store.recordLockRequests('7', 556, null, 50, DIAMONDS).every((l) => !l.recorded)).toBe(true);
    expect(store.markLockHandled(dep1, W, polled[0]!.id, 'locked', 210)).toEqual({ chatId: '7' });
    expect(store.markLockHandled(dep1, W, polled[0]!.id, 'locked', 211)).toBeUndefined();
    expect(store.keeperPoll(dep1, 220, 20)).toEqual([]);
  });

  it('keeps LOCK state per Diamond, so a fresh deploy on the same chain starts empty (Codex #3571 r1)', () => {
    const { store } = fresh();
    store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
    store.keeperPoll(dep1, 100, 20);
    expect(store.recordLockRequests('7', 1, 100, 50, DIAMONDS)[0]!.recorded).toBe(true);
    // The agent's bundle now names a new Diamond on chain 1.
    const DB = '0x00000000000000000000000000000000000000b1';
    const dep1b = { chainId: 1, diamond: DB };
    // A keeper polling the new Diamond is handed nothing recorded for the old one.
    expect(store.keeperPoll(dep1b, 110, 20)).toEqual([]);
    expect(store.pendingLockWallets(dep1b, 0)).toEqual([]);
    expect(store.markLockHandled(dep1b, W, 1, 'locked', 120)).toBeUndefined();
    // Only the old Diamond's poll is fresh: under the new list nothing records.
    const next = { ...DIAMONDS, 1: DB };
    const { store: s2 } = fresh();
    s2.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
    s2.keeperPoll(dep1, 100, 20);
    expect(s2.recordLockRequests('7', 1, 100, 50, next)[0]!.recorded).toBe(false);
    // Once the new Diamond is polled, a request records against it, and the
    // old request stays with the old Diamond (case of the address does not matter).
    store.recordLockRequests('7', 2, 115, 50, next);
    expect(store.keeperPoll({ chainId: 1, diamond: DB.toUpperCase().replace('0X', '0x') }, 130, 20).map((r) => r.id)).toEqual([2]);
    expect(store.keeperPoll(dep1, 130, 20).map((r) => r.id)).toEqual([1]);
  });

  it('warns each unanswered LOCK once, and prunes old records', () => {
    const { store } = fresh();
    store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
    store.keeperPoll(dep1, 100, 20);
    store.recordLockRequests('7', 1, 100, 50, DIAMONDS);
    expect(store.takeUnansweredLocks(99, 200, 10)).toEqual([]);
    const warned = store.takeUnansweredLocks(100, 200, 10);
    expect(warned).toEqual([{ chainId: 1, wallet: w, upToId: warned[0]!.upToId, chatId: '7' }]);
    expect(store.takeUnansweredLocks(100, 201, 10)).toEqual([]);
    store.markLockHandled(dep1, W, warned[0]!.upToId, 'locked', 300);
    store.pruneClosed(300 + LOCK_RETENTION_SECONDS + 1);
    expect(store.keeperPoll(dep1, 400, 20)).toEqual([]);
    expect(CLOSED_RETENTION_SECONDS).toBeGreaterThan(LOCK_RETENTION_SECONDS);
  });

  describe('request order (#3836)', () => {
    const clear = (chainId: number) => [{ op: 'clear', chainId } as const];

    it('issues no code for a link request older than one already applied', () => {
      const { store } = fresh();
      expect(store.issueLinkCode('n', W, 1, 1000, 200)).toBe('issued');
      // Older than the applied one: nothing stored, and the mark stays.
      expect(store.issueLinkCode('o', W, 1, 1000, 199)).toBe('superseded');
      expect(store.consumeLinkCode('o', 10)).toBeNull();
      // The same second is not older; another chain has its own order.
      expect(store.issueLinkCode('s', W, 1, 1000, 200)).toBe('issued');
      expect(store.issueLinkCode('c', W, 2, 1000, 50)).toBe('issued');
    });

    it('orders link and unlink together, in the same step as the change', () => {
      const { store } = fresh();
      store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '7' }], 1);
      // An unlink signed at 300 is applied and raises chain 1's mark…
      expect(store.commit(W, 1, [{ chainId: 1, chatId: '7' }], clear(1), 2, { issuedAt: 300, scope: 1 }).ok).toBe(true);
      // …so a link request signed before it no longer gets a code.
      expect(store.issueLinkCode('late', W, 1, 1000, 299)).toBe('superseded');
      // An older unlink writes nothing, even where the rows match.
      store.commit(W, 1, [], [{ op: 'link', chainId: 1, chatId: '8' }], 3);
      expect(store.commit(W, 1, [{ chainId: 1, chatId: '8' }], clear(1), 4, { issuedAt: 250, scope: 1 })).toEqual({
        ok: false,
        superseded: true,
      });
      expect(store.chatsOf([{ wallet: W, chainId: 1 }])).toEqual(['8']);
    });

    it('a stale read raises no mark', () => {
      const { store } = fresh();
      expect(store.commit(W, 1, [{ chainId: 1, chatId: '7' }], clear(1), 1, { issuedAt: 500, scope: 1 })).toEqual({ ok: false });
      expect(store.issueLinkCode('x', W, 1, 1000, 400)).toBe('issued');
    });

    it("an unlink for every chain raises the mark on every chain, and is ordered against each chain's", () => {
      const { store } = fresh();
      expect(store.commit(W, null, [], [{ op: 'revokeCodes', chainId: null }], 1, { issuedAt: 300, scope: null }).ok).toBe(true);
      for (const chainId of [1, 2, 97]) expect(store.issueLinkCode(`c${chainId}`, W, chainId, 1000, 299)).toBe('superseded');
      expect(store.issueLinkCode('c', W, 2, 1000, 400)).toBe('issued');
      // Chain 2 now holds 400: an every-chain unlink signed before it is older.
      expect(store.commit(W, null, [], [{ op: 'revokeCodes', chainId: null }], 2, { issuedAt: 350, scope: null })).toEqual({
        ok: false,
        superseded: true,
      });
      expect(store.consumeLinkCode('c', 10)).toEqual({ wallet: w, chainId: 2 });
    });

    it('drops a mark once no request it could refuse can pass the age check', () => {
      const { store, db } = fresh();
      store.issueLinkCode('a', W, 1, 1000, 1_000);
      store.commit(W, null, [], [], 1, { issuedAt: 1_000, scope: null });
      store.pruneClosed(1_000 + ORDER_RETENTION_SECONDS);
      expect(db.prepare('SELECT COUNT(*) AS n FROM request_order_chain').all()).toEqual([{ n: 1 }]);
      store.pruneClosed(1_001 + ORDER_RETENTION_SECONDS);
      expect(db.prepare('SELECT COUNT(*) AS n FROM request_order_chain').all()).toEqual([{ n: 0 }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM request_order_wallet').all()).toEqual([{ n: 0 }]);
    });
  });

  describe('the alert phrase (#3346)', () => {
    const link = (store: TelegramStateStore, chainId: number, chatId: string, at = 1) =>
      store.commit(W, chainId, store.linkedRows(W, chainId), [{ op: 'link', chainId, chatId }], at);

    const mark = (store: TelegramStateStore, chatId: string, chainId: number) =>
      store.phraseMarksOf([{ wallet: W, chatId, chainId }])[0];
    const accept = (store: TelegramStateStore, at: number) => {
      for (const n of store.duePhraseNotices(at, 50)) store.phraseNoticeSent(W, n.chatId, n.chainId, n.id, true, at);
    };

    it('is set only while a private chat is linked, and a group is reported', () => {
      const { store } = fresh();
      link(store, 1, '7');
      // A chat never seen at a handshake counts as a group.
      expect(store.setPhrase(W, null, 'blue heron', 10, 10)).toEqual({ kind: 'no-private-chat' });
      store.recordChatType('7', true, 5);
      link(store, 2, '-99');
      store.recordChatType('-99', false, 5);
      expect(store.setPhrase(W, null, 'blue heron', 10, 10)).toEqual({ kind: 'set', groupLinked: true, scope: 'all' });
      expect(store.phraseStatus(W, 1)).toEqual({ set: true, setAt: 10, scope: 'all' });
      // Only the private chat gets a notice; the group is never told.
      expect(store.duePhraseNotices(100, 10).map((n) => n.chatId)).toEqual(['7']);
    });

    it('refuses a request signed before the newest applied, in its own order', () => {
      const { store } = fresh();
      store.recordChatType('7', true, 1);
      link(store, 1, '7');
      expect(store.setPhrase(W, null, 'blue heron', 20, 20).kind).toBe('set');
      expect(store.setPhrase(W, null, null, 19, 21)).toEqual({ kind: 'superseded' });
      expect(store.setPhrase(W, null, null, 20, 22).kind).toBe('set');
      expect(store.phraseStatus(W, 1).set).toBe(false);
    });

    it('a chat shows the phrase only once Telegram accepted the notice', () => {
      const { store } = fresh();
      store.recordChatType('7', true, 1);
      link(store, 1, '7');
      store.setPhrase(W, null, 'blue heron', 10, 10);
      expect(mark(store, '7', 1)).toBeNull();
      const [n] = store.duePhraseNotices(100, 10);
      expect(n).toMatchObject({ chatId: '7', chainId: 0, told: [null], target: 'blue heron', chainIds: [1] });
      store.phraseNoticeSent(W, '7', 0, n!.id, false, 11);
      expect(mark(store, '7', 1)).toBeNull();
      // Retried only after the retry window.
      expect(store.duePhraseNotices(11, 10)).toEqual([]);
      store.phraseNoticeSent(W, '7', 0, n!.id, true, 12);
      expect(mark(store, '7', 1)).toBe('blue heron');
      expect(store.duePhraseNotices(1000, 10)).toEqual([]);
      // A change states the phrase the chat was told and the new one.
      store.setPhrase(W, null, 'red kite', 30, 30);
      expect(store.duePhraseNotices(1000, 10)[0]).toMatchObject({ told: ['blue heron'], target: 'red kite' });
      expect(mark(store, '7', 1)).toBe('blue heron');
    });

    it('a newly linked chat shows none, the same chat on another network shows it at once', () => {
      const { store } = fresh();
      store.recordChatType('7', true, 1);
      store.recordChatType('8', true, 1);
      link(store, 1, '7');
      store.setPhrase(W, null, 'blue heron', 10, 10);
      accept(store, 11);
      link(store, 2, '7', 12);
      expect(store.chatMarksOf([{ wallet: W, chainId: 2 }])).toEqual([{ chatId: '7', mark: 'blue heron' }]);
      link(store, 2, '8', 13);
      expect(mark(store, '8', 2)).toBeNull();
      // A chat unlinked everywhere forgets what it was told.
      store.commit(W, 1, store.linkedRows(W, 1), [{ op: 'clear', chainId: 1 }], 14);
      store.commit(W, 2, store.linkedRows(W, 2), [{ op: 'link', chainId: 2, chatId: '7' }], 15);
      expect(mark(store, '7', 2)).toBeNull();
    });

    it('retires a notice that no longer covers any network, so it never holds a batch place', () => {
      const { store, db } = fresh();
      store.recordChatType('7', true, 1);
      link(store, 1, '7');
      // The wallet-wide notice is still unsent when network 1 sets its own
      // phrase: the wallet-wide one no longer covers any network of chat 7.
      store.setPhrase(W, null, 'blue heron', 10, 10);
      store.setPhrase(W, 1, 'red kite', 20, 20);
      // A batch of one still reaches the network's notice.
      expect(store.duePhraseNotices(100, 1)).toEqual([
        expect.objectContaining({ chatId: '7', chainId: 1, chainIds: [1], target: 'red kite' }),
      ]);
      expect(db.prepare('SELECT chain_id FROM phrase_notices').all()).toEqual([{ chain_id: 1 }]);
    });

    it("a network's phrase leaves the other network and its chats untouched", () => {
      const { store } = fresh();
      store.recordChatType('7', true, 1);
      store.recordChatType('8', true, 1);
      link(store, 1, '7'); // network A
      link(store, 2, '8'); // network B only
      store.setPhrase(W, null, 'blue heron', 10, 10);
      accept(store, 11);
      // A contract wallet's approval on A sets A's own phrase.
      expect(store.setPhrase(W, 1, 'red kite', 20, 20)).toEqual({ kind: 'set', groupLinked: false, scope: 'network' });
      // Only the chat linked on A is told, and the notice names A alone.
      const due = store.duePhraseNotices(100, 10);
      expect(due).toEqual([expect.objectContaining({ chatId: '7', chainId: 1, chainIds: [1], told: ['blue heron'], target: 'red kite' })]);
      accept(store, 21);
      expect(mark(store, '7', 1)).toBe('red kite');
      expect(mark(store, '8', 2)).toBe('blue heron');
      expect(store.phraseStatus(W, 1)).toEqual({ set: true, setAt: 20, scope: 'network' });
      expect(store.phraseStatus(W, 2)).toEqual({ set: true, setAt: 10, scope: 'all' });
      // Removing A's phrase on A leaves B's.
      store.setPhrase(W, 1, null, 30, 30);
      accept(store, 31);
      expect(mark(store, '7', 1)).toBeNull();
      expect(mark(store, '8', 2)).toBe('blue heron');
      expect(store.phraseStatus(W, 1).set).toBe(false);
      expect(store.phraseStatus(W, 2).set).toBe(true);
    });

    it("a network's phrase needs a private chat on that network, and is ordered against both kinds", () => {
      const { store } = fresh();
      store.recordChatType('8', true, 1);
      link(store, 2, '8');
      expect(store.setPhrase(W, 1, 'red kite', 10, 10)).toEqual({ kind: 'no-private-chat' });
      expect(store.setPhrase(W, null, 'blue heron', 20, 20).kind).toBe('set');
      // Older than the wallet-wide request that covers this network.
      expect(store.setPhrase(W, 2, 'red kite', 19, 21)).toEqual({ kind: 'superseded' });
      expect(store.setPhrase(W, 2, 'red kite', 25, 25).kind).toBe('set');
      // A wallet-wide request older than B's is refused too.
      expect(store.setPhrase(W, null, null, 24, 26)).toEqual({ kind: 'superseded' });
    });

    it("a key-signed request replaces every network's own phrase", () => {
      const { store } = fresh();
      store.recordChatType('7', true, 1);
      store.recordChatType('8', true, 1);
      link(store, 1, '7');
      link(store, 2, '8');
      store.setPhrase(W, 1, 'red kite', 10, 10);
      store.setPhrase(W, 2, 'grey owl', 11, 11);
      accept(store, 12);
      expect(mark(store, '7', 1)).toBe('red kite');
      store.setPhrase(W, null, 'blue heron', 20, 20);
      expect(store.phraseStatus(W, 1)).toEqual({ set: true, setAt: 20, scope: 'all' });
      expect(store.phraseStatus(W, 2)).toEqual({ set: true, setAt: 20, scope: 'all' });
      // Each chat keeps what it was told until it accepts the notice.
      expect(mark(store, '8', 2)).toBe('grey owl');
      accept(store, 21);
      expect(mark(store, '7', 1)).toBe('blue heron');
      expect(mark(store, '8', 2)).toBe('blue heron');
    });

    it('a chat notice is kept only until sent, or for an hour', () => {
      const { store } = fresh();
      const id = store.queueChatNotice('7', W, 1, 'unlink', null, 100);
      store.chatNoticeSent(id, false, 100);
      expect(store.dueChatNotices(200, 200, 10).map((n) => n.id)).toEqual([id]);
      expect(store.dueChatNotices(200, 100 + 3601, 10)).toEqual([]);
      const id2 = store.queueChatNotice('7', W, 1, 'added', 'blue heron', 5000);
      store.chatNoticeSent(id2, true, 5000);
      expect(store.dueChatNotices(9000, 5001, 10)).toEqual([]);
    });

    it('a chat notice is queued in the same commit as its change, or not at all', () => {
      const { store } = fresh();
      link(store, 1, '7');
      const observed = store.linkedRows(W, 1);
      const notice = { op: 'chatNotice', chatId: '7', chainId: 1, kind: 'unlink', phrase: null } as const;
      const done = store.commit(W, 1, observed, [{ op: 'clear', chainId: 1 }, notice], 50);
      expect(done).toMatchObject({ ok: true, ids: [] });
      const ids = done.ok ? done.noticeIds : [];
      expect(store.dueChatNotices(100, 100, 10).map((n) => n.id)).toEqual(ids);
      // A commit on a stale read writes nothing, so it queues nothing.
      expect(store.commit(W, 1, observed, [{ op: 'clear', chainId: 1 }, notice], 60)).toEqual({ ok: false });
      expect(store.dueChatNotices(100, 100, 10)).toHaveLength(1);
    });
  });
});
