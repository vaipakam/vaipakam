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
  univ3AdapterMatchesQuoter,
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

/**
 * What became of one adapter slot when the confirm asked it — one value
 * per slot, so the sentence the card shows is derived from what actually
 * happened to every venue rather than from flags each path remembered to
 * set (#2463 round 9; rounds 2–8 each found a path that folded "could not
 * tell" into "no price").
 *
 *  - `quoted` — produced at least one candidate.
 *  - `declined` — the venue ANSWERED and had nothing usable: no route, no
 *    pool at any tier, a target its adapter does not allow, a mock that
 *    would not pay.
 *  - `unanswered` — the app never got an answer it could judge: a timeout,
 *    transport failure, rate limit or 5xx, a malformed body, or a failed
 *    read of something the route depends on.
 *  - `no-proxy` — an aggregator this deployment has no quote proxy for, so
 *    it was not asked.
 *  - `unconfigured` — the quote proxy answered that it has no key for it.
 *  - `no-origin` — 0x, not asked because the account that will originate
 *    the transaction is unknown: the connected account is a contract
 *    wallet (a Safe), whose transaction an owner or relayer sends. 0x
 *    binds some of its liquidity to the originating EOA, so a quote made
 *    for the wrong origin is one the close-out may not be able to use.
 *  - `other-pools` — a UniV3 adapter whose router belongs to a different
 *    V3 factory from the quoter this app knows, so this app cannot price it.
 */
export type SlotOutcome =
  | 'quoted'
  | 'declined'
  | 'unanswered'
  | 'no-proxy'
  | 'unconfigured'
  | 'no-origin'
  | 'other-pools';

export type CloseOutRoute =
  | { kind: 'route'; calls: AdapterCall[]; venues: SwapVenueKind[] }
  /** Nothing to send. `outcomes` says, per adapter slot, why. */
  | {
      kind: 'no-quote';
      outcomes: { kind: SwapVenueKind; outcome: SlotOutcome }[];
    };

/**
 * Why a confirm found nothing to send — the ONE place the no-quote message
 * is decided, so each sentence claims only what was actually checked.
 *
 *  - `unread` — some adapter could not be identified, so it was never asked.
 *  - `unanswered` — at least one venue gave no answer the app could judge.
 *  - `unconfigured` — nothing declined, and everything left out was left
 *    out for want of the quote proxy or its key.
 *  - `unreachable` — nothing declined, and something left out cannot be
 *    asked from this app at all.
 *  - `partly-reached` — the venues asked declined, but others the protocol
 *    lists were left out.
 *  - `declined` — every venue was asked and every one declined.
 */
export type NoQuoteReason =
  | 'unread'
  | 'unanswered'
  | 'unconfigured'
  | 'unreachable'
  | 'partly-reached'
  | 'declined';

export function noQuoteReason(
  route: Extract<CloseOutRoute, { kind: 'no-quote' }>,
  rosterIncomplete: boolean,
): NoQuoteReason {
  if (rosterIncomplete) return 'unread';
  const has = (o: SlotOutcome) => route.outcomes.some((x) => x.outcome === o);
  if (has('unanswered')) return 'unanswered';
  const configGap = has('no-proxy') || has('unconfigured');
  const unaskable = has('other-pools') || has('no-origin');
  const leftOut = configGap || unaskable;
  if (!has('declined')) {
    return configGap && !unaskable ? 'unconfigured' : 'unreachable';
  }
  return leftOut ? 'partly-reached' : 'declined';
}

/** The EIP-7702 delegation designator: an EOA that delegated its code
 *  still originates its own transactions. */
const DELEGATED_EOA_PREFIX = '0xef0100';

/**
 * The account that will originate the close-out transaction, as far as the
 * app can know it: the connected account when that account is an EOA
 * (including one with an EIP-7702 delegation), `null` otherwise.
 *
 * A contract wallet (the Safe connector) is not the origin of its own
 * transactions: an owner or a relayer sends them, and the app cannot tell
 * which. A failed code read is not known either, so it is `null` too.
 */
