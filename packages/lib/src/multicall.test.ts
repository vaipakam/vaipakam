import { describe, it, expect, vi } from 'vitest';
import {
  encodeFunctionData,
  encodeFunctionResult,
  toFunctionSelector,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';
import {
  MULTICALL3_ADDRESS,
  encodeBatchCalls,
  batchCalls,
  aggregateReads,
  type BatchCall,
} from './multicall';

// A minimal single-return view function — the common "one value per id" shape
// batchCalls is built for.
const BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

const TARGET: Address = '0x00000000000000000000000000000000000000A1';
const ADDR_A: Address = '0x1111111111111111111111111111111111111111';
const ADDR_B: Address = '0x2222222222222222222222222222222222222222';

/** Encode a uint256 the way an on-chain `balanceOf` would return it. */
function uint256Result(value: bigint): `0x${string}` {
  return encodeFunctionResult({
    abi: BALANCE_ABI,
    functionName: 'balanceOf',
    result: value,
  });
}

describe('encodeBatchCalls', () => {
  it('encodes one BatchCall per arg tuple, all pointed at the same target', () => {
    const calls = encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', [
      [ADDR_A],
      [ADDR_B],
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0].target).toBe(TARGET);
    expect(calls[1].target).toBe(TARGET);
  });

  it('produces calldata that matches viem encodeFunctionData exactly', () => {
    const [call] = encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', [[ADDR_A]]);
    const expected = encodeFunctionData({
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      args: [ADDR_A],
    });
    expect(call.callData).toBe(expected);
    // …and it carries the right 4-byte selector prefix.
    expect(call.callData.startsWith(toFunctionSelector('balanceOf(address)'))).toBe(true);
  });

  it('returns an empty array for an empty arg list', () => {
    expect(encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', [])).toEqual([]);
  });
});

/**
 * Build a stub PublicClient whose `readContract` returns a fixed sequence of
 * aggregate3 result batches (one per chunk, in call order). The mock records
 * every invocation so the test can assert chunking + argument shape.
 */
function stubClient(
  batches: readonly { success: boolean; returnData: `0x${string}` }[][],
) {
  const readContract = vi.fn(async () => {
    const next = batches[readContract.mock.calls.length - 1];
    return next;
  });
  return { client: { readContract } as unknown as PublicClient, readContract };
}

describe('batchCalls', () => {
  it('short-circuits to [] without any RPC call when given no calls', async () => {
    const { client, readContract } = stubClient([]);
    const out = await batchCalls<bigint>(client, BALANCE_ABI, 'balanceOf', []);
    expect(out).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });

  it('decodes each successful subcall to its return value, in order', async () => {
    const calls = encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', [
      [ADDR_A],
      [ADDR_B],
    ]);
    const { client } = stubClient([
      [
        { success: true, returnData: uint256Result(100n) },
        { success: true, returnData: uint256Result(250n) },
      ],
    ]);

    const out = await batchCalls<bigint>(client, BALANCE_ABI, 'balanceOf', calls);
    expect(out).toEqual([100n, 250n]);
  });

  it('maps reverted / empty / undecodable subcalls to null without aborting the batch', async () => {
    const calls: BatchCall[] = encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', [
      [ADDR_A],
      [ADDR_B],
      [ADDR_A],
      [ADDR_B],
    ]);
    const { client } = stubClient([
      [
        { success: true, returnData: uint256Result(7n) }, // ok
        { success: false, returnData: '0x' }, // reverted → null
        { success: true, returnData: '0x' }, // empty payload → null
        { success: true, returnData: '0xdeadbeef' }, // undecodable → null
      ],
    ]);

    const out = await batchCalls<bigint>(client, BALANCE_ABI, 'balanceOf', calls);
    expect(out).toEqual([7n, null, null, null]);
  });

  it('chunks calls at chunkSize, one aggregate3 per chunk, reassembled in order', async () => {
    const args = [[ADDR_A], [ADDR_B], [ADDR_A], [ADDR_B], [ADDR_A]] as const;
    const calls = encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', args);
    const { client, readContract } = stubClient([
      [
        { success: true, returnData: uint256Result(1n) },
        { success: true, returnData: uint256Result(2n) },
      ],
      [
        { success: true, returnData: uint256Result(3n) },
        { success: true, returnData: uint256Result(4n) },
      ],
      [{ success: true, returnData: uint256Result(5n) }],
    ]);

    const out = await batchCalls<bigint>(
      client,
      BALANCE_ABI,
      'balanceOf',
      calls,
      2,
    );

    expect(out).toEqual([1n, 2n, 3n, 4n, 5n]);
    // 5 calls / chunkSize 2 → 3 aggregate3 round-trips.
    expect(readContract).toHaveBeenCalledTimes(3);
  });

  it('routes every batch through Multicall3 with allowFailure=true', async () => {
    const calls = encodeBatchCalls(TARGET, BALANCE_ABI, 'balanceOf', [[ADDR_A]]);
    const { client, readContract } = stubClient([
      [{ success: true, returnData: uint256Result(42n) }],
    ]);

    await batchCalls<bigint>(client, BALANCE_ABI, 'balanceOf', calls);

    const callArgs = readContract.mock.calls[0][0] as {
      address: Address;
      functionName: string;
      args: [{ target: Address; allowFailure: boolean; callData: `0x${string}` }[]];
    };
    expect(callArgs.address).toBe(MULTICALL3_ADDRESS);
    expect(callArgs.functionName).toBe('aggregate3');
    const [call3] = callArgs.args[0];
    expect(call3.target).toBe(TARGET);
    expect(call3.allowFailure).toBe(true);
    expect(call3.callData).toBe(calls[0].callData);
  });
});

