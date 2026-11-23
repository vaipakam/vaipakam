/** #3922 option A — which source of a read failed, and its reference. */
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { ReadFailures, chainAnswered, unavailable, unwrapRead } from './failedRead';

describe('ReadFailures', () => {
  it('reports nothing when no request failed', () => {
    const f = new ReadFailures();
    expect(f.verdict(false)).toBeNull();
    expect(f.indexerFailed).toBe(false);
  });

  it('keeps the first failed request\'s reference', () => {
    const f = new ReadFailures();
    f.indexer({ answered: true, reference: 'AAAAAAAAAA' });
    f.indexer({ answered: true, reference: 'BBBBBBBBBB' });
    expect(f.verdict(false)).toEqual({ source: 'indexer', indexer: { answered: true, reference: 'AAAAAAAAAA' } });
  });

  it('keeps a first failure with no answer as such, even if a later one has a reference', () => {
    const f = new ReadFailures();
    f.indexer({ answered: false, reference: null });
    f.indexer({ answered: true, reference: 'BBBBBBBBBB' });
    expect(f.verdict(false)).toEqual({ source: 'indexer', indexer: { answered: false, reference: null } });
  });

  it('keeps an answer without a reference apart from no answer', () => {
    const f = new ReadFailures();
    f.indexer({ answered: true, reference: null });
    expect(f.verdict(false)).toEqual({ source: 'indexer', indexer: { answered: true, reference: null } });
  });

  it('names both sources when the chain fallback failed too', () => {
    const f = new ReadFailures();
    f.indexer({ answered: true, reference: 'AAAAAAAAAA' });
    expect(f.verdict(true)).toEqual({ source: 'both', indexer: { answered: true, reference: 'AAAAAAAAAA' } });
  });

  it('names the chain alone when only the chain was asked and failed', () => {
    expect(new ReadFailures().verdict(true)).toEqual({ source: 'chain' });
  });
});

describe('unwrapRead', () => {
  it('passes a loading result through', () => {
    expect(unwrapRead(undefined)).toEqual({ data: undefined, failedRead: null });
  });
  it('turns an unavailable result into null with what failed', () => {
    expect(unwrapRead(unavailable({ source: 'chain' }))).toEqual({ data: null, failedRead: { source: 'chain' } });
  });
  it('keeps an ordinary value, including one that names other fields', () => {
    const v = { unavailable: 1, other: 2 };
    expect(unwrapRead(v)).toEqual({ data: v, failedRead: null });
    expect(unwrapRead([1])).toEqual({ data: [1], failedRead: null });
  });
});

describe('chainAnswered', () => {
  it('treats a revert as an answer', () => {
    const revert = new ContractFunctionRevertedError({ abi: [], functionName: 'getLoan', message: 'reverted' });
    expect(chainAnswered(new BaseError('call failed', { cause: revert }))).toBe(true);
  });
  it('treats anything else as a failed read', () => {
    expect(chainAnswered(new BaseError('HTTP request failed'))).toBe(false);
    expect(chainAnswered(new Error('boom'))).toBe(false);
    expect(chainAnswered(undefined)).toBe(false);
  });
});
