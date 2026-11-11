/**
 * #3088 — the Telegram LOCK command: what the agent reads as one, and what it
 * records for the keeper (in the agent's Telegram state object, #1722). The agent signs nothing; the keeper makes the lock
 * call and answers.
 */
import { describe, expect, it } from 'vitest';
import { extractLockCommand, type TelegramUpdate } from '../src/telegram';
import { LOCK_READINESS_FRESH_SEC, recordLockRequests, type LinkStatePort } from '../src/telegramLinks';
import type { LocaleReader } from '../src/alertChannelChange';
import { TelegramStateStore } from '../src/telegramState/store';
import { sqliteDo } from './helpers/sqliteDo';
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

/** The agent's own Diamond on each chain in these tests. */
const DIAMONDS: Record<number, string> = {
  84532: '0x0000000000000000000000000000000000084532',
  421614: '0x0000000000000000000000000000000000421614',
  97: '0x0000000000000000000000000000000000000097',
};

/** The store with each (wallet, chain, chat) linked and each chain's
 *  keeper last seen polling at the given time. */
function harness(links: [string, number, string][], polledAt: [number, number][]) {
  const h = sqliteDo();
  const store = new TelegramStateStore(h.sql, h.tx);
  for (const [wallet, chainId, chatId] of links) {
    store.commit(wallet, chainId, [], [{ op: 'link', chainId, chatId }], 0);
  }
  for (const [chainId, at] of polledAt) store.keeperPoll({ chainId, diamond: DIAMONDS[chainId]! }, at, 1);
  const state = {
    recordLockRequests: async (...a: Parameters<TelegramStateStore['recordLockRequests']>) => store.recordLockRequests(...a),
  } as unknown as LinkStatePort;
  return { db: h.db, store, state };
}

/** The locale stored for each wallet (the shared `user_thresholds` row). */
const locales =
  (by: Record<string, string>): LocaleReader =>
  async (pairs) =>
    pairs.map((p) => by[p.wallet] ?? 'en');

describe('recordLockRequests', () => {
  const NOW = 1_000_000;
  const requests = (db: ReturnType<typeof sqliteDo>['db'], cols = '*') =>
    db.prepare(`SELECT ${cols} FROM lock_requests ORDER BY id`).all();

  it('records one row per wallet and chain the chat is linked to where a keeper is working LOCK, once per update', async () => {
    const { db, state } = harness(
      [
        ['0xaaa', 84532, '42'],
        ['0xaaa', 421614, '42'],
        ['0xbbb', 84532, '99'],
      ],
      [
        [84532, NOW - 60],
        [421614, NOW - 60],
      ],
    );
    const loc = locales({ '0xaaa': 'de' });
    const links = await recordLockRequests(state, loc, '42', 7, NOW, NOW, DIAMONDS);
    expect(links).toEqual([
      { wallet: '0xaaa', chainId: 84532, locale: 'de', recorded: true },
      { wallet: '0xaaa', chainId: 421614, locale: 'de', recorded: true },
    ]);
    // Telegram redelivers the same update: nothing new is recorded.
    await recordLockRequests(state, loc, '42', 7, NOW, NOW, DIAMONDS);
    // No chat is stored with a request: the keeper's answer goes to the chat
    // the wallet is linked to when it answers, so an unlink stops every reply.
    expect(requests(db, 'id, chain_id, wallet, update_id, requested_at, handled_at, outcome')).toEqual([
      { id: 1, chain_id: 84532, wallet: '0xaaa', update_id: 7, requested_at: NOW, handled_at: null, outcome: null },
      { id: 2, chain_id: 421614, wallet: '0xaaa', update_id: 7, requested_at: NOW, handled_at: null, outcome: null },
    ]);
  });

  it('records nothing on a chain whose keeper poll is stale or missing, and says which', async () => {
    const { db, state } = harness(
      [
        ['0xaaa', 84532, '42'],
        ['0xaaa', 421614, '42'],
        ['0xaaa', 97, '42'],
      ],
      [
        [84532, NOW - 60],
        [421614, NOW - LOCK_READINESS_FRESH_SEC - 1],
      ],
    );
    const links = await recordLockRequests(state, locales({}), '42', 7, NOW, NOW, DIAMONDS);
    expect(links.map((l) => [l.chainId, l.recorded])).toEqual([
      [97, false],
      [84532, true],
      [421614, false],
    ]);
    expect(requests(db, 'chain_id')).toEqual([{ chain_id: 84532 }]);
  });

  it('stamps the request with the time the owner SENT it, not the time it arrived (Codex #3092)', async () => {
    const { db, state } = harness([['0xaaa', 84532, '42']], [[84532, NOW - 60]]);
    await recordLockRequests(state, locales({}), '42', 7, NOW - 600, NOW, DIAMONDS);
    // A send time ahead of this clock is recorded as now, never later.
    await recordLockRequests(state, locales({}), '42', 8, NOW + 120, NOW, DIAMONDS);
    expect(requests(db, 'update_id, requested_at')).toEqual([
      { update_id: 7, requested_at: NOW - 600 },
      { update_id: 8, requested_at: NOW },
    ]);
  });

  it('records nothing for a LOCK sent longer ago than the age limit, or with no send time, and still returns the links', async () => {
    const { db, state } = harness([['0xaaa', 84532, '42']], [[84532, NOW - 60]]);
    for (const sentAt of [NOW - LOCK_REQUEST_TTL_SEC - 1, null]) {
      expect(await recordLockRequests(state, locales({}), '42', 7, sentAt, NOW, DIAMONDS)).toEqual([
        { wallet: '0xaaa', chainId: 84532, locale: 'en', recorded: false },
      ]);
    }
    expect(requests(db)).toEqual([]);
    // Exactly at the limit is still in time.
    await recordLockRequests(state, locales({}), '42', 9, NOW - LOCK_REQUEST_TTL_SEC, NOW, DIAMONDS);
    expect(requests(db)).toHaveLength(1);
  });

  it('records nothing for a chat linked to no wallet', async () => {
    const { db, state } = harness([], [[84532, NOW - 60]]);
    expect(await recordLockRequests(state, locales({}), '42', 7, NOW, NOW, DIAMONDS)).toEqual([]);
    expect(requests(db)).toEqual([]);
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
