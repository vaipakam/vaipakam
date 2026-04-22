import { Contract, Interface, type Provider } from 'ethers';

/**
 * Multicall3 is deployed at the same address on every chain that supports
 * CREATE2-determinstic deploys, Sepolia included. We use `aggregate3` so
 * individual failures don't poison the whole batch — each sub-call returns
 * `{success, returnData}` and the caller decides how to handle failures.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
];

export interface BatchCall {
  target: string;
  callData: string;
}

/**
 * Fan out `calls` through Multicall3 in chunks of `chunkSize` (default 100).
 * Returns `(decoded | null)` per input call — `null` slots correspond to
 * subcalls that reverted, so callers can surface them without aborting the
 * whole batch.
 */
export async function batchCalls<T>(
  provider: Provider,
  iface: Interface,
  fragment: string,
  calls: BatchCall[],
  chunkSize = 100,
): Promise<(T | null)[]> {
  if (calls.length === 0) return [];
  const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  const out: (T | null)[] = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += chunkSize) {
    const slice = calls.slice(i, i + chunkSize);
    const args = slice.map((c) => ({
      target: c.target,
      allowFailure: true,
      callData: c.callData,
    }));
    const results: Array<{ success: boolean; returnData: string }> =
      await multicall.aggregate3.staticCall(args);
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (!r.success || r.returnData === '0x') continue;
      try {
        const decoded = iface.decodeFunctionResult(fragment, r.returnData);
        // `decodeFunctionResult` returns a Result-like tuple; for a single
        // struct-returning function, the caller wants `decoded[0]`.
        out[i + j] = decoded[0] as T;
      } catch {
        // leave slot as null
      }
    }
  }
  return out;
}