describe('aggregateReads', () => {
  const MC3: Address = '0x00000000000000000000000000000000000000c3';
  const read = (account: Address) => ({
    address: TARGET,
    abi: BALANCE_ABI,
    functionName: 'balanceOf',
    args: [account],
  });

  it('reads every call in ONE aggregate3, in order, against the given Multicall3', async () => {
    const { client, readContract } = stubClient([
      [
        { success: true, returnData: uint256Result(5n) },
        { success: true, returnData: uint256Result(6n) },
      ],
    ]);
    const out = await aggregateReads(client, MC3, [read(ADDR_A), read(ADDR_B)]);
    expect(out).toEqual([
      { status: 'success', result: 5n },
      { status: 'success', result: 6n },
    ]);
    expect(readContract).toHaveBeenCalledTimes(1);
    const callArgs = readContract.mock.calls[0][0] as {
      address: Address;
      functionName: string;
      args: [{ allowFailure: boolean; callData: `0x${string}` }[]];
    };
    expect(callArgs.address).toBe(MC3);
    expect(callArgs.functionName).toBe('aggregate3');
    expect(callArgs.args[0].map((c) => c.allowFailure)).toEqual([true, true]);
    expect(callArgs.args[0][1].callData).toBe(
      encodeFunctionData({ abi: BALANCE_ABI, functionName: 'balanceOf', args: [ADDR_B] }),
    );
  });

  it('reports a reverted, empty or undecodable answer as that call failing', async () => {
    const { client } = stubClient([
      [
        { success: false, returnData: '0x08c379a0' },
        { success: true, returnData: '0x' },
        { success: true, returnData: '0xdeadbeef' },
      ],
    ]);
    const out = await aggregateReads(client, MC3, [read(ADDR_A), read(ADDR_B), read(ADDR_A)]);
    expect(out.map((s) => s.status)).toEqual(['failure', 'failure', 'failure']);
  });

  it('REJECTS when the request itself fails, rather than failing every slot', async () => {
    const outage = new Error('429 Too Many Requests');
    const client = {
      readContract: vi.fn(async () => {
        throw outage;
      }),
    } as unknown as PublicClient;
    await expect(aggregateReads(client, MC3, [read(ADDR_A)])).rejects.toBe(outage);
  });

  it('rejects an answer whose length does not match the calls', async () => {
    const { client } = stubClient([[{ success: true, returnData: uint256Result(1n) }]]);
    await expect(aggregateReads(client, MC3, [read(ADDR_A), read(ADDR_B)])).rejects.toThrow(
      /1 result\(s\) for 2 call\(s\)/,
    );
  });

  it('pins the read to a block when one is given, and to none otherwise', async () => {
    const { client, readContract } = stubClient([
      [{ success: true, returnData: uint256Result(1n) }],
      [{ success: true, returnData: uint256Result(2n) }],
    ]);
    await aggregateReads(client, MC3, [read(ADDR_A)], 1234n);
    await aggregateReads(client, MC3, [read(ADDR_A)]);
    const pinned = readContract.mock.calls[0][0] as { blockNumber?: bigint };
    const latest = readContract.mock.calls[1][0] as { blockNumber?: bigint };
    expect(pinned.blockNumber).toBe(1234n);
    expect('blockNumber' in latest).toBe(false);
  });

  it('sends nothing for no reads', async () => {
    const { client, readContract } = stubClient([]);
    expect(await aggregateReads(client, MC3, [])).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });
});