export async function transactionOrigin(
  client: Pick<PublicClient, 'getCode'>,
  account: Address,
): Promise<Address | null> {
  let code;
  try {
    code = await client.getCode({ address: account });
  } catch {
    return null;
  }
  if (code === undefined || code === '0x') return account;
  return code.toLowerCase().startsWith(DELEGATED_EOA_PREFIX) ? account : null;
}

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
  /** Whether the account that will originate the transaction is known
   *  (`transactionOrigin`). 0x is askable only when it is: see `no-origin`. */
  originKnown: boolean,
): SwapVenueKind[] {
  const out: SwapVenueKind[] = [];
  if (agentConfigured && originKnown && roster.zeroex !== undefined) out.push('zeroex');
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
  /** How many adapters the Diamond lists whose disabled flag was READ as
   *  false — of any kind, including ones this app cannot name. Zero, with
   *  nothing unread, means the contract itself has no venue to try:
   *  `triggerDefault` reverts `NoEnabledSwapRoute` for every caller,
   *  operator included, until governance enables one. */
  enabledCount: number;
}

/**
 * Where a needs-route close-out stands on this chain, as ONE derived
 * value (#2463 round 6). Every card body and confirm-time message keys off
 * this rather than re-deriving its own subset of the conditions, which is
 * how three rounds of findings each found a sentence claiming more than
 * the roster showed.
 *
 * - `available` — at least one venue this app can ask.
 * - `unread` — some entry's name or disabled flag could not be read, and
 *   nothing askable was found; absence is not proven.
 * - `no-enabled-venue` — the list was read in full and no adapter is
 *   enabled (or none is registered). Nobody can close the loan by sale.
 * - `proxy-unconfigured` — an aggregator the app would ask is enabled,
 *   but this deployment has no quote proxy to ask it through.
 * - `unsupported` — enabled venues exist, none this app can ask from
 *   here (of a kind it cannot price, or 0x for a wallet whose transaction
 *   origin is unknown); another caller with its own route can still
 *   close it.
 */
export type RoutePosture =
  | 'available'
  | 'unread'
  | 'no-enabled-venue'
  | 'proxy-unconfigured'
  | 'unsupported';

export function routePosture(
  read: CloseOutRoster,
  chainId: number,
  agentConfigured: boolean,
  /** `transactionOrigin` resolved to an account (`true`), to unknown
   *  (`false`), or not yet (`undefined`). */
  originKnown: boolean | undefined,
): RoutePosture {
  if (quotableVenues(read.roster, chainId, agentConfigured, originKnown === true).length > 0) {
    return 'available';
  }
  if (read.incomplete) return 'unread';
  // 0x would be askable but whether this wallet originates its own
  // transactions has not been read: not proven either way.
  if (originKnown === undefined && agentConfigured && read.roster.zeroex !== undefined) {
    return 'unread';
  }
  if (read.enabledCount === 0) return 'no-enabled-venue';
  if (!agentConfigured && (read.roster.zeroex !== undefined || read.roster.oneinch !== undefined)) {
    return 'proxy-unconfigured';
  }
  return 'unsupported';
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
    // A disabled entry's name is irrelevant — it is skipped either way —
    // so only an entry that might be a usable venue makes the read partial.
    incomplete: entries.some(
      (e) => e.disabled === undefined || (e.disabled === false && e.name === undefined),
    ),
    enabledCount: entries.filter((e) => e.disabled === false).length,
  };
}

const QUOTE_TIMEOUT_MS = 8_000;

/** `ConfigFacet.getLiquidationConfig` — the EFFECTIVE values, with the
 *  defaults applied for any knob governance left unset. */
const LIQUIDATION_CONFIG_ABI = [
  {
    type: 'function',
    name: 'getLiquidationConfig',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'handlingFeeBps', type: 'uint256' },
      { name: 'maxSlippageBps', type: 'uint256' },
      { name: 'maxIncentiveBps', type: 'uint256' },
    ],
  },
] as const;

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
 *  for that aggregator", the aggregator answering with no route, or no
 *  answer the app can judge. */
