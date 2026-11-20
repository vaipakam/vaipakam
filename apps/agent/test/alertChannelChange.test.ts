/**
 * #3246 — removing a Telegram alert chat waits while protected mode is on:
 * the chat linked now keeps its alerts, is told, and may CANCEL; the tick
 * applies the change once due. Unprotected accounts keep the immediate path,
 * and an unreadable protection status changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { extractCancelCommand, type TelegramUpdate } from '../src/telegram';
import {
  applyDueChannelChanges,
  cancelFromChat,
  requestRelink,
  requestUnlink,
  sendPhraseNotices,
  NOTICE_RETRY_SECONDS,
  type ChannelDeps,
  type SendOutcome,
} from '../src/alertChannelFlow';
import { MAX_PROTECTED_DELAY_SECONDS, type ProtectionReader, type TelegramStatePort } from '../src/alertChannelChange';
import { TelegramStateStore } from '../src/telegramState/store';
import { sqliteDo } from './helpers/sqliteDo';

const NOW = 1_800_000_000;
const DAY = 86_400;
const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The flows' state port over the real store on Node's SQLite (#1722): each
 *  RPC method of the object, made async as the stub makes it. */
const PORT_METHODS = [
  'linkedRows',
  'linksOfChat',
  'commit',
  'markNotified',
  'markNoticeAttempt',
  'unnotifiedChanges',
  'dueChanges',
  'cancelPendingForChat',
  'applyChange',
  'pruneClosed',
  'phraseMarksOf',
  'queueChatNotice',
  'chatNoticeSent',
  'dueChatNotices',
  'duePhraseNotices',
  'phraseNoticeSent',
] as const;
function portOf(store: TelegramStateStore): TelegramStatePort {
  const port: Record<string, unknown> = {};
  for (const m of PORT_METHODS) {
    const f = (store[m] as (...a: unknown[]) => unknown).bind(store);
    port[m] = async (...a: unknown[]) => f(...a);
  }
  return port as unknown as TelegramStatePort;
}

function harness() {
  const h = sqliteDo();
  const store = new TelegramStateStore(h.sql, h.tx);
  return { db: h.db, store, state: portOf(store) };
}

/** Link `chatId` to (W, `chainId`) now, as an immediate link does. */
const link = (store: TelegramStateStore, chainId: number, chatId: string) =>
  store.commit(W, chainId, store.linkedRows(W, chainId), [{ op: 'link', chainId, chatId }], 0);

/** The chat linked to (W, `chainId`), or null. */
const chat = (store: TelegramStateStore, chainId: number) => store.chatsOf([{ wallet: W, chainId }])[0] ?? null;

/** A reader with a fixed answer per chain; a chain absent from the map is unreadable. */
const reader =
  (by: Record<number, { enabled: boolean; delaySeconds: number }>): ProtectionReader =>
  async (_w, c) =>
    by[c] ?? null;

/** Deps whose send records each message and answers `outcome` (Telegram
 *  accepted it, unless a test says otherwise). Every locale reads as 'en'. */
function deps(state: TelegramStatePort, read: ProtectionReader, now = NOW, outcome: SendOutcome = 'accepted') {
  const sent: { chat: string; text: string }[] = [];
  const d: ChannelDeps = {
    state,
    locales: async (pairs) => pairs.map(() => 'en'),
    read,
    now,
    send: async (chat, text) => {
      sent.push({ chat, text });
      return outcome;
    },
  };
  return { d, sent };
}

describe('extractCancelCommand', () => {
  const u = (text: string, type = 'private'): TelegramUpdate => ({ update_id: 1, message: { chat: { id: 42, type }, text } });
  it('reads CANCEL, /cancel and /cancel@Bot, case-blind', () => {
    for (const t of ['CANCEL', 'cancel', ' Cancel ', '/cancel', '/CANCEL@VaipakamBot']) {
      expect(extractCancelCommand(u(t)), t).toEqual({ chatId: '42', isPrivate: true });
    }
  });
  it('ignores anything else and flags a group', () => {
    for (const t of ['cancel it', 'CANCELLED', 'LOCK']) expect(extractCancelCommand(u(t)), t).toBeNull();
    expect(extractCancelCommand(u('CANCEL', 'group'))).toEqual({ chatId: '42', isPrivate: false });
  });
});

