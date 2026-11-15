/**
 * #1722 — the agent's Telegram link steps over its state object: the
 * test-alert chat lookup, and the one warning a chat gets when a LOCK it sent
 * has had no answer from a keeper for an hour.
 */
import { describe, expect, it } from 'vitest';
import { getTelegramChatId, issueTelegramLinkCode, LOCK_UNANSWERED_SEC, warnUnansweredLocks, type LinkStatePort } from '../src/telegramLinks';
import type { LocaleReader } from '../src/alertChannelChange';
import { TelegramStateStore } from '../src/telegramState/store';
import type { TelegramOutcome } from '../src/telegram';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';
const w = W.toLowerCase();
const CHAIN = 84532;
const NOW = 1_800_000_000;
const DIAMOND = '0x63816b149266c9dbfb7683dfd02d851915238049';
const DEP = { chainId: CHAIN, diamond: DIAMOND };

function harness() {
  const h = sqliteDo();
  const store = new TelegramStateStore(h.sql, h.tx);
  return { db: h.db, store };
}
const locales =
  (locale: string): LocaleReader =>
  async (pairs) =>
    pairs.map(() => locale);

describe('getTelegramChatId', () => {
  it('returns the chat and locale of a linked wallet, whatever its spelling', async () => {
    const { store } = harness();
    store.commit(w, CHAIN, [], [{ op: 'link', chainId: CHAIN, chatId: '9876' }], 0);
    const state = { chatsOf: async (p: { wallet: string; chainId: number }[]) => store.chatsOf(p) } as unknown as LinkStatePort;
    expect(await getTelegramChatId(state, locales('ta'), W, CHAIN)).toEqual({ chatId: '9876', locale: 'ta' });
    expect(await getTelegramChatId(state, locales('ta'), W, 97)).toBeNull();
  });
});

describe('issueTelegramLinkCode', () => {
  it('makes the alerts row before the code, and issues no code when it cannot (Codex #3571 r1)', async () => {
    const { store } = harness();
    const state = {
      issueLinkCode: async (...a: Parameters<TelegramStateStore['issueLinkCode']>) => store.issueLinkCode(...a),
    } as unknown as LinkStatePort;
    const order: string[] = [];
    const code = await issueTelegramLinkCode(
      state,
      async (wallet, chainId) => {
        order.push(`row ${wallet} ${chainId}`);
      },
      w,
      CHAIN,
      NOW,
    );
    expect(order).toEqual([`row ${w} ${CHAIN}`]);
    expect(store.consumeLinkCode(code, NOW)).toEqual({ wallet: w, chainId: CHAIN });

    let issued = 0;
    const counting = { issueLinkCode: async () => (issued++, true) } as unknown as LinkStatePort;
    await expect(
      issueTelegramLinkCode(counting, async () => Promise.reject(new Error('d1 down')), w, CHAIN, NOW),
    ).rejects.toThrow('d1 down');
    expect(issued).toBe(0);
  });
});

describe('warnUnansweredLocks', () => {
  function recorded() {
    const { db, store } = harness();
    store.commit(w, CHAIN, [], [{ op: 'link', chainId: CHAIN, chatId: '42' }], 0);
    store.keeperPoll(DEP, NOW, 1);
    store.recordLockRequests('42', 1, NOW, NOW - 300, { [CHAIN]: DIAMOND });
    store.recordLockRequests('42', 2, NOW + 60, NOW - 300, { [CHAIN]: DIAMOND });
    const state = { takeUnansweredLocks: async (...a: Parameters<TelegramStateStore['takeUnansweredLocks']>) => store.takeUnansweredLocks(...a) };
    const sent: { chat: string; text: string }[] = [];
    const send = (o: TelegramOutcome = 'accepted') => async (chat: string, text: string) => {
      sent.push({ chat, text });
      return o;
    };
    return { db, store, state, sent, send };
  }

  it('warns once per wallet and chain, only after an hour without an answer', async () => {
    const { state, sent, send } = recorded();
    expect(await warnUnansweredLocks(state, locales('en'), send(), NOW + LOCK_UNANSWERED_SEC - 1)).toBe(0);
    expect(sent).toEqual([]);
    expect(await warnUnansweredLocks(state, locales('en'), send(), NOW + LOCK_UNANSWERED_SEC + 60)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe('42');
    expect(sent[0]!.text).toContain('has not answered your LOCK');
    expect(sent[0]!.text).toContain('Vaipakam app');
    // Told once: a later tick says nothing more.
    expect(await warnUnansweredLocks(state, locales('en'), send(), NOW + 3 * LOCK_UNANSWERED_SEC)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('says nothing for a request the keeper answered', async () => {
    const { store, state, sent, send } = recorded();
    store.markLockHandled(DEP, w, 2, 'locked', NOW + 120);
    expect(await warnUnansweredLocks(state, locales('en'), send(), NOW + 2 * LOCK_UNANSWERED_SEC)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('takes nothing while no bot can send, so a later tick still warns', async () => {
    const { state, sent, send } = recorded();
    expect(await warnUnansweredLocks(state, locales('en'), null, NOW + 2 * LOCK_UNANSWERED_SEC)).toBe(0);
    expect(await warnUnansweredLocks(state, locales('en'), send(), NOW + 2 * LOCK_UNANSWERED_SEC)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('does not retry a warning Telegram refused (at most once)', async () => {
    const { state, sent, send } = recorded();
    expect(await warnUnansweredLocks(state, locales('en'), send('transient'), NOW + 2 * LOCK_UNANSWERED_SEC)).toBe(0);
    expect(await warnUnansweredLocks(state, locales('en'), send(), NOW + 3 * LOCK_UNANSWERED_SEC)).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
