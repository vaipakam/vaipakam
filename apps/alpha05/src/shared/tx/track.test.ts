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
    p = transition(p, { type: 'mined', submittedHash: HASH, hash: HASH, repriced: false, blockNumber: 10n, reverted: false });
    expect(p).toMatchObject({ kind: 'mined', hash: HASH });
    p = transition(p, { type: 'measured', hash: HASH, outcome: summarize([{ status: 'done', label: 'repay' }], 2) });
    expect(p).toMatchObject({ kind: 'measured', outcome: { verdict: 'done' } });
    // The measured phase keeps the block the transaction mined in.
    expect(p).toMatchObject({ kind: 'measured', blockNumber: 10n });
  });
  it('never jumps from submitted to measured: the receipt is not the effect', () => {
    const submitted = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(submitted, { type: 'measured', hash: HASH, outcome: summarize([], 1) })).toThrow(IllegalTransition);
  });
  it('refuses a receipt for another hash', () => {
    const submitted = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(submitted, { type: 'mined', submittedHash: HASH, hash: OTHER, repriced: false, blockNumber: 1n, reverted: false })).toThrow(IllegalTransition);
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
    expect(unknown).toEqual({ kind: 'receipt-unknown', hash: HASH, at: 1, message: 'timed out' });
    expect(() => transition(unknown, { type: 'review' })).toThrow(IllegalTransition);
    expect(() => transition(unknown, { type: 'mined', submittedHash: HASH, hash: OTHER, repriced: false, blockNumber: 1n, reverted: false })).toThrow(IllegalTransition);
    expect(transition(unknown, { type: 'mined', submittedHash: HASH, hash: HASH, repriced: false, blockNumber: 7n, reverted: false })).toMatchObject({ kind: 'mined', hash: HASH });
    expect(transition(unknown, { type: 'reset' })).toEqual({ kind: 'idle' });
  });
  it('tracks a repriced transaction under its mined hash and measures it', () => {
    const submitted = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1 });
    const mined = transition(submitted, { type: 'mined', submittedHash: HASH, hash: OTHER, repriced: true, blockNumber: 3n, reverted: false });
    expect(mined).toEqual({ kind: 'mined', hash: OTHER, submittedHash: HASH, blockNumber: 3n, reverted: false });
    expect(() => transition(mined, { type: 'measured', hash: HASH, outcome: summarize([], 1) })).toThrow(IllegalTransition);
    expect(transition(mined, { type: 'measured', hash: OTHER, outcome: summarize([{ status: 'done', label: 'x' }], 2) })).toMatchObject({ kind: 'measured', hash: OTHER, submittedHash: HASH });
  });
  it('ends a cancelled or replaced transaction as superseded, never mined or measured', () => {
    const submitted = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1 });
    for (const reason of ['cancelled', 'replaced'] as const) {
      const p = transition(submitted, { type: 'superseded', submittedHash: HASH, minedHash: OTHER, reason, blockNumber: 4n });
      expect(p).toEqual({ kind: 'superseded', submittedHash: HASH, minedHash: OTHER, reason, blockNumber: 4n, unwound: [], landed: [] });
      expect(() => transition(p, { type: 'measured', hash: OTHER, outcome: summarize([], 1) })).toThrow(IllegalTransition);
      expect(transition(p, { type: 'review' })).toEqual({ kind: 'review' });
      expect(transition(p, { type: 'reset' })).toEqual({ kind: 'idle' });
    }
    // Also after a resumed track, and only for this flow's hash.
    const unknown = transition(submitted, { type: 'receipt-unknown', hash: HASH, message: 'timed out' });
    // Codex #3489 r20: the earlier steps of a multi-transaction action are kept on this ending.
    const earlier = [{ status: 'done' as const, label: 'Protected mode is on' }];
    expect(transition(submitted, { type: 'superseded', submittedHash: HASH, minedHash: OTHER, reason: 'cancelled', blockNumber: 4n, landed: earlier })).toMatchObject({ landed: earlier });
    expect(transition(unknown, { type: 'superseded', submittedHash: HASH, minedHash: OTHER, reason: 'cancelled', blockNumber: 5n }).kind).toBe('superseded');
    expect(() => transition(submitted, { type: 'superseded', submittedHash: OTHER, minedHash: OTHER, reason: 'cancelled', blockNumber: 5n })).toThrow(IllegalTransition);
  });
  it('keeps what the flow put back when the transaction was superseded', () => {
    const submitted = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1 });
    const unwound = [{ status: 'not-done', label: 'Approval put back', reason: 'the wallet refused' } as const];
    const p = transition(submitted, { type: 'superseded', submittedHash: HASH, minedHash: OTHER, reason: 'cancelled', blockNumber: 4n, unwound });
    expect(p).toMatchObject({ kind: 'superseded', unwound });
  });
  it('ends an account wallet step that never ran as superseded, with no mined hash, only for an account flow', () => {
    const via = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1, viaAccount: true });
    const unwound = [{ status: 'done' as const, label: 'Approval put back' }];
    for (const reason of ['account-cancelled', 'account-failed'] as const) {
      const p = transition(via, { type: 'superseded', submittedHash: HASH, minedHash: null, reason, blockNumber: null, unwound });
      expect(p).toEqual({ kind: 'superseded', submittedHash: HASH, minedHash: null, reason, blockNumber: null, unwound, landed: [] });
    }
    const plain = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(plain, { type: 'superseded', submittedHash: HASH, minedHash: null, reason: 'account-cancelled', blockNumber: null })).toThrow(IllegalTransition);
    // A wallet cancel or replacement always names the transaction that mined.
    expect(() => transition(via, { type: 'superseded', submittedHash: HASH, minedHash: null, reason: 'cancelled', blockNumber: null })).toThrow(IllegalTransition);
    expect(() => transition(via, { type: 'superseded', submittedHash: HASH, minedHash: OTHER, reason: 'account-failed', blockNumber: 3n })).toThrow(IllegalTransition);
  });
  it('refuses a different mined hash that is not a reprice', () => {
    const submitted = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(submitted, { type: 'mined', submittedHash: HASH, hash: OTHER, repriced: false, blockNumber: 1n, reverted: false })).toThrow(IllegalTransition);
  });
  it('puts a resumed hash back in flight before the wait, refusing a reset or a second resume', () => {
    const submitted = transition({ kind: 'signing' }, { type: 'submitted', hash: HASH, at: 1 });
    const unknown = transition(submitted, { type: 'receipt-unknown', hash: HASH, message: 'timed out' });
    const resumed = transition(unknown, { type: 'resume', hash: HASH });
    expect(resumed).toEqual({ kind: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(resumed, { type: 'resume', hash: HASH })).toThrow(IllegalTransition);
    expect(() => transition(resumed, { type: 'reset' })).toThrow(IllegalTransition);
    expect(() => transition(unknown, { type: 'resume', hash: OTHER })).toThrow(IllegalTransition);
    expect(() => transition(submitted, { type: 'resume', hash: HASH })).toThrow(IllegalTransition);
    // The resumed wait can still fail again, keeping the hash and its time.
    expect(transition(resumed, { type: 'receipt-unknown', hash: HASH, message: 'again' })).toEqual({ kind: 'receipt-unknown', hash: HASH, at: 1, message: 'again' });
  });
  it('resets only a flow that is not in flight', () => {
    expect(transition({ kind: 'failed', message: 'x' }, { type: 'reset' })).toEqual({ kind: 'idle' });
    expect(() => transition({ kind: 'submitted', hash: HASH, at: 1 }, { type: 'reset' })).toThrow(IllegalTransition);
    expect(() => transition({ kind: 'mined', hash: HASH, submittedHash: HASH, blockNumber: 1n, reverted: false }, { type: 'reset' })).toThrow(IllegalTransition);
  });
});

