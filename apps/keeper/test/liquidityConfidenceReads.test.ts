/**
 * liquidityConfidence's per-tick read budget (#1896).
 *
 * The per-selector attribution in the bench harness put this pass at 428
 * requests per tick with 1% of them on a transaction path. Two structural
 * causes, both fixed here and both pinned below:
 *
 *   1. One `getLoanDetails` per active loan, sequentially, to answer a question
 *      about DISTINCT collateral assets.
 *   2. `getAssetPrice` and `decimals()` re-read for the same token once per
 *      (asset x PAA quote token) pair — 2·A·Q round-trips per chain per tick
 *      for values that cannot change within a tick, one of which (`decimals`)
 *      cannot change at all.
 *
 * WHY THESE ASSERTIONS AND NOT A CALL COUNT. A total-request bound would pass
 * against an implementation that cached the wrong thing — in particular one
 * that cached a FAILED `decimals()` read, which is the tempting simplification
 * and the dangerous one: `tokenDecimals` falls back to 18 on failure, and a
 * cached 18 for a 6-decimal token silently skews every slippage figure derived
 * from it for the rest of the tick. So the assertions are per-token identities
 * ("read exactly once") plus an explicit test that a failing read is retried.
 *
 * The bench fixture cannot cover any of this: it has no ERC-20 ABI, so every
 * `decimals()` read there returns `0x` and fails, and `tokenDecimals` swallows
 * that without logging. The pass has been profiled with 78 silent failures per
 * run and an `err/run` of 0.0.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
} from 'viem';
import {
  ConfigFacetABI,
  LoanFacetABI,
  MetricsFacetABI,
  OracleFacetABI,
} from '@vaipakam/contracts/abis';
import { MULTICALL3_ADDRESS } from '../src/multicall3';

const AGGREGATE3 = {
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
} as const;

function fn(abi: unknown, name: string): AbiFunction {
  const item = (abi as readonly AbiFunction[]).find(
    (i) => i.type === 'function' && i.name === name,
  );
  if (!item) throw new Error(`${name} not found on ABI`);
  return item;
}

const F = {
  bundle: fn(ConfigFacetABI, 'getDepthTierConfigBundle'),
  paa: fn(ConfigFacetABI, 'getPaaAssets'),
  keeperTier: fn(ConfigFacetABI, 'getKeeperTier'),
  loanCount: fn(MetricsFacetABI, 'getActiveLoansCount'),
  loanPage: fn(MetricsFacetABI, 'getActiveLoansPaginated'),
  details: fn(LoanFacetABI, 'getLoanDetails'),
  price: fn(OracleFacetABI, 'getAssetPrice'),
  decimals: fn(erc20Abi, 'decimals'),
} as const;

const SEL = Object.fromEntries(
  Object.entries(F).map(([k, f]) => [k, toFunctionSelector(f).toLowerCase()]),
) as Record<keyof typeof F, string>;

const AGG_SEL = toFunctionSelector(AGGREGATE3).toLowerCase();

/** Two distinct collateral assets, and three PAA quote tokens. */
const ASSETS = [
  '0x00000000000000000000000000000000000000a1',
  '0x00000000000000000000000000000000000000a2',
] as const;
const QUOTES = [
  '0x00000000000000000000000000000000000000b1',
  '0x00000000000000000000000000000000000000b2',
  '0x00000000000000000000000000000000000000b3',
] as const;

function enc(f: AbiFunction, result: unknown): string {
  return encodeFunctionResult({
    abi: [f] as Abi,
    functionName: f.name,
    result: result as never,
  });
}

/**
 * A `getLoanDetails` tuple built from the compiled ABI: every field zeroed
 * except the three this pass reads. Derived rather than hand-written, because
 * the struct carries 20+ fields and a literal would drift.
 */
