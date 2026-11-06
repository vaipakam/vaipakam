/**
 * #3246 — removing a Telegram alert chat waits while protected mode is on:
 * the chat linked now keeps its alerts, is told, and may CANCEL; the tick
 * applies the change once due. Unprotected accounts keep the immediate path,
 * and an unreadable protection status changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { extractCancelCommand, type TelegramUpdate } from '../src/telegram';
import {
  applyDueChannelChanges,
  cancelFromChat,
  requestRelink,
  requestUnlink,
  NOTICE_RETRY_SECONDS,
  type ChannelDeps,
  type SendOutcome,
} from '../src/alertChannelFlow';
import { MAX_PROTECTED_DELAY_SECONDS, type ProtectionReader } from '../src/alertChannelChange';
import { linkTelegramStatement, unlinkTelegram, unlinkTelegramOnChain } from '../src/db';

type SqlValue = number | string | null;
const NOW = 1_800_000_000;
const DAY = 86_400;
const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE user_thresholds (wallet TEXT NOT NULL, chain_id INTEGER NOT NULL, tg_chat_id TEXT, locale TEXT, updated_at INTEGER, warn_hf REAL, alert_hf REAL, critical_hf REAL, push_channel TEXT, created_at INTEGER, PRIMARY KEY (wallet, chain_id))`);
  db.exec(`CREATE TABLE telegram_links (code TEXT PRIMARY KEY, wallet TEXT NOT NULL, chain_id INTEGER NOT NULL)`);
  db.exec(readFileSync(new URL('../../indexer/migrations/0084_alert_channel_changes.sql', import.meta.url), 'utf8'));
  const run = (sql: string, args: SqlValue[]) => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } });
  const stmt = (sql: string, args: SqlValue[] = []) => ({
    bind: (...a: SqlValue[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => run(sql, args),
    __exec: () => (/^\s*select|\breturning\b/i.test(sql) ? { results: db.prepare(sql).all(...args) } : run(sql, args)),
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.__exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;
  return { db, d1 };
}

/** A reader with a fixed answer per chain; a chain absent from the map is unreadable. */
const reader =
  (by: Record<number, { enabled: boolean; delaySeconds: number }>): ProtectionReader =>
  async (_w, c) =>
    by[c] ?? null;

/** Deps whose send records each message and answers `outcome` (Telegram
 *  accepted it, unless a test says otherwise). */
function deps(d1: D1Database, read: ProtectionReader, now = NOW, outcome: SendOutcome = 'accepted') {
  const sent: { chat: string; text: string }[] = [];
  const d: ChannelDeps = {
    db: d1,
    read,
    now,
    send: async (chat, text) => {
      sent.push({ chat, text });
      return outcome;
    },
  };
  return { d, sent };
}

const chat = (db: DatabaseSync, chainId: number) =>
  (db.prepare('SELECT tg_chat_id FROM user_thresholds WHERE wallet = ? AND chain_id = ?').get(W, chainId) as { tg_chat_id: string | null }).tg_chat_id;
/** The production link write for (W, 84532) by `chatId`, guarded on the chat seen. */
const link = (d1: D1Database, chatId: string) => (expected: string | null) =>
  linkTelegramStatement(d1, W, 84532, chatId, expected);
const unlinkNow = (d1: D1Database, chainScoped: number | null) => async (chains: number[] | 'all') => {
  if (chains === 'all') return chainScoped === null ? unlinkTelegram(d1, W) : unlinkTelegramOnChain(d1, W, chainScoped);
  for (const c of chains) await unlinkTelegramOnChain(d1, W, c);
};

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
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestUnlink(d, W, null, unlinkNow(d1, null))).toEqual({ kind: 'done', pending: [] });
    expect(chat(db, 84532)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('waits the delay while protected, keeps the chat and tells it', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0), ('${W}', 421614, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 3 * DAY }, 421614: { enabled: false, delaySeconds: 0 } }));
    const out = await requestUnlink(d, W, null, unlinkNow(d1, null));
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: NOW + 3 * DAY }] });
    // The protected chain keeps its chat; the open one clears at once.
    expect(chat(db, 84532)).toBe('42');
    expect(chat(db, 421614)).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe('42');
    expect(sent[0]!.text).toContain('CANCEL');
    expect(sent[0]!.text).toContain('LOCK');
  });

  it('changes nothing when a chain cannot be read', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0), ('${W}', 97, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestUnlink(d, W, null, unlinkNow(d1, null))).toEqual({ kind: 'unknown' });
    expect(chat(db, 84532)).toBe('42');
    expect(chat(db, 97)).toBe('42');
    expect(sent).toEqual([]);
  });

  it('never waits longer than the longest delay the contracts allow', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 365 * DAY } }));
    const out = await requestUnlink(d, W, 84532, unlinkNow(d1, 84532));
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: NOW + MAX_PROTECTED_DELAY_SECONDS }] });
  });
});

