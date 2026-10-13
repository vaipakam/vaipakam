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
  type RosterSlot,
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
 *  - `unpriceable` — a venue this app has no way to price on this chain at
 *    all (no quoter for it here, or a kind it does not quote).
 */
export type SlotOutcome =
  | 'quoted'
  | 'declined'
  | 'unanswered'
  | 'no-proxy'
  | 'unconfigured'
  | 'no-origin'
  | 'other-pools'
  | 'unpriceable';

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
  const unaskable = has('other-pools') || has('no-origin') || has('unpriceable');
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
 * Whether this app can ask one adapter slot for a price at all — decided
 * from facts that hold for the visit, never from a quote.
 *
 * THE ONE RULE for askability (#2463 round 13). The card's posture and the
 * confirm's route both read it, so the card can no longer offer a button
 * on a slot the confirm is certain to skip: rounds 11, 12 and 13 each found
 * one such slot (a Safe asking 0x, a wallet origin never read, a UniV3
 * router on another factory), because the card judged availability from
 * the roster's kinds while the confirm judged each slot.
 *
 *  - `askable` — the confirm will ask it for a price.
 *  - `no-proxy` — an aggregator, and this deployment has no quote proxy.
 *  - `no-origin` — 0x, and the transaction's origin is not known.
 *  - `other-pools` — a UniV3 adapter whose router is on another factory.
 *  - `unpriceable` — no way to price this kind on this chain.
 *  - `unread` — a fact this depends on could not be read.
 */
export type SlotAskability =
  | 'askable'
  | 'no-proxy'
  | 'no-origin'
  | 'other-pools'
  | 'unpriceable'
  | 'unread';

export interface ClassifiedSlot {
  kind: SwapVenueKind;
  slot: RosterSlot;
  askability: SlotAskability;
}

/** The roster's kinds in the order the confirm asks them. */
const VENUE_ORDER: readonly SwapVenueKind[] = [
  'zeroex',
  'oneinch',
  'univ3',
  'balancerv2',
  'testnetMock',
];

export async function classifySlots(deps: {
  client: Pick<PublicClient, 'readContract'>;
  chainId: number;
  roster: AdapterRoster;
  agentConfigured: boolean;
  /** `transactionOrigin`'s answer: the originating account, or `null`. */
  txOrigin: Address | null;
}): Promise<ClassifiedSlot[]> {
  const { client, chainId, roster, agentConfigured, txOrigin } = deps;
  const judge = async (kind: SwapVenueKind, slot: RosterSlot): Promise<SlotAskability> => {
    switch (kind) {
      case 'zeroex':
        if (!agentConfigured) return 'no-proxy';
        return txOrigin === null ? 'no-origin' : 'askable';
      case 'oneinch':
        return agentConfigured ? 'askable' : 'no-proxy';
      case 'univ3': {
        if (UNIV3_VENUES[chainId] === undefined) return 'unpriceable';
        // The adapter's router is governance's choice; price it only where
        // it trades the same pools as the quoter this app knows.
        const match = await univ3AdapterMatchesQuoter(client, slot.address, chainId).catch(
          () => 'unanswered' as const,
        );
        return match === 'match' ? 'askable' : match === 'mismatch' ? 'other-pools' : 'unread';
      }
      case 'testnetMock':
        return 'askable';
      default:
        return 'unpriceable';
    }
  };
  const slots = VENUE_ORDER.flatMap((kind) => (roster[kind] ?? []).map((slot) => ({ kind, slot })));
  return Promise.all(
    slots.map(async ({ kind, slot }) => ({ kind, slot, askability: await judge(kind, slot) })),
  );
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
 * - `available` — at least one slot `classifySlots` judged askable.
 * - `unread` — some entry, or a fact a slot's askability depends on, could
 *   not be read, and nothing askable was found; absence is not proven.
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

export function routePosture(read: CloseOutRoster, slots: readonly ClassifiedSlot[]): RoutePosture {
  const has = (a: SlotAskability) => slots.some((x) => x.askability === a);
  if (has('askable')) return 'available';
  if (read.incomplete || has('unread')) return 'unread';
  if (read.enabledCount === 0) return 'no-enabled-venue';
  if (has('no-proxy')) return 'proxy-unconfigured';
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

/** Everything the posture is derived from, read together. */
export interface RouteStanding {
  read: CloseOutRoster;
  slots: ClassifiedSlot[];
  /** `transactionOrigin`'s answer, carried so the confirm quotes 0x for the
   *  same origin the slots were judged with. */
  txOrigin: Address | null;
  posture: RoutePosture;
}

/**
 * Read the roster, the submitting wallet's transaction origin and every
 * slot's askability, and derive the posture from them. The card's poll and
 * the confirm both call this, so the card cannot offer what the confirm
 * would then refuse for a reason knowable in advance.
 */
export async function readRouteStanding(deps: {
  client: Pick<PublicClient, 'readContract' | 'getCode'>;
  diamond: Address;
  chainId: number;
  testnetMockAdapter: Address | undefined;
  agentConfigured: boolean;
  /** The connected account, or undefined when none is connected. */
  account: Address | undefined;
}): Promise<RouteStanding> {
  const [read, txOrigin] = await Promise.all([
    readCloseOutRoster(deps.client, deps.diamond, deps.testnetMockAdapter),
    deps.account ? transactionOrigin(deps.client, deps.account) : Promise.resolve(null),
  ]);
  const slots = await classifySlots({
    client: deps.client,
    chainId: deps.chainId,
    roster: read.roster,
    agentConfigured: deps.agentConfigured,
    txOrigin,
  });
  return { read, slots, txOrigin, posture: routePosture(read, slots) };
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
  /** `classifySlots`' answer for this confirm: only `askable` slots are
   *  asked, and every other slot is recorded as an outcome. */
  slots: readonly ClassifiedSlot[];
  sale: CloseOutSale;
  agentOrigin: string | null;
  /** The account that will originate the close-out transaction. The
   *  aggregators' taker is the adapter contract; 0x asks for the
   *  originating EOA as well. `null` when it is not known (a contract
   *  wallet), and then 0x is not asked: see `no-origin`. */
  txOrigin: Address | null;
  fetchImpl?: typeof fetch;
}): Promise<CloseOutRoute> {
  const { client, chainId, diamond, sale, agentOrigin } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Every enabled instance of a venue is asked, in the Diamond's order:
  // two adapters of one kind (an adapter replacement in progress) each
  // have their own taker and allowlist, so one refusing says nothing
  // about the other.
  const slots = deps.slots.filter((s) => s.askability === 'askable');
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
        // Its router was matched to this chain's quoter in `classifySlots`.
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
    // Slots that were never asked are outcomes too: protocol-enabled routes
    // left out, each for the reason `classifySlots` gave.
    const notAsked = deps.slots
      .filter((s) => s.askability !== 'askable')
      .map((s) => ({
        kind: s.kind,
        outcome: (s.askability === 'unread' ? 'unanswered' : s.askability) as SlotOutcome,
      }));
    return {
      kind: 'no-quote',
      outcomes: [
        ...slots.map((sl, i) => ({ kind: sl.kind, outcome: results[i].outcome })),
        ...notAsked,
      ],
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
