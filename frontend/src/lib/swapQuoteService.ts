/**
 * Phase 7a — liquidation-path quote orchestration.
 *
 * Fetches a swap quote from every available venue in parallel, ranks
 * the successful responses by expected output (best first), and
 * returns a ready-to-submit `AdapterCall[]` try-list for the Diamond's
 * `triggerLiquidation(loanId, calls)` / `triggerDefault(loanId, calls)`
 * entry points.
 *
 * Sources:
 *   - 0x v2 Swap API — via Cloudflare Worker `/quote/0x`
 *     (API key injected server-side)
 *   - 1inch v6 Swap API — via Cloudflare Worker `/quote/1inch`
 *   - UniswapV3 QuoterV2 — direct on-chain view call (no API key)
 *   - Balancer V2 Vault queries — DEFERRED (stubbed returning null)
 *
 * Any individual fetcher is allowed to return `null` (venue down,
 * liquidity insufficient, chain unsupported). Orchestrator never
 * throws — worst case it returns an empty array and the caller
 * routes to `FallbackPending` on-chain.
 *
 * Security invariants preserved:
 *   - The diamond still enforces the oracle-derived `minOutputAmount`
 *     on every adapter. A stale / malicious quote cannot reduce the
 *     proceeds floor; it can only fail the adapter's own min-out
 *     check and skip to the next entry in the ranked list.
 *   - Worker proxies do NOT touch the submitted calldata after fetch
 *     — they pass the aggregator response through verbatim, so any
 *     server-side tampering would reveal itself on-chain as a failed
 *     slippage check rather than an accepted bad swap.
 */

import { type Address, type Hex, encodeAbiParameters, encodeFunctionData } from 'viem';
import type { PublicClient } from 'viem';
import { adapterIdxFor, getSwapRegistry } from '../contracts/swapRegistry';

export interface QuoteRequest {
  chainId: number;
  /** ERC-20 collateral asset the diamond will sell. */
  sellToken: Address;
  /** ERC-20 principal asset the diamond expects to receive. */
  buyToken: Address;
  /** Exact amount of `sellToken` to sell (base units, wei-style bigint). */
  sellAmount: bigint;
  /** Transaction `from` — the diamond address that will execute. */
  taker: Address;
  /** Slippage in basis points (default 600 = 6%, matching the on-chain
   *  LibFallback ceiling). Venues enforce this on their side. */
  slippageBps?: number;
}

export interface AdapterCall {
  /** Storage index into the diamond's `s.swapAdapters` array. */
  adapterIdx: bigint;
  /** ABI-encoded routing payload the adapter decodes:
   *    - 0x / 1inch: raw `transaction.data` from the aggregator
   *    - UniV3:      abi.encode(uint24 fee)
   *    - Balancer:   abi.encode(bytes32 poolId)
   */
  data: Hex;
}

export interface RankedQuote {
  adapterKind: 'zeroex' | 'oneinch' | 'univ3' | 'balancerv2';
  /** Expected proceeds amount, in `buyToken` base units — used for
   *  ranking. */
  expectedOutput: bigint;
  /** The AdapterCall ready to drop into the ordered try-list. */
  call: AdapterCall;
}

export interface QuoteOrchestratorArgs extends QuoteRequest {
  /** Base URL of the hf-watcher worker (without trailing slash). Used
   *  for `/quote/0x` and `/quote/1inch`. Null disables aggregator
   *  fetches — only on-chain venues contribute to the try-list. */
  workerOrigin: string | null;
  /** viem public client for the `sellToken`'s chain. Required for
   *  UniV3 on-chain quoter reads. */
  publicClient: PublicClient;
}

// ─── Aggregator quote shapes — minimal subset we actually read. ────────

interface ZeroExQuoteResponse {
  transaction?: { to?: string; data?: string; value?: string };
  buyAmount?: string;
  sellAmount?: string;
  // Other fields (sources, grossBuyAmount, etc.) not consumed here.
}

interface OneInchQuoteResponse {
  tx?: { to?: string; data?: string; value?: string };
  dstAmount?: string; // v6 renamed from toAmount
  toAmount?: string;  // fallback for older responses
}

// ─── Per-venue fetchers. Each returns RankedQuote | null. ──────────────

