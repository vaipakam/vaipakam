/**
 * #2399 — recognising the Diamond's own "no facet hosts this selector"
 * revert, `VaipakamDiamond.FunctionDoesNotExist()`, through a REAL viem
 * client rather than a hand-built error object.
 *
 * Why this file exists. Once the combined Diamond ABI started carrying the
 * proxy's errors, viem began DECODING that revert. The decoded message reads
 * `FunctionDoesNotExist()` and no longer contains the raw selector, so the
 * old text match on `0xa9ad62f8` stopped recognising the exact revert it was
 * written for, and every "older deploy without this view" branch would have
 * flipped from fail-open to fail. Only the real decode path shows that, so
 * these tests drive `readContract` against a transport that reverts.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, type Abi } from 'viem';
import { baseSepolia } from 'viem/chains';
import { DIAMOND_ABI_VIEM, OfferPreviewFacetABI } from '@vaipakam/contracts/abis';
import { isFunctionDoesNotExistRevert, isMissingSelectorError } from './preflights';

const FN_MISSING = '0xa9ad62f8';
const DIAMOND = '0x0000000000000000000000000000000000000001';
const ACCEPTOR = '0x0000000000000000000000000000000000000002';

/** The error `readContract` throws when the node reverts with `data`. */
async function revertFrom(abi: Abi, data: string): Promise<unknown> {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: custom({
      async request({ method }) {
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
        throw Object.assign(new Error('execution reverted'), { code: 3, data });
      },
    }),
  });
  try {
    await client.readContract({
      address: DIAMOND,
      abi,
      functionName: 'previewAccept',
      args: [1n, ACCEPTOR],
    });
  } catch (err) {
    return err;
  }
  throw new Error('the read did not revert');
}

describe('the Diamond ABI decodes the proxy revert (#2399)', () => {
  it('names FunctionDoesNotExist — the decoded form the detectors must handle', async () => {
    const err = await revertFrom(DIAMOND_ABI_VIEM, FN_MISSING);
    expect(String((err as Error).message)).toContain('FunctionDoesNotExist()');
    // The selector is gone from the decoded message: a text match on it
    // alone is what this change would have broken.
    expect(String((err as Error).message)).not.toContain(FN_MISSING);
  });
});

describe('recognising an unrouted selector', () => {
  it('recognises the DECODED revert (combined Diamond ABI)', async () => {
    const err = await revertFrom(DIAMOND_ABI_VIEM, FN_MISSING);
    expect(isFunctionDoesNotExistRevert(err)).toBe(true);
    expect(isMissingSelectorError(err)).toBe(true);
  });

  it('still recognises the UNDECODED revert (an ABI without the declaration)', async () => {
    const err = await revertFrom(OfferPreviewFacetABI as Abi, FN_MISSING);
    expect(isFunctionDoesNotExistRevert(err)).toBe(true);
    expect(isMissingSelectorError(err)).toBe(true);
  });

  it('does not mistake another revert for it', async () => {
    const err = await revertFrom(DIAMOND_ABI_VIEM, '0xdeadbeef');
    expect(isFunctionDoesNotExistRevert(err)).toBe(false);
    expect(isMissingSelectorError(err)).toBe(false);
  });
});
