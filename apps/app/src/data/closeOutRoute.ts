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
import { encodeFunctionData, toEventSelector, type Address, type Hex, type PublicClient } from 'viem';
import {
  packAggregatorData,
  packUniV3Data,
  parseOneInchQuote,
  parseZeroExQuote,
  quoteTestnetMock,
  quoteUniV3Tiers,
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
  /** Every venue this app could ask declined to quote. Nothing to send.
   *  `unconfigured` names the aggregators the agent answered for with
   *  "no API key here": a standing posture of this deployment, not a
   *  passing lack of prices, so the card says which it was. */
  | { kind: 'no-quote'; asked: SwapVenueKind[]; unconfigured: SwapVenueKind[] };

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

/** One read of a Diamond's adapter list. */
export interface CloseOutRoster {
  roster: AdapterRoster;
  /** True when some adapter's name or disabled flag could not be read.
   *  Such an entry is left out of `roster` — an unread venue is not one to
   *  send — but it also means an empty result is not proof that no usable
   *  venue exists, only that none could be identified. */
  incomplete: boolean;
}

/** Read the roster for one chain's Diamond. */
export async function readCloseOutRoster(
  client: Pick<PublicClient, 'readContract'>,
  diamond: Address,
  testnetMockAdapter: Address | undefined,
): Promise<CloseOutRoster> {
  const entries = await readSwapAdapterEntries(client, diamond);
  return {
    roster: resolveAdapterRoster(entries, { testnetMockAdapter }),
    incomplete: entries.some((e) => e.name === undefined || e.disabled === undefined),
  };
}

const QUOTE_TIMEOUT_MS = 8_000;

const SWAP_TARGET_ALLOWED_ABI = [
  {
    type: 'function',
    name: 'swapTargetAllowed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** The agent's answer: the aggregator's body, "this deployment has no key
 *  for that aggregator", or nothing usable. */
type AgentAnswer = { body: unknown } | 'unconfigured' | null;

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
    if (res.ok) return { body: await res.json() };
    // `quoteProxy.ts` answers 503 `<venue>-not-configured` when its key is
    // absent. Anything else non-OK is a passing failure.
    if (res.status === 503) {
      const err = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      if (typeof err === 'string' && err.endsWith('-not-configured')) return 'unconfigured';
    }
    return null;
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
  const unconfigured: SwapVenueKind[] = [];

  const attempts = venues.map(async (kind): Promise<RouteCandidate | RouteCandidate[] | null> => {
    const slot = roster[kind];
    if (slot === undefined) return null;
    const adapterIdx = BigInt(slot.idx);
    switch (kind) {
      case 'zeroex':
      case 'oneinch': {
        const answer = await agentQuote(fetchImpl, agentOrigin!, kind, {
          chainId,
          sellToken: sale.sellToken,
          buyToken: sale.buyToken,
          sellAmount: sale.sellAmount.toString(),
          taker: slot.address,
        });
        if (answer === 'unconfigured') {
          unconfigured.push(kind);
          return null;
        }
        if (answer === null) return null;
        const q =
          kind === 'zeroex' ? parseZeroExQuote(answer.body) : parseOneInchQuote(answer.body);
        if (!q) return null;
        // The adapter calls only swap targets governance has allowed on it
        // (`AggregatorAdapterBase.swapTargetAllowed`). A quote naming any
        // other target — a router the aggregator has rotated to — is an
        // attempt the adapter is certain to refuse.
        const allowed = await client.readContract({
          address: slot.address,
          abi: SWAP_TARGET_ALLOWED_ABI,
          functionName: 'swapTargetAllowed',
          args: [q.swapTarget],
        });
        if (!allowed) return null;
        return {
          kind,
          expectedOutput: q.expectedOutput,
          call: { adapterIdx, data: packAggregatorData(q.swapTarget, q.swapCalldata) },
        };
      }
      case 'univ3':
        // One candidate per quoting pool: the same adapter index may appear
        // more than once, and a second tier is a real back-up if the best
        // pool moves below the minimum before the transaction runs.
        return (await quoteUniV3Tiers(client, chainId, sale)).map((q) => ({
          kind,
          expectedOutput: q.expectedOutput,
          call: { adapterIdx, data: packUniV3Data(q.fee) },
        }));
      case 'testnetMock': {
        const out = await quoteTestnetMock(client, slot.address, diamond, sale);
        if (out === null) return null;
        return { kind, expectedOutput: out, call: { adapterIdx, data: TESTNET_MOCK_DATA } };
      }
      default:
        return null;
    }
  });

  const candidates = (await Promise.all(attempts.map((p) => p.catch(() => null))))
    .flat()
    .filter((c): c is RouteCandidate => c !== null);
  if (candidates.length === 0) return { kind: 'no-quote', asked: venues, unconfigured };
  const ranked = rankRoutes(candidates);
  return { kind: 'route', calls: ranked.map((c) => c.call), venues: ranked.map((c) => c.kind) };
}

/**
 * What this close-out would do if it were sent now, read from the chain
 * rather than from the quotes.
 *
 *  - `'sale'` — the simulated close-out ran and no adapter-failure event
 *    came out of it: some route met the protocol's minimum.
 *  - `'fallback'` — it ran and emitted `LibSwap.SwapAllAdaptersFailed` for
 *    this loan. Every route was refused, and the close-out would succeed
 *    into the full-collateral fallback instead of a sale.
 *  - `'unknown'` — the node could not run the preview (`eth_simulateV1`
 *    unsupported, or the call reverted, which the ordinary simulation
 *    that follows reports in its own words).
 *
 * This is the check that makes every way a route can fail the same case.
 * A quote can be for the wrong caller, name a router the adapter does not
 * allow, point at an index governance has just moved, or simply come in
 * under the minimum; a plain `eth_call` passes all of them, because
 * `triggerDefault` catches each attempt and SUCCEEDS into the fallback.
 * Only the logs tell the two endings apart, and `eth_simulateV1` is the
 * read that returns logs.
 */
export type CloseOutPreview = 'sale' | 'fallback' | 'unknown';

const TRIGGER_DEFAULT_ABI = [
  {
    type: 'function',
    name: 'triggerDefault',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'loanId', type: 'uint256' },
      {
        name: 'adapterCalls',
        type: 'tuple[]',
        components: [
          { name: 'adapterIdx', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** `LibSwap.SwapAllAdaptersFailed(uint256 indexed loanId)`. */
export const SWAP_ALL_ADAPTERS_FAILED_TOPIC = toEventSelector(
  'SwapAllAdaptersFailed(uint256)',
);

export async function previewCloseOut(deps: {
  client: Pick<PublicClient, 'simulateCalls'>;
  diamond: Address;
  account: Address;
  loanId: bigint;
  calls: readonly AdapterCall[];
}): Promise<CloseOutPreview> {
  const { client, diamond, account, loanId, calls } = deps;
  let results;
  try {
    ({ results } = await client.simulateCalls({
      account,
      calls: [
        {
          to: diamond,
          data: encodeFunctionData({
            abi: TRIGGER_DEFAULT_ABI,
            functionName: 'triggerDefault',
            args: [loanId, calls],
          }),
        },
      ],
    }));
  } catch {
    return 'unknown';
  }
  const result = results[0];
  if (!result || result.status !== 'success') return 'unknown';
  const loanTopic = `0x${loanId.toString(16).padStart(64, '0')}` as Hex;
  const failed = (result.logs ?? []).some(
    (log) =>
      log.address.toLowerCase() === diamond.toLowerCase() &&
      log.topics[0] === SWAP_ALL_ADAPTERS_FAILED_TOPIC &&
      log.topics[1]?.toLowerCase() === loanTopic,
  );
  return failed ? 'fallback' : 'sale';
}