export async function fetchZeroExQuote(
  workerOrigin: string,
  req: QuoteRequest,
): Promise<RankedQuote | null> {
  const idx = adapterIdxFor(req.chainId, 'zeroex');
  if (idx == null) return null;
  try {
    const res = await fetch(`${workerOrigin}/quote/0x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chainId: req.chainId,
        sellToken: req.sellToken,
        buyToken: req.buyToken,
        sellAmount: req.sellAmount.toString(),
        taker: req.taker,
        slippageBps: req.slippageBps ?? 600,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ZeroExQuoteResponse;
    const data = body.transaction?.data;
    const buyAmount = body.buyAmount;
    if (!data || !data.startsWith('0x') || !buyAmount) return null;
    return {
      adapterKind: 'zeroex',
      expectedOutput: BigInt(buyAmount),
      call: { adapterIdx: BigInt(idx), data: data as Hex },
    };
  } catch {
    return null;
  }
}

export async function fetch1inchQuote(
  workerOrigin: string,
  req: QuoteRequest,
): Promise<RankedQuote | null> {
  const idx = adapterIdxFor(req.chainId, 'oneinch');
  if (idx == null) return null;
  try {
    const res = await fetch(`${workerOrigin}/quote/1inch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chainId: req.chainId,
        sellToken: req.sellToken,
        buyToken: req.buyToken,
        sellAmount: req.sellAmount.toString(),
        taker: req.taker,
        slippageBps: req.slippageBps ?? 600,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OneInchQuoteResponse;
    const data = body.tx?.data;
    const amount = body.dstAmount ?? body.toAmount;
    if (!data || !data.startsWith('0x') || !amount) return null;
    return {
      adapterKind: 'oneinch',
      expectedOutput: BigInt(amount),
      call: { adapterIdx: BigInt(idx), data: data as Hex },
    };
  } catch {
    return null;
  }
}

// QuoterV2.quoteExactInputSingle — minimal ABI we need.
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
    stateMutability: 'nonpayable', // QuoterV2 is stateless but not view
    type: 'function',
  },
] as const;

export async function fetchUniV3Quote(
  client: PublicClient,
  req: QuoteRequest,
): Promise<RankedQuote | null> {
  const reg = getSwapRegistry(req.chainId);
  if (!reg?.uniV3Quoter) return null;
  const idx = adapterIdxFor(req.chainId, 'univ3');
  if (idx == null) return null;

  // Try every configured fee tier; pick the best output. QuoterV2 is
  // marked `nonpayable` (it reverts-to-return internally) but is a
  // pure simulation — `simulateContract` / `call` return the output.
  let best: { fee: number; amountOut: bigint } | null = null;
  for (const fee of reg.uniV3FeeTiers) {
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
      const result = await client.call({
        to: reg.uniV3Quoter as Address,
        data,
      });
      if (!result.data) continue;
      const amountOut = BigInt(
        '0x' + result.data.slice(2, 66), // first 32-byte return slot
      );
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { fee, amountOut };
      }
    } catch {
      // Pool for this fee tier doesn't exist — skip.
      continue;
    }
  }
  if (!best) return null;

  return {
    adapterKind: 'univ3',
    expectedOutput: best.amountOut,
    call: {
      adapterIdx: BigInt(idx),
      data: encodeAbiParameters([{ type: 'uint24' }], [best.fee]) as Hex,
    },
  };
}

/**
 * Phase 7a.3-deferred. Balancer V2 quotes require a subgraph lookup
 * (find the pool holding the pair) followed by a BalancerQueries
 * `queryBatchSwap` on-chain simulation. Returns null until that
 * integration lands.
 */
export async function fetchBalancerV2Quote(
  _client: PublicClient,
  _req: QuoteRequest,
): Promise<RankedQuote | null> {
  return null;
}

// ─── Orchestrator. Fetches all 4 venues, ranks, returns try-list. ──────

export interface OrchestratedQuotes {
  /** Every successful quote, descending by expected output. */
  ranked: RankedQuote[];
  /** The `AdapterCall[]` to submit on-chain — same as `ranked`, but
   *  stripped to the `call` field so it's directly wagmi-safe. */
  calls: AdapterCall[];
  /** Venues that didn't respond / errored, for UI disclosure. */
  failedKinds: ('zeroex' | 'oneinch' | 'univ3' | 'balancerv2')[];
}

export async function orchestrateQuotes(
  args: QuoteOrchestratorArgs,
): Promise<OrchestratedQuotes> {
  const { workerOrigin, publicClient, ...req } = args;

  const wantZeroEx = !!workerOrigin;
  const want1inch = !!workerOrigin;

  const results = await Promise.allSettled([
    wantZeroEx ? fetchZeroExQuote(workerOrigin!, req) : Promise.resolve(null),
    want1inch ? fetch1inchQuote(workerOrigin!, req) : Promise.resolve(null),
    fetchUniV3Quote(publicClient, req),
    fetchBalancerV2Quote(publicClient, req),
  ]);
  const kinds: ('zeroex' | 'oneinch' | 'univ3' | 'balancerv2')[] = [
    'zeroex',
    'oneinch',
    'univ3',
    'balancerv2',
  ];
  const ranked: RankedQuote[] = [];
  const failedKinds: ('zeroex' | 'oneinch' | 'univ3' | 'balancerv2')[] = [];
  for (let i = 0; i < results.length; ++i) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) {
      ranked.push(r.value);
    } else {
      failedKinds.push(kinds[i]);
    }
  }
  ranked.sort((a, b) => (b.expectedOutput > a.expectedOutput ? 1 : -1));
  const calls = ranked.map((q) => q.call);
  return { ranked, calls, failedKinds };
}
