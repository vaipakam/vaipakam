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
  packAggregatorData,
  packUniV3Data,
  parseOneInchQuote,
  parseZeroExQuote,
  quoteTestnetMock,
  quoteUniV3,
  rankRoutes,
  readSwapAdapterEntries,
  resolveAdapterRoster,
  TESTNET_MOCK_DATA,
  UNIV3_VENUES,
  type AdapterCall,
  type AdapterRoster,
  type RouteCandidate,
  type SwapVenueKind,
} from '@vaipakam/lib/swapRoutes';

/** What is being sold: the loan's whole collateral, for its principal
 *  asset — the amounts `triggerDefault` passes to the failover. */
export interface CloseOutSale {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
}

export type CloseOutRoute =
  | { kind: 'route'; calls: AdapterCall[]; venues: SwapVenueKind[] }
  /** Every venue this app could ask declined to quote. Nothing to send. */
  | { kind: 'no-quote' };

/** The agent's origin for quotes, or `null` when the deployment has none. */
export function agentQuoteOrigin(): string | null {
  const url = import.meta.env.VITE_AGENT_ORIGIN as string | undefined;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

/**
 * The venues this app could ask for a price on this chain, given the
 * Diamond's roster. Empty means the card has no route to offer — said as
 * such, never as a button.
 */
export function quotableVenues(
  roster: AdapterRoster,
  chainId: number,
  agentConfigured: boolean,
): SwapVenueKind[] {
  const out: SwapVenueKind[] = [];
  if (agentConfigured && roster.zeroex !== undefined) out.push('zeroex');
  if (agentConfigured && roster.oneinch !== undefined) out.push('oneinch');
  if (roster.univ3 !== undefined && UNIV3_VENUES[chainId] !== undefined) out.push('univ3');
  if (roster.testnetMock !== undefined) out.push('testnetMock');
  return out;
}

/** Read the roster for one chain's Diamond. */
export async function readCloseOutRoster(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  testnetMockAdapter: Address | undefined,
): Promise<AdapterRoster> {
  const entries = await readSwapAdapterEntries(client, diamond);
  return resolveAdapterRoster(entries, { testnetMockAdapter });
}

const QUOTE_TIMEOUT_MS = 8_000;

async function agentQuote(
  fetchImpl: typeof fetch,
  origin: string,
  venue: 'zeroex' | 'oneinch',
  body: Record<string, unknown>,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin}/quote/${venue === 'zeroex' ? '0x' : '1inch'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask every venue this app can reach for a price on this sale, and rank
 * what comes back into the try-list.
 *
 * Built fresh each time it is called: aggregator calldata is quoted for a
 * moment and does not keep. Each aggregator is quoted with ITS ADAPTER as
 * the taker: the adapter pulls the collateral from the Diamond and calls
 * the swap target itself, so calldata quoted for the Diamond would be for
 * a caller that never makes the call.
 */
export async function buildCloseOutRoute(deps: {
  client: Pick<PublicClient, 'readContract' | 'call'>;
  chainId: number;
  diamond: Address;
  roster: AdapterRoster;
  sale: CloseOutSale;
  agentOrigin: string | null;
  fetchImpl?: typeof fetch;
}): Promise<CloseOutRoute> {
  const { client, chainId, diamond, roster, sale, agentOrigin } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const venues = quotableVenues(roster, chainId, agentOrigin !== null);

  const attempts = venues.map(async (kind): Promise<RouteCandidate | null> => {
    const slot = roster[kind];
    if (slot === undefined) return null;
    const adapterIdx = BigInt(slot.idx);
    switch (kind) {
      case 'zeroex':
      case 'oneinch': {
        const body = await agentQuote(fetchImpl, agentOrigin!, kind, {
          chainId,
          sellToken: sale.sellToken,
          buyToken: sale.buyToken,
          sellAmount: sale.sellAmount.toString(),
          taker: slot.address,
        });
        const q = kind === 'zeroex' ? parseZeroExQuote(body) : parseOneInchQuote(body);
        if (!q) return null;
        return {
          kind,
          expectedOutput: q.expectedOutput,
          call: { adapterIdx, data: packAggregatorData(q.swapTarget, q.swapCalldata) },
        };
      }
      case 'univ3': {
        const q = await quoteUniV3(client, chainId, sale);
        if (!q) return null;
        return {
          kind,
          expectedOutput: q.expectedOutput,
          call: { adapterIdx, data: packUniV3Data(q.fee) },
        };
      }
      case 'testnetMock': {
        const out = await quoteTestnetMock(client, slot.address, diamond, sale);
        if (out === null) return null;
        return { kind, expectedOutput: out, call: { adapterIdx, data: TESTNET_MOCK_DATA } };
      }
      default:
        return null;
    }
  });

  const candidates = (await Promise.all(attempts.map((p) => p.catch(() => null)))).filter(
    (c): c is RouteCandidate => c !== null,
  );
  if (candidates.length === 0) return { kind: 'no-quote' };
  const ranked = rankRoutes(candidates);
  return { kind: 'route', calls: ranked.map((c) => c.call), venues: ranked.map((c) => c.kind) };
}
