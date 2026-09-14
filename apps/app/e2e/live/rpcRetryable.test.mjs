import { describe, it, expect } from 'vitest';
import * as viem from 'viem';
import {
  AbiDecodingDataSizeTooSmallError,
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  RawContractError,
} from 'viem';
import { rpcRetryable } from './rpcRetryable.mjs';

/**
 * The classifier is deliberately lopsided — it names ONE failure and
 * retries everything else — so the cases here pin both halves: a revert
 * is refused, and nothing else is.
 *
 * It named more than that until #2107 round 3, and this header said so.
 * What it named were failures to DECODE a reply, and two attempts to
 * bound that set were broken by review in consecutive rounds. They are
 * no longer classified here because they are no longer inside the retry
 * at all — `confirmWrite` decodes outside it — so the cases below assert
 * the INVERSE of what they once did, and `writeConfirm.test.mjs` holds
 * the guarantee that replaced them.
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

  it('refuses a revert carried as RawContractError, the raw-call shape', () => {
    // The two read paths surface a revert differently: `readContract`
    // raises ContractFunctionRevertedError, a raw `call` carries
    // RawContractError. The drives use the raw call now, so this is the
    // shape that actually reaches the classifier in production.
    const raw = new RawContractError({ data: '0x' });
    expect(rpcRetryable(new BaseError('call failed', { cause: raw }))).toBe(false);
  });

  it('RETRIES every decoding failure — they are no longer its problem', () => {
    // This is the inverse of what two earlier revisions asserted, and
    // the inversion is the fix (#2107 round 3). Naming decode failures
    // here failed twice: first as a class list (AbiDecodingZeroDataError,
    // then AbiDecodingDataSizeTooSmallError), then as viem's `Abi*Error`
    // name family (which InvalidBytesBooleanError and
    // SliceOffsetOutOfBoundsError escape entirely).
    //
    // `confirmWrite` now fetches raw bytes under the retry and decodes
    // OUTSIDE it, so a decode failure can never be waited out no matter
    // what this says — which is why this may safely say nothing. The
    // guarantee moved from a list to a boundary; `writeConfirm.test.mjs`
    // holds the assertion that matters.
    const decodeFailures = [
      new AbiDecodingZeroDataError(),
      new AbiDecodingDataSizeTooSmallError({ data: '0x01', params: [], size: 1 }),
      ...['InvalidBytesBooleanError', 'SliceOffsetOutOfBoundsError', 'SizeExceedsPaddingSizeError']
        .filter((n) => typeof viem[n] === 'function')
        .map((n) => {
          const carrier = new BaseError('decode failed');
          carrier.name = n;
          return carrier;
        }),
    ];
    expect(decodeFailures.length).toBeGreaterThan(3); // an empty sweep proves nothing
    for (const e of decodeFailures) {
      expect(rpcRetryable(new BaseError('call failed', { cause: e }))).toBe(true);
    }
  });

  it('the escapees from the retired name rule really do exist in viem', () => {
    // The round-3 finding rested on these being real exports, so it is
    // checked rather than taken on trust — and the check records which
    // ones. `PositionOutOfBoundsError`, also named in that finding, is
    // NOT exported by the installed viem; the other three are, which is
    // enough for the finding to stand.
    expect(typeof viem.InvalidBytesBooleanError).toBe('function');
    expect(typeof viem.SliceOffsetOutOfBoundsError).toBe('function');
    expect(typeof viem.SizeExceedsPaddingSizeError).toBe('function');
    expect(/^Abi[A-Za-z]*Error$/.test('InvalidBytesBooleanError')).toBe(false);
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
