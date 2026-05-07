import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── ethers mock ─────────────────────────────────────────────────────────
// We mock `Contract` at module scope so every `batchCalls` invocation hits
// the same fake multicall. `aggregate3.staticCall` is a vi.fn the tests
// reprogram per-case, and the `Interface.decodeFunctionResult` behavior is
// controlled via the mocked `Interface` class passed into `batchCalls`.

const aggregate3StaticCall = vi.fn();

vi.mock('ethers', () => {
  class ContractMock {
    aggregate3: { staticCall: typeof aggregate3StaticCall };
    constructor(public address: string, public abi: unknown, public runner: unknown) {
      this.aggregate3 = { staticCall: aggregate3StaticCall };
    }
  }
  class InterfaceMock {
    decodeFunctionResult(_fragment: string, returnData: string): unknown[] {
      // The test provides encoded returnData of the form "0x<hex-number>";
      // we decode it back into [bigint]. Bad data throws to exercise the
      // catch-branch in batchCalls.
      if (!returnData.startsWith('0x') || returnData.length < 3) {
        throw new Error('bad return data');
      }
      if (returnData === '0xBAD') throw new Error('decode failure');
      return [BigInt(returnData)];
    }
  }
  return { Contract: ContractMock, Interface: InterfaceMock };
});

import { batchCalls, MULTICALL3_ADDRESS } from '../../src/lib/multicall';
import { Interface } from 'ethers';

const TARGET = '0x0000000000000000000000000000000000000001';

function mkCall(i: number) {
  return { target: TARGET, callData: '0x' + (i + 1).toString(16) };
}

function ok(returnData: string) {
  return { success: true, returnData };
}
function fail() {
  return { success: false, returnData: '0x' };
}

beforeEach(() => {
  aggregate3StaticCall.mockReset();
});

describe('batchCalls', () => {
  it('returns an empty array for zero calls without touching the provider', async () => {
    const out = await batchCalls<bigint>({} as any, new Interface([]), 'f', []);
    expect(out).toEqual([]);
    expect(aggregate3StaticCall).not.toHaveBeenCalled();
  });

  it('decodes successful subcalls in order', async () => {
    aggregate3StaticCall.mockResolvedValueOnce([ok('0x1'), ok('0x2'), ok('0x3')]);
    const out = await batchCalls<bigint>(
      {} as any,
      new Interface([]),
      'f',
      [mkCall(0), mkCall(1), mkCall(2)],
    );
    expect(out).toEqual([1n, 2n, 3n]);
  });

  it('returns null for reverted subcalls (success=false)', async () => {
    aggregate3StaticCall.mockResolvedValueOnce([ok('0x5'), fail(), ok('0x7')]);
    const out = await batchCalls<bigint>(
      {} as any,
      new Interface([]),
      'f',
      [mkCall(0), mkCall(1), mkCall(2)],
    );
    expect(out).toEqual([5n, null, 7n]);
  });

  it('returns null when returnData is the empty-bytes sentinel ("0x")', async () => {
    aggregate3StaticCall.mockResolvedValueOnce([
      { success: true, returnData: '0x' },
      ok('0x9'),
    ]);
    const out = await batchCalls<bigint>(
      {} as any,
      new Interface([]),
      'f',
      [mkCall(0), mkCall(1)],
    );
    expect(out).toEqual([null, 9n]);
  });

  it('returns null when the decoder throws instead of aborting the batch', async () => {
    aggregate3StaticCall.mockResolvedValueOnce([ok('0xBAD'), ok('0x4')]);
    const out = await batchCalls<bigint>(
      {} as any,
      new Interface([]),
      'f',
      [mkCall(0), mkCall(1)],
    );
    expect(out).toEqual([null, 4n]);
  });

  it('chunks large batches at the default 100-call boundary', async () => {
    const calls = Array.from({ length: 250 }, (_, i) => mkCall(i));
    aggregate3StaticCall
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ok('0x' + (i + 1).toString(16))))
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ok('0x' + (i + 101).toString(16))))
      .mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ok('0x' + (i + 201).toString(16))));
    const out = await batchCalls<bigint>({} as any, new Interface([]), 'f', calls);
    expect(aggregate3StaticCall).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(250);
    expect(out[0]).toBe(1n);
    expect(out[99]).toBe(100n);
    expect(out[100]).toBe(101n);
    expect(out[249]).toBe(250n);
  });

  it('honors a custom chunkSize', async () => {
    const calls = Array.from({ length: 7 }, (_, i) => mkCall(i));
    aggregate3StaticCall
      .mockResolvedValueOnce([ok('0x1'), ok('0x2'), ok('0x3')])
      .mockResolvedValueOnce([ok('0x4'), ok('0x5'), ok('0x6')])
      .mockResolvedValueOnce([ok('0x7')]);
    const out = await batchCalls<bigint>({} as any, new Interface([]), 'f', calls, 3);
    expect(aggregate3StaticCall).toHaveBeenCalledTimes(3);
    expect(out).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
  });

  it('propagates a provider-level failure (aggregate3 rejecting)', async () => {
    aggregate3StaticCall.mockRejectedValueOnce(new Error('rpc down'));
    await expect(
      batchCalls<bigint>({} as any, new Interface([]), 'f', [mkCall(0)]),
    ).rejects.toThrow(/rpc down/);
  });

  it('exposes the canonical Multicall3 deploy address', () => {
    expect(MULTICALL3_ADDRESS).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });
});