describe('requestRelink', () => {
  it('links at once where no chat is linked, or the same chat again', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, NULL, 'en', 0)`);
    const { d } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    expect(await requestRelink(d, W, 84532, '77', 'en', link(d1, '77'))).toBe('linked');
    expect(chat(db, 84532)).toBe('77');
    expect(await requestRelink(d, W, 84532, '77', 'en', link(d1, '77'))).toBe('linked');
    expect(chat(db, 84532)).toBe('77');
  });

  it('moves to a different chat only after the delay, telling both chats', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    expect(await requestRelink(d, W, 84532, '77', 'en', link(d1, '77'))).toBe('pending');
    expect(chat(db, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['42', '77']);

    // Not due yet: nothing moves.
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + DAY).d)).toBe(0);
    expect(chat(db, 84532)).toBe('42');
    // Due: the new chat takes over and both are told.
    const later = deps(d1, reader({}), NOW + 2 * DAY);
    expect(await applyDueChannelChanges(later.d)).toBe(1);
    expect(chat(db, 84532)).toBe('77');
    expect(later.sent.map((m) => m.chat)).toEqual(['42', '77']);
  });

  it('tells the new chat and keeps the old one when protection cannot be read', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({}));
    expect(await requestRelink(d, W, 84532, '77', 'en', link(d1, '77'))).toBe('unknown');
    expect(chat(db, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['77']);
  });
});

describe('cancelFromChat', () => {
  it('lets the chat being removed cancel, and only from a private chat', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    await requestUnlink(d, W, null, unlinkNow(d1, null));
    // The new chat (or any other chat) cannot cancel it.
    expect(await cancelFromChat(d, '77', true, 'en')).toBe(0);
    expect(await cancelFromChat(d, '42', false, 'en')).toBe(0);
    expect(await cancelFromChat(d, '42', true, 'en')).toBe(1);
    // Cancelled: the due tick leaves the chat linked.
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 3 * DAY).d)).toBe(0);
    expect(chat(db, 84532)).toBe('42');
  });
});

describe('applyDueChannelChanges', () => {
  it('clears only the chat the unlink was asked about', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    db.exec(`INSERT INTO telegram_links VALUES ('CODE', '${W}', 84532)`);
    const { d } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    await requestUnlink(d, W, null, unlinkNow(d1, null));
    // The handshake codes go at the request: a code only links.
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_links').get()).toEqual({ n: 0 });
    const due = deps(d1, reader({}), NOW + 2 * DAY);
    expect(await applyDueChannelChanges(due.d)).toBe(1);
    expect(chat(db, 84532)).toBeNull();
    expect(due.sent.map((m) => m.chat)).toEqual(['42']);
    // Applied once: a second tick does nothing.
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 3 * DAY).d)).toBe(0);
  });

  it('a new request supersedes the pending one with a fresh delay', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    await requestUnlink(deps(d1, r).d, W, null, unlinkNow(d1, null));
    await requestUnlink(deps(d1, r, NOW + DAY).d, W, null, unlinkNow(d1, null));
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 2 * DAY).d)).toBe(0);
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 3 * DAY).d)).toBe(1);
    expect(db.prepare(`SELECT state FROM alert_channel_changes ORDER BY id`).all()).toEqual([
      { state: 'superseded' },
      { state: 'applied' },
    ]);
  });

  it('never starts the wait until the chat being removed accepted the notice', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    const out = await requestUnlink(deps(d1, r, NOW, 'transient').d, W, null, unlinkNow(d1, null));
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: null }] });
    // Long past the delay, still untold: nothing is due, and a failed retry
    // keeps it that way.
    const failing = deps(d1, r, NOW + 10 * DAY, 'refused');
    expect(await applyDueChannelChanges(failing.d)).toBe(0);
    expect(failing.sent.map((m) => m.chat)).toEqual(['42']);
    expect(chat(db, 84532)).toBe('42');
    // A retry inside the back-off window sends nothing.
    const soon = deps(d1, r, NOW + 10 * DAY + 60);
    expect(await applyDueChannelChanges(soon.d)).toBe(0);
    expect(soon.sent).toEqual([]);
    // The retry Telegram accepts starts the wait from then.
    const told = NOW + 10 * DAY + NOTICE_RETRY_SECONDS;
    const ok = deps(d1, r, told);
    expect(await applyDueChannelChanges(ok.d)).toBe(0);
    expect(ok.sent.map((m) => m.chat)).toEqual(['42']);
    expect(await applyDueChannelChanges(deps(d1, r, told + 2 * DAY - 1).d)).toBe(0);
    expect(await applyDueChannelChanges(deps(d1, r, told + 2 * DAY).d)).toBe(1);
    expect(chat(db, 84532)).toBeNull();
  });

  it('an immediate link closes the pending change, so it can never apply later', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    expect(await requestRelink(deps(d1, r).d, W, 84532, '77', 'en', link(d1, '77'))).toBe('pending');
    // The chat linked now links again (immediate): the move is superseded.
    expect(await requestRelink(deps(d1, r, NOW + DAY).d, W, 84532, '42', 'en', link(d1, '42'))).toBe('linked');
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 3 * DAY).d)).toBe(0);
    expect(chat(db, 84532)).toBe('42');
    expect(db.prepare(`SELECT state FROM alert_channel_changes`).all()).toEqual([{ state: 'superseded' }]);
  });

  it('a move applies only while the chat it replaces is still the linked one', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    expect(await requestRelink(deps(d1, r).d, W, 84532, '77', 'en', link(d1, '77'))).toBe('pending');
    // Something else changed the chat in between (outside these flows).
    db.exec(`UPDATE user_thresholds SET tg_chat_id = '99'`);
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 2 * DAY).d)).toBe(0);
    expect(chat(db, 84532)).toBe('99');
  });

  it('a wallet-wide unlink revokes the codes of every chain at once', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    db.exec(`INSERT INTO telegram_links VALUES ('A', '${W}', 84532), ('B', '${W}', 97)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    await requestUnlink(deps(d1, r).d, W, null, unlinkNow(d1, null));
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_links').get()).toEqual({ n: 0 });
  });

  it('keeps a protected removal waiting when no bot can send, and tells the chat once one can', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    const noBot: ChannelDeps = { ...deps(d1, r).d, send: null };
    expect(await requestUnlink(noBot, W, null, unlinkNow(d1, null))).toEqual({
      kind: 'done',
      pending: [{ chain_id: 84532, effective_at: null }],
    });
    expect(chat(db, 84532)).toBe('42');
    expect(await applyDueChannelChanges({ ...noBot, now: NOW + 10 * DAY })).toBe(0);
    expect(chat(db, 84532)).toBe('42');
    // The bot is back: the tick tells the chat and starts the wait then.
    const back = deps(d1, r, NOW + 10 * DAY);
    expect(await applyDueChannelChanges(back.d)).toBe(0);
    expect(back.sent.map((m) => m.chat)).toEqual(['42']);
    expect(await applyDueChannelChanges(deps(d1, r, NOW + 12 * DAY).d)).toBe(1);
  });

  it("states each chain's own deadline when one chat waits different delays", async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0), ('${W}', 421614, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY }, 421614: { enabled: true, delaySeconds: 5 * DAY } });
    const { d, sent } = deps(d1, r);
    const out = await requestUnlink(d, W, null, unlinkNow(d1, null));
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
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    let inner = true;
    const racing: ChannelDeps = {
      db: d1,
      read: r,
      now: NOW,
      send: async () => {
        // While the first notice is in flight, a second request replaces the
        // change, and its own notice fails.
        if (inner) {
          inner = false;
          await requestUnlink(deps(d1, r, NOW + 60, 'transient').d, W, null, unlinkNow(d1, null));
        }
        return 'accepted';
      },
    };
    await requestUnlink(racing, W, null, unlinkNow(d1, null));
    expect(db.prepare(`SELECT state, notified_at FROM alert_channel_changes ORDER BY id`).all()).toEqual([
      { state: 'superseded', notified_at: null },
      { state: 'pending', notified_at: null },
    ]);
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 2 * DAY + 60, 'refused').d)).toBe(0);
    expect(chat(db, 84532)).toBe('42');
  });

  it('retries the least recently tried notices first, so refusing chats cannot starve others', async () => {
    const { db, d1 } = sqliteD1();
    // 60 rows whose chats refuse (more than one batch of 50), then one more.
    for (let i = 0; i < 61; i++) {
      const w = `0x${i.toString(16).padStart(40, '0')}`;
      db.exec(`INSERT INTO alert_channel_changes (wallet, chain_id, kind, old_chat_id, requested_at, delay_seconds, state)
               VALUES ('${w}', 84532, 'unlink', '${i === 60 ? 'good' : 'bad' + i}', ${NOW}, ${2 * DAY}, 'pending')`);
    }
    const tried = new Set<string>();
    for (let tick = 0; tick < 2; tick++) {
      const t = NOW + tick * NOTICE_RETRY_SECONDS;
      const d: ChannelDeps = {
        db: d1,
        read: reader({}),
        now: t,
        send: async (c) => {
          tried.add(c);
          return c === 'good' ? 'accepted' : 'refused';
        },
      };
      await applyDueChannelChanges(d);
    }
    expect(tried.has('good')).toBe(true);
    expect(db.prepare(`SELECT notified_at FROM alert_channel_changes WHERE old_chat_id = 'good'`).get()).toEqual({
      notified_at: NOW + NOTICE_RETRY_SECONDS,
    });
  });

  it('a link decided on a stale read re-decides, so a race cannot skip the wait', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds (wallet, chain_id, tg_chat_id, locale, updated_at) VALUES ('${W}', 84532, NULL, 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    let raced = false;
    // The owner's handshake lands between this request's read (no chat)
    // and its write.
    const racing = (expected: string | null) => {
      if (!raced) {
        raced = true;
        db.exec(`UPDATE user_thresholds SET tg_chat_id = '42'`);
      }
      return linkTelegramStatement(d1, W, 84532, '77', expected);
    };
    const { d, sent } = deps(d1, r);
    expect(await requestRelink(d, W, 84532, '77', 'en', racing)).toBe('pending');
    expect(chat(db, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['42', '77']);
  });
});
