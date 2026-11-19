/**
 * #3434 part 2 — the EIP-7702 delegation watch, over the real shared schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { delegationNotice, runDelegationWatchChain, type DelegationDeps } from '../src/delegationWatch';
import { createSqliteD1 } from '../../indexer/test/helpers/sqliteD1';

const DIR = new URL('../../indexer/migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const CHAIN = { id: 84532, name: 'Base Sepolia' };
const A = '0x00000000000000000000000000000000000000aa';
const B = '0x00000000000000000000000000000000000000bb';
const DELEGATE = '00000000000000000000000000000000000000dd';
const OTHER = '00000000000000000000000000000000000000ee';

function setup() {
  const h = createSqliteD1(MIGRATIONS);
  for (const w of [A, B]) {
    h.db
      .prepare(
        `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, locale, created_at, updated_at)
         VALUES (?, ?, 1.5, 1.2, 1.05, ?, 'en', 1, 1)`,
      )
      .run(w, CHAIN.id, w === A ? 'subscribed' : null);
  }
  let codes: Record<string, `0x${string}` | undefined> = {};
  const sent: { to: string; text: string }[] = [];
  const deps = (over: Partial<DelegationDeps> = {}): DelegationDeps => ({
    db: h.d1 as D1Database,
    readCodes: async (ws) => new Map(ws.map((w) => [w.toLowerCase(), codes[w.toLowerCase()]])),
    readCostsAProbe: () => false,
    chatsOf: async (pairs) => pairs.map((p) => `chat-${p.wallet}`),
    sendTelegram: async (chat, text) => {
      sent.push({ to: chat, text });
      return 'accepted';
    },
    sendPush: async (wallet, title) => {
      sent.push({ to: `push-${wallet}`, text: title });
      return 'accepted';
    },
    link: 'https://app.example',
    ...over,
  });
  const stored = () =>
    Object.fromEntries(
      (h.db.prepare('SELECT wallet, delegation FROM owner_delegation ORDER BY wallet').all() as { wallet: string; delegation: string }[]).map(
        (r) => [r.wallet, r.delegation],
      ),
    );
  return { h, deps, sent, stored, setCodes: (c: typeof codes) => (codes = c) };
}

describe('runDelegationWatchChain', () => {
  it('tells an owner found delegated, once, and records plain wallets silently', async () => {
    const t = setup();
    t.setCodes({ [A]: `0xef0100${DELEGATE}`, [B]: '0x' });
    expect(await runDelegationWatchChain(t.deps(), CHAIN, { remaining: 10 }, 100)).toBe(1);
    expect(t.sent.map((s) => s.to).sort()).toEqual([`chat-${A}`, `push-${A}`]);
    expect(t.sent.find((s) => s.to === `chat-${A}`)!.text).toContain(`delegated (EIP-7702) to the contract 0x${DELEGATE}`);
    expect(t.stored()).toEqual({ [A]: `0x${DELEGATE}`, [B]: '' });
    // Unchanged on the next lap: nothing more.
    await runDelegationWatchChain(t.deps(), CHAIN, { remaining: 10 }, 200);
    expect(t.sent).toHaveLength(2);
  });

  it('tells a change of delegate and a removal', async () => {
    const t = setup();
    t.setCodes({ [A]: `0xef0100${DELEGATE}`, [B]: `0xef0100${DELEGATE}` });
    await runDelegationWatchChain(t.deps(), CHAIN, { remaining: 10 }, 100);
    t.sent.length = 0;
    t.setCodes({ [A]: `0xef0100${OTHER}`, [B]: '0x' });
    await runDelegationWatchChain(t.deps({ sendPush: null }), CHAIN, { remaining: 10 }, 200);
    const texts = Object.fromEntries(t.sent.map((s) => [s.to, s.text]));
    expect(texts[`chat-${A}`]).toContain(`to the contract 0x${OTHER}`);
    expect(texts[`chat-${B}`]).toContain('was removed');
  });

  it('keeps every reading when the code read fails', async () => {
    const t = setup();
    expect(await runDelegationWatchChain(t.deps({ readCodes: async () => null }), CHAIN, { remaining: 10 }, 100)).toBe(0);
    expect(t.stored()).toEqual({});
  });

  it('leaves a notice the allowance cannot carry for the next lap', async () => {
    const t = setup();
    t.setCodes({ [A]: `0xef0100${DELEGATE}`, [B]: `0xef0100${DELEGATE}` });
    // 1 read + 1 codes + 1 chats = 3; 6 leaves 2 sends (A on two rails) and the write.
    await runDelegationWatchChain(t.deps(), CHAIN, { remaining: 6 }, 100);
    expect(t.stored()).toEqual({ [A]: `0x${DELEGATE}` });
    await runDelegationWatchChain(t.deps(), CHAIN, { remaining: 10 }, 200);
    expect(t.sent.map((s) => s.to)).toContain(`chat-${B}`);
  });
});

describe('delegationNotice', () => {
  it('says nothing for no change, contract code, or a plain wallet first seen', () => {
    expect(delegationNotice(A, 'X', '0xdd', '0xdd')).toBeNull();
    expect(delegationNotice(A, 'X', null, 'contract')).toBeNull();
    expect(delegationNotice(A, 'X', null, '')).toBeNull();
  });
});
