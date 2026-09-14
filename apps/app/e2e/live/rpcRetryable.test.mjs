import { describe, it, expect } from 'vitest';
import * as viem from 'viem';
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
} from 'viem';
import { ABI_ERROR_NAME, rpcRetryable } from './rpcRetryable.mjs';

/**
 * The classifier is deliberately lopsided — it names the deterministic
 * failures and retries everything else — so the cases here pin both
 * halves: the named ones are refused, and nothing unnamed is.
 */
describe('rpcRetryable', () => {
  it('refuses a contract revert, however deep in the cause chain', () => {
    const reverted = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'signedOfferFilledAmount',
      message: 'execution reverted',
    });
    // viem nests: the revert is normally the cause, not the outer error.
    const outer = new BaseError('call failed', { cause: reverted });
    expect(rpcRetryable(outer)).toBe(false);
    expect(rpcRetryable(reverted)).toBe(false);
  });

  it('refuses a decode of empty return data', () => {
    const zero = new AbiDecodingZeroDataError();
    expect(rpcRetryable(new BaseError('call failed', { cause: zero }))).toBe(false);
  });

  it('refuses a decode of malformed NON-empty data', () => {
    // `0x01` for a `uint256`. The first version of this classifier named
    // AbiDecodingZeroDataError alone and retried this one for 90 s
    // (#2107 round 2) — which is why the rule is now by family.
    const small = new AbiDecodingDataSizeTooSmallError({
      data: '0x01',
      params: [],
      size: 1,
    });
    expect(rpcRetryable(new BaseError('call failed', { cause: small }))).toBe(false);
  });

  it('refuses EVERY Abi*Error viem exports, not a hand-kept list', () => {
    // The rule tests a NAME, so it is only as good as viem's naming
    // convention — and this is what stops that being trusted silently.
    // A renamed or newly added error outside the convention fails here
    // instead of being quietly retried to the deadline.
    const names = Object.keys(viem).filter((n) => /^Abi[A-Za-z]*Error$/.test(n));
    expect(names.length).toBeGreaterThan(10); // an empty sweep proves nothing
    expect(names).toContain('AbiDecodingZeroDataError');
    expect(names).toContain('AbiDecodingDataSizeTooSmallError');
    for (const name of names) {
      // viem assigns `name` in the constructor and each of these takes
      // different arguments, so the sweep carries the name on a real
      // BaseError rather than constructing seventeen shapes.
      const carrier = new BaseError('call failed');
      carrier.name = name;
      expect(rpcRetryable(carrier), `${name} must not be retried`).toBe(false);
      expect(ABI_ERROR_NAME.test(name), `${name} matches the family rule`).toBe(true);
    }
  });

  it('does not match a name that merely contains the pattern', () => {
    for (const name of ['NotAnAbiDecodingError', 'AbiDecodingZeroDataErrorish', 'Abi', 'Error']) {
      const carrier = new BaseError('x');
      carrier.name = name;
      expect(rpcRetryable(carrier), `${name} is not an ABI error`).toBe(true);
    }
  });

  it('retries a transport failure', () => {
    expect(rpcRetryable(new HttpRequestError({ url: 'https://x', details: 'socket hang up' }))).toBe(
      true,
    );
  });

  it('retries anything it does not recognise', () => {
    // The open side. A rule that had to enumerate THIS side would be
    // wrong without knowing it; erring here means an unfamiliar error
    // behaves exactly as it did before the classifier existed.
    expect(rpcRetryable(new Error('missing trie node'))).toBe(true);
    expect(rpcRetryable(new BaseError('429 Too Many Requests'))).toBe(true);
    expect(rpcRetryable('a string, not an error')).toBe(true);
    expect(rpcRetryable(null)).toBe(true);
    expect(rpcRetryable(undefined)).toBe(true);
  });

  it('does not mistake a non-viem object carrying a walk property', () => {
    // `walk` is how the cause chain is reached, so a plain object with a
    // non-callable `walk` must not take that path.
    expect(rpcRetryable({ walk: 'not a function' })).toBe(true);
  });
});
