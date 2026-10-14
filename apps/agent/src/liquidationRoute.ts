/**
 * #2463 — POST /liquidation-route: the ranked swap try-list for closing out
 * one past-due loan, for the app's lender close-out card.
 *
 * Why the agent builds it rather than the browser. `DefaultedFacet
 * .triggerDefault` on a liquid, non-collapsed loan reverts
 * `NoEnabledSwapRoute` on an empty `adapterCalls` (#1005 S9), so the caller
 * must bring real routes. Two of the venues need the operator's API keys,
 * which never ship to a browser; and the builder that ranks and encodes them
 * is `@vaipakam/lib/swapRoutes`, the same one the keeper runs — one encoder,
 * not a browser copy of it.
 *
 * The sale is sized from the CHAIN, exactly as the contract sizes it: the
 * loan's full `collateralAmount` of `collateralAsset`, sold for
 * `principalAsset`, executed by the Diamond. The caller sends only the chain
 * and the loan id, so it cannot ask for a route the contract will not run.
 *
 * What this does NOT decide. Whether the close-out is due (grace, sequencer,
 * pause, an internal-match candidate) is the app's `decideForcedClose`, read
 * from the chain; this endpoint answers only "which routes could execute the
 * sale". The Diamond enforces the oracle-derived minimum output on every
 * entry and falls back as designed, so a stale route can cost only gas.
 *
 * Abuse bound. The handler is behind the agent's Origin gate and spends one
 * request from EACH aggregator proxy's rate-limit budget, because one call
 * here fans out to both aggregators on the operator's keys. No new
 * rate-limit namespace is declared (each must be registered with the
 * account; see wrangler.jsonc).
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { LoanFacetABI } from '@vaipakam/contracts/abis';
import { orchestrateSwapRoutes, type SwapRouteResult } from '@vaipakam/lib/swapRoutes';
import { getChainConfigs, type Env } from './env';

/** The contract's liquidation slippage ceiling, as the keeper quotes it. */
const ROUTE_SLIPPAGE_BPS = 600;
const LOAN_STATUS_ACTIVE = 0;
const ASSET_TYPE_ERC20 = 0;

export interface LiquidationRouteBody {
  chainId: number;
  loanId: string;
}

/** The response: the try-list in submit order, and what each entry is. */
export interface LiquidationRouteResponse {
  chainId: number;
  loanId: string;
  /** What the route sells — the loan's full collateral, read from chain. */
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  /** `LibSwap.AdapterCall[]`, best expected output first. Empty = no venue
   *  could quote this sale right now. */
  calls: { adapterIdx: string; data: `0x${string}` }[];
  ranked: { kind: string; expectedOutput: string }[];
  failed: string[];
}

export type RouteOutcome =
  | { kind: 'ok'; body: LiquidationRouteResponse }
  | { kind: 'error'; status: number; code: string };

const LOAN_ID = /^[1-9][0-9]{0,77}$/;

export function parseLiquidationRouteBody(raw: unknown): LiquidationRouteBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) return null;
  if (typeof o.loanId !== 'string' || !LOAN_ID.test(o.loanId)) return null;
  return { chainId: o.chainId, loanId: o.loanId };
}

/** The route for one loan, from a chain client and the Diamond address.
 *  Separated from the HTTP layer so it is tested without a Worker. */
export async function buildLiquidationRoute(
  deps: {
    client: PublicClient;
    diamond: Address;
    zeroExApiKey?: string;
    oneInchApiKey?: string;
    orchestrate?: typeof orchestrateSwapRoutes;
  },
  body: LiquidationRouteBody,
): Promise<RouteOutcome> {
  let loan: {
    status: number;
    assetType: number;
    collateralAssetType: number;
    principalAsset: Address;
    collateralAsset: Address;
    collateralAmount: bigint;
  };
  try {
    loan = (await deps.client.readContract({
      address: deps.diamond,
      abi: LoanFacetABI,
      functionName: 'getLoanDetails',
      args: [BigInt(body.loanId)],
    })) as typeof loan;
  } catch {
    return { kind: 'error', status: 502, code: 'loan-unreadable' };
  }
  // Only an Active ERC-20 loan with ERC-20 collateral reaches the swap
  // branch; anything else has no route to build (and the app does not ask).
  if (Number(loan.status) !== LOAN_STATUS_ACTIVE) return { kind: 'error', status: 409, code: 'loan-not-active' };
  if (Number(loan.assetType) !== ASSET_TYPE_ERC20 || Number(loan.collateralAssetType) !== ASSET_TYPE_ERC20) {
    return { kind: 'error', status: 409, code: 'not-an-erc20-swap' };
  }
  if (loan.collateralAmount === 0n) return { kind: 'error', status: 409, code: 'no-collateral' };

  const result: SwapRouteResult = await (deps.orchestrate ?? orchestrateSwapRoutes)(
    { zeroExApiKey: deps.zeroExApiKey, oneInchApiKey: deps.oneInchApiKey },
    deps.client,
    {
      chainId: body.chainId,
      sellToken: loan.collateralAsset,
      buyToken: loan.principalAsset,
      sellAmount: loan.collateralAmount,
      taker: deps.diamond,
      slippageBps: ROUTE_SLIPPAGE_BPS,
    },
  );
  return {
    kind: 'ok',
    body: {
      chainId: body.chainId,
      loanId: body.loanId,
      sellToken: loan.collateralAsset,
      buyToken: loan.principalAsset,
      sellAmount: loan.collateralAmount.toString(),
      calls: result.calls.map((c) => ({ adapterIdx: c.adapterIdx.toString(), data: c.data })),
      ranked: result.ranked.map((q) => ({ kind: q.kind, expectedOutput: q.expectedOutput.toString() })),
      failed: result.failed,
    },
  };
}

type RateLimitBinding = { limit(input: { key: string }): Promise<{ success: boolean }> } | undefined;

async function withinBudget(req: Request, binding: RateLimitBinding): Promise<boolean> {
  if (!binding) return true;
  try {
    const { success } = await binding.limit({ key: req.headers.get('cf-connecting-ip') ?? 'unknown' });
    return success;
  } catch {
    return true; // same policy as the quote proxies: a binding error does not fail closed
  }
}

/** HTTP entry. `corsOrigin` is resolved by the caller's Origin gate. */
export async function handleLiquidationRoute(req: Request, env: Env, corsOrigin: string): Promise<Response> {
  const reply = (data: unknown, status: number) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  // Both budgets: this one call reaches both aggregators on the operator's keys.
  if (!(await withinBudget(req, env.QUOTE_0X_RATELIMIT)) || !(await withinBudget(req, env.QUOTE_1INCH_RATELIMIT))) {
    return reply({ error: 'rate-limited' }, 429);
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return reply({ error: 'invalid-payload' }, 400);
  }
  const body = parseLiquidationRouteBody(raw);
  if (!body) return reply({ error: 'invalid-payload' }, 400);
  const chain = getChainConfigs(env).find((c) => c.id === body.chainId);
  if (!chain) return reply({ error: 'chain-not-configured' }, 404);

  const outcome = await buildLiquidationRoute(
    {
      client: createPublicClient({ transport: http(chain.rpc) }) as PublicClient,
      diamond: chain.diamond as Address,
      zeroExApiKey: env.ZEROEX_API_KEY,
      oneInchApiKey: env.ONEINCH_API_KEY,
    },
    body,
  );
  return outcome.kind === 'ok' ? reply(outcome.body, 200) : reply({ error: outcome.code }, outcome.status);
}
