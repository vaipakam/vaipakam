/**
 * Building the swap try-list a forced close sends — the ONE builder the
 * connected app's close-out (#2463) and the keeper's liquidation and
 * default passes (#2468) share.
 *
 * `swapRoutes.ts` holds the rules (wire formats, response parsers, the
 * roster, ranking). This module composes them into a route: read which
 * adapters the Diamond lists, decide which of them this caller can ask,
 * ask those, and rank what comes back. Until #2468 the keeper carried its
 * own copy of that composition with a hand-kept index table, the Diamond
 * as the aggregator taker, and no Base Sepolia entry; two builders meant
 * two sets of mistakes, and the keeper's were silent.
 *
 * The one thing that differs between callers is HOW an aggregator is
 * reached. The app goes through the agent's key-holding proxy and cannot
 * name the transaction's originating account for every wallet it
 * supports; a Worker calls the APIs directly with its own keys and knows
 * the account that will send. That difference is an injected
 * {@link AggregatorSource}; everything else is shared.
 *
 * What a route does NOT do is protect the sale price — and does not need
 * to. The contract computes its own oracle-derived minimum and every
 * adapter enforces it; a stale or bad quote can only fail its attempt.
 * What a route cannot control is what happens if EVERY attempt fails: the
 * close-out then succeeds into the protocol's full-collateral fallback.
 * {@link previewCloseOut} is how a caller finds out which ending it would
 * reach before sending.
 *
 * Framework-agnostic: viem only, no browser or Worker globals.
 */
import { encodeFunctionData, toEventSelector, type Address, type Hex, type PublicClient } from 'viem';
import {
  ADAPTER_NAME_KIND,
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
  univ3AdapterMatchesQuoter,
  type AdapterCall,
  type AdapterRoster,
  type RosterSlot,
  type RouteCandidate,
  type SwapVenueKind,
} from './swapRoutes';

/** What is being sold, and for what. For `triggerDefault` this is the
 *  loan's whole collateral for its principal asset; the keeper's partial
 *  and split liquidations sell a slice of it. */
export interface CloseOutSale {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
}

/**
 * What became of one adapter slot when the builder asked it — one value
 * per slot, so whatever a caller says about a route is derived from what
 * actually happened to every venue rather than from flags each path
 * remembered to set (#2463 round 9; rounds 2–8 each found a path that
 * folded "could not tell" into "no price").
 *
 *  - `quoted` — produced at least one candidate.
 *  - `declined` — the venue ANSWERED and had nothing usable: an explicit
 *    no-liquidity answer, no pool at any tier, a mock that would not pay.
 *  - `target-not-allowed` — an aggregator answered with a route through a
 *    swap target its adapter has not been allowed to call (0x rotating to
 *    a new Settler, typically). The adapter would refuse it, so it is not
 *    sent; kept distinct from `declined` because it is a governance task
 *    (the allowlist rotation in the incident runbook), not a market answer.
 *  - `unanswered` — no answer the builder could judge: a timeout,
 *    transport failure, rate limit or 5xx, a body that is neither a quote
 *    nor an explicit no-liquidity answer, or a failed
 *    read of something the route depends on.
 *  - `no-proxy` — an aggregator this caller has no way to reach (the app
 *    without a quote proxy), so it was not asked.
 *  - `unconfigured` — an aggregator this caller holds no key for, or whose
 *    key was refused.
 *  - `origin-bound` — 0x, for a caller that cannot name the account that
 *    will ORIGINATE the transaction: see {@link SlotAskability}.
 *  - `other-pools` — a UniV3 adapter whose router belongs to a different
 *    V3 factory from the quoter this module knows, so it cannot be priced.
 *  - `unpriceable` — a venue there is no way to price on this chain at all
 *    (no quoter for it here, or a kind this module does not quote — Balancer
 *    V2, whose only source is a subgraph whose hosting is in doubt, #2468).
 */
export type SlotOutcome =
  | 'quoted'
  | 'declined'
  | 'target-not-allowed'
  | 'unanswered'
  | 'no-proxy'
  | 'unconfigured'
  | 'origin-bound'
  | 'other-pools'
  | 'unpriceable';

