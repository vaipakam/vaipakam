/**
 * Keeper adapter over the shared swap-route builder (#2463).
 *
 * The registry, the adapter-data encoders and the ranking moved to
 * `@vaipakam/lib/swapRoutes`, so the keeper and the agent's
 * `/liquidation-route` (the app's lender close-out) build try-lists the same
 * way. This module keeps the keeper's names and its `Env`-shaped signature so
 * its callers are unchanged; it only hands the Worker's aggregator keys to
 * the builder.
 */
import type { PublicClient } from 'viem';
import {
  orchestrateSwapRoutes,
  type RankedSwapRoute,
  type SwapAdapterCall,
  type SwapRouteRequest,
  type SwapRouteResult,
} from '@vaipakam/lib/swapRoutes';
import type { Env } from './env';

export type ServerQuoteRequest = SwapRouteRequest;
export type ServerAdapterCall = SwapAdapterCall;
export type ServerRankedQuote = RankedSwapRoute;
export type ServerOrchestrationResult = SwapRouteResult;

export function orchestrateServerQuotes(
  env: Env,
  client: PublicClient,
  req: ServerQuoteRequest,
): Promise<ServerOrchestrationResult> {
  return orchestrateSwapRoutes(
    { zeroExApiKey: env.ZEROEX_API_KEY, oneInchApiKey: env.ONEINCH_API_KEY },
    client,
    req,
  );
}
