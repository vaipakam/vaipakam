/**
 * The swap route a lender's close-out sends with `triggerDefault` when the
 * collateral has to be sold (#2463).
 *
 * `ready-needs-route` is a loan the chain will close only with a non-empty
 * try-list of swap routes (`LibSwap.swapWithFailover` reverts
 * `NoEnabledSwapRoute` on an empty or all-disabled one, #1005 S9). Until
 * this module existed the app could not build one, so the overdue card
 * told the lender an operator was needed — on the commonest shape of
 * overdue loan there is.
 *
 * How the route is built, and what it relies on:
 *
 *  - **Which adapters exist, and at which index, is READ from the Diamond**
 *    at the moment of building (`@vaipakam/lib/swapRoutes`). Nothing here
 *    keeps an index table.
 *  - **Aggregator quotes go through the agent's `/quote/0x` and
 *    `/quote/1inch` proxy**, which holds the API keys server-side. No key
 *    reaches the browser. Without `VITE_AGENT_ORIGIN` those two venues are
 *    simply not asked.
 *  - **Uniswap V3 is quoted on-chain**, through the chain's QuoterV2.
 *  - **The testnet mock adapter** is used only where the chain's own
 *    deployment record declares it, and only after reading that it would
 *    pay: not switched to revert, callable by the Diamond, and holding
 *    enough of the principal asset to cover what it would owe.
 *  - **Balancer V2 is not asked.** Its only source is a subgraph whose
 *    hosting is in doubt (#2468); a venue we cannot verify is left out
 *    rather than sent on a guess.
 *
 * What it does NOT do is protect the sale price — and does not need to.
 * The contract computes its own oracle-derived minimum and every adapter
 * enforces it; a stale or bad quote can only fail its attempt. What a
 * route cannot control is what happens if EVERY attempt fails: the
 * close-out then succeeds into the protocol's full-collateral fallback.
 * The card says so; this module only builds the list.
 */
import type { Address, PublicClient } from 'viem';
import {
  aggregatorAnswerForStatus,
  buildCloseOutRoute as buildSharedRoute,
  classifySlots as classifySharedSlots,
  readCloseOutRoster,
  routePosture,
  type AggregatorAnswer,
  type AggregatorSource,
  type ClassifiedSlot,
  type CloseOutRoster,
  type CloseOutRoute,
  type CloseOutSale,
  type RoutePosture,
} from '@vaipakam/lib/routeBuilder';
import type { AdapterRoster } from '@vaipakam/lib/swapRoutes';

// The builder itself is shared with the keeper (#2468) and lives in
// `@vaipakam/lib/routeBuilder`. This module is the app's side of it: how
// the app reaches the aggregators (through the agent's key-holding proxy,
// never 0x — see `SlotAskability` there), and the card's standing read.
export {
  noQuoteReason,
  previewCloseOut,
  readCloseOutRoster,
  routeMissingAnswers,
  routePosture,
  SWAP_ADAPTER_SUCCEEDED_TOPIC,
  SWAP_ALL_ADAPTERS_FAILED_TOPIC,
  type ClassifiedSlot,
  type CloseOutPreview,
  type CloseOutRoster,
  type CloseOutRoute,
  type CloseOutSale,
  type NoQuoteReason,
  type RoutePosture,
  type SlotAskability,
  type SlotOutcome,
} from '@vaipakam/lib/routeBuilder';