function loanDetails(collateral: string): string {
  const out = F.details.outputs;
  const one = (p: { name?: string; type: string; components?: readonly unknown[] }): unknown => {
    const n = p.name ?? '';
    if (n === 'collateralAsset') return collateral;
    if (n === 'collateralAssetType' || n === 'status') return 0;
    const t = p.type;
    if (t.endsWith('[]')) return [];
    if (t === 'tuple') {
      return ((p.components ?? []) as { name?: string; type: string }[]).map(one);
    }
    if (t === 'address') return '0x0000000000000000000000000000000000000000';
    if (t === 'bool') return false;
    if (t === 'string') return '';
    if (t === 'bytes') return '0x';
    if (/^bytes\d+$/.test(t)) return `0x${'00'.repeat(Number(t.slice(5)))}`;
    return 0n;
  };
  const vals = out.map((o) => one(o as never));
  return enc(F.details, out.length === 1 ? vals[0] : vals);
}

type Tally = {
  /** getAssetPrice calls, by the asset argument (lowercased). */
  price: string[];
  /** decimals() calls, by the token they were sent to (lowercased). */
  decimals: string[];
  /** standalone (un-batched) getLoanDetails calls. */
  serialDetails: number;
  /** aggregate3 calls, and the selectors they carried. */
  batches: { to: string; inner: string[] }[];
};

/**
 * @param failDecimalsFor token whose `decimals()` always reverts, to check that
 *        a FAILED read is not cached.
 */
function install(failDecimalsFor?: string): { tally: Tally; restore: () => void } {
  const tally: Tally = { price: [], decimals: [], serialDetails: 0, batches: [] };
  const real = globalThis.fetch;

  const answer = (to: string, data: string): string | null => {
    const sel = data.slice(0, 10).toLowerCase();
    switch (sel) {
      case SEL.bundle:
        return enc(F.bundle, [
          true, // depthTieredLtvEnabled
          100n, // liquiditySlippageBps — must be non-zero or the chain is skipped
          0n,
          0n,
          1_000n, // floorSizePad — likewise
          2_000n,
          3_000n,
          4_000n,
          0n,
          0n,
          0n,
        ]);
      case SEL.paa:
        return enc(F.paa, QUOTES.map((q) => q));
      case SEL.keeperTier:
        return enc(F.keeperTier, 1);
      case SEL.loanCount:
        return enc(F.loanCount, BigInt(ASSETS.length));
      case SEL.loanPage:
        return enc(F.loanPage, ASSETS.map((_, i) => BigInt(i + 1)));
      case SEL.details: {
        const { args } = decodeFunctionData({ abi: [F.details] as Abi, data: data as `0x${string}` });
        const id = Number((args as readonly unknown[])[0]);
        return loanDetails(ASSETS[(id - 1) % ASSETS.length]);
      }
      case SEL.price: {
        const { args } = decodeFunctionData({ abi: [F.price] as Abi, data: data as `0x${string}` });
        tally.price.push(String((args as readonly string[])[0]).toLowerCase());
        return enc(F.price, [1_000_000n, 8]);
      }
      case SEL.decimals:
        tally.decimals.push(to.toLowerCase());
        if (failDecimalsFor && to.toLowerCase() === failDecimalsFor.toLowerCase()) return null;
        return enc(F.decimals, 18);
      default:
        return null;
    }
  };

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(typeof input === 'string' ? input : (input as { url?: string })?.url ?? '');
    // Aggregator quote APIs and anything else non-RPC: a bland 200. Every quote
    // then fails, which is fine — the reads under test happen before the quotes.
    if (!url.includes('mock-rpc')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init?.body ?? '{}');
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((req: { method: string; params?: unknown[]; id?: unknown }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: req.id ?? 1, result });
      const fail = () => ({
        jsonrpc: '2.0',
        id: req.id ?? 1,
        error: { code: -32000, message: 'execution reverted' },
      });
      if (req.method === 'eth_chainId') return ok('0x14a34');
      if (req.method === 'eth_blockNumber') return ok('0x1312d00');
      if (req.method !== 'eth_call') return ok(null);
      const call = (req.params?.[0] ?? {}) as { to?: string; data?: string };
      const to = (call.to ?? '').toLowerCase();
      const data = (call.data ?? '0x').toLowerCase();

      if (data.slice(0, 10) === AGG_SEL) {
        const { args } = decodeFunctionData({ abi: [AGGREGATE3] as Abi, data: data as `0x${string}` });
        const calls = args[0] as readonly { target: string; callData: string }[];
        tally.batches.push({
          to,
          inner: calls.map((c) => c.callData.slice(0, 10).toLowerCase()),
        });
        return ok(
          enc(AGGREGATE3 as unknown as AbiFunction, calls.map((c) => {
            const r = answer(c.target.toLowerCase(), c.callData.toLowerCase());
            return { success: r !== null, returnData: (r ?? '0x') as `0x${string}` };
          })),
        );
      }

      if (data.slice(0, 10) === SEL.details) tally.serialDetails += 1;
      const r = answer(to, data);
      return r === null ? fail() : ok(r);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { tally, restore: () => { globalThis.fetch = real; } };
}