export type CloseOutRoute =
  /** Something to send. `outcomes` covers every slot, as for `no-quote`:
   *  a venue that did not answer is a back-up this route does not have
   *  (#2463 round 15). */
  | {
      kind: 'route';
      /** Ranked: what `triggerDefault` / `triggerLiquidation` take. */
      calls: AdapterCall[];
      /** The ranked candidates themselves, `calls[i]` being
       *  `candidates[i].call` — for a caller that compares quoted outputs
       *  (the keeper's split and flash-loan decisions). */
      candidates: RouteCandidate[];
      venues: SwapVenueKind[];
      outcomes: { kind: SwapVenueKind; outcome: SlotOutcome }[];
    }
  /** Nothing to send. `outcomes` says, per adapter slot, why. */
  | {
      kind: 'no-quote';
      outcomes: { kind: SwapVenueKind; outcome: SlotOutcome }[];
    };

/**
 * Why a build found nothing to send — the ONE place the no-quote reason
 * is decided, so each sentence a caller derives claims only what was
 * actually checked.
 *
 *  - `unread` — some adapter could not be identified, so it was never asked.
 *  - `unanswered` — at least one venue gave no answer the builder could judge.
 *  - `unanswered-partly-reached` — the same, and some venue the protocol
 *    lists was also left out, which a retry alone will not change.
 *  - `unconfigured` — nothing declined, and everything left out was left
 *    out for want of a way to reach it or a key for it.
 *  - `unreachable` — nothing declined, and something left out cannot be
 *    asked by this caller at all.
 *  - `partly-reached` — the venues asked declined, but others the protocol
 *    lists were left out.
 *  - `declined` — every venue was asked and every one declined.
 */
export type NoQuoteReason =
  | 'unread'
  | 'unanswered'
  | 'unanswered-partly-reached'
  | 'unconfigured'
  | 'unreachable'
  | 'partly-reached'
  | 'declined';

export function noQuoteReason(
  route: Extract<CloseOutRoute, { kind: 'no-quote' }>,
  /** The roster read the route was built from. An enabled adapter it
   *  could not name never becomes a slot, so it has no outcome of its own;
   *  it counts here as a venue the protocol lists that was left out
   *  (#2480 r6) — otherwise "every venue was asked" could be claimed. */
  roster: Pick<CloseOutRoster, 'incomplete' | 'unrecognized'>,
): NoQuoteReason {
  if (roster.incomplete) return 'unread';
  const has = (o: SlotOutcome) => route.outcomes.some((x) => x.outcome === o);
  const configGap = has('no-proxy') || has('unconfigured');
  const unaskable =
    has('other-pools') || has('origin-bound') || has('unpriceable') || roster.unrecognized > 0;
  const leftOut = configGap || unaskable;
  if (has('unanswered')) return leftOut ? 'unanswered-partly-reached' : 'unanswered';
  // A refused swap target was an answer with nothing this route can use,
  // which is what `declined` says to a reader; the distinct outcome is for
  // operators, who read it in the keeper's log.
  if (!has('declined') && !has('target-not-allowed')) {
    return configGap && !unaskable ? 'unconfigured' : 'unreachable';
  }
  return leftOut ? 'partly-reached' : 'declined';
}

/**
 * Whether a route about to be sent was built without hearing from some
 * venue the builder did ask — so a back-up that venue might have offered
 * is unknown, not absent. Venues left out for a standing reason are not
 * this: a caller already knows what it cannot ask.
 */
export function routeMissingAnswers(route: Extract<CloseOutRoute, { kind: 'route' }>): boolean {
  return route.outcomes.some((o) => o.outcome === 'unanswered');
}

/**
 * Whether this caller can ask one adapter slot for a price at all —
 * decided from facts that hold for the visit (or the tick), never from a
 * quote.
 *
 * THE ONE RULE for askability (#2463 round 13). A caller that shows a
 * posture before it builds (the app's card) and the build itself both read
 * it, so the posture cannot offer what the build is certain to skip.
 *
 *  - `askable` — the build will ask it for a price.
 *  - `no-proxy` — an aggregator this caller has no way to reach.
 *  - `unconfigured` — an aggregator this caller holds no key for.
 *  - `origin-bound` — 0x, for a caller that cannot name the transaction's
 *    originating account. 0x quotes can bind liquidity to that account,
 *    and the app cannot know it for every wallet it supports (a Safe's
 *    transaction is sent by an owner or a relayer, a smart account's by a
 *    bundler), so the app never asks 0x (#2463 round 14). A Worker that
 *    sends from its own EOA knows the origin and can ask.
 *  - `other-pools` — a UniV3 adapter whose router is on another factory.
 *  - `unpriceable` — no way to price this kind on this chain.
 *  - `unread` — a fact this depends on could not be read.
 */
