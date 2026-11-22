// apps/keeper/test/matcherPreviewIntentAbi.test.ts — the matcher encodes
// `previewIntent` from the combined Diamond ABI, so a move of its host facet
// (#1104, #3843) cannot leave the intent-fill confirmation without it.

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, zeroAddress } from 'viem';
import { PREVIEW_INTENT_ABI } from '../src/matcher';

describe('matcher previewIntent ABI', () => {
  it('carries exactly one previewIntent, and it encodes', () => {
    expect(PREVIEW_INTENT_ABI).toHaveLength(1);
    const fn = PREVIEW_INTENT_ABI[0] as { inputs: { type: string }[] };
    const args = fn.inputs.map((i) => (i.type === 'address' ? zeroAddress : i.type === 'bool' ? false : i.type.startsWith('uint') || i.type.startsWith('int') ? 0n : i.type === 'bytes32' ? `0x${'0'.repeat(64)}` : '0x'));
    expect(encodeFunctionData({ abi: PREVIEW_INTENT_ABI, functionName: 'previewIntent', args }).slice(0, 10)).toBe('0x51e43cd9');
  });
});
