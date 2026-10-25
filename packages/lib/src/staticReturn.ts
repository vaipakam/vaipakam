/**
 * #2812 — decode a view's answer only when it has the shape this build's
 * ABI describes.
 *
 * A getter whose outputs are all static (integers, flags, addresses, fixed
 * bytes, fixed-length arrays and tuples of those) always returns the same
 * number of bytes, and the ABI says how many. viem decodes such an answer
 * by position and ignores anything past the bytes it expects, so an answer
 * from DIFFERENT code decodes without an error whenever it is at least as
 * long as this build expects: every field after the first one that moved
 * comes back as its neighbour's value. That is the state between a change
 * to a getter's outputs and the deploy of the facet behind it (#2812 took
 * two flags out of the middle of `getProtocolConfigBundle`, so the old
 * 21-word answer read through the new 19-word ABI put a flag under the
 * matcher fee).
 *
 * So the rule is one comparison, made for every such read: the answer's
 * length equals the length the ABI describes, or the answer is not decoded
 * and the caller is told it does not match. It covers any future change to
 * a static tuple, not only this one. What it cannot see is a reorder that
 * keeps the length; binding the names to the code that answered is the
 * separate rule in `abiDescribesGetterAt` (`@vaipakam/lib/protocolKnobs`).
 *
 * The ABI is a parameter so this package keeps no runtime dependency on
 * `@vaipakam/contracts`.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAbiItem,
  type Abi,
  type AbiParameter,
  type Address,
  type PublicClient,
} from 'viem';

/** Bytes one static ABI value occupies, or null when it is dynamic. */
function staticParameterBytes(p: AbiParameter): number | null {
  const fixedArray = /^(.*)\[(\d+)\]$/.exec(p.type);
  if (fixedArray) {
    const inner = staticParameterBytes({ ...p, type: fixedArray[1] } as AbiParameter);
    return inner === null ? null : inner * Number(fixedArray[2]);
  }
  if (p.type.endsWith('[]') || p.type === 'bytes' || p.type === 'string') return null;
  if (p.type === 'tuple') {
    const components = (p as { components?: readonly AbiParameter[] }).components ?? [];
    let total = 0;
    for (const c of components) {
      const b = staticParameterBytes(c);
      if (b === null) return null;
      total += b;
    }
    return total;
  }
  // uint*, int*, bool, address, bytes1..bytes32: one word each.
  return 32;
}

/** The exact length, in bytes, of the answer the ABI describes for
 *  `functionName`; null when the getter is absent, has no outputs, or any
 *  output is dynamic (its length is then not fixed and this rule does not
 *  apply). */
export function staticReturnBytes(abi: Abi, functionName: string): number | null {
  const item = getAbiItem({ abi, name: functionName });
  if (!item || item.type !== 'function' || item.outputs.length === 0) return null;
  let total = 0;
  for (const o of item.outputs) {
    const b = staticParameterBytes(o);
    if (b === null) return null;
    total += b;
  }
  return total;
}

export type StaticReturnRead =
  /** Every output, in ABI order (a single-output getter gives a list of
   *  one). */
  | { kind: 'decoded'; outputs: readonly unknown[] }
  /** The chain answered with a different number of bytes than this
   *  build's ABI describes: the code behind the getter is not the code
   *  this build was compiled against, and nothing is decoded. */
  | { kind: 'shape-mismatch'; gotBytes: number; expectedBytes: number };

/**
 * Call a no-argument (or `args`-taking) static-output view and decode its
 * answer only if its length is the one the ABI describes. A revert or a
 * transport failure throws, as `readContract` would; the caller decides
 * what that means for its source. A getter with a dynamic output is a
 * programming error here and throws.
 */
export async function readStaticReturn(opts: {
  client: PublicClient;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
}): Promise<StaticReturnRead> {
  const expectedBytes = staticReturnBytes(opts.abi, opts.functionName);
  if (expectedBytes === null) {
    throw new Error(`readStaticReturn: ${opts.functionName} has no static outputs in this ABI`);
  }
  const { data } = await opts.client.call({
    to: opts.address,
    data: encodeFunctionData({
      abi: opts.abi,
      functionName: opts.functionName,
      args: opts.args,
    } as Parameters<typeof encodeFunctionData>[0]),
    ...(opts.blockNumber === undefined ? {} : { blockNumber: opts.blockNumber }),
  });
  const gotBytes = data ? (data.length - 2) / 2 : 0;
  if (!data || gotBytes !== expectedBytes) return { kind: 'shape-mismatch', gotBytes, expectedBytes };
  const decoded = decodeFunctionResult({
    abi: opts.abi,
    functionName: opts.functionName,
    data,
  } as Parameters<typeof decodeFunctionResult>[0]) as unknown;
  const item = getAbiItem({ abi: opts.abi, name: opts.functionName }) as { outputs: readonly unknown[] };
  return { kind: 'decoded', outputs: item.outputs.length === 1 ? [decoded] : (decoded as readonly unknown[]) };
}

/** A shape mismatch said in words, for a log line or a disclosure. */
export function describeShapeMismatch(functionName: string, r: { gotBytes: number; expectedBytes: number }): string {
  const words = (n: number) => (n % 32 === 0 ? `${n / 32} words` : `${n} bytes`);
  return `${functionName} answered ${words(r.gotBytes)}, and this build's ABI describes ${words(r.expectedBytes)}: the code behind it is not the code this build was compiled against`;
}
