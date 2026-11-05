import { describe, expect, it } from 'vitest';
import { summarize } from './outcome';
import { IllegalTransition, transition } from './track';

const HASH = ('0x' + 'a'.repeat(64)) as `0x${string}`;
const OTHER = ('0x' + 'b'.repeat(64)) as `0x${string}`;

describe('transition', () => {
  it('walks the one allowed sequence to a measured outcome', () => {
    let p = transition({ kind: 'idle' }, { type: 'review' });
    p = transition(p, { type: 'sign' });
    p = transition(p, { type: 'submitted', hash: HASH, at: 1 });
    p = transition(p, { type: 'mined', hash: HASH, blockNumber: 10n, reverted: false });
    expect(p).toMatchObject({ kind: 'mined', hash: HASH });
    p = transition(p, { type: 'measured', hash: HASH, outcome: summarize([{ status: 'done', label: 'repay' }], 2) });
    expect(p).toMatchObject({ kind: 'measured', outcome: { verdict: 'done' } });
  });
  it('never jumps from submitted to measured: the receipt is not the effect', () => {
    const submitted = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(submitted, { type: 'measured', hash: HASH, outcome: summarize([], 1) })).toThrow(IllegalTransition);
  });
  it('refuses a receipt for another hash', () => {
    const submitted = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(submitted, { type: 'mined', hash: OTHER, blockNumber: 1n, reverted: false })).toThrow(IllegalTransition);
  });
  it('fails from signing and submission only', () => {
    const signing = transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' });
    expect(transition(signing, { type: 'failed', stage: 'signing', message: 'declined' })).toMatchObject({ kind: 'failed', stage: 'signing' });
    expect(() => transition({ kind: 'review' }, { type: 'failed', stage: 'signing', message: 'x' })).toThrow(IllegalTransition);
  });
  it('resets only a flow that is not in flight', () => {
    expect(transition({ kind: 'failed', stage: 'signing', message: 'x' }, { type: 'reset' })).toEqual({ kind: 'idle' });
    expect(() => transition({ kind: 'submitted', hash: HASH, at: 1 }, { type: 'reset' })).toThrow(IllegalTransition);
  });
});
