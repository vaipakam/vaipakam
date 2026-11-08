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
    { functionName: 'repayLoan', args: [3n] },
  ]);
  const ok = { success: true, returnData: '0x' as const };
  const skip = { success: false, returnData: '0x' as const };

  it('sizes from the strict form of the same batch, plus the margin', async () => {
    const seen: boolean[][] = [];
    const limit = await bestEffortGasLimit(calls, {
      estimate: async (c) => {
        seen.push(c.map((i) => i.allowFailure));
        return 1_000_000n;
      },
      simulate: async () => {
        throw new Error('not reached');
      },
    });
    expect(seen).toEqual([[false, false, false]]);
    expect(limit).toBe(gasLimitFromEstimate(1_000_000n));
    // The batch itself is untouched: still sent best-effort.
    expect(calls.every((c) => c.allowFailure)).toBe(true);
  });

  it('when an item would revert, re-estimates the whole batch with only the items that ran required', async () => {
    const seen: { data: string; allowFailure: boolean }[][] = [];
    const limit = await bestEffortGasLimit(calls, {
      estimate: async (c) => {
        seen.push(c.map((i) => ({ data: i.callData, allowFailure: i.allowFailure })));
        if (c.every((i) => !i.allowFailure)) throw new Error('reverts');
        return 900_000n;
      },
      simulate: async () => [ok, skip, ok],
    });
    // Every item stays, in order: the failing one still runs and spends
    // gas, and a later item may depend on an earlier one.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([
      { data: calls[0].callData, allowFailure: false },
      { data: calls[1].callData, allowFailure: true },
      { data: calls[2].callData, allowFailure: false },
    ]);
    expect(limit).toBe(gasLimitFromEstimate(900_000n));
  });

  it('leaves it to the wallet when no item would run', async () => {
    const limit = await bestEffortGasLimit(calls, {
      estimate: async () => {
        throw new Error('reverts');
      },
      simulate: async () => [skip, skip, skip],
    });
    expect(limit).toBeUndefined();
  });

  it('leaves it to the wallet when the marked batch reverts too', async () => {
    const limit = await bestEffortGasLimit(calls, {
      estimate: async () => {
        throw new Error('reverts');
      },
      simulate: async () => [ok, skip, ok],
    });
    expect(limit).toBeUndefined();
  });
});