describe('a contract wallet as sender (#3770)', () => {
  it("follows the wallet's id to the chain hash it runs under, through an unknown receipt and a resume", () => {
    let p = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1, viaAccount: true });
    expect(p).toEqual({ kind: 'submitted', hash: HASH, at: 1, viaAccount: true });
    p = transition(p, { type: 'receipt-unknown', hash: HASH, message: 'approvals unread' });
    expect(p).toEqual({ kind: 'receipt-unknown', hash: HASH, at: 1, message: 'approvals unread', viaAccount: true });
    p = transition(p, { type: 'resume', hash: HASH });
    expect(p).toEqual({ kind: 'submitted', hash: HASH, at: 1, viaAccount: true });
    expect(transition(p, { type: 'mined', submittedHash: HASH, hash: OTHER, repriced: false, blockNumber: 3n, reverted: false })).toMatchObject({ kind: 'mined', hash: OTHER, submittedHash: HASH });
  });
  it('still refuses another hash for an ordinary wallet', () => {
    const p = transition(transition(transition({ kind: 'idle' }, { type: 'review' }), { type: 'sign' }), { type: 'submitted', hash: HASH, at: 1, viaAccount: false });
    expect(p).toEqual({ kind: 'submitted', hash: HASH, at: 1 });
    expect(() => transition(p, { type: 'mined', submittedHash: HASH, hash: OTHER, repriced: false, blockNumber: 3n, reverted: false })).toThrow(IllegalTransition);
  });
});
