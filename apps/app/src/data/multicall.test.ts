/**
 * #126 — the shared multicall encoding: every item is best-effort, and a
 * long list splits at the facet's cap with order kept.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { gasLimitFromEstimate } from '@vaipakam/lib/gasLimit';
import { bestEffortGasLimit, chunkForMulticall, encodeBestEffort, MAX_MULTICALL_CALLS } from './multicall';

describe('encodeBestEffort', () => {
  it('encodes each call with allowFailure set', () => {
    const calls = encodeBestEffort([
      { functionName: 'repayLoan', args: [7n] },
      { functionName: 'precloseDirect', args: [9n] },
    ]);
    expect(calls.every((c) => c.allowFailure)).toBe(true);
    const decoded = calls.map((c) => decodeFunctionData({ abi: DIAMOND_ABI_VIEM, data: c.callData }));
    expect(decoded.map((d) => [d.functionName, d.args])).toEqual([
      ['repayLoan', [7n]],
      ['precloseDirect', [9n]],
    ]);
  });
});

describe('chunkForMulticall', () => {
  it('splits at the facet cap and keeps order', () => {
    const items = Array.from({ length: MAX_MULTICALL_CALLS * 2 + 1 }, (_, i) => i);
    const chunks = chunkForMulticall(items);
    expect(chunks.map((c) => c.length)).toEqual([MAX_MULTICALL_CALLS, MAX_MULTICALL_CALLS, 1]);
    expect(chunks.flat()).toEqual(items);
  });

  it('returns nothing for nothing', () => {
    expect(chunkForMulticall([])).toEqual([]);
  });
});

describe('bestEffortGasLimit', () => {
  const calls = encodeBestEffort([
    { functionName: 'repayLoan', args: [1n] },
    { functionName: 'repayLoan', args: [2n] },
  ]);

  it('sizes from the strict form of the same batch, plus the margin', async () => {
    const seen: boolean[][] = [];
    const limit = await bestEffortGasLimit(calls, async (c) => {
      seen.push(c.map((i) => i.allowFailure));
      return 1_000_000n;
    });
    expect(seen).toEqual([[false, false]]);
    expect(limit).toBe(gasLimitFromEstimate(1_000_000n));
    // The batch itself is untouched: still sent best-effort.
    expect(calls.every((c) => c.allowFailure)).toBe(true);
  });

  it('when an item would revert, sums the items that would run', async () => {
    const limit = await bestEffortGasLimit(calls, async (c) => {
      if (c.length > 1) throw new Error('reverts');
      if (c[0].callData === calls[1].callData) throw new Error('reverts');
      return 400_000n;
    });
    expect(limit).toBe(gasLimitFromEstimate(400_000n));
  });

  it('leaves it to the wallet when no item would run', async () => {
    const limit = await bestEffortGasLimit(calls, async () => {
      throw new Error('reverts');
    });
    expect(limit).toBeUndefined();
  });
});