/** The agent's origin for quotes, or `null` when the deployment has none. */
export function agentQuoteOrigin(): string | null {
  const url = import.meta.env.VITE_AGENT_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

/**
 * What the agent's quote proxy says it can ask (#2463 round 15). A proxy
 * URL alone does not mean an aggregator can be asked: the Worker can lack
 * the key, or refuse this app's origin. `'absent'` — the deployment has no
 * proxy; `'unread'` — the readiness answer could not be read (which is
 * also how an origin outside the proxy's allow-list shows up: the browser
 * refuses the response); otherwise, per aggregator, whether its key is held.
 */
export type QuoteProxyReadiness = 'absent' | 'unread' | { oneinch: boolean };

export async function readQuoteProxyReadiness(
  agentOrigin: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteProxyReadiness> {
  if (agentOrigin === null) return 'absent';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${agentOrigin}/quote/readiness`, { signal: ctrl.signal });
    if (!res.ok) return 'unread';
    const body = (await res.json().catch(() => null)) as { oneinch?: unknown } | null;
    return typeof body?.oneinch === 'boolean' ? { oneinch: body.oneinch } : 'unread';
  } catch {
    return 'unread';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The app's {@link AggregatorSource}: 1inch through the agent's proxy when
 * it holds a key, 0x never (`origin-bound` — this app cannot name the
 * transaction's originating account for every wallet it supports).
 */
export function agentAggregatorSource(
  quoteProxy: QuoteProxyReadiness,
  agentOrigin: string | null,
  fetchImpl: typeof fetch = fetch,
): AggregatorSource {
  return {
    askability(kind) {
      if (kind === 'zeroex') return 'origin-bound';
      if (quoteProxy === 'absent') return 'no-proxy';
      if (quoteProxy === 'unread') return 'unread';
      return quoteProxy.oneinch ? 'askable' : 'unconfigured';
    },
    quote(kind, req) {
      if (agentOrigin === null) return Promise.resolve('unconfigured');
      return agentQuote(fetchImpl, agentOrigin, kind, {
        chainId: req.chainId,
        sellToken: req.sellToken,
        buyToken: req.buyToken,
        sellAmount: req.sellAmount.toString(),
        taker: req.taker,
        slippageBps: req.slippageBps,
      });
    },
  };
}

/** Every slot's askability, for this app. */
export function classifySlots(deps: {
  client: Pick<PublicClient, 'readContract'>;
  chainId: number;
  roster: AdapterRoster;
  quoteProxy: QuoteProxyReadiness;
}): Promise<ClassifiedSlot[]> {
  return classifySharedSlots({
    client: deps.client,
    chainId: deps.chainId,
    roster: deps.roster,
    aggregators: agentAggregatorSource(deps.quoteProxy, null),
  });
}

/** Everything the posture is derived from, read together. */
export interface RouteStanding {
  read: CloseOutRoster;
  slots: ClassifiedSlot[];
  posture: RoutePosture;
}

/**
 * Read the roster and every slot's askability, and derive the posture from them. The card's poll and
 * the confirm both call this, so the card cannot offer what the confirm
 * would then refuse for a reason knowable in advance.
 */
export async function readRouteStanding(deps: {
  client: Pick<PublicClient, 'readContract'>;
  diamond: Address;
  chainId: number;
  testnetMockAdapter: Address | undefined;
  agentOrigin: string | null;
  fetchImpl?: typeof fetch;
}): Promise<RouteStanding> {
  const read = await readCloseOutRoster(deps.client, deps.diamond, deps.testnetMockAdapter);
  // The proxy is asked what it can quote only when an aggregator it would
  // quote is on the list; otherwise its answer decides nothing.
  const quoteProxy: QuoteProxyReadiness =
    (read.roster.oneinch?.length ?? 0) > 0
      ? await readQuoteProxyReadiness(deps.agentOrigin, deps.fetchImpl)
      : 'absent';
  const slots = await classifySlots({
    client: deps.client,
    chainId: deps.chainId,
    roster: read.roster,
    quoteProxy,
  });
  return { read, slots, posture: routePosture(read, slots) };
}

const QUOTE_TIMEOUT_MS = 8_000;

/** The agent's answer: the aggregator's body, "this deployment has no key
 *  for that aggregator", the aggregator answering with no route, or no
 *  answer the app can judge. */
type AgentAnswer = AggregatorAnswer;

async function agentQuote(
  fetchImpl: typeof fetch,
  origin: string,
  venue: 'zeroex' | 'oneinch',
  body: Record<string, unknown>,
): Promise<AgentAnswer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin}/quote/${venue === 'zeroex' ? '0x' : '1inch'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (res.ok) {
      const parsed = await res.json().catch(() => undefined);
      // The proxy re-serialises an upstream body it could not parse as
      // `{ error, status }` and keeps the upstream's 200, so an envelope with
      // an `error` field is a response nobody could read, not a decline.
      const envelope =
        parsed !== null && typeof parsed === 'object' && 'error' in (parsed as object);
      return parsed === undefined || envelope ? 'unanswered' : { body: parsed };
    }
    // `quoteProxy.ts` answers 503 `<venue>-not-configured` when its key is
    // absent.
    if (res.status === 503) {
      const err = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      if (typeof err === 'string' && err.endsWith('-not-configured')) return 'unconfigured';
    }
    return aggregatorAnswerForStatus(res.status);
  } catch {
    return 'unanswered';
  } finally {
    clearTimeout(timer);
  }
}

/** Ask every slot this app can reach for a price on this sale, and rank
 *  the try-list — the shared builder, with the agent's proxy as the source. */
export function buildCloseOutRoute(deps: {
  client: Pick<PublicClient, 'readContract' | 'call'>;
  chainId: number;
  diamond: Address;
  slots: readonly ClassifiedSlot[];
  sale: CloseOutSale;
  agentOrigin: string | null;
  fetchImpl?: typeof fetch;
}): Promise<CloseOutRoute> {
  return buildSharedRoute({
    client: deps.client,
    chainId: deps.chainId,
    diamond: deps.diamond,
    slots: deps.slots,
    sale: deps.sale,
    // Askability was already decided in `slots`; only `quote` is used here.
    aggregators: agentAggregatorSource('absent', deps.agentOrigin, deps.fetchImpl ?? fetch),
  });
}
