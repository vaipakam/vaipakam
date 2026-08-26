/**
 * A selector-aware JSON-RPC mock, for CPU profiling the keeper's passes
 * off-Cloudflare (#1896).
 *
 * WHY THIS SHAPE. The thing we are trying to measure is CPU, and on a Worker
 * the CPU in an RPC-heavy pass is not the waiting — it is `JSON.parse` of the
 * response plus viem's ABI decode of the result. A mock that returns `0x` for
 * every call would therefore measure almost nothing and rank every pass as
 * free. So every `eth_call` here is answered with a REAL ABI-encoded result
 * for the selector that was asked for, built from the compiled Diamond ABI,
 * with arrays filled to a configurable length. The decode work the pass then
 * does is the same work it does in production.
 *
 * WHAT IT IS NOT. This runs on Node, not workerd. Absolute milliseconds here
 * are not workerd milliseconds — V8 is the same engine but the build, the
 * limits and the I/O model are not. Read the output as a RANKING and as an
 * order-of-magnitude bound, which is what #1896 actually needs: the open
 * question is *which* pass is expensive, and a ranking answers it.
 */
import {
  encodeFunctionResult,
  decodeFunctionData,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

/** How many entries every dynamic array result carries. */
export const ARRAY_LEN = Number(process.env.BENCH_ARRAY_LEN ?? 25);

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;

/**
 * Multicall3's `aggregate3`, which viem uses for `publicClient.multicall`.
 * It is not on the Diamond ABI, so it needs handling of its own: the inner
 * calldata is unwrapped and each sub-call answered on its own selector, which
 * is what makes a batched read cost realistic decode work rather than one
 * cheap blob.
 */
const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const satisfies Abi;

/** selector -> function item, across the whole Diamond surface. */
const BY_SELECTOR = new Map<string, AbiFunction>();
for (const item of DIAMOND_ABI_VIEM as readonly AbiFunction[]) {
  if (item.type !== 'function') continue;
  try {
    BY_SELECTOR.set(toFunctionSelector(item), item);
  } catch {
    // Overloads that fail to serialise are not worth aborting the harness for.
  }
}

/** A plausible, correctly-typed value for one ABI output parameter. */
function defaultFor(p: AbiParameter): unknown {
  const t = p.type;
  if (t.endsWith('[]')) {
    const inner = { ...p, type: t.slice(0, -2) } as AbiParameter;
    return Array.from({ length: ARRAY_LEN }, () => defaultFor(inner));
  }
  const fixed = t.match(/^(.*)\[(\d+)\]$/);
  if (fixed) {
    const inner = { ...p, type: fixed[1] } as AbiParameter;
    return Array.from({ length: Number(fixed[2]) }, () => defaultFor(inner));
  }
  if (t === 'tuple') {
    const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
    return comps.map(defaultFor);
  }
  if (t === 'address') return ADDRESS;
  if (t === 'bool') return false;
  if (t === 'string') return 'x';
  if (t === 'bytes') return '0x';
  if (/^bytes\d+$/.test(t)) {
    const n = Number(t.slice(5));
    return `0x${'11'.repeat(n)}`;
  }
  if (/^u?int\d*$/.test(t)) {
    // Non-trivial magnitude: a zero everywhere would let a pass early-return
    // on "nothing to do" and profile as free, which is the failure mode this
    // harness exists to avoid.
    return 1_000_000_000_000_000_000n;
  }
  return 0n;
}

/** ABI-encode a plausible result for whatever selector was called. */
function answerCall(data: string): string {
  const selector = data.slice(0, 10).toLowerCase();

  if (selector === toFunctionSelector(MULTICALL3_ABI[0]).toLowerCase()) {
    const { args } = decodeFunctionData({
      abi: MULTICALL3_ABI,
      data: data as `0x${string}`,
    });
    const calls = args[0] as readonly { callData: string }[];
    const results = calls.map((c) => ({
      success: true,
      returnData: answerCall(c.callData) as `0x${string}`,
    }));
    return encodeFunctionResult({
      abi: MULTICALL3_ABI,
      functionName: 'aggregate3',
      result: results,
    });
  }

  const fn = BY_SELECTOR.get(selector);
  if (!fn || fn.outputs.length === 0) return '0x';
  const values = fn.outputs.map(defaultFor);
  return encodeFunctionResult({
    abi: [fn] as Abi,
    functionName: fn.name,
    result: (fn.outputs.length === 1 ? values[0] : values) as never,
  });
}

const HEX = (n: number | bigint) => `0x${n.toString(16)}`;

/** Answer one JSON-RPC request object. */
function answer(req: { method: string; params?: unknown[]; id?: unknown }): unknown {
  const { method, params = [] } = req;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
  switch (method) {
    case 'eth_chainId':
      return ok(HEX(8453));
    case 'eth_blockNumber':
      return ok(HEX(20_000_000));
    case 'eth_call':
      return ok(answerCall(((params[0] as { data?: string })?.data ?? '0x') as string));
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return ok({
        number: HEX(20_000_000),
        hash: `0x${'22'.repeat(32)}`,
        parentHash: `0x${'33'.repeat(32)}`,
        timestamp: HEX(Math.floor(Date.now() / 1000)),
        baseFeePerGas: HEX(1_000_000_000),
        gasLimit: HEX(30_000_000),
        gasUsed: HEX(15_000_000),
        miner: ADDRESS,
        extraData: '0x',
        transactions: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        difficulty: '0x0',
      });
    case 'eth_getLogs':
      return ok([]);
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return ok(HEX(1_000_000_000));
    case 'eth_estimateGas':
      return ok(HEX(500_000));
    case 'eth_getTransactionCount':
      return ok(HEX(7));
    case 'eth_sendRawTransaction':
      return ok(`0x${'44'.repeat(32)}`);
    case 'eth_getTransactionReceipt':
      return ok({
        transactionHash: `0x${'44'.repeat(32)}`,
        blockNumber: HEX(20_000_000),
        blockHash: `0x${'22'.repeat(32)}`,
        status: '0x1',
        gasUsed: HEX(400_000),
        cumulativeGasUsed: HEX(400_000),
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        contractAddress: null,
        from: ADDRESS,
        to: ADDRESS,
        transactionIndex: '0x0',
        type: '0x2',
        effectiveGasPrice: HEX(1_000_000_000),
      });
    case 'eth_feeHistory':
      return ok({
        oldestBlock: HEX(19_999_990),
        baseFeePerGas: Array.from({ length: 11 }, () => HEX(1_000_000_000)),
        gasUsedRatio: Array.from({ length: 10 }, () => 0.5),
        reward: Array.from({ length: 10 }, () => [HEX(1_000_000_000)]),
      });
    default:
      return ok(null);
  }
}

/** Counts requests served, so a pass that did nothing cannot look cheap. */
export const rpcStats = { calls: 0 };

/** Install the mock as global fetch. Returns a restore function. */
export function installRpcMock(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(
      typeof input === 'string' ? input : (input as { url?: string })?.url ?? '',
    );
    // Anything that is not our fake RPC endpoint (aggregator quotes, Telegram,
    // Push) gets a bland 200 rather than a network attempt.
    if (!url.includes('mock-rpc')) {
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    rpcStats.calls += 1;
    const body = JSON.parse(init?.body ?? '{}');
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
