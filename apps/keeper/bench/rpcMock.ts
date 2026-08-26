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

/** What a count-shaped uint answers — bounds every pagination loop. */
export const COUNT_VALUE = Number(process.env.BENCH_COUNT ?? 50);

/**
 * How many FULL pages one selector serves before it starts answering with an
 * empty array. Without this a paginated read is infinite: every page comes
 * back full, so the caller always asks for one more.
 */
export const MAX_PAGES = Number(process.env.BENCH_PAGES ?? 2);

/**
 * Hard ceiling on RPC calls one pass may make before the mock refuses to
 * answer.
 *
 * A timeout cannot fix a runaway loop here: `Promise.race` abandons the
 * waiter, it does not cancel the pass, so a spinning pass keeps burning CPU in
 * the background and the next pass profiles on a loaded machine. Bounding it
 * at the SOURCE is what actually stops it — the mock throws, the pass's own
 * catch unwinds it, and the run continues.
 *
 * Exceeding this is itself a finding, not a harness failure: a pass issuing
 * thousands of calls per tick against three chains is the CPU problem.
 */
export const CALL_BUDGET = Number(process.env.BENCH_CALL_BUDGET ?? 3000);

/** Per-selector call counter, reset between passes. */
const pageCounts = new Map<string, number>();
let budgetLeft = CALL_BUDGET;
/** Set when a pass blew the budget, so the runner can report it as unbounded. */
export const budget = { exceeded: false };

export function resetPages(): void {
  pageCounts.clear();
  budgetLeft = CALL_BUDGET;
  budget.exceeded = false;
}

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

/**
 * A plausible, correctly-typed value for one ABI output parameter.
 *
 * `fnName` is not decoration: `getActiveLoansCount`'s output is UNNAMED in the
 * ABI, so a parameter-name-only heuristic misses it, answers 1e18, and the
 * caller then walks ~1e16 pages. That is precisely how preGraceWatcher came
 * out at 20,025 calls and 5.9 s and looked like the worst pass in the tree.
 */
function defaultFor(p: AbiParameter, fnName = ''): unknown {
  const t = p.type;
  if (t.endsWith('[]')) {
    const inner = { ...p, type: t.slice(0, -2) } as AbiParameter;
    return Array.from({ length: ARRAY_LEN }, () => defaultFor(inner, fnName));
  }
  const fixed = t.match(/^(.*)\[(\d+)\]$/);
  if (fixed) {
    const inner = { ...p, type: fixed[1] } as AbiParameter;
    return Array.from({ length: Number(fixed[2]) }, () => defaultFor(inner, fnName));
  }
  if (t === 'tuple') {
    const comps = (p as { components?: readonly AbiParameter[] }).components ?? [];
    return comps.map((c) => defaultFor(c, fnName));
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
    // A COUNT and an AMOUNT need different magnitudes, and conflating them
    // hung the first working run of this harness: `getActiveLoansCount`
    // answered 1e18, so the liquidator's pagination loop had 1e18/200 pages
    // to walk and never returned. Names are the only signal available here,
    // and they are reliable enough for a profiling fixture.
    const COUNTISH = /count|total|length|len|num|size|pages/i;
    if (COUNTISH.test(p.name ?? '') || COUNTISH.test(fnName)) {
      return BigInt(COUNT_VALUE);
    }
    // Non-trivial magnitude otherwise: a zero everywhere would let a pass
    // early-return on "nothing to do" and profile as free, which is the
    // failure mode this harness exists to avoid.
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

  // Exhaust arrays after MAX_PAGES so pagination terminates — but ONLY for
  // genuinely paginated reads, identified by a cursor/offset-shaped INPUT.
  //
  // Applying it to every array-returning function silently under-counted:
  // `getUserActiveLoans(address)` is a per-user list, not a page, and emptying
  // it after two calls meant 18 of 20 seeded users returned no loans at all.
  // The watcher's measured cost came out a large multiple too low, and looked
  // clean while doing it.
  const paginated = fn.inputs.some((i) =>
    /offset|start|cursor|page|index|from/i.test(i.name ?? ''),
  );
  const returnsArray = fn.outputs.some((o) => o.type.endsWith('[]'));
  let exhausted = false;
  if (returnsArray && paginated) {
    const seen = (pageCounts.get(selector) ?? 0) + 1;
    pageCounts.set(selector, seen);
    exhausted = seen > MAX_PAGES;
  }
  const values = fn.outputs.map((o) =>
    exhausted && o.type.endsWith('[]') ? [] : defaultFor(o, fn.name),
  );
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
    budgetLeft -= 1;
    if (budgetLeft < 0) {
      budget.exceeded = true;
      throw new Error(
        `[bench] RPC call budget of ${CALL_BUDGET} exhausted — this pass is ` +
          'unbounded against the fixture. That is the finding, not a bug.',
      );
    }
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
