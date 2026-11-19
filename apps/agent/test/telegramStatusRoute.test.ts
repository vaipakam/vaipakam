/**
 * #3573 — the owner's own Telegram status: the signed read issues a pass
 * under the signer's scope, the pass reads again, and the answer carries no
 * chat id and no phrase.
 */
import { describe, expect, it } from 'vitest';
import {
  answerPassStatus,
  answerSignedStatus,
  parsePassRequest,
  READ_PASS_TTL_SEC,
  readPassHash,
  type StatusStatePort,
} from '../src/telegramStatusRoute';
import { TelegramStateStore } from '../src/telegramState/store';
import { sqliteDo } from './helpers/sqliteDo';

const W = '0xAbC0000000000000000000000000000000000001';
const w = W.toLowerCase();
const NOW = 1_800_000_000;

function harness() {
  const h = sqliteDo();
  const store = new TelegramStateStore(h.sql, h.tx);
  const port: StatusStatePort = {
    issueReadPass: async (...a) => store.issueReadPass(...a),
    readPassScope: async (...a) => store.readPassScope(...a),
    linkStatus: async (...a) => store.linkStatus(...a),
  };
  return { store, port };
}

describe('linkStatus', () => {
  it('says linked, pending and phrase-set, and never the chat or the phrase', () => {
    const { store } = harness();
    expect(store.linkStatus(W, 1)).toEqual({ chainId: 1, linked: false, pending: null, phraseSet: false });
    store.commit(w, 1, [], [{ op: 'link', chainId: 1, chatId: '42' }], NOW);
    store.setPhrase(w, [1], 'blue heron', NOW);
    const done = store.commit(
      w,
      1,
      [{ chainId: 1, chatId: '42' }],
      [{ op: 'pend', chainId: 1, kind: 'unlink', oldChatId: '42', newChatId: null, delaySeconds: 3600 }],
      NOW,
    );
    expect(done.ok).toBe(true);
    const status = store.linkStatus(W, 1);
    expect(status).toEqual({ chainId: 1, linked: true, pending: { kind: 'unlink', effectiveAt: null }, phraseSet: true });
    expect(JSON.stringify(status)).not.toContain('42');
    expect(JSON.stringify(status)).not.toContain('heron');
    store.markNotified(done.ok ? done.ids : [], NOW + 10);
    expect(store.linkStatus(W, 1).pending).toEqual({ kind: 'unlink', effectiveAt: NOW + 10 + 3600 });
    // Another chain is its own answer.
    expect(store.linkStatus(W, 2)).toEqual({ chainId: 2, linked: false, pending: null, phraseSet: false });
  });
});

describe('the read pass', () => {
  it('a wallet signature reads every chain; a smart account reads the signed one only', async () => {
    const { store, port } = harness();
    store.commit(w, 1, [], [{ op: 'link', chainId: 1, chatId: '42' }], NOW);

    const plain = await answerSignedStatus(port, W, 1, 'ecdsa', NOW);
    expect(plain.scope).toBe('wallet');
    expect(plain.wallet).toBe(w);
    expect(plain.status.linked).toBe(true);
    expect(plain.passExpiresAt).toBe(NOW + READ_PASS_TTL_SEC);
    expect(await answerPassStatus(port, plain.pass, 2, NOW + 1)).toEqual({
      ok: true,
      wallet: w,
      status: { chainId: 2, linked: false, pending: null, phraseSet: false },
    });

    const smart = await answerSignedStatus(port, W, 1, 'chain', NOW);
    expect(smart.scope).toBe('chain');
    expect((await answerPassStatus(port, smart.pass, 1, NOW + 1)).ok).toBe(true);
    expect(await answerPassStatus(port, smart.pass, 2, NOW + 1)).toEqual({ ok: false, error: 'pass-other-chain' });
  });

  it('keeps only the digest, and refuses an unknown or expired pass', async () => {
    const { store, port } = harness();
    const { pass } = await answerSignedStatus(port, W, 1, 'ecdsa', NOW);
    expect(store.readPassScope(pass, NOW)).toBeNull();
    expect(store.readPassScope(await readPassHash(pass), NOW)).toEqual({ wallet: w, chainId: null });
    expect(await answerPassStatus(port, 'A'.repeat(43), 1, NOW)).toEqual({ ok: false, error: 'pass-expired' });
    expect(await answerPassStatus(port, pass, 1, NOW + READ_PASS_TTL_SEC + 1)).toEqual({
      ok: false,
      error: 'pass-expired',
    });
    store.sweepExpiredCodes(NOW + READ_PASS_TTL_SEC + 1);
    expect(store.readPassScope(await readPassHash(pass), NOW)).toBeNull();
  });

  it('holds at most a few passes per wallet, dropping the oldest', async () => {
    const { store, port } = harness();
    const passes: string[] = [];
    for (let i = 0; i <= TelegramStateStore.MAX_READ_PASSES; i++) {
      passes.push((await answerSignedStatus(port, W, 1, 'ecdsa', NOW + i)).pass);
    }
    expect(store.readPassScope(await readPassHash(passes[0]!), NOW)).toBeNull();
    expect(store.readPassScope(await readPassHash(passes.at(-1)!), NOW)).not.toBeNull();
  });
});

describe('parsePassRequest', () => {
  it('takes a well-formed pass and chain id only', () => {
    const pass = 'a'.repeat(43);
    expect(parsePassRequest({ pass, chain_id: 84532 })).toEqual({ ok: true, pass, chainId: 84532 });
    expect(parsePassRequest({ pass: 'short', chain_id: 1 })).toEqual({ ok: false, reason: 'pass' });
    expect(parsePassRequest({ pass, chain_id: '1' })).toEqual({ ok: false, reason: 'chain_id' });
    expect(parsePassRequest(null)).toEqual({ ok: false, reason: 'body' });
  });
});
