import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeAbiParameters } from 'viem';
import { SETTLE_SIM_ABI } from '../src/rewardHorizonHeartbeat';

// #3012 / #3026 — the close-out calls gained a trailing `progressed` flag, but
// the live testnet Diamonds answer the older, shorter result until the next
// fresh deploy. The pass reads both through one narrower shape.
describe('close-out result bridge', () => {
  it('reads the sweep from the old and the new result', () => {
    const old = encodeAbiParameters([{ type: 'uint256' }], [7n]);
    const next = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [7n, true]);
    for (const data of [old, next]) {
      expect(decodeFunctionResult({ abi: SETTLE_SIM_ABI, functionName: 'sweepForfeitedInteractionRewards', data })).toBe(7n);
    }
  });

  it('reads the retirement from the old and the new result', () => {
    const old = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [2n, 9n]);
    const next = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], [2n, 9n, true]);
    for (const data of [old, next]) {
      expect(decodeFunctionResult({ abi: SETTLE_SIM_ABI, functionName: 'retireZeroPricedRemainders', data })).toEqual([2n, 9n]);
    }
  });

  it('keeps every error, so a refusal still decodes by name', () => {
    expect(SETTLE_SIM_ABI.some((i) => i.type === 'error' && i.name === 'InteractionPoolReservedShortfall')).toBe(true);
  });
});
