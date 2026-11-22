import { buildUnwatchLoanMessage, buildWatchLoanMessage } from '@vaipakam/lib/watchedLoans';
import { describe, expect, it } from 'vitest';
import { knownAfter, readKnownWatch, readWatchAnswer, watchable, watchBody, watchMessage, watchPath, writeKnownWatch } from './watch';

const W = '0x00000000000000000000000000000000000000aa' as const;
const S = '0x1234' as const;
const watch = { kind: 'watch', loanId: 7n } as const;
const unwatch = { kind: 'unwatch', loanId: 7n } as const;
const list = { kind: 'list' } as const;

describe('watch requests', () => {
  it('signs the shared message for the named loan', () => {
    expect(watchMessage(watch, W, 84532, 100)).toBe(buildWatchLoanMessage(W, 84532, 7, 100));
    expect(watchMessage(unwatch, W, 84532, 100)).toBe(buildUnwatchLoanMessage(W, 84532, 7, 100));
  });
  it('sends each action to its route with the loan id as a number', () => {
    expect(watchPath(watch)).toBe('/watch/loans/add');
    expect(watchPath(unwatch)).toBe('/watch/loans/remove');
    expect(watchPath(list)).toBe('/watch/loans/list');
    expect(watchBody(watch, W, 1, 2, S)).toEqual({ wallet: W, chain_id: 1, issuedAt: 2, signature: S, loanId: 7 });
    expect(watchBody(list, W, 1, 2, S)).not.toHaveProperty('loanId');
  });
  it('refuses an id the service cannot take', () => {
    expect(watchable(1n)).toBe(true);
    expect(watchable(0n)).toBe(false);
    expect(watchable(2n ** 53n)).toBe(false);
  });
});

describe('readWatchAnswer', () => {
  it('reads a watch, and whether Telegram is linked', () => {
    expect(readWatchAnswer(watch, 200, { ok: true, watching: true, already: false, telegramLinked: false })).toEqual({ ok: true, kind: 'watch', already: false, telegramLinked: false });
  });
  it('never reports a watch from a body it cannot read', () => {
    expect(readWatchAnswer(watch, 200, { ok: true })).toMatchObject({ ok: false, problem: 'other' });
    expect(readWatchAnswer(unwatch, 200, { ok: true, watching: true })).toMatchObject({ ok: false, problem: 'other' });
  });
  it('reads each refusal with its limit', () => {
    expect(readWatchAnswer(watch, 409, { error: 'too-many-loans', limit: 10 })).toEqual({ ok: false, problem: 'too-many-loans', status: 409, limit: 10 });
    expect(readWatchAnswer(watch, 429, { error: 'changes-spent' })).toMatchObject({ problem: 'changes-spent', limit: null });
    expect(readWatchAnswer(watch, 409, { error: 'wallet-holds-a-position' })).toMatchObject({ problem: 'holds-a-position' });
    expect(readWatchAnswer(unwatch, 404, { error: 'not-watching' })).toMatchObject({ problem: 'not-watching' });
    expect(readWatchAnswer(watch, 409, { error: 'request-already-used' })).toMatchObject({ problem: 'used' });
    expect(readWatchAnswer(watch, 500, null)).toMatchObject({ problem: 'other', status: 500 });
  });
  it('reads a list strictly', () => {
    expect(readWatchAnswer(list, 200, { loans: [{ chainId: 1, loanId: 7, watchedAt: 5 }], limits: { maxLoansPerWallet: 10 } })).toEqual({
      ok: true,
      kind: 'list',
      loans: [{ chainId: 1, loanId: 7n, watchedAt: 5 }],
      maxLoans: 10,
    });
    expect(readWatchAnswer(list, 200, { loans: [{ chainId: 1 }] })).toMatchObject({ ok: false, problem: 'other' });
  });
});

describe('what this browser knows', () => {
  it('records only what an answer established', () => {
    expect(knownAfter(watch, { ok: true, kind: 'watch', already: true, telegramLinked: true }, 9)).toEqual({ state: 'watching', at: 9 });
    expect(knownAfter(unwatch, { ok: false, problem: 'not-watching', status: 404, limit: null }, 9)).toEqual({ state: 'stopped', at: 9 });
    expect(knownAfter(watch, { ok: false, problem: 'busy' as never, status: 429, limit: null }, 9)).toBeNull();
    expect(knownAfter(watch, { ok: false, problem: 'used', status: 409, limit: null }, 9)).toBeNull();
  });
  it('keeps a record per network, wallet and loan', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    writeKnownWatch(1, W, 7n, { state: 'watching', at: 3 }, store);
    expect(readKnownWatch(1, W, 7n, store)).toEqual({ state: 'watching', at: 3 });
    expect(readKnownWatch(2, W, 7n, store)).toBeNull();
    expect(readKnownWatch(1, W, 8n, store)).toBeNull();
  });
});