function db(): unknown {
  const stmt: Record<string, unknown> = {};
  stmt.bind = () => stmt;
  stmt.all = async () => ({ results: [], success: true, meta: {} });
  stmt.first = async () => null;
  stmt.run = async () => ({ results: [], success: true, meta: {} });
  return { prepare: () => stmt, batch: async () => [], exec: async () => ({}) };
}

async function run(): Promise<void> {
  const { runLiquidityConfidence } = await import('../src/liquidityConfidence');
  await runLiquidityConfidence({
    DB: db(),
    RPC_BASE_SEPOLIA: 'https://mock-rpc.invalid/base-sepolia',
  } as never);
}

/** How many times `x` appears in `xs`. */
const count = (xs: string[], x: string): number =>
  xs.filter((v) => v === x.toLowerCase()).length;

describe('liquidityConfidence read budget (#1896)', () => {
  it('batches the loan-detail scan and reads each token price/decimals once', async () => {
    const { tally, restore } = install();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
    } finally {
      restore();
      spy.mockRestore();
      log.mockRestore();
    }

    // 1. The collateral scan is batched, and nothing fell back to per-loan.
    expect(tally.batches.length).toBeGreaterThan(0);
    for (const b of tally.batches) expect(b.to).toBe(MULTICALL3_ADDRESS.toLowerCase());
    expect(tally.batches.flatMap((b) => b.inner)).toContain(SEL.details);
    expect(tally.serialDetails).toBe(0);

    // 2. Every token's price is read EXACTLY once for the whole tick. Without
    //    the cache each of the 2 assets re-reads its own price plus all 3 quote
    //    prices — 8 reads for 5 tokens.
    expect(tally.price.length).toBeGreaterThan(0);
    for (const t of [...ASSETS, ...QUOTES]) {
      expect(count(tally.price, t), `price re-read for ${t}`).toBeLessThanOrEqual(1);
    }

    // 3. Same for decimals, which is immutable and was the worst offender.
    for (const t of [...ASSETS, ...QUOTES]) {
      expect(count(tally.decimals, t), `decimals re-read for ${t}`).toBeLessThanOrEqual(1);
    }

    // 4. The pass still did its work — a cache that reduced the count by not
    //    running would satisfy everything above.
    expect(count(tally.price, QUOTES[QUOTES.length - 1])).toBe(1);
  });

  it('does NOT cache a failed decimals read — it retries', async () => {
    // The deliberate half of the design. `tokenDecimals` falls back to 18 on
    // failure; caching that would pin a wrong decimals for the rest of the tick
    // and silently skew every slippage figure computed from it. So a failure
    // must stay uncached, and this is what stops the "simplification".
    const { tally, restore } = install(QUOTES[0]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
    } finally {
      restore();
      spy.mockRestore();
      log.mockRestore();
    }

    // Attempted once per asset rather than once per tick: 2 assets, so >= 2.
    expect(count(tally.decimals, QUOTES[0])).toBeGreaterThan(1);
    // And the tokens that DID answer are still cached.
    expect(count(tally.decimals, QUOTES[1])).toBeLessThanOrEqual(1);
  });
});
