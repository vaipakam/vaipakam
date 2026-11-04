/**
 * #3088 — the Telegram LOCK command: what the agent reads as one, and what it
 * records for the keeper. The agent signs nothing; the keeper makes the lock
 * call and answers.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { extractLockCommand, type TelegramUpdate } from '../src/telegram';
import { recordLockRequests } from '../src/db';
import { lockNotRunning, lockRecorded, lockStale } from '../src/i18n';
import { LOCK_REQUEST_TTL_SEC } from '@vaipakam/lib/protectedLock';

const SENT = 1_700_000_000;
const update = (text: string, type = 'private', date: unknown = SENT): TelegramUpdate =>
  ({ update_id: 7, message: { chat: { id: 42, type }, date, text } }) as TelegramUpdate;

describe('extractLockCommand', () => {
  it('reads LOCK, /lock and /lock@Bot, case-blind', () => {
    for (const text of ['LOCK', 'lock', ' Lock ', '/lock', '/LOCK@VaipakamBot']) {
      expect(extractLockCommand(update(text)), text).toEqual({ chatId: '42', updateId: 7, sentAt: SENT, isPrivate: true });
    }
  });

  it('says when the chat is not a private one', () => {
    expect(extractLockCommand(update('LOCK', 'group'))).toEqual({ chatId: '42', updateId: 7, sentAt: SENT, isPrivate: false });
  });

  it("carries the message's own send time, and null when it is absent or not a time", () => {
    for (const date of [0, -5, 1.5, '1700000000']) {
      expect(extractLockCommand(update('LOCK', 'private', date))?.sentAt, String(date)).toBeNull();
    }
    expect(extractLockCommand({ update_id: 7, message: { chat: { id: 42, type: 'private' }, text: 'LOCK' } })?.sentAt).toBeNull();
  });

  it('ignores anything else, and an update without its id', () => {
    for (const text of ['unlock', 'LOCK now', 'lock 0xabc', '/start LOCK', 'LOCKED']) {
      expect(extractLockCommand(update(text)), text).toBeNull();
    }
    expect(extractLockCommand({ message: { chat: { id: 42, type: 'private' }, text: 'LOCK' } })).toBeNull();
  });
});

type SqlValue = number | string | null;

function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE user_thresholds (wallet TEXT NOT NULL, chain_id INTEGER NOT NULL, tg_chat_id TEXT, locale TEXT, PRIMARY KEY (wallet, chain_id))`);
  db.exec(readFileSync(new URL('../../indexer/migrations/0083_protected_lock_requests.sql', import.meta.url), 'utf8'));
  const stmt = (sql: string, args: SqlValue[] = []) => ({
    bind: (...a: SqlValue[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    __exec: () => (/^\s*select/i.test(sql) ? { results: db.prepare(sql).all(...args) } : { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    db,
    d1: {
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
    } as unknown as D1Database,
  };
}

describe('recordLockRequests', () => {
  const NOW = 1_000_000;

  it('records one row per wallet and chain the chat is linked to where a keeper is working LOCK, once per update', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('0xaaa', 84532, '42', 'de'), ('0xaaa', 421614, '42', 'de'), ('0xbbb', 84532, '99', 'en')`);
    db.exec(`INSERT INTO protected_lock_readiness VALUES (84532, ${NOW - 60}), (421614, ${NOW - 60})`);
    const links = await recordLockRequests(d1, '42', 7, NOW, NOW);
    expect(links).toEqual([
      { wallet: '0xaaa', chainId: 84532, locale: 'de', recorded: true },
      { wallet: '0xaaa', chainId: 421614, locale: 'de', recorded: true },
    ]);
    // Telegram redelivers the same update: nothing new is recorded.
    await recordLockRequests(d1, '42', 7, NOW, NOW);
    const rows = db.prepare('SELECT * FROM protected_lock_requests ORDER BY id').all();
    // No chat is stored with a request: the keeper answers in the chat the
    // wallet is linked to when it answers, so an unlink stops every reply.
    expect(rows).toEqual([
      { id: 1, chain_id: 84532, wallet: '0xaaa', update_id: 7, requested_at: NOW, handled_at: null, outcome: null },
      { id: 2, chain_id: 421614, wallet: '0xaaa', update_id: 7, requested_at: NOW, handled_at: null, outcome: null },
    ]);
  });

  it('records nothing on a chain whose keeper heartbeat is stale or missing, and says which', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('0xaaa', 84532, '42', 'en'), ('0xaaa', 421614, '42', 'en'), ('0xaaa', 97, '42', 'en')`);
    db.exec(`INSERT INTO protected_lock_readiness VALUES (84532, ${NOW - 60}), (421614, ${NOW - 301})`);
    const links = await recordLockRequests(d1, '42', 7, NOW, NOW);
    expect(links.map((l) => [l.chainId, l.recorded])).toEqual([
      [97, false],
      [84532, true],
      [421614, false],
    ]);
    expect(db.prepare('SELECT chain_id FROM protected_lock_requests').all()).toEqual([{ chain_id: 84532 }]);
  });

  it("stamps the request with the time the owner SENT it, not the time it arrived (Codex #3092)", async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('0xaaa', 84532, '42', 'en')`);
    db.exec(`INSERT INTO protected_lock_readiness VALUES (84532, ${NOW - 60})`);
    await recordLockRequests(d1, '42', 7, NOW - 600, NOW);
    // A send time ahead of this clock is recorded as now, never later.
    await recordLockRequests(d1, '42', 8, NOW + 120, NOW);
    expect(db.prepare('SELECT update_id, requested_at FROM protected_lock_requests ORDER BY id').all()).toEqual([
      { update_id: 7, requested_at: NOW - 600 },
      { update_id: 8, requested_at: NOW },
    ]);
  });

  it('records nothing for a LOCK sent longer ago than the age limit, or with no send time, and still returns the links', async () => {
    const { db, d1 } = sqliteD1();
    db.exec(`INSERT INTO user_thresholds VALUES ('0xaaa', 84532, '42', 'en')`);
    db.exec(`INSERT INTO protected_lock_readiness VALUES (84532, ${NOW - 60})`);
    for (const sentAt of [NOW - LOCK_REQUEST_TTL_SEC - 1, null]) {
      expect(await recordLockRequests(d1, '42', 7, sentAt, NOW)).toEqual([{ wallet: '0xaaa', chainId: 84532, locale: 'en', recorded: false }]);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM protected_lock_requests').get()).toEqual({ n: 0 });
    // Exactly at the limit is still in time.
    await recordLockRequests(d1, '42', 9, NOW - LOCK_REQUEST_TTL_SEC, NOW);
    expect(db.prepare('SELECT COUNT(*) AS n FROM protected_lock_requests').get()).toEqual({ n: 1 });
  });

  it('records nothing for a chat linked to no wallet', async () => {
    const { db, d1 } = sqliteD1();
    expect(await recordLockRequests(d1, '42', 7, NOW, NOW)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM protected_lock_requests').get()).toEqual({ n: 0 });
  });
});

describe('the reply', () => {
  it('names every link and says nothing is locked yet', () => {
    const text = lockRecorded('en', [{ walletShort: '0xaaa…', chainId: 84532 }, { walletShort: '0xaaa…', chainId: 421614 }]);
    expect(text).toContain('wallet 0xaaa… on chain 84532; wallet 0xaaa… on chain 421614');
    expect(text).toContain('Nothing is locked yet');
  });

  it('says a late LOCK was not recorded, and where to lock instead', () => {
    const text = lockStale('en');
    expect(text).toContain('more than an hour ago');
    expect(text).toContain('nothing will be locked');
    expect(text).toContain('Vaipakam app');
  });

  it('says plainly when nothing will act on the request, and where to lock instead', () => {
    const text = lockNotRunning('en', [{ walletShort: '0xaaa…', chainId: 97 }]);
    expect(text).toContain('not running right now for wallet 0xaaa… on chain 97');
    expect(text).toContain('nothing will be locked from this message');
    expect(text).toContain('Vaipakam app');
  });
});
