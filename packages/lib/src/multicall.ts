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
  /**
   * Optional block to pin every chunk to.
   *
   * Without it each chunk reads whatever `latest` the serving node has, so a
   * batch can straddle blocks and a load-balanced endpoint can answer one
   * chunk from a node several blocks behind another. Pinning makes the whole
   * batch describe ONE state, and turns "this node is behind" from a silently
   * stale answer into an error the caller can act on.
   */
  blockNumber?: bigint,
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
      ...(blockNumber === undefined ? {} : { blockNumber }),
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

/** One read in an {@link aggregateReads} call — the shape viem's own
 *  `readContract` takes, without its generics. */
export interface AggregateRead {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/** One read's answer. `failure` means the CHAIN refused that call (it
 *  reverted, or answered nothing the ABI can decode); it never stands for a
 *  provider failure, which rejects the whole {@link aggregateReads} call. */
export type AggregateSlot =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown };

/**
 * Evaluate `reads` in ONE Multicall3 `aggregate3` — one `eth_call`, so one
 * block — and decode each answer against its own ABI.
 *
 * This exists because viem's `multicall({ allowFailure: true })` cannot
 * keep the two facts its callers need. It splits the calls into chunks by
 * calldata size and sends each chunk as its own request, so a plan is not
 * guaranteed to be read at one block; and when a chunk's request REJECTS —
 * an RPC outage, a timeout, a rate limit — it copies that error into every
 * slot of the chunk as `status: 'failure'`, the same status an on-chain
 * revert gets. A caller that reads a failed slot as "the protocol refused
 * this call" then states a verdict from a provider outage.
 *
 * Here a request that does not complete rejects, and only a call the chain
 * itself refused comes back as a `failure` slot.
 */
export async function aggregateReads(
  publicClient: Pick<PublicClient, 'readContract'>,
  multicall3: Address,
  reads: readonly AggregateRead[],
  /** The block to read at; omitted, the node's `latest`. A caller that
   *  states the block its figures describe pins it here, so the figures
   *  and the stated block cannot disagree. */
  blockNumber?: bigint,
): Promise<AggregateSlot[]> {
  if (reads.length === 0) return [];
  const calls = reads.map((r) => ({
    target: r.address,
    allowFailure: true,
    callData: encodeFunctionData({
      abi: r.abi as Abi,
      functionName: r.functionName,
      args: r.args,
    } as never),
  }));
  const results = (await publicClient.readContract({
    address: multicall3,
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [calls],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as readonly { success: boolean; returnData: `0x${string}` }[];
  if (results.length !== reads.length) {
    throw new Error(`aggregate3 answered ${results.length} result(s) for ${reads.length} call(s)`);
  }
  return results.map((r, i): AggregateSlot => {
    if (!r.success) return { status: 'failure', error: r.returnData };
    try {
      return {
        status: 'success',
        result: decodeFunctionResult({
          abi: reads[i].abi as Abi,
          functionName: reads[i].functionName,
          data: r.returnData,
        } as never),
      };
    } catch (error) {
      return { status: 'failure', error };
    }
  });
}
