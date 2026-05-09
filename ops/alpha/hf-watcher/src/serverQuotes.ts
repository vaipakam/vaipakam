/**
 * Phase 7a.4 — server-side mirror of `frontend/src/lib/swapQuoteService.ts`.
 *
 * Fetches quotes from every available DEX venue (0x / 1inch / UniV3 /
 * Balancer V2 — Balancer stubbed pending subgraph integration), ranks
 * by expected output, returns a ready-to-submit `AdapterCall[]` for the
 * Diamond's `triggerLiquidation(loanId, calls)`.
 *
 * Lives inside the Cloudflare Worker so the operator's API keys never
 * leave the trusted infra (no need to proxy through `/quote/*` like
 * the frontend does).
 *
 * SAFETY: server-side ranking does NOT weaken any on-chain guard. The
 * diamond enforces the oracle-derived `minOutputAmount` per-adapter;
 * a stale or hostile quote can only fail the adapter's slippage check
 * and the next-best entry tries.
 */

import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  encodeFunctionData,
} from 'viem';
import type { Env } from './env';

export interface ServerQuoteRequest {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps?: number;
}

export interface ServerAdapterCall {
  adapterIdx: bigint;
  data: Hex;
}

export interface ServerRankedQuote {
  kind: 'zeroex' | 'oneinch' | 'univ3' | 'balancerv2';
  expectedOutput: bigint;
  call: ServerAdapterCall;
}

export interface ServerOrchestrationResult {
  ranked: ServerRankedQuote[];
  calls: ServerAdapterCall[];
  failed: ('zeroex' | 'oneinch' | 'univ3' | 'balancerv2')[];
}

// ─── Per-chain registry. Mirror of frontend/swapRegistry.ts. ───────────

type AdapterIdxMap = {
  zeroex: number | null;
  oneinch: number | null;
  univ3: number | null;
  balancerv2: number | null;
};

interface ChainSwap {
  uniV3Quoter: Address | null;
  balancerVault: Address;
  /** Balancer V2 subgraph URL — null disables the venue. Hosted-
   *  service URLs by default; production deployments override via
   *  env to point at a paid / decentralized-network endpoint. */
  balancerV2SubgraphUrl: string | null;
  uniV3FeeTiers: readonly number[];
  adapters: AdapterIdxMap;
}

const COMMON_FEE_TIERS = [500, 3000, 10000] as const;
const BALANCER_V2_VAULT_CANONICAL =
  '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as const;

