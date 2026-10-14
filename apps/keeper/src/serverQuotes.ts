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
  readCloseOutRoster,
  type ClassifiedSlot,
  type AggregatorAnswer,
  type AggregatorKind,
  type AggregatorQuoteRequest,
  type AggregatorSource,
  type CloseOutRoster,
  type CloseOutRoute,
} from '@vaipakam/lib/routeBuilder';
import type { AdapterCall, SwapVenueKind } from '@vaipakam/lib/swapRoutes';
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
}

const QUOTE_TIMEOUT_MS = 8_000;
/** How long one chain's roster read is reused. A roster changes only by
 *  governance action, and a stale read can only send an attempt the
 *  contract refuses or skips; what it saves is three reads per adapter on
 *  every quote of every pass. */
const ROSTER_TTL_MS = 60_000;

interface RosterStanding {
  read: CloseOutRoster;
  slots: ClassifiedSlot[];
}

/** Roster AND each slot's askability, per chain + Diamond + whether an
 *  origin is known (the only caller-side fact askability reads). The
 *  UniV3 router check costs three reads per adapter, so it rides the same
 *  cache as the roster rather than running on every quote. */
const standingCache = new Map<string, { at: number; standing: Promise<RosterStanding> }>();

/** Test seam. */
export function _resetRosterCache(): void {
  standingCache.clear();
}

function standingFor(
  client: PublicClient,
  chainId: number,
  diamond: Address,
  aggregators: AggregatorSource,
  originKnown: boolean,
): Promise<RosterStanding> {
  const key = `${chainId}:${diamond.toLowerCase()}:${originKnown ? 'origin' : 'no-origin'}`;
  const hit = standingCache.get(key);
  if (hit && Date.now() - hit.at < ROSTER_TTL_MS) return hit.standing;
  const mock = getDeployment(chainId)?.testnetMocks?.mockSwapAdapter as Address | undefined;
  const standing = (async () => {
    const read = await readCloseOutRoster(client, diamond, mock);
    const slots = await classifySlots({ client, chainId, roster: read.roster, aggregators });
    return { read, slots };
  })();
  // A failed read is not cached: the next quote asks again.
  standing.catch(() => standingCache.delete(key));
  standingCache.set(key, { at: Date.now(), standing });
  return standing;
}

async function directAnswer(url: string, headers: Record<string, string>): Promise<AggregatorAnswer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
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
export function keeperAggregatorSource(env: Env, txOrigin: Address | undefined): AggregatorSource {
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
        return directAnswer(url.toString(), { '0x-api-key': env.ZEROEX_API_KEY, '0x-version': 'v2' });
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
      return directAnswer(url.toString(), { Authorization: `Bearer ${env.ONEINCH_API_KEY}` });
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
): Promise<ServerOrchestrationResult> {
  const aggregators = keeperAggregatorSource(env, req.txOrigin);
  let standing: RosterStanding;
  try {
    standing = await standingFor(client, req.chainId, req.diamond, aggregators, !!req.txOrigin);
  } catch (err) {
    return {
      ranked: [],
      calls: [],
      failed: [`roster-unread:${String(err).slice(0, 80)}`],
      route: null,
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
  if (route.kind === 'no-quote') return { ranked: [], calls: [], failed, route };
  const ranked: ServerRankedQuote[] = route.candidates.flatMap((c) =>
    c.expectedOutput === null ? [] : [{ kind: c.kind, expectedOutput: c.expectedOutput, call: c.call }],
  );
  return { ranked, calls: route.calls, failed, route };
}
