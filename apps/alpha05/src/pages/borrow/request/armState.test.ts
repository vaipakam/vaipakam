import { describe, expect, it } from 'vitest';
import type { TxPhase } from '../../../shared/tx/outcome';
import { armEnding } from './armState';

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
});
