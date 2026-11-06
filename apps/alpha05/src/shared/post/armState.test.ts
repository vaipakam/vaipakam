import { describe, expect, it } from 'vitest';
import type { TxPhase } from '../tx/outcome';
import { armEnding, armRead } from './armState';

const HASH = '0x0000000000000000000000000000000000000000000000000000000000000001' as const;

const measured = (verdict: 'done' | 'partial' | 'not-done' | 'unknown') => ({ kind: 'measured', hash: HASH, outcome: { verdict } }) as unknown as TxPhase;

describe('armEnding', () => {
  it('says set only when the read-back confirmed it, and not set only when it showed otherwise', () => {
    expect(armEnding(measured('done'))).toBe('armed');
    expect(armEnding(measured('not-done'))).toBe('not-set');
    expect(armEnding(measured('unknown'))).toBe('unknown');
    expect(armEnding(measured('partial'))).toBe('unknown');
  });

  it('never says "not set" for a transaction that was sent and not measured', () => {
    for (const kind of ['signing', 'submitted', 'mined', 'receipt-unknown'] as const) expect(armEnding({ kind, hash: HASH } as unknown as TxPhase)).toBe('unknown');
    expect(armEnding({ kind: 'superseded', reason: 'replaced' } as unknown as TxPhase)).toBe('unknown');
  });

  it('says skipped when nothing was sent or the wallet cancelled it', () => {
    expect(armEnding({ kind: 'review' } as TxPhase)).toBe('skipped');
    expect(armEnding({ kind: 'idle' } as TxPhase)).toBe('skipped');
    expect(armEnding({ kind: 'failed', message: 'x' } as unknown as TxPhase)).toBe('skipped');
    expect(armEnding({ kind: 'superseded', reason: 'cancelled' } as unknown as TxPhase)).toBe('skipped');
  });

  it('says set when the step read the choice already on the request, whatever the phase', () => {
    expect(armEnding({ kind: 'review' } as TxPhase, true)).toBe('armed');
    expect(armEnding({ kind: 'idle' } as TxPhase, true)).toBe('armed');
  });
});

describe('armRead', () => {
  const A = '0x00000000000000000000000000000000000000aa';
  const choice = { maxCStar: 5n, allowDowngrade: false };
  const state = (accepted: boolean, creatorFull: boolean, creator = A) =>
    ({ creator, accepted, stored: { creatorFull, creatorMaxCStar: creatorFull ? 5n : 0n, creatorAllowFullDowngrade: false } }) as never;

  it('reads the choice on a taken request as set, never as taken without it', () => {
    expect(armRead(state(true, true), A, choice)).toBe('set');
    expect(armRead(state(false, true), A, choice)).toBe('set');
  });

  it('says taken without it only when the request does not carry the choice', () => {
    expect(armRead(state(true, false), A, choice)).toBe('taken-unset');
    expect(armRead(state(false, false), A, choice)).toBe('open-unset');
  });

  it("says nothing about another wallet's request", () => {
    expect(armRead(state(true, true, '0x00000000000000000000000000000000000000bb'), A, choice)).toBe('not-creator');
  });
});