export type SlotAskability =
  | 'askable'
  | 'no-proxy'
  | 'unconfigured'
  | 'origin-bound'
  | 'other-pools'
  | 'unpriceable'
  | 'unread';

export interface ClassifiedSlot {
  kind: SwapVenueKind;
  slot: RosterSlot;
  askability: SlotAskability;
}

/** The two venues reached over an API rather than quoted on-chain. */
export type AggregatorKind = 'zeroex' | 'oneinch';

/** One aggregator's answer: its response body, "no key for this
 *  aggregator", the aggregator answering with no route, or no answer the
 *  builder can judge. */
export type AggregatorAnswer = { body: unknown } | 'unconfigured' | 'declined' | 'unanswered';

export interface AggregatorQuoteRequest {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  /** The ADAPTER: it holds the input and calls the swap target, so a quote
   *  made for any other address is calldata for the wrong caller. */
  taker: Address;
  slippageBps: number;
}

/**
 * How this caller reaches the aggregators. The ONLY seam between the
 * app's builder and a Worker's.
 */
export interface AggregatorSource {
  /** Whether `kind` can be asked by this caller at all. Synchronous: a
   *  source that needs to read something first (the app's proxy
   *  readiness) reads it before it is constructed. */
  askability(kind: AggregatorKind): Extract<
    SlotAskability,
    'askable' | 'no-proxy' | 'unconfigured' | 'origin-bound' | 'unread'
  >;
  quote(kind: AggregatorKind, req: AggregatorQuoteRequest): Promise<AggregatorAnswer>;
}

/**
 * An aggregator's NON-2xx HTTP status, as an answer. A rejected credential
 * is the caller's configuration, not the market: it stays wrong until an
 * operator replaces the key. Any other 4xx except a rate limit is the
 * aggregator answering — no route for this pair or size. A 429 or 5xx is
 * no answer at all.
 */
export function aggregatorAnswerForStatus(status: number): Exclude<AggregatorAnswer, { body: unknown }> {
  if (status === 401 || status === 403) return 'unconfigured';
  return status >= 400 && status < 500 && status !== 429 ? 'declined' : 'unanswered';
}