type AgentAnswer = { body: unknown } | 'unconfigured' | 'declined' | 'unanswered';

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
      return parsed === undefined ? 'unanswered' : { body: parsed };
    }
    // `quoteProxy.ts` answers 503 `<venue>-not-configured` when its key is
    // absent.
    if (res.status === 503) {
      const err = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
      if (typeof err === 'string' && err.endsWith('-not-configured')) return 'unconfigured';
    }
    // A rejected credential is the deployment's configuration, not the
    // market: it stays wrong until an operator replaces the key.
    if (res.status === 401 || res.status === 403) return 'unconfigured';
    // Any other 4xx except a rate limit is the aggregator answering — no
    // route for this pair or size. A 429 or 5xx is no answer at all.
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? 'declined' : 'unanswered';
  } catch {
    return 'unanswered';
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
  /** The account that will originate the close-out transaction. The
   *  aggregators' taker is the adapter contract; 0x asks for the
   *  originating EOA as well. `null` when it is not known (a contract
   *  wallet), and then 0x is not asked: see `no-origin`. */
  txOrigin: Address | null;
  fetchImpl?: typeof fetch;
}): Promise<CloseOutRoute> {
  const { client, chainId, diamond, roster, sale, agentOrigin } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // 0x is kept here even for an unknown origin, so its slot is recorded as
  // `no-origin` rather than vanishing from the outcomes.
  const venues = quotableVenues(roster, chainId, agentOrigin !== null, true);

  // Every enabled instance of a venue is asked, in the Diamond's order:
  // two adapters of one kind (an adapter replacement in progress) each
  // have their own taker and allowlist, so one refusing says nothing
  // about the other.
  const slots = venues.flatMap((kind) => (roster[kind] ?? []).map((slot) => ({ kind, slot })));
  type Attempt = { outcome: SlotOutcome; candidates: RouteCandidate[] };
  const none = (outcome: SlotOutcome): Attempt => ({ outcome, candidates: [] });

  // The aggregators are quoted with the protocol's OWN slippage ceiling, read
  // from the Diamond, not with the proxy's default: calldata built for a
  // tighter limit than the protocol allows can revert on movement the
  // oracle floor would accept, and send the close-out into the fallback for
  // nothing. Unread, no aggregator is asked: a quote built on a guessed
  // limit is not one this app can stand behind.
  const needsSlippage = slots.some((s) => s.kind === 'zeroex' || s.kind === 'oneinch');
  let slippageBps: number | null = null;
  if (needsSlippage) {
    try {
      const [, maxSlippageBps] = await client.readContract({
        address: diamond,
        abi: LIQUIDATION_CONFIG_ABI,
        functionName: 'getLiquidationConfig',
      });
      slippageBps = Number(maxSlippageBps);
    } catch {
      slippageBps = null;
    }
  }

  const attempt = async ({ kind, slot }: (typeof slots)[number]): Promise<Attempt> => {
    const adapterIdx = BigInt(slot.idx);
    switch (kind) {
      case 'zeroex':
      case 'oneinch': {
        if (kind === 'zeroex' && deps.txOrigin === null) return none('no-origin');
        if (slippageBps === null) return none('unanswered');
        const answer = await agentQuote(fetchImpl, agentOrigin!, kind, {
          chainId,
          sellToken: sale.sellToken,
          buyToken: sale.buyToken,
          sellAmount: sale.sellAmount.toString(),
          taker: slot.address,
          slippageBps,
          ...(deps.txOrigin ? { txOrigin: deps.txOrigin } : {}),
        });
        if (typeof answer === 'string') return none(answer);
        const q =
          kind === 'zeroex' ? parseZeroExQuote(answer.body) : parseOneInchQuote(answer.body);
        // A well-formed answer with no usable route in it is a decline
        // (0x answers 200 with no liquidity, for one).
        if (!q) return none('declined');
        // The adapter calls only swap targets governance has allowed on it
        // (`AggregatorAdapterBase.swapTargetAllowed`). A quote naming any
        // other target — a router the aggregator has rotated to — is an
        // attempt the adapter is certain to refuse.
        let allowed;
        try {
          allowed = await client.readContract({
            address: slot.address,
            abi: SWAP_TARGET_ALLOWED_ABI,
            functionName: 'swapTargetAllowed',
            args: [q.swapTarget],
          });
        } catch {
          return none('unanswered');
        }
        if (!allowed) return none('declined');
        return {
          outcome: 'quoted',
          candidates: [
            {
              kind,
              expectedOutput: q.expectedOutput,
              call: { adapterIdx, data: packAggregatorData(q.swapTarget, q.swapCalldata) },
            },
          ],
        };
      }
      case 'univ3': {
        // The adapter's router is governance's choice; price it only where
        // it trades the same pools as the quoter this app knows.
        const match = await univ3AdapterMatchesQuoter(client, slot.address, chainId);
        if (match === 'unanswered') return none('unanswered');
        if (match === 'mismatch') return none('other-pools');
        // One candidate per quoting pool: the same adapter index may appear
        // more than once, and a second tier is a real back-up if the best
        // pool moves below the minimum before the transaction runs.
        const { tiers, unanswered } = await quoteUniV3Tiers(client, chainId, sale);
        if (tiers.length === 0) return none(unanswered ? 'unanswered' : 'declined');
        return {
          outcome: 'quoted',
          candidates: tiers.map((q) => ({
            kind,
            expectedOutput: q.expectedOutput,
            call: { adapterIdx, data: packUniV3Data(q.fee) },
          })),
        };
      }
      case 'testnetMock': {
        const out = await quoteTestnetMock(client, slot.address, diamond, sale);
        if (out === 'unanswered') return none('unanswered');
        if (out === null) return none('declined');
        return {
          outcome: 'quoted',
          candidates: [{ kind, expectedOutput: out, call: { adapterIdx, data: TESTNET_MOCK_DATA } }],
        };
      }
      default:
        return none('declined');
    }
  };

  const results = await Promise.all(
    slots.map((s) => attempt(s).catch((): Attempt => none('unanswered'))),
  );
  const candidates = results.flatMap((r) => r.candidates);
  if (candidates.length === 0) {
    // Aggregators the roster lists that were never asked for want of a
    // quote proxy are outcomes too: protocol-enabled routes left out.
    const noProxy: { kind: SwapVenueKind; outcome: SlotOutcome }[] =
      agentOrigin === null
        ? (['zeroex', 'oneinch'] as const).flatMap((k) =>
            (roster[k] ?? []).map(() => ({ kind: k, outcome: 'no-proxy' as const })),
          )
        : [];
    return {
      kind: 'no-quote',
      outcomes: [...slots.map((sl, i) => ({ kind: sl.kind, outcome: results[i].outcome })), ...noProxy],
    };
  }
  const ranked = rankRoutes(candidates);
  return { kind: 'route', calls: ranked.map((c) => c.call), venues: ranked.map((c) => c.kind) };
}