describe('requestUnlink', () => {
  it('clears at once when the account is not protected', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d, sent } = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestUnlink(d, W, null, NOW)).toEqual({ kind: 'done', pending: [] });
    expect(chat(store, 84532)).toBeNull();
    // #3346 — nothing told the chat beforehand, so it is told now.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe('42');
    expect(sent[0]!.text).toContain('no longer gets alerts');
    expect(sent[0]!.text).toContain('Vaipakam app');
  });

  it('keeps the unlink when the notice to the old chat fails (#3346)', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d, sent } = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }), NOW, 'refused');
    expect(await requestUnlink(d, W, 84532, NOW)).toEqual({ kind: 'done', pending: [] });
    expect(chat(store, 84532)).toBeNull();
    expect(sent.map((m) => m.chat)).toEqual(['42']);
  });

  it('waits the delay while protected, keeps the chat and tells it', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    link(store, 421614, '42');
    const { d, sent } = deps(state, reader({ 84532: { enabled: true, delaySeconds: 3 * DAY }, 421614: { enabled: false, delaySeconds: 0 } }));
    const out = await requestUnlink(d, W, null, NOW);
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: NOW + 3 * DAY }] });
    // The protected chain keeps its chat; the open one clears at once.
    expect(chat(store, 84532)).toBe('42');
    expect(chat(store, 421614)).toBeNull();
    // The protected chain's notice, then (#3346) the open chain's at-once one.
    expect(sent).toHaveLength(2);
    expect(sent[0]!.chat).toBe('42');
    expect(sent[0]!.text).toContain('CANCEL');
    expect(sent[0]!.text).toContain('LOCK');
    expect(sent[1]!.chat).toBe('42');
    expect(sent[1]!.text).toContain('no longer gets alerts');
  });

  it('changes nothing when a chain cannot be read', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    link(store, 97, '42');
    const { d, sent } = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestUnlink(d, W, null, NOW)).toEqual({ kind: 'unknown' });
    expect(chat(store, 84532)).toBe('42');
    expect(chat(store, 97)).toBe('42');
    expect(sent).toEqual([]);
  });

  it('never waits longer than the longest delay the contracts allow', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d } = deps(state, reader({ 84532: { enabled: true, delaySeconds: 365 * DAY } }));
    const out = await requestUnlink(d, W, 84532, NOW);
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: NOW + MAX_PROTECTED_DELAY_SECONDS }] });
  });

  it('changes nothing for a request signed before a link already applied (#3836)', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    // A link request signed at NOW was applied (its code issued)…
    expect(store.issueLinkCode('CODE', W, 84532, NOW + 600, NOW)).toBe('issued');
    const { d, sent } = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    // …so an unlink a Safe approved slowly, signed before it, is refused.
    expect(await requestUnlink(d, W, 84532, NOW - 1)).toEqual({ kind: 'superseded' });
    expect(chat(store, 84532)).toBe('42');
    expect(store.consumeLinkCode('CODE', NOW)).toEqual({ wallet: W.toLowerCase(), chainId: 84532 });
    expect(sent).toEqual([]);
  });
});

