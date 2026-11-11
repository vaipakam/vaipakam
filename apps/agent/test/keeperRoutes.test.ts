/**
 * #1722 — the routes the keeper reaches the agent's Telegram state through:
 * they fail closed without a token, refuse a wrong token or a Diamond other
 * than the agent's own, answer a repeated LOCK report once, and send only
 * alerts that parse.
 */
import { describe, expect, it } from 'vitest';
import { handleKeeperRoute, channelResult, type KeeperRouteDeps } from '../src/keeperRoutes';
import type { KeeperStatePort } from '../src/telegramLinks';
import { TelegramStateStore } from '../src/telegramState/store';
import type { TelegramOutcome } from '../src/telegram';
import { sqliteDo } from './helpers/sqliteDo';

const TOKEN = 'keeper-route-secret';
const DIAMOND = '0x63816B149266C9dBFB7683dfd02D851915238049';
const W = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_800_000_000;
const CHAIN = 84532;

function harness(over: Partial<KeeperRouteDeps> = {}, outcome: TelegramOutcome = 'accepted') {
  const h = sqliteDo();
  const store = new TelegramStateStore(h.sql, h.tx);
  const state: KeeperStatePort = {
    keeperPoll: async (...a) => store.keeperPoll(...a),
    pendingLockWallets: async (...a) => store.pendingLockWallets(...a),
    markLockHandled: async (...a) => store.markLockHandled(...a),
    takeUnansweredLocks: async (...a) => store.takeUnansweredLocks(...a),
    chatsOf: async (...a) => store.chatsOf(...a),
  };
  const sent: { chat: string; text: string }[] = [];
  const deps: KeeperRouteDeps = {
    token: TOKEN,
    state,
    locales: async (pairs) => pairs.map(() => 'en'),
    send: async (chat, text) => {
      sent.push({ chat, text });
      return outcome;
    },
    diamondOf: (c) => (c === CHAIN ? DIAMOND : null),
    chainName: () => 'Base Sepolia',
    appOrigin: 'https://app.example',
    now: () => NOW,
    ...over,
  };
  const call = async (path: string, body: unknown, auth: string | null = `Bearer ${TOKEN}`, method = 'POST') => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth !== null) headers.Authorization = auth;
    const req = new Request(`https://agent.example${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const res = (await handleKeeperRoute(req, path, deps))!;
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const link = (wallet: string, chatId: string) => store.commit(wallet, CHAIN, [], [{ op: 'link', chainId: CHAIN, chatId }], 0);
  return { store, sent, call, link };
}

const base = { chainId: CHAIN, diamond: DIAMOND };

describe('keeper route authority', () => {
  it('is not a keeper route outside /keeper/', async () => {
    const res = await handleKeeperRoute(new Request('https://agent.example/tg/webhook', { method: 'POST' }), '/tg/webhook', {} as KeeperRouteDeps);
    expect(res).toBeNull();
  });

  it('answers 503 on every route when no token is configured', async () => {
    const { call } = harness({ token: undefined });
    expect((await call('/keeper/lock/poll', base)).status).toBe(503);
    expect((await call('/keeper/alerts', base, null)).status).toBe(503);
  });

  it('refuses a missing or wrong token, and a GET', async () => {
    const { call } = harness();
    expect((await call('/keeper/lock/poll', base, null)).status).toBe(401);
    expect((await call('/keeper/lock/poll', base, 'Bearer wrong')).status).toBe(401);
    expect((await call('/keeper/lock/poll', base, TOKEN)).status).toBe(401);
    expect((await call('/keeper/lock/poll', base, 'Bearer ')).status).toBe(401);
    expect((await call('/keeper/lock/poll', base, `Bearer ${TOKEN}`, 'GET')).status).toBe(405);
  });

  it('refuses a Diamond other than its own, and a chain it does not serve', async () => {
    const { call } = harness();
    const other = await call('/keeper/lock/poll', { ...base, diamond: B });
    expect(other).toEqual({ status: 409, body: { error: 'diamond-mismatch', diamond: DIAMOND } });
    // The same Diamond in another case is the same Diamond.
    expect((await call('/keeper/lock/poll', { ...base, diamond: DIAMOND.toLowerCase() })).status).toBe(200);
    expect((await call('/keeper/lock/poll', { chainId: 1, diamond: DIAMOND })).status).toBe(404);
    expect((await call('/keeper/lock/poll', { chainId: CHAIN })).status).toBe(400);
  });

  it('refuses a body that is not a JSON object, or too large', async () => {
    const { call } = harness();
    expect((await call('/keeper/lock/poll', 'not json')).status).toBe(400);
    expect((await call('/keeper/lock/poll', [1, 2])).status).toBe(400);
    expect((await call('/keeper/lock/poll', { ...base, pad: 'x'.repeat(70 * 1024) })).status).toBe(413);
    expect((await call('/keeper/unknown', base)).status).toBe(404);
  });
});

describe('LOCK routes', () => {
  it('a poll marks the chain as worked and returns the open requests', async () => {
    const { store, call, link } = harness();
    link(W, '42');
    // No keeper has polled: a LOCK is not recorded.
    expect(store.recordLockRequests('42', 1, NOW, NOW - 300)[0]!.recorded).toBe(false);
    expect((await call('/keeper/lock/poll', base)).body).toEqual({ requests: [] });
    expect(store.recordLockRequests('42', 2, NOW, NOW - 300)[0]!.recorded).toBe(true);
    const polled = await call('/keeper/lock/poll', { ...base, limit: 5 });
    expect(polled.body).toEqual({ requests: [{ id: 1, wallet: W, requestedAt: NOW }] });
    expect((await call('/keeper/lock/poll', { ...base, limit: 51 })).status).toBe(400);
    expect((await call('/keeper/lock/pending', { ...base, since: NOW - 10 })).body).toEqual({ wallets: [W] });
    expect((await call('/keeper/lock/pending', { ...base, since: -1 })).status).toBe(400);
  });

  it('records an outcome once and tells the linked chat once', async () => {
    const { store, sent, call, link } = harness();
    link(W, '42');
    store.keeperPoll(CHAIN, NOW, 1);
    store.recordLockRequests('42', 1, NOW, NOW - 300);
    const report = { ...base, wallet: W.toUpperCase().replace('0X', '0x'), upToId: 1, outcome: 'locked' };
    expect((await call('/keeper/lock/handled', report)).body).toEqual({ recorded: true, telegram: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe('42');
    expect(sent[0]!.text).toContain('now locked');
    // A retry after a lost answer records nothing and sends nothing.
    expect((await call('/keeper/lock/handled', report)).body).toEqual({ recorded: false, telegram: 'off' });
    expect(sent).toHaveLength(1);
  });

  it('records a silent drop without a message, and refuses an unknown outcome or a bad reason', async () => {
    const { store, sent, call, link } = harness();
    link(W, '42');
    store.keeperPoll(CHAIN, NOW, 1);
    store.recordLockRequests('42', 1, NOW, NOW - 300);
    const report = { ...base, wallet: W, upToId: 1 };
    expect((await call('/keeper/lock/handled', { ...report, outcome: 'whatever' })).status).toBe(400);
    expect((await call('/keeper/lock/handled', { ...report, outcome: 'refused', reason: 'see x.io' })).status).toBe(400);
    expect((await call('/keeper/lock/handled', { ...report, outcome: 'refused' })).status).toBe(400);
    expect((await call('/keeper/lock/handled', { ...report, wallet: '0x1', outcome: 'locked' })).status).toBe(400);
    expect((await call('/keeper/lock/handled', { ...report, outcome: 'dropped-old' })).body).toEqual({ recorded: true, telegram: 'off' });
    expect(sent).toEqual([]);
  });

  it('names a refusal, and answers off when the wallet is unlinked or no bot can send', async () => {
    const { store, sent, call, link } = harness();
    link(W, '42');
    store.keeperPoll(CHAIN, NOW, 1);
    store.recordLockRequests('42', 1, NOW, NOW - 300);
    store.recordLockRequests('42', 2, NOW, NOW - 300);
    const refused = await call('/keeper/lock/handled', { ...base, wallet: W, upToId: 1, outcome: 'refused', reason: 'NotOwner' });
    expect(refused.body).toEqual({ recorded: true, telegram: 'sent' });
    expect(sent[0]!.text).toContain('(NotOwner)');
    store.commit(W, CHAIN, [{ chainId: CHAIN, chatId: '42' }], [{ op: 'clear', chainId: CHAIN }], 0);
    expect((await call('/keeper/lock/handled', { ...base, wallet: W, upToId: 2, outcome: 'expired' })).body).toEqual({ recorded: true, telegram: 'off' });

    const noBot = harness({ send: undefined });
    noBot.link(W, '42');
    noBot.store.keeperPoll(CHAIN, NOW, 1);
    noBot.store.recordLockRequests('42', 1, NOW, NOW - 300);
    expect((await noBot.call('/keeper/lock/handled', { ...base, wallet: W, upToId: 1, outcome: 'locked' })).body).toEqual({ recorded: true, telegram: 'off' });
  });
});

describe('alerts route', () => {
  const alert = (wallet: string, extra: Record<string, unknown> = {}) => ({
    chainId: CHAIN,
    wallet,
    alert: { kind: 'hf', band: 'critical', loanId: 7, hf: 1.01 },
    ...extra,
  });

  it('sends each alert to the chat linked to its recipient, in order', async () => {
    const { sent, call, link } = harness();
    link(W, '42');
    link(B, '77');
    const out = await call('/keeper/alerts', {
      ...base,
      alerts: [
        alert(W),
        alert(B, { alert: { kind: 'text', text: 'click https://evil.example' } }),
        alert('0xcccccccccccccccccccccccccccccccccccccccc'),
        alert(W, { chainId: 421614 }),
        alert(W, { to: B }),
      ],
    });
    expect(out.body).toEqual({ results: ['sent', 'refused', 'off', 'refused', 'sent'] });
    expect(sent.map((m) => m.chat)).toEqual(['42', '77']);
    expect(sent[0]!.text).toContain('https://app.example');
    expect(sent.some((m) => m.text.includes('evil'))).toBe(false);
  });

  it('maps a send that was not accepted to the keeper outcome', async () => {
    for (const [o, r] of [
      ['refused', 'refused'],
      ['transient', 'retry'],
      ['unknown', 'retry'],
    ] as const) {
      const { call, link } = harness({}, o);
      link(W, '42');
      expect((await call('/keeper/alerts', { ...base, alerts: [alert(W)] })).body, o).toEqual({ results: [r] });
      expect(channelResult(o)).toBe(r);
    }
  });

  it('refuses an empty or oversized batch', async () => {
    const { call } = harness();
    expect((await call('/keeper/alerts', { ...base, alerts: [] })).status).toBe(400);
    expect((await call('/keeper/alerts', { ...base, alerts: Array.from({ length: 26 }, () => alert(W)) })).status).toBe(400);
    expect((await call('/keeper/alerts', { ...base, alerts: 'x' })).status).toBe(400);
  });
});