/** The roster's kinds in the order the builder asks them. */
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
  aggregators: Pick<AggregatorSource, 'askability'>;
}): Promise<ClassifiedSlot[]> {
  const { client, chainId, roster, aggregators } = deps;
  const judge = async (kind: SwapVenueKind, slot: RosterSlot): Promise<SlotAskability> => {
    switch (kind) {
      case 'zeroex':
      case 'oneinch':
        return aggregators.askability(kind);
      case 'univ3': {
        if (UNIV3_VENUES[chainId] === undefined) return 'unpriceable';
        // The adapter's router is governance's choice; price it only where
        // it trades the same pools as the quoter this module knows.
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
   *  false — of any kind, including ones this module cannot name. Zero,
   *  with nothing unread, means the contract itself has no venue to try:
   *  a liquid `triggerDefault` reverts `NoEnabledSwapRoute` for every
   *  caller until governance enables one. */
  enabledCount: number;
  /** How many of those enabled adapters have a READABLE name this module
   *  does not recognise (a new venue, a renamed implementation) and are not
   *  the declared testnet mock. They are absent from `roster` — there is
   *  no wire format to send them — but they are venues that exist, and a
   *  caller reporting why it found no route must not let them vanish
   *  (#2480 r1 `4267324316`). */
  unrecognized: number;
}

/**
 * Where a needs-route close-out stands on this chain, as ONE derived
 * value (#2463 round 6).
 *
 * - `available` — at least one slot {@link classifySlots} judged askable.
 * - `unread` — some entry, or a fact a slot's askability depends on, could
 *   not be read, and nothing askable was found; absence is not proven.
 * - `no-enabled-venue` — the list was read in full and no adapter is
 *   enabled (or none is registered). Nobody can close the loan by sale.
 * - `proxy-unconfigured` — an aggregator is enabled, but this caller has no
 *   way to reach it or no key for it.
 * - `unsupported` — enabled venues exist, none this caller can ask; another
 *   caller with its own route can still close it.
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
  if (has('no-proxy') || has('unconfigured')) return 'proxy-unconfigured';
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
    unrecognized: entries.filter(
      (e) =>
        e.disabled === false &&
        e.name !== undefined &&
        ADAPTER_NAME_KIND[e.name] === undefined &&
        e.address.toLowerCase() !== testnetMockAdapter?.toLowerCase(),
    ).length,
  };
}

/**
 * Whether a 200 body that is not a quote is the aggregator saying, in its
 * own words, that it has no route. 0x v2 answers 200 with
 * `liquidityAvailable: false`. 1inch says so with a 4xx (handled by
 * {@link aggregatorAnswerForStatus}), so a 200 from it that is not a quote
 * is never a decline.
 */
function saysNoLiquidity(kind: AggregatorKind, body: unknown): boolean {
  if (kind !== 'zeroex' || typeof body !== 'object' || body === null) return false;
  return (body as { liquidityAvailable?: unknown }).liquidityAvailable === false;
}

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

/**
 * Ask every slot this caller can reach for a price on this sale, and rank
 * what comes back into the try-list.
 *
 * Built fresh each time it is called: aggregator calldata is quoted for a
 * moment and does not keep. Each aggregator is quoted with ITS ADAPTER as
 * the taker: the adapter pulls the input from the Diamond and calls the
 * swap target itself, so calldata quoted for the Diamond would be for a
 * caller that never makes the call.
 */
export async function buildCloseOutRoute(deps: {
  client: Pick<PublicClient, 'readContract' | 'call'>;
  chainId: number;
  diamond: Address;
  /** {@link classifySlots}' answer: only `askable` slots are asked, and
   *  every other slot is recorded as an outcome. */
  slots: readonly ClassifiedSlot[];
  sale: CloseOutSale;
  aggregators: Pick<AggregatorSource, 'quote'>;
  /** The aggregators' slippage limit. Omitted, the protocol's OWN ceiling
   *  is read from the Diamond — calldata built for a tighter limit than the
   *  protocol allows can revert on movement the oracle floor would accept,
   *  and send the close-out into the fallback for nothing. A caller that
   *  is only MEASURING a price (the keeper's liquidity-confidence pass)
   *  passes its own. */
  slippageBps?: number;
}): Promise<CloseOutRoute> {
  const { client, chainId, diamond, sale, aggregators } = deps;
  // Every enabled instance of a venue is asked, in the Diamond's order:
  // two adapters of one kind (an adapter replacement in progress) each
  // have their own taker and allowlist, so one refusing says nothing
  // about the other.
  const slots = deps.slots.filter((s) => s.askability === 'askable');
  type Attempt = { outcome: SlotOutcome; candidates: RouteCandidate[] };
  const none = (outcome: SlotOutcome): Attempt => ({ outcome, candidates: [] });

  // Unread, no aggregator is asked: a quote built on a guessed limit is
  // not one this builder can stand behind.
  const needsSlippage = slots.some((s) => s.kind === 'zeroex' || s.kind === 'oneinch');
  let slippageBps: number | null = deps.slippageBps ?? null;
  if (needsSlippage && slippageBps === null) {
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
        const answer = await aggregators.quote(kind, {
          chainId,
          sellToken: sale.sellToken,
          buyToken: sale.buyToken,
          sellAmount: sale.sellAmount,
          taker: slot.address,
          slippageBps,
        });
        if (typeof answer === 'string') return none(answer);
        const q =
          kind === 'zeroex' ? parseZeroExQuote(answer.body) : parseOneInchQuote(answer.body);
        // Only an EXPLICIT no-liquidity answer is a decline. Any other body
        // that is not a quote (a changed response schema, an empty `{}`) is
        // an answer the builder cannot judge, and saying "no route" for it
        // would claim a market fact nobody stated (#2480 r5).
        if (!q) return none(saysNoLiquidity(kind, answer.body) ? 'declined' : 'unanswered');
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
        if (!allowed) return none('target-not-allowed');
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
  // Every slot's outcome, asked or not, on BOTH results: slots never asked
  // are protocol-enabled routes left out, each for the reason
  // `classifySlots` gave.
  const outcomes = [
    ...slots.map((sl, i) => ({ kind: sl.kind, outcome: results[i].outcome })),
    ...deps.slots
      .filter((s) => s.askability !== 'askable')
      .map((s) => ({
        kind: s.kind,
        outcome: (s.askability === 'unread' ? 'unanswered' : s.askability) as SlotOutcome,
      })),
  ];
  if (candidates.length === 0) return { kind: 'no-quote', outcomes };
  const ranked = rankRoutes(candidates);
  return {
    kind: 'route',
    calls: ranked.map((c) => c.call),
    candidates: ranked,
    venues: ranked.map((c) => c.kind),
    outcomes,
  };
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