describe('requestRelink', () => {
  it('links at once where no chat is linked, or the same chat again', async () => {
    const { store, state } = harness();
    const { d } = deps(state, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('linked');
    expect(chat(store, 84532)).toBe('77');
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('linked');
    expect(chat(store, 84532)).toBe('77');
  });

  it('moves an unprotected account at once and tells the chat it left (#3346)', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d, sent } = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('linked');
    expect(chat(store, 84532)).toBe('77');
    expect(sent.map((m) => m.chat)).toEqual(['42']);
    expect(sent[0]!.text).toContain('different Telegram chat');
    // Linking the same chat again tells nobody.
    const again = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestRelink(again.d, W, 84532, '77', 'en')).toBe('linked');
    expect(again.sent).toEqual([]);
  });

  it('moves to a different chat only after the delay, telling both chats', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d, sent } = deps(state, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('pending');
    expect(chat(store, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['42', '77']);

    // Not due yet: nothing moves.
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + DAY).d)).toBe(0);
    expect(chat(store, 84532)).toBe('42');
    // Due: the new chat takes over and both are told.
    const later = deps(state, reader({}), NOW + 2 * DAY);
    expect(await applyDueChannelChanges(later.d)).toBe(1);
    expect(chat(store, 84532)).toBe('77');
    expect(later.sent.map((m) => m.chat)).toEqual(['42', '77']);
  });

  it('tells the new chat and keeps the old one when protection cannot be read', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d, sent } = deps(state, reader({}));
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('unknown');
    expect(chat(store, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['77']);
  });
});

describe('cancelFromChat', () => {
  it('lets the chat being removed cancel, and only from a private chat', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const { d } = deps(state, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    await requestUnlink(d, W, null, NOW);
    // The new chat (or any other chat) cannot cancel it.
    expect(await cancelFromChat(d, '77', true)).toBe(0);
    expect(await cancelFromChat(d, '42', false)).toBe(0);
    expect(await cancelFromChat(d, '42', true)).toBe(1);
    // Cancelled: the due tick leaves the chat linked.
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 3 * DAY).d)).toBe(0);
    expect(chat(store, 84532)).toBe('42');
  });
});

