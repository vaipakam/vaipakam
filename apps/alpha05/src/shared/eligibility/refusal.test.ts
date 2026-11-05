import { describe, expect, it } from 'vitest';
import { UNRECOGNISED, USER_REJECTED, refusalFromError } from './refusal';

describe('refusalFromError', () => {
  it('names the wallet decline', () => {
    const r = refusalFromError(Object.assign(new Error('User rejected the request.'), { code: 4001 }));
    expect(r.code).toBe(USER_REJECTED);
    expect(r.reason).toMatch(/Nothing was sent/);
  });
  it("uses the protocol's own custom-error name from the decoded revert", () => {
    const err = Object.assign(new Error('reverted'), { cause: { data: { errorName: 'InsufficientCollateral' } } });
    const r = refusalFromError(err);
    expect(r.code).toBe('InsufficientCollateral');
    expect(r.reason).toMatch(/^The protocol refused this step: /);
  });
  it('resolves a known selector without a decoded name', () => {
    const err = Object.assign(new Error('x'), { data: '0xa9ad62f8' });
    expect(refusalFromError(err).code).toBe('FunctionDoesNotExist');
  });
  it('keeps an unknown selector as the refusal code, stated as unnamed', () => {
    const err = Object.assign(new Error('x'), { data: '0xdeadbeef' + '00'.repeat(32) });
    const r = refusalFromError(err);
    expect(r.code).toBe('0xdeadbeef');
    expect(r.reason).toMatch(/cannot name/);
  });
  it('is still a refusal, with a stated unknown, for anything else', () => {
    const r = refusalFromError(new Error('socket hang up'));
    expect(r.code).toBe(UNRECOGNISED);
    expect(r.reason).toMatch(/cannot name: socket hang up/);
    expect(refusalFromError(undefined).code).toBe(UNRECOGNISED);
  });
  it('carries the remedy the caller can offer', () => {
    expect(refusalFromError(new Error('x'), { label: 'Add collateral', to: '/positions/1' }).remedy).toEqual({ label: 'Add collateral', to: '/positions/1' });
  });
});
