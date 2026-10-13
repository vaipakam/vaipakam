/**
 * Phase 7a.4 — server-side liquidation quote orchestration.
 *
 * Fetches quotes from every available DEX venue (0x / 1inch / UniV3 /
 * Balancer V2 — Balancer stubbed pending subgraph integration), ranks
 * by expected output, returns a ready-to-submit `AdapterCall[]` for the
 * Diamond's `triggerLiquidation(loanId, calls)`.
 *
 * Lives inside the Cloudflare Worker so the operator's API keys never
 * leave the trusted infra (no need to proxy through the agent's
 * `/quote/*` routes like the connected app does). The rules both
 * builders share — wire formats, response parsing, UniV3 venues — are in
 * `@vaipakam/lib/swapRoutes`.
 *
 * SAFETY: server-side ranking does NOT weaken any on-chain guard. The
 * diamond enforces the oracle-derived `minOutputAmount` per-adapter;
 * a stale or hostile quote can only fail the adapter's slippage check
 * and the next-best entry tries.
 */

import type { Address, Hex, PublicClient } from 'viem';
import {
  packAggregatorData,
  packBalancerV2Data,
  packUniV3Data,
  parseOneInchQuote,
  parseZeroExQuote,
  quoteUniV3,
} from '@vaipakam/lib/swapRoutes';
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

// ─── Per-chain registry. ───────────────────────────────────────────────
//
// Wire formats, response parsing and the UniV3 quoter venues live in
// `@vaipakam/lib/swapRoutes`, shared with the connected app's forced
// close-out (#2463). The adapter INDEXES below are still hand-kept; #2468
// replaces them with the on-chain roster that module resolves.

type AdapterIdxMap = {
  zeroex: number | null;
  oneinch: number | null;
  univ3: number | null;
  balancerv2: number | null;
};

interface ChainSwap {
  balancerVault: Address;
  /** Balancer V2 subgraph URL — null disables the venue. Hosted-
   *  service URLs by default; production deployments override via
   *  env to point at a paid / decentralized-network endpoint. */
  balancerV2SubgraphUrl: string | null;
  adapters: AdapterIdxMap;
}

const BALANCER_V2_VAULT_CANONICAL =
  '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as const;

const CHAIN_SWAP: Record<number, ChainSwap> = {
  1: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  8453: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-base-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  42161: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-arbitrum-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  10: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-optimism-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: 2, balancerv2: 3 },
  },
  1101: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-polygon-zk-v2',
    adapters: { zeroex: 0, oneinch: 1, univ3: null, balancerv2: 3 },
  },
  56: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    // Balancer V2 not deployed on BNB Chain.
    balancerV2SubgraphUrl: null,
    adapters: { zeroex: 0, oneinch: 1, univ3: null, balancerv2: 3 },
  },
  // BNB testnet — 0x/1inch have NO testnet backend (0x's API covers BNB
  // mainnet 56, not 97), so the ONLY liquidation route is the on-chain
  // PancakeSwap V3 UniV3Adapter. `univ3: 0` is a STATIC index into the
  // Diamond's on-chain getSwapAdapters() list (same static-mirror pattern as
  // every other chain here) and MUST equal the index DeployUniV3Adapter.s.sol
  // logs at registration — the UniV3 adapter is the sole/first entry on this
  // no-aggregator chain, so index 0 (verified on-chain). If aggregator adapters
  // are ever registered before it, bump this to match. Quote via PancakeSwap's
  // V3 QuoterV2 (factory-matched to the oracle's UNISWAP_V3_FACTORY) over
  // Pancake's fee tiers. Balancer V2 not on BNB.
  97: {
    balancerVault: BALANCER_V2_VAULT_CANONICAL,
    balancerV2SubgraphUrl: null,
    adapters: { zeroex: null, oneinch: null, univ3: 0, balancerv2: null },
  },
};

// ─── Aggregator API helpers. ───────────────────────────────────────────

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
    const q = parseZeroExQuote(await res.json());
    if (!q) return null;
    return {
      kind: 'zeroex',
      expectedOutput: q.expectedOutput,
      call: {
        adapterIdx: BigInt(cs.adapters.zeroex),
        data: packAggregatorData(q.swapTarget, q.swapCalldata),
      },
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
    const q = parseOneInchQuote(await res.json());
    if (!q) return null;
    return {
      kind: 'oneinch',
      expectedOutput: q.expectedOutput,
      call: {
        adapterIdx: BigInt(cs.adapters.oneinch),
        data: packAggregatorData(q.swapTarget, q.swapCalldata),
      },
    };
  } catch {
    return null;
  }
}

async function fetchUniV3(
  client: PublicClient,
  req: ServerQuoteRequest,
): Promise<ServerRankedQuote | null> {
  const cs = CHAIN_SWAP[req.chainId];
  if (cs?.adapters.univ3 == null) return null;
  const best = await quoteUniV3(client, req.chainId, req);
  if (!best) return null;
  return {
    kind: 'univ3',
    expectedOutput: best.expectedOutput,
    call: {
      adapterIdx: BigInt(cs.adapters.univ3),
      data: packUniV3Data(best.fee),
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

  const data = packBalancerV2Data(poolId as Hex);
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