describe('applyDueChannelChanges', () => {
  const codes = (db: ReturnType<typeof harness>['db']) => db.prepare('SELECT COUNT(*) AS n FROM link_codes').get();
  const changes = (db: ReturnType<typeof harness>['db'], cols: string) =>
    db.prepare(`SELECT ${cols} FROM channel_changes ORDER BY id`).all();

  it('clears only the chat the unlink was asked about', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    store.issueLinkCode('CODE', W, 84532, NOW + 600, NOW);
    const { d } = deps(state, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    await requestUnlink(d, W, null, NOW);
    // The handshake codes go at the request: a code only links.
    expect(codes(db)).toEqual({ n: 0 });
    const due = deps(state, reader({}), NOW + 2 * DAY);
    expect(await applyDueChannelChanges(due.d)).toBe(1);
    expect(chat(store, 84532)).toBeNull();
    expect(due.sent.map((m) => m.chat)).toEqual(['42']);
    // Applied once: a second tick does nothing.
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 3 * DAY).d)).toBe(0);
  });

  it('a new request supersedes the pending one with a fresh delay', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    await requestUnlink(deps(state, r).d, W, null, NOW);
    await requestUnlink(deps(state, r, NOW + DAY).d, W, null, NOW + DAY);
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 2 * DAY).d)).toBe(0);
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 3 * DAY).d)).toBe(1);
    expect(changes(db, 'state')).toEqual([{ state: 'superseded' }, { state: 'applied' }]);
  });

  it('never starts the wait until the chat being removed accepted the notice', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    const out = await requestUnlink(deps(state, r, NOW, 'transient').d, W, null, NOW);
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: null }] });
    // Long past the delay, still untold: nothing is due, and a failed retry
    // keeps it that way.
    const failing = deps(state, r, NOW + 10 * DAY, 'refused');
    expect(await applyDueChannelChanges(failing.d)).toBe(0);
    expect(failing.sent.map((m) => m.chat)).toEqual(['42']);
    expect(chat(store, 84532)).toBe('42');
    // A retry inside the back-off window sends nothing.
    const soon = deps(state, r, NOW + 10 * DAY + 60);
    expect(await applyDueChannelChanges(soon.d)).toBe(0);
    expect(soon.sent).toEqual([]);
    // The retry Telegram accepts starts the wait from then.
    const told = NOW + 10 * DAY + NOTICE_RETRY_SECONDS;
    const ok = deps(state, r, told);
    expect(await applyDueChannelChanges(ok.d)).toBe(0);
    expect(ok.sent.map((m) => m.chat)).toEqual(['42']);
    expect(await applyDueChannelChanges(deps(state, r, told + 2 * DAY - 1).d)).toBe(0);
    expect(await applyDueChannelChanges(deps(state, r, told + 2 * DAY).d)).toBe(1);
    expect(chat(store, 84532)).toBeNull();
  });

  it('an immediate link closes the pending change, so it can never apply later', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    expect(await requestRelink(deps(state, r).d, W, 84532, '77', 'en')).toBe('pending');
    // The chat linked now links again (immediate): the move is superseded.
    expect(await requestRelink(deps(state, r, NOW + DAY).d, W, 84532, '42', 'en')).toBe('linked');
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 3 * DAY).d)).toBe(0);
    expect(chat(store, 84532)).toBe('42');
    expect(changes(db, 'state')).toEqual([{ state: 'superseded' }]);
  });

  it('a move applies only while the chat it replaces is still the linked one', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    expect(await requestRelink(deps(state, r).d, W, 84532, '77', 'en')).toBe('pending');
    // Something else changed the chat in between (outside these flows).
    db.exec(`UPDATE links SET chat_id = '99'`);
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 2 * DAY).d)).toBe(0);
    expect(chat(store, 84532)).toBe('99');
  });

  it('a wallet-wide unlink revokes the codes of every chain at once', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    store.issueLinkCode('A', W, 84532, NOW + 600, NOW);
    store.issueLinkCode('B', W, 97, NOW + 600, NOW);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    await requestUnlink(deps(state, r).d, W, null, NOW);
    expect(codes(db)).toEqual({ n: 0 });
  });

  it('keeps a protected removal waiting when no bot can send, and tells the chat once one can', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    const noBot: ChannelDeps = { ...deps(state, r).d, send: null };
    expect(await requestUnlink(noBot, W, null, NOW)).toEqual({
      kind: 'done',
      pending: [{ chain_id: 84532, effective_at: null }],
    });
    expect(chat(store, 84532)).toBe('42');
    expect(await applyDueChannelChanges({ ...noBot, now: NOW + 10 * DAY })).toBe(0);
    expect(chat(store, 84532)).toBe('42');
    // The bot is back: the tick tells the chat and starts the wait then.
    const back = deps(state, r, NOW + 10 * DAY);
    expect(await applyDueChannelChanges(back.d)).toBe(0);
    expect(back.sent.map((m) => m.chat)).toEqual(['42']);
    expect(await applyDueChannelChanges(deps(state, r, NOW + 12 * DAY).d)).toBe(1);
  });

  it("states each chain's own deadline when one chat waits different delays", async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    link(store, 421614, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY }, 421614: { enabled: true, delaySeconds: 5 * DAY } });
    const { d, sent } = deps(state, r);
    const out = await requestUnlink(d, W, null, NOW);
    expect(out).toEqual({
      kind: 'done',
      pending: [
        { chain_id: 84532, effective_at: NOW + 2 * DAY },
        { chain_id: 421614, effective_at: NOW + 5 * DAY },
      ],
    });
    expect(sent).toHaveLength(2);
    const two = new Date((NOW + 2 * DAY) * 1000).toISOString().slice(0, 10);
    const five = new Date((NOW + 5 * DAY) * 1000).toISOString().slice(0, 10);
    expect(sent[0]!.text).toContain(two);
    expect(sent[0]!.text).not.toContain(five);
    expect(sent[1]!.text).toContain(five);
  });

  it('a notice accepted after its change was replaced never starts the newer change', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    let inner = true;
    const racing: ChannelDeps = {
      ...deps(state, r).d,
      send: async () => {
        // While the first notice is in flight, a second request replaces the
        // change, and its own notice fails.
        if (inner) {
          inner = false;
          await requestUnlink(deps(state, r, NOW + 60, 'transient').d, W, null, NOW);
        }
        return 'accepted';
      },
    };
    await requestUnlink(racing, W, null, NOW);
    expect(changes(db, 'state, notified_at')).toEqual([
      { state: 'superseded', notified_at: null },
      { state: 'pending', notified_at: null },
    ]);
    expect(await applyDueChannelChanges(deps(state, reader({}), NOW + 2 * DAY + 60, 'refused').d)).toBe(0);
    expect(chat(store, 84532)).toBe('42');
  });

  it('retries the least recently tried notices first, so refusing chats cannot starve others', async () => {
    const { db, state } = harness();
    // 60 rows whose chats refuse (more than one batch of 50), then one more.
    for (let i = 0; i < 61; i++) {
      const w = `0x${i.toString(16).padStart(40, '0')}`;
      db.exec(`INSERT INTO channel_changes (wallet, chain_id, kind, old_chat_id, requested_at, delay_seconds, state)
               VALUES ('${w}', 84532, 'unlink', '${i === 60 ? 'good' : 'bad' + i}', ${NOW}, ${2 * DAY}, 'pending')`);
    }
    const tried = new Set<string>();
    for (let tick = 0; tick < 2; tick++) {
      const d: ChannelDeps = {
        ...deps(state, reader({}), NOW + tick * NOTICE_RETRY_SECONDS).d,
        send: async (c) => {
          tried.add(c);
          return c === 'good' ? 'accepted' : 'refused';
        },
      };
      await applyDueChannelChanges(d);
    }
    expect(tried.has('good')).toBe(true);
    expect(db.prepare(`SELECT notified_at FROM channel_changes WHERE old_chat_id = 'good'`).get()).toEqual({
      notified_at: NOW + NOTICE_RETRY_SECONDS,
    });
  });

  it('a link decided on a stale read re-decides, so a race cannot skip the wait', async () => {
    const { store, state } = harness();
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    // The owner's handshake lands between this request's read (no chat)
    // and its write.
    let raced = false;
    const racingState: TelegramStatePort = {
      ...state,
      linkedRows: async (w, c) => {
        const rows = await state.linkedRows(w, c);
        if (!raced) {
          raced = true;
          link(store, 84532, '42');
        }
        return rows;
      },
    };
    const { d, sent } = deps(racingState, r);
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('pending');
    expect(chat(store, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['42', '77']);
  });

  it('an unlink decided on a stale read writes nothing and decides again', async () => {
    const { store, state } = harness();
    const read = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    // A protected chat is linked right after this request's first read
    // (nothing linked), before its write.
    let raced = false;
    const racingState: TelegramStatePort = {
      ...state,
      linkedRows: async (w, c) => {
        const rows = await state.linkedRows(w, c);
        if (!raced) {
          raced = true;
          link(store, 84532, '42');
        }
        return rows;
      },
    };
    const { d, sent } = deps(racingState, read);
    const out = await requestUnlink(d, W, null, NOW);
    // The second decision saw the protected chat: it waits, and is told.
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: NOW + 2 * DAY }] });
    expect(chat(store, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['42']);
  });

  it('a move decided while the linked chat changed writes nothing and decides again', async () => {
    const { db, store, state } = harness();
    link(store, 84532, '42');
    let reads = 0;
    // While this request reads protection, another change moves the chat
    // from 42 to 55.
    const read: ProtectionReader = async () => {
      if (reads++ === 0) link(store, 84532, '55');
      return { enabled: true, delaySeconds: 2 * DAY };
    };
    const { d, sent } = deps(state, read);
    expect(await requestRelink(d, W, 84532, '77', 'en')).toBe('pending');
    // The move recorded is from the chat linked now, and that chat is told.
    expect(changes(db, 'old_chat_id, new_chat_id, state')).toEqual([{ old_chat_id: '55', new_chat_id: '77', state: 'pending' }]);
    expect(sent.map((m) => m.chat)).toEqual(['55', '77']);
  });

  it('a second pass that read the same due change writes nothing, even in the same second', async () => {
    const { store, state } = harness();
    link(store, 84532, '42');
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    await requestUnlink(deps(state, r).d, W, null, NOW);
    const due = store.dueChanges(NOW + 2 * DAY, 50);
    expect(due).toHaveLength(1);
    expect(store.applyChange(due[0]!.id, NOW + 2 * DAY)?.applied).toBe(true);
    // The owner links the same chat again before the second pass runs.
    link(store, 84532, '42');
    expect(store.applyChange(due[0]!.id, NOW + 2 * DAY)).toBeNull();
    expect(chat(store, 84532)).toBe('42');
  });
});