const CHAIN_SWAP: Record<number, ChainSwap> = {
  1: {
    uniV3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  8453: {
    uniV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-base-v2',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  42161: {
    uniV3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  10: {
    uniV3Quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-optimism-v2',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  1101: {
    uniV3Quoter: null,
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-zk-v2',
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: { zeroex: 0, oneinch: 1, univ3: null, balancerv2: 3 },
  },
  56: {
    uniV3Quoter: null,
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    // Balancer V2 not deployed on BNB Chain.
    balancerV2SubgraphUrl: null,
    uniV3FeeTiers: COMMON_FEE_TIERS,
    adapters: { zeroex: 0, oneinch: 1, univ3: null, balancerv2: 3 },
  },
};

// ─── Aggregator API helpers. ───────────────────────────────────────────

interface ZeroExResp {
  transaction?: { data?: string };
  buyAmount?: string;
}
interface OneInchResp {
  tx?: { data?: string };
  dstAmount?: string;
  toAmount?: string;
}

async function fetchZeroEx(
  env: Env,
  req: ServerQuoteRequest,
): Promise<ServerRankedQuote | null> {
  if (!env.ZEROEX_API_KEY) return null;
  const cs = CHAIN_SWAP[req.chainId];
  if (!cs?.adapters.zeroex && cs?.adapters.zeroex !== 0) return null;
  const url = new URL('https://api.0x.org/swap/allowance-holder/quote');
  url.searchParams.set('chainId', String(req.chainId));
  url.searchParams.set('sellToken', req.sellToken);
  url.searchParams.set('buyToken', req.buyToken);
  url.searchParams.set('sellAmount', req.sellAmount.toString());
  url.searchParams.set('taker', req.taker);
  url.searchParams.set('slippageBps', String(req.slippageBps ?? 600));
  try {
    const res = await fetch(url.toString(), {
      headers: {
        '0x-api-key': env.ZEROEX_API_KEY,
        '0x-version': 'v2',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ZeroExResp;
    const data = body.transaction?.data;
    const out = body.buyAmount;
    if (!data || !data.startsWith('0x') || !out) return null;
    return {
      kind: 'zeroex',
      expectedOutput: BigInt(out),
      call: { adapterIdx: BigInt(cs.adapters.zeroex), data: data as Hex },
    };
  } catch {
    return null;
  }
}

async function fetchOneInch(
  env: Env,
  req: ServerQuoteRequest,
): Promise<ServerRankedQuote | null> {
  if (!env.ONEINCH_API_KEY) return null;
  const cs = CHAIN_SWAP[req.chainId];
  if (cs?.adapters.oneinch == null) return null;
  const url = new URL(
    `https://api.1inch.dev/swap/v6.0/${req.chainId}/swap`,
  );
  url.searchParams.set('src', req.sellToken);
  url.searchParams.set('dst', req.buyToken);
  url.searchParams.set('amount', req.sellAmount.toString());
  url.searchParams.set('from', req.taker);
  url.searchParams.set('slippage', String((req.slippageBps ?? 600) / 100));
  url.searchParams.set('disableEstimate', 'true');
  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.ONEINCH_API_KEY}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OneInchResp;
    const data = body.tx?.data;
    const amount = body.dstAmount ?? body.toAmount;
    if (!data || !data.startsWith('0x') || !amount) return null;
    return {
      kind: 'oneinch',
      expectedOutput: BigInt(amount),
      call: { adapterIdx: BigInt(cs.adapters.oneinch), data: data as Hex },
    };
  } catch {
    return null;
  }
}

// QuoterV2.quoteExactInputSingle minimal ABI.
const QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: 'address', name: 'tokenIn', type: 'address' },
          { internalType: 'address', name: 'tokenOut', type: 'address' },
          { internalType: 'uint256', name: 'amountIn', type: 'uint256' },
          { internalType: 'uint24', name: 'fee', type: 'uint24' },
          { internalType: 'uint160', name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
        internalType: 'struct IQuoterV2.QuoteExactInputSingleParams',
        name: 'params',
        type: 'tuple',
      },
    ],
    name: 'quoteExactInputSingle',
    outputs: [
      { internalType: 'uint256', name: 'amountOut', type: 'uint256' },
      { internalType: 'uint160', name: 'sqrtPriceX96After', type: 'uint160' },
      { internalType: 'uint32', name: 'initializedTicksCrossed', type: 'uint32' },
      { internalType: 'uint256', name: 'gasEstimate', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

async function fetchUniV3(
  client: PublicClient,
  req: ServerQuoteRequest,
): Promise<ServerRankedQuote | null> {
  const cs = CHAIN_SWAP[req.chainId];
  if (!cs?.uniV3Quoter || cs.adapters.univ3 == null) return null;
  let best: { fee: number; out: bigint } | null = null;
  for (const fee of cs.uniV3FeeTiers) {
    try {
      const data = encodeFunctionData({
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn: req.sellToken,
            tokenOut: req.buyToken,
            amountIn: req.sellAmount,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
      const result = await client.call({ to: cs.uniV3Quoter, data });
      if (!result.data) continue;
      const out = BigInt('0x' + result.data.slice(2, 66));
      if (out > 0n && (!best || out > best.out)) best = { fee, out };
    } catch {
      continue;
    }
  }
  if (!best) return null;
  return {
    kind: 'univ3',
    expectedOutput: best.out,
    call: {
      adapterIdx: BigInt(cs.adapters.univ3),
      data: encodeAbiParameters([{ type: 'uint24' }], [best.fee]) as Hex,
    },
  };
}

/**
 * Phase 7a polish — Balancer V2 quote via subgraph.
 *
 * Mirror of the frontend `fetchBalancerV2Quote` in
 * `frontend/src/lib/swapQuoteService.ts`. Two-step:
 *   1. GraphQL query against the per-chain Balancer V2 subgraph for
 *      the deepest pool containing both tokens.
 *   2. Constant-product spot estimate from the pool's reserves.
 *
 * Returns null on any "data unavailable" path (no subgraph, no pool,
 * degenerate balances, network / parse error). The on-chain Balancer
 * V2 adapter enforces the oracle-derived `minOutputAmount` exactly,
 * so a rough ranking estimate can't push proceeds below the floor.
 */
async function fetchBalancerV2(
  req: ServerQuoteRequest,
): Promise<ServerRankedQuote | null> {
  const cs = CHAIN_SWAP[req.chainId];
  if (!cs?.balancerV2SubgraphUrl || cs.adapters.balancerv2 == null) return null;

  const sellLower = req.sellToken.toLowerCase();
  const buyLower = req.buyToken.toLowerCase();
  const query = `
    query {
      pools(
        where: {
          tokensList_contains: ["${sellLower}", "${buyLower}"]
          totalLiquidity_gt: "10000"
        }
        orderBy: totalLiquidity
        orderDirection: desc
        first: 1
      ) {
        id
        tokens { address balance decimals }
      }
    }
  `;

  let resJson: unknown;
  try {
    const res = await fetch(cs.balancerV2SubgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    resJson = await res.json();
  } catch {
    return null;
  }

  const pools = (resJson as { data?: { pools?: unknown[] } })?.data?.pools;
  if (!Array.isArray(pools) || pools.length === 0) return null;
  const pool = pools[0] as {
    id?: string;
    tokens?: Array<{ address?: string; balance?: string; decimals?: number }>;
  };
  const poolId = pool.id;
  if (!poolId || !poolId.startsWith('0x') || poolId.length < 66) return null;
  const tokens = pool.tokens ?? [];
  const sellEntry = tokens.find(
    (t) => (t.address ?? '').toLowerCase() === sellLower,
  );
  const buyEntry = tokens.find(
    (t) => (t.address ?? '').toLowerCase() === buyLower,
  );
  if (!sellEntry || !buyEntry) return null;
  const sellBal = decimalStringToBigInt(
    sellEntry.balance ?? '0',
    sellEntry.decimals ?? 18,
  );
  const buyBal = decimalStringToBigInt(
    buyEntry.balance ?? '0',
    buyEntry.decimals ?? 18,
  );
  if (sellBal === 0n || buyBal === 0n) return null;

  const out = (req.sellAmount * buyBal) / sellBal;
  if (out === 0n) return null;

  const data = encodeAbiParameters(
    [{ type: 'bytes32' }],
    [poolId as `0x${string}`],
  ) as Hex;
  return {
    kind: 'balancerv2',
    expectedOutput: out,
    call: { adapterIdx: BigInt(cs.adapters.balancerv2), data },
  };
}

function decimalStringToBigInt(s: string, decimals: number): bigint {
  if (!s) return 0n;
  const trimmed = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return 0n;
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const dot = abs.indexOf('.');
  const intPart = dot === -1 ? abs : abs.slice(0, dot);
  let fracPart = dot === -1 ? '' : abs.slice(dot + 1);
  if (fracPart.length > decimals) fracPart = fracPart.slice(0, decimals);
  const padded = fracPart.padEnd(decimals, '0');
  try {
    const v = BigInt((intPart + padded) || '0');
    return negative ? -v : v;
  } catch {
    return 0n;
  }
}

// ─── Orchestrator entrypoint. ──────────────────────────────────────────

export async function orchestrateServerQuotes(
  env: Env,
  client: PublicClient,
  req: ServerQuoteRequest,
): Promise<ServerOrchestrationResult> {
  const settled = await Promise.allSettled([
    fetchZeroEx(env, req),
    fetchOneInch(env, req),
    fetchUniV3(client, req),
    fetchBalancerV2(req),
  ]);
  const kinds: ('zeroex' | 'oneinch' | 'univ3' | 'balancerv2')[] = [
    'zeroex',
    'oneinch',
    'univ3',
    'balancerv2',
  ];
  const ranked: ServerRankedQuote[] = [];
  const failed: ('zeroex' | 'oneinch' | 'univ3' | 'balancerv2')[] = [];
  for (let i = 0; i < settled.length; ++i) {
    const r = settled[i];
    if (r.status === 'fulfilled' && r.value) ranked.push(r.value);
    else failed.push(kinds[i]);
  }
  ranked.sort((a, b) => (b.expectedOutput > a.expectedOutput ? 1 : -1));
  return { ranked, calls: ranked.map((q) => q.call), failed };
}
