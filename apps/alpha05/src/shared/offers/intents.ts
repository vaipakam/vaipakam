/**
 * #3319 — the lenders standing ready for a pair: the protocol's own list of
 * active, funded lender intents (`MetricsFacet.getActiveLenderIntents`),
 * read through the wallet's connection and narrowed to the pair. A standing
 * intent is not an offer the borrower can take: a matching service fills a
 * request against it when the request's terms fit the lender's limits, so
 * the page states what is ready and never promises a fill.
 */
import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI, AggregatorAdapterFactoryFacetABI, LenderIntentFacetABI } from '@vaipakam/contracts/abis';
import type { LifecycleTerms } from '../post/postModel';
import { CONFIG, METRICS } from './reads';

const INTENT = LenderIntentFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;
const FACTORY = AggregatorAdapterFactoryFacetABI as Abi;

type Hex = `0x${string}`;

/** One row of `LibMetricsTypes.LenderIntentSummary`. */
export interface IntentSummary {
  owner: Hex;
  lendingAsset: Hex;
  collateralAsset: Hex;
  maxExposure: bigint;
  minRateBps: bigint;
  maxInitLtvBps: number;
  maxDurationDays: number;
  minFillAmount: bigint;
  requiresKeeperAuth: boolean;
  livePrincipal: bigint;
  availableCapital: bigint;
}

/** How many intents one call reads, and how many calls one view makes. */
export const INTENT_PAGE = 50;
export const INTENT_PAGES = 4;

export interface IntentsRead {
  intents: IntentSummary[];
  /** Every active intent on the network, on every pair. */
  total: bigint;
  /** How many of them were read: fewer than `total` when the list is longer
   *  than this view reads, which the page states. */
  scanned: number;
  /** Each network gate below, read at the same block as the list: true when
   *  it is closed, null when it could not be read. */
  closed: Record<IntentGate, boolean | null>;
  /** The owners (lower-cased) that are lending aggregators, whose intents
   *  cannot fill while the aggregator gate is closed: read only then, empty
   *  while it is open, and null when they could not be read. */
  pausedOwners: readonly string[] | null;
}

/**
 * Every network-level guard the protocol's intent fill applies, in its
 * order, and what a closed one stops: every fill (`all`: the global pause,
 * then the matching and standing-intent switches); only the protocol's own
 * matching service (`service`: the keeper pause, which the service obeys
 * while a lender or another filler may still fill); or only the intents a
 * lending aggregator owns (`aggregators`). `closedWhen` is the value that
 * closes it. Every gate is read from this one list, so a guard added here
 * reaches both the read and the verdict.
 */
export const INTENT_GATES = {
  protocolPaused: { abi: 'admin', fn: 'paused', closedWhen: true, stops: 'all' },
  matching: { abi: 'config', fn: 'getPartialFillEnabled', closedWhen: false, stops: 'all' },
  intents: { abi: 'intent', fn: 'isLenderIntentEnabled', closedWhen: false, stops: 'all' },
  keepers: { abi: 'admin', fn: 'keepersPaused', closedWhen: true, stops: 'service' },
  aggregators: { abi: 'admin', fn: 'aggregatorAdaptersPaused', closedWhen: true, stops: 'aggregators' },
} as const;

export type IntentGate = keyof typeof INTENT_GATES;

const GATE_ABI: Readonly<Record<(typeof INTENT_GATES)[IntentGate]['abi'], Abi>> = { admin: ADMIN, config: CONFIG, intent: INTENT };

/** Whether a request can be filled against the standing lenders now: every
 *  gate open (`on`); the protocol paused, so nothing is filled or posted
 *  (`halted`); a switch off, so no intent fill at all (`off`); only the
 *  matching service stopped, so a lender or another filler still may
 *  (`paused`); or not known, because a gate that decides it was unread. */
export type IntentMatching = 'on' | 'halted' | 'off' | 'paused' | 'unknown';

export function intentMatching(r: Pick<IntentsRead, 'closed' | 'pausedOwners'>): IntentMatching {
  const c = r.closed;
  if (c.protocolPaused === true) return 'halted';
  if (c.matching === true || c.intents === true) return 'off';
  if (c.protocolPaused === null || c.matching === null || c.intents === null) return 'unknown';
  if (c.keepers === true) return 'paused';
  if (c.keepers === null || c.aggregators === null || r.pausedOwners === null) return 'unknown';
  return 'on';
}

/**
 * Reads the network's active lender intents, up to the view's cap, and
 * every gate a fill against them passes. Everything is read at one block:
 * the list is a swap-and-pop set, so pages read at different blocks could
 * skip an intent that moved between them and still look complete, and a
 * gate read at another block could describe a different moment.
 */
export async function readLenderIntents(client: PublicClient, diamond: Hex): Promise<IntentsRead> {
  const blockNumber = await client.getBlockNumber();
  const read = <T>(abi: Abi, functionName: string, args?: readonly unknown[]) =>
    client.readContract({ address: diamond, abi, functionName, args, blockNumber }) as Promise<T>;
  const gateKeys = Object.keys(INTENT_GATES) as IntentGate[];
  const gatesRead = Promise.all(
    gateKeys.map((k) => {
      const g = INTENT_GATES[k];
      return read<boolean>(GATE_ABI[g.abi], g.fn).then(
        (v) => v === g.closedWhen,
        (): boolean | null => null,
      );
    }),
  );
  const intents: IntentSummary[] = [];
  let total = 0n;
  let scanned = 0;
  for (let page = 0; page < INTENT_PAGES; page++) {
    const offset = BigInt(page * INTENT_PAGE);
    const [rows, all] = await read<readonly [readonly IntentSummary[], bigint]>(METRICS, 'getActiveLenderIntents', [offset, BigInt(INTENT_PAGE)]);
    total = all;
    intents.push(...rows);
    scanned += rows.length;
    if (BigInt(scanned) >= all || rows.length < INTENT_PAGE) break;
  }
  const values = await gatesRead;
  const closed = Object.fromEntries(gateKeys.map((k, i) => [k, values[i]])) as Record<IntentGate, boolean | null>;
  let pausedOwners: string[] | null = [];
  if (closed.aggregators === true) {
    const owners = [...new Set(intents.map((i) => i.owner.toLowerCase()))];
    try {
      const flags = await Promise.all(owners.map((o) => read<boolean>(FACTORY, 'isAggregatorAdapter', [o])));
      pausedOwners = owners.filter((_, i) => flags[i]);
    } catch {
      pausedOwners = null;
    }
  }
  return { intents, total, scanned, closed, pausedOwners };
}