describe('the alert phrase in channel messages (#3346)', () => {
  /** A private chat '42' linked on 84532 that has been told `phrase`. */
  async function told(phrase: string) {
    const { store, state } = harness();
    store.recordChatType('42', true, 0);
    link(store, 84532, '42');
    store.setPhrase(W, phrase, 1, 1);
    const open = reader({ 84532: { enabled: false, delaySeconds: 0 } });
    const first = deps(state, open);
    await sendPhraseNotices(first.d);
    return { store, state, open, first };
  }

  it('the notice states the new phrase, and the chat moves to it once accepted', async () => {
    const { store, first } = await told('blue heron');
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.text).toContain('«blue heron»');
    // The first notice is led by no phrase: the chat had been told none.
    expect(first.sent[0]!.text.startsWith('Your alert phrase')).toBe(false);
    expect(store.phraseMarksOf([{ wallet: W, chatId: '42' }])).toEqual(['blue heron']);
  });

  it('a change is led by the phrase the chat was told, and kept until Telegram accepts', async () => {
    const { store, state } = await told('blue heron');
    store.setPhrase(W, 'red kite', 2, 2);
    const refused = deps(state, reader({ 84532: { enabled: true, delaySeconds: DAY } }), NOW, 'refused');
    await sendPhraseNotices(refused.d);
    expect(refused.sent[0]!.text.startsWith('Your alert phrase: «blue heron»')).toBe(true);
    expect(refused.sent[0]!.text).toContain('«red kite»');
    // A protected account is told how to lock.
    expect(refused.sent[0]!.text).toContain('lock the vault');
    expect(store.phraseMarksOf([{ wallet: W, chatId: '42' }])).toEqual(['blue heron']);
    const later = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 } }), NOW + NOTICE_RETRY_SECONDS + 1);
    await sendPhraseNotices(later.d);
    expect(store.phraseMarksOf([{ wallet: W, chatId: '42' }])).toEqual(['red kite']);
  });

  it('the old chat hears of an unlink with the phrase it was told, and Push is told the network', async () => {
    const { store, state, open } = await told('blue heron');
    const pushed: [string, number][] = [];
    const { d, sent } = deps(state, open);
    d.pushChange = async (wallet, chainId) => {
      pushed.push([wallet, chainId]);
    };
    await requestUnlink(d, W, null, NOW);
    expect(chat(store, 84532)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.startsWith('Your alert phrase: «blue heron»')).toBe(true);
    expect(pushed).toEqual([[W, 84532]]);
  });

  it('a chat added beside a linked one tells the linked one, never the phrase to the new chat', async () => {
    const { store, state, open } = await told('blue heron');
    store.recordChatType('77', true, 0);
    const { d, sent } = deps(state, open);
    expect(await requestRelink(d, W, 421614, '77', 'en')).toBe('linked');
    const toOld = sent.filter((m) => m.chat === '42');
    expect(toOld).toHaveLength(1);
    expect(toOld[0]!.text.startsWith('Your alert phrase: «blue heron»')).toBe(true);
    expect(toOld[0]!.text).toContain('Another Telegram chat');
    expect(store.phraseMarksOf([{ wallet: W, chatId: '77' }])).toEqual([null]);
  });

  it('a group chat is never shown the phrase', async () => {
    const { store, state } = harness();
    store.recordChatType('42', true, 0);
    link(store, 84532, '42');
    link(store, 421614, '-5');
    store.setPhrase(W, 'blue heron', 1, 1);
    const { d, sent } = deps(state, reader({ 84532: { enabled: false, delaySeconds: 0 }, 421614: { enabled: false, delaySeconds: 0 } }));
    await sendPhraseNotices(d);
    expect(sent.map((m) => m.chat)).toEqual(['42']);
    expect(store.phraseMarksOf([{ wallet: W, chatId: '-5' }])).toEqual([null]);
  });
});
