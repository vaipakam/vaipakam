/**
 * Server-side swap-route building for the keeper's forced closes.
 *
 * The Diamond's `triggerLiquidation` / `triggerPartialLiquidation` /
 * `triggerLiquidationSplit` / `triggerDefault` each take a caller-ranked
 * `AdapterCall[]` naming registered swap adapters BY INDEX. This module
 * builds that list with the SAME builder the connected app's close-out
 * uses (`@vaipakam/lib/routeBuilder`, #2468), so the keeper no longer
 * carries its own copy of the rules:
 *
 *  - **Indexes are read from the Diamond** (`getSwapAdapters()` + each
 *    adapter's `adapterName()`), never from a hand-kept table. The table
 *    this replaced was correct only until governance added, removed or
 *    reordered an adapter, and had no entry at all for Base Sepolia.
 *  - **Each aggregator is quoted with ITS ADAPTER as the taker.** The
 *    adapter holds the input and calls the swap target; the table-era code
 *    quoted for the Diamond, which is calldata for a caller that never
 *    makes the call.
 *  - **The testnet mock adapter** is used only at the address the chain's
 *    deployment record declares, and only after reading that it would pay.
 *  - **Balancer V2 is not asked.** Its only source was The Graph's hosted
 *    subgraph, whose hosting is in doubt (#2468); a venue that cannot be
 *    verified is left out rather than sent on a guess. A Balancer adapter
 *    on the roster is reported as `unpriceable`.
 *
 * What differs from the app is only how aggregators are reached: the
 * keeper calls 0x and 1inch directly with its own keys (which never leave
 * the Worker), and — because it sends from its own EOA — it can name the
 * transaction's origin, so 0x is askable here where the app cannot ask it.
 *
 * SAFETY: route building does NOT weaken any on-chain guard. The Diamond
 * enforces the oracle-derived minimum output on every attempt; a stale or
 * hostile quote can only fail its attempt and the next entry tries.
 */

import type { Address, PublicClient } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  aggregatorAnswerForStatus,
  buildCloseOutRoute,
  classifySlots,
  noQuoteReason,
  readCloseOutRoster,
  type ClassifiedSlot,
  type AggregatorAnswer,
  type AggregatorKind,
  type AggregatorQuoteRequest,
  type AggregatorSource,
  type CloseOutRoster,
  type CloseOutRoute,
  type NoQuoteReason,
} from '@vaipakam/lib/routeBuilder';
import type { AdapterCall, SwapVenueKind } from '@vaipakam/lib/swapRoutes';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { MULTICALL3_ADDRESS } from './multicall3';
import type { Env } from './env';

export interface ServerQuoteRequest {
  chainId: number;
  /** The Diamond whose adapter list the route is built against — and the
   *  caller the testnet mock checks it would pay. */
  diamond: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  /** The account that will SEND the transaction — the keeper EOA. 0x can
   *  bind a quote to it, so without it 0x is not asked. */
  txOrigin?: Address;
  /** Aggregator slippage limit. Omitted, the protocol's own ceiling is
   *  read from the Diamond (the right limit for a close-out); the
   *  liquidity-confidence pass, which only measures a price, passes its
   *  own. */
  slippageBps?: number;
  /** The fetch aggregator quotes go through. Omitted, the global one; a
   *  pass that caps its requests passes its budget's. */
  fetchFn?: typeof fetch;
}

export type ServerAdapterCall = AdapterCall;

export interface ServerRankedQuote {
  kind: SwapVenueKind;
  expectedOutput: bigint;
  call: ServerAdapterCall;
}

export interface ServerOrchestrationResult {
  /** Candidates with a quoted output, best first. */
  ranked: ServerRankedQuote[];
  /** The full try-list, in rank order — what the Diamond takes. */
  calls: ServerAdapterCall[];
  /** Venues on the roster that produced nothing, with the reason. */
  failed: string[];
  /** The shared builder's own result, for a caller that reports it. */
  route: CloseOutRoute | null;
  /** Why nothing was quoted — the shared `noQuoteReason` rule, applied to
   *  the roster this build read — or null when there is a route. Only
   *  `declined` says every venue was asked and every one declined; any
   *  other reason means some venue was not heard from, so a caller must
   *  not treat the empty list as the market's answer (#2487 r1). */
  noQuote: NoQuoteReason | null;
}

const QUOTE_TIMEOUT_MS = 8_000;

/**
 * One read of the Diamond's adapter list and each slot's askability.
 *
 * NOT cached across builds (#2480 r1 `4267324307`). The positions it
 * carries are what the try-list's `adapterIdx` values are made of, and a
 * governance removal or reorder between the read and the submit would send
 * calldata to a different adapter, or an index the contract rejects. A
 * caller that builds several try-lists for ONE close (the liquidator's
 * full, half and partial quotes for one loan) reads it once and passes it
 * to each — the same moment, not a remembered one.
 */
export interface RosterStanding {
  read: CloseOutRoster;
  slots: ClassifiedSlot[];
}

export async function readKeeperRouteStanding(
  env: Env,
  client: PublicClient,
  chainId: number,
  diamond: Address,
  txOrigin: Address | undefined,
): Promise<RosterStanding> {
  const mock = getDeployment(chainId)?.testnetMocks?.mockSwapAdapter as Address | undefined;
  // One aggregate for every adapter's name and flag (#2488): the roster's
  // length must not set how many requests a route build costs.
  const read = await readCloseOutRoster(client, diamond, mock, {
    multicallAddress: MULTICALL3_ADDRESS,
  });
  const slots = await classifySlots({
    client,
    chainId,
    roster: read.roster,
    aggregators: keeperAggregatorSource(env, txOrigin),
  });
  return { read, slots };
}

