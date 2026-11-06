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
import { unlinkTelegram, unlinkTelegramOnChain } from '../src/db';

type SqlValue = number | string | null;
const NOW = 1_800_000_000;
const DAY = 86_400;
const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE user_thresholds (wallet TEXT NOT NULL, chain_id INTEGER NOT NULL, tg_chat_id TEXT, locale TEXT, updated_at INTEGER, PRIMARY KEY (wallet, chain_id))`);
  db.exec(`CREATE TABLE telegram_links (code TEXT PRIMARY KEY, wallet TEXT NOT NULL, chain_id INTEGER NOT NULL)`);
  db.exec(readFileSync(new URL('../../indexer/migrations/0084_alert_channel_changes.sql', import.meta.url), 'utf8'));
  const run = (sql: string, args: SqlValue[]) => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } });
  const stmt = (sql: string, args: SqlValue[] = []) => ({
    bind: (...a: SqlValue[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => run(sql, args),
    __exec: () => (/^\s*select/i.test(sql) ? { results: db.prepare(sql).all(...args) } : run(sql, args)),
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestUnlink(d, W, null, unlinkNow(d1, null))).toEqual({ kind: 'done', pending: [] });
    expect(chat(db, 84532)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('waits the delay while protected, keeps the chat and tells it', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0), ('${W}', 421614, '42', 'en', 0)`);
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0), ('${W}', 97, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: false, delaySeconds: 0 } }));
    expect(await requestUnlink(d, W, null, unlinkNow(d1, null))).toEqual({ kind: 'unknown' });
    expect(chat(db, 84532)).toBe('42');
    expect(chat(db, 97)).toBe('42');
    expect(sent).toEqual([]);
  });

  it('never waits longer than the longest delay the contracts allow', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 365 * DAY } }));
    const out = await requestUnlink(d, W, 84532, unlinkNow(d1, 84532));
    expect(out).toEqual({ kind: 'done', pending: [{ chain_id: 84532, effective_at: NOW + MAX_PROTECTED_DELAY_SECONDS }] });
  });
});

describe('requestRelink', () => {
  it('links at once where no chat is linked, or the same chat again', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, NULL, 'en', 0)`);
    let linked = 0;
    const { d } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    expect(await requestRelink(d, W, 84532, '77', 'en', async () => void linked++)).toBe('linked');
    db.exec(`UPDATE user_thresholds SET tg_chat_id = '77'`);
    expect(await requestRelink(d, W, 84532, '77', 'en', async () => void linked++)).toBe('linked');
    expect(linked).toBe(2);
  });

  it('moves to a different chat only after the delay, telling both chats', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } }));
    let linked = 0;
    expect(await requestRelink(d, W, 84532, '77', 'en', async () => void linked++)).toBe('pending');
    expect(linked).toBe(0);
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    const { d, sent } = deps(d1, reader({}));
    expect(await requestRelink(d, W, 84532, '77', 'en', async () => {})).toBe('unknown');
    expect(chat(db, 84532)).toBe('42');
    expect(sent.map((m) => m.chat)).toEqual(['77']);
  });
});

describe('cancelFromChat', () => {
  it('lets the chat being removed cancel, and only from a private chat', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
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
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    expect(await requestRelink(deps(d1, r).d, W, 84532, '77', 'en', async () => {})).toBe('pending');
    // The chat linked now links again (immediate): the move is superseded.
    expect(await requestRelink(deps(d1, r, NOW + DAY).d, W, 84532, '42', 'en', async () => {})).toBe('linked');
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 3 * DAY).d)).toBe(0);
    expect(chat(db, 84532)).toBe('42');
    expect(db.prepare(`SELECT state FROM alert_channel_changes`).all()).toEqual([{ state: 'superseded' }]);
  });

  it('a move applies only while the chat it replaces is still the linked one', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    expect(await requestRelink(deps(d1, r).d, W, 84532, '77', 'en', async () => {})).toBe('pending');
    // Something else changed the chat in between (outside these flows).
    db.exec(`UPDATE user_thresholds SET tg_chat_id = '99'`);
    expect(await applyDueChannelChanges(deps(d1, reader({}), NOW + 2 * DAY).d)).toBe(0);
    expect(chat(db, 84532)).toBe('99');
  });

  it('a wallet-wide unlink revokes the codes of every chain at once', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('${W}', 84532, '42', 'en', 0)`);
    db.exec(`INSERT INTO telegram_links VALUES ('A', '${W}', 84532), ('B', '${W}', 97)`);
    const r = reader({ 84532: { enabled: true, delaySeconds: 2 * DAY } });
    await requestUnlink(deps(d1, r).d, W, null, unlinkNow(d1, null));
    expect(db.prepare('SELECT COUNT(*) AS n FROM telegram_links').get()).toEqual({ n: 0 });
  });
});