/**
 * What this close-out would do if it were sent now, read from the chain
 * rather than from the quotes.
 *
 *  - `'sale'` — the simulated close-out ran and emitted
 *    `LibSwap.SwapAdapterSucceeded` for this loan: a route met the
 *    protocol's minimum. Affirmative evidence, not the absence of a
 *    failure.
 *  - `'fallback'` — it ran and emitted `LibSwap.SwapAllAdaptersFailed` for
 *    this loan. Every route was refused, and the close-out would succeed
 *    into the full-collateral fallback instead of a sale.
 *  - `'other'` — it ran and emitted neither. The loan no longer takes the
 *    sale branch at all: its collateral was re-classified illiquid, its LTV
 *    crossed the collapse threshold, or an opposing position matched it,
 *    while the route was being built. The card's sale copy no longer
 *    describes what this transaction would do.
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
export type CloseOutPreview = 'sale' | 'fallback' | 'other' | 'unknown';

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

/** `LibSwap.SwapAdapterSucceeded(uint256 indexed loanId, uint256 indexed
 *  adapterIdx, address adapter, uint256 outputAmount)`. */
export const SWAP_ADAPTER_SUCCEEDED_TOPIC = toEventSelector(
  'SwapAdapterSucceeded(uint256,uint256,address,uint256)',
);

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
  // `logs` is optional in the response: a node that ran the call without
  // reporting events has not shown which ending it reached, which is not
  // the same as having shown that it reached neither.
  const logs = result.logs;
  if (logs === undefined) return 'unknown';
  const loanTopic = `0x${loanId.toString(16).padStart(64, '0')}` as Hex;
  const emitted = (topic: Hex) =>
    logs.some(
      (log) =>
        log.address.toLowerCase() === diamond.toLowerCase() &&
        log.topics[0] === topic &&
        log.topics[1]?.toLowerCase() === loanTopic,
    );
  if (emitted(SWAP_ADAPTER_SUCCEEDED_TOPIC)) return 'sale';
  if (emitted(SWAP_ALL_ADAPTERS_FAILED_TOPIC)) return 'fallback';
  return 'other';
}
