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
  it('fails from signing only: nothing was submitted', () => {
    const signing = transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' });
    expect(transition(signing, { type: 'failed', message: 'declined' })).toEqual({ kind: 'failed', message: 'declined' });
    expect(() => transition({ kind: 'review' }, { type: 'failed', message: 'x' })).toThrow(IllegalTransition);
    expect(() => transition({ kind: 'submitted', hash: HASH, at: 1 }, { type: 'failed', message: 'x' })).toThrow(IllegalTransition);
  });
  it('keeps the hash when the receipt cannot be read, resumes into mined, never into a new review', () => {
    const submitted = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1 });
    const unknown = transition(submitted, { type: 'receipt-unknown', hash: HASH, message: 'timed out' });
    expect(unknown).toEqual({ kind: 'receipt-unknown', hash: HASH, message: 'timed out' });
    expect(() => transition(unknown, { type: 'review' })).toThrow(IllegalTransition);
    expect(() => transition(unknown, { type: 'mined', hash: OTHER, blockNumber: 1n, reverted: false })).toThrow(IllegalTransition);
    expect(transition(unknown, { type: 'mined', hash: HASH, blockNumber: 7n, reverted: false })).toMatchObject({ kind: 'mined', hash: HASH });
    expect(transition(unknown, { type: 'reset' })).toEqual({ kind: 'idle' });
  });
  it('resets only a flow that is not in flight', () => {
    expect(transition({ kind: 'failed', message: 'x' }, { type: 'reset' })).toEqual({ kind: 'idle' });
    expect(() => transition({ kind: 'submitted', hash: HASH, at: 1 }, { type: 'reset' })).toThrow(IllegalTransition);
    expect(() => transition({ kind: 'mined', hash: HASH, blockNumber: 1n, reverted: false }, { type: 'reset' })).toThrow(IllegalTransition);
  });
});