async function directAnswer(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
): Promise<AggregatorAnswer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (!res.ok) return aggregatorAnswerForStatus(res.status);
    const body = await res.json().catch(() => undefined);
    return body === undefined ? 'unanswered' : { body };
  } catch {
    return 'unanswered';
  } finally {
    clearTimeout(timer);
  }
}

/** The keeper's {@link AggregatorSource}: 0x and 1inch called directly
 *  with the Worker's own keys. */
export function keeperAggregatorSource(
  env: Env,
  txOrigin: Address | undefined,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): AggregatorSource {
  return {
    askability(kind: AggregatorKind) {
      if (kind === 'zeroex') {
        if (!env.ZEROEX_API_KEY) return 'unconfigured';
        return txOrigin ? 'askable' : 'origin-bound';
      }
      return env.ONEINCH_API_KEY ? 'askable' : 'unconfigured';
    },
    quote(kind: AggregatorKind, req: AggregatorQuoteRequest) {
      if (kind === 'zeroex') {
        if (!env.ZEROEX_API_KEY || !txOrigin) return Promise.resolve('unconfigured');
        const url = new URL('https://api.0x.org/swap/allowance-holder/quote');
        url.searchParams.set('chainId', String(req.chainId));
        url.searchParams.set('sellToken', req.sellToken);
        url.searchParams.set('buyToken', req.buyToken);
        url.searchParams.set('sellAmount', req.sellAmount.toString());
        url.searchParams.set('taker', req.taker);
        url.searchParams.set('txOrigin', txOrigin);
        url.searchParams.set('slippageBps', String(req.slippageBps));
        return directAnswer(url.toString(), { '0x-api-key': env.ZEROEX_API_KEY, '0x-version': 'v2' }, fetchFn);
      }
      if (!env.ONEINCH_API_KEY) return Promise.resolve('unconfigured');
      const url = new URL(`https://api.1inch.dev/swap/v6.0/${req.chainId}/swap`);
      url.searchParams.set('src', req.sellToken);
      url.searchParams.set('dst', req.buyToken);
      url.searchParams.set('amount', req.sellAmount.toString());
      url.searchParams.set('from', req.taker);
      if (txOrigin) url.searchParams.set('origin', txOrigin);
      url.searchParams.set('slippage', String(req.slippageBps / 100));
      // The adapter does not hold the input until the Diamond moves it, so
      // 1inch's own balance/allowance simulation would refuse the quote.
      url.searchParams.set('disableEstimate', 'true');
      return directAnswer(url.toString(), { Authorization: `Bearer ${env.ONEINCH_API_KEY}` }, fetchFn);
    },
  };
}

/**
 * Build the ranked try-list for one sale on one chain's Diamond.
 *
 * Never throws: a roster that cannot be read is an empty result with the
 * reason in `failed`, the same as every venue declining.
 */
export async function orchestrateServerQuotes(
  env: Env,
  client: PublicClient,
  req: ServerQuoteRequest,
  /** A standing read for THIS close, shared by its several builds; read
   *  fresh when omitted. Must have been read with the same `txOrigin`. */
  given?: RosterStanding,
): Promise<ServerOrchestrationResult> {
  const aggregators = keeperAggregatorSource(env, req.txOrigin, req.fetchFn);
  let standing: RosterStanding;
  try {
    standing =
      given ?? (await readKeeperRouteStanding(env, client, req.chainId, req.diamond, req.txOrigin));
  } catch (err) {
    // Described, never stringified: a viem transport error carries the
    // request URL, and this Worker's RPC URLs carry API keys (#2480 r1).
    return {
      ranked: [],
      calls: [],
      failed: [`roster-unread:${describeFailure(err)}`],
      route: null,
      noQuote: 'unread',
    };
  }
  const { read, slots } = standing;
  const route = await buildCloseOutRoute({
    client,
    chainId: req.chainId,
    diamond: req.diamond,
    slots,
    sale: { sellToken: req.sellToken, buyToken: req.buyToken, sellAmount: req.sellAmount },
    aggregators,
    slippageBps: req.slippageBps,
  });
  const failed = route.outcomes
    .filter((o) => o.outcome !== 'quoted')
    .map((o) => `${o.kind}:${o.outcome}`);
  if (read.incomplete) failed.push('roster-incomplete');
  // No enabled adapter at all is a governance condition, not a quote
  // failure, and is said as such (#2480 r3 `4267485505`).
  else if (read.enabledCount === 0) failed.push('no-enabled-adapters');
  // An enabled adapter this module cannot name is a venue that exists and
  // was not asked — said, not dropped (#2480 r1 `4267324316`).
  if (read.unrecognized > 0) failed.push(`unrecognized-adapters:${read.unrecognized}`);
  if (route.kind === 'no-quote') {
    return { ranked: [], calls: [], failed, route, noQuote: noQuoteReason(route, read) };
  }
  const ranked: ServerRankedQuote[] = route.candidates.flatMap((c) =>
    c.expectedOutput === null ? [] : [{ kind: c.kind, expectedOutput: c.expectedOutput, call: c.call }],
  );
  return { ranked, calls: route.calls, failed, route, noQuote: null };
}
