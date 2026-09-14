import { describe, it, expect } from 'vitest';
import {
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
} from 'viem';
import { rpcRetryable } from './rpcRetryable.mjs';

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