/** What lenders hold ready for one pair, from their intents on it. */
export interface StandingReady {
  /** Intents on the pair with something ready to lend. */
  lenders: number;
  /** The most any ONE of them can lend now: the smaller of its un-lent
   *  capital and the room left under its exposure cap. A request is filled
   *  from one intent, so a sum across lenders is not an amount one request
   *  can draw, and none is given. */
  largest: bigint;
  /** The lowest rate floor among them. */
  minRateBps: bigint;
  /** The longest term and the highest loan-to-value any of them accepts. */
  maxDays: number;
  maxLtvBps: number;
}

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/**
 * Narrows the read to the pair; null when no lender stands ready on it. The
 * reader's own intents are left out (`exclude`): the protocol refuses a match
 * whose two sides share a creator, so they can never fill the reader's own
 * request. So are the intents of `unavailable` owners (a lending aggregator
 * while aggregators are paused), which cannot fill now. `limited` keeps only
 * the intents whose lender lets only fillers it has chosen fill against them
 * (`requiresKeeperAuth`, true) or only the rest, which any filler may fill
 * (false); left out, it keeps both. The two are stated apart, because
 * whether the matching service is among a lender's chosen fillers is not
 * something this read knows.
 */
export function standingReady(
  intents: readonly IntentSummary[],
  lending: Hex,
  collateral: Hex,
  opts: { exclude?: Hex | null; limited?: boolean; unavailable?: readonly string[] | null } = {},
): StandingReady | null {
  const { exclude, limited, unavailable } = opts;
  let out: StandingReady | null = null;
  for (const i of intents) {
    if (!same(i.lendingAsset, lending) || !same(i.collateralAsset, collateral)) continue;
    if (exclude && same(i.owner, exclude)) continue;
    if (limited !== undefined && i.requiresKeeperAuth !== limited) continue;
    if (unavailable?.includes(i.owner.toLowerCase())) continue;
    const room = i.maxExposure > i.livePrincipal ? i.maxExposure - i.livePrincipal : 0n;
    const ready = room < i.availableCapital ? room : i.availableCapital;
    // Less than the lender's smallest fill cannot be lent at all.
    if (ready === 0n || ready < i.minFillAmount) continue;
    if (out === null) out = { lenders: 0, largest: 0n, minRateBps: i.minRateBps, maxDays: 0, maxLtvBps: 0 };
    out.lenders += 1;
    if (ready > out.largest) out.largest = ready;
    if (i.minRateBps < out.minRateBps) out.minRateBps = i.minRateBps;
    if (i.maxDurationDays > out.maxDays) out.maxDays = i.maxDurationDays;
    if (i.maxInitLtvBps > out.maxLtvBps) out.maxLtvBps = i.maxInitLtvBps;
  }
  return out;
}

/** A request's lifecycle terms, as the protocol call states them
 *  (`lifecycleTerms`), widened so any value can be checked. */
export type IntentRequestTerms = { [K in keyof LifecycleTerms]: LifecycleTerms[K] extends boolean ? boolean : number };

/** Why no standing intent can fill a request, whatever the lender's own
 *  limits. */
export type IntentRequestBlock = 'pro-rata' | 'partial-repay' | 'prepay-listing' | 'cadence';

/**
 * One check per lifecycle term, in the order the protocol's intent fill
 * applies them: it requires the full term's interest
 * (`LenderIntentFullTermRequired`), refuses partial repayment
 * (`LenderIntentPartialRepayNotAllowed`), and then fills only a request
 * whose lifecycle terms equal the intent's fixed ones, which carry no
 * listing consent and no interest schedule (`LifecycleTermsMismatch`).
 * Keyed by the terms the protocol call carries, so a new term there is a
 * type error here until it has a check.
 */
const INTENT_TERM_CHECKS: { readonly [K in keyof IntentRequestTerms]: (v: IntentRequestTerms[K]) => IntentRequestBlock | null } = {
  useFullTermInterest: (v) => (v ? null : 'pro-rata'),
  allowsPartialRepay: (v) => (v ? 'partial-repay' : null),
  allowsPrepayListing: (v) => (v ? 'prepay-listing' : null),
  periodicInterestCadence: (v) => (v !== 0 ? 'cadence' : null),
};

/** Why no standing intent can fill a request with these terms; null when
 *  the terms allow it. */
export function intentRequestBlock(t: IntentRequestTerms): IntentRequestBlock | null {
  for (const key of Object.keys(INTENT_TERM_CHECKS) as (keyof IntentRequestTerms)[]) {
    const block = (INTENT_TERM_CHECKS[key] as (v: IntentRequestTerms[typeof key]) => IntentRequestBlock | null)(t[key]);
    if (block !== null) return block;
  }
  return null;
}
