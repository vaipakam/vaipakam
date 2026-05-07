import {
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type PublicClient,
} from 'viem';

/**
 * Multicall3 is deployed at the same address on every chain that supports
 * CREATE2-deterministic deploys, Sepolia included. We use `aggregate3` so
 * individual failures don't poison the whole batch — each sub-call returns
 * `{success, returnData}` and the caller decides how to handle failures.
 */
export const MULTICALL3_ADDRESS: Address =
  '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'target', type: 'address' },
          { internalType: 'bool', name: 'allowFailure', type: 'bool' },
          { internalType: 'bytes', name: 'callData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Call3[]',
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'aggregate3',
    outputs: [
      {
        components: [
          { internalType: 'bool', name: 'success', type: 'bool' },
          { internalType: 'bytes', name: 'returnData', type: 'bytes' },
        ],
        internalType: 'struct Multicall3.Result[]',
        name: 'returnData',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

export interface BatchCall {
  target: Address;
  /** ABI-encoded calldata (`0x…`). Build with {@link encodeBatchCalls} or
   *  viem's `encodeFunctionData` directly. */
  callData: `0x${string}`;
}

/**
 * Helper: encode the same function N times against different arg tuples.
 * Common pattern for protocol-stats / risk / offer-detail sweeps where a
 * single view function is called across many IDs.
 */
export function encodeBatchCalls(
  target: Address,
  abi: Abi,
  functionName: string,
  argsList: readonly (readonly unknown[])[],
): BatchCall[] {
  return argsList.map((args) => ({
    target,
    callData: encodeFunctionData({ abi, functionName, args }),
  }));
}

/**
 * Fan out `calls` through Multicall3 in chunks of `chunkSize` (default 100).
 * Returns `(decoded | null)` per input call — `null` slots correspond to
 * subcalls that reverted (or decode failures), so callers can surface them
 * without aborting the whole batch. `abi` + `functionName` drive the
 * return-data decode for each slot; all calls in a batch must hit the
 * same function signature (same ABI entry), though target addresses may
 * differ per slot.
 */
export async function batchCalls<T>(
  publicClient: PublicClient,
  abi: Abi,
  functionName: string,
  calls: BatchCall[],
  chunkSize = 100,
): Promise<(T | null)[]> {
  if (calls.length === 0) return [];
  const out: (T | null)[] = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += chunkSize) {
    const slice = calls.slice(i, i + chunkSize);
    const args = slice.map((c) => ({
      target: c.target,
      allowFailure: true,
      callData: c.callData,
    }));
    const results = (await publicClient.readContract({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      args: [args],
    })) as readonly { success: boolean; returnData: `0x${string}` }[];

    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (!r.success || r.returnData === '0x') continue;
      try {
        const decoded = decodeFunctionResult({
          abi,
          functionName,
          data: r.returnData,
        });
        // viem's `decodeFunctionResult` already unwraps a single-return
        // function (returns the value directly, not a tuple). For multi-
        // return functions it returns a tuple; callers pass the tuple
        // type as `T`.
        out[i + j] = decoded as T;
      } catch {
        // leave slot as null
      }
    }
  }
  return out;
}
