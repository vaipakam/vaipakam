/**
 * #3319 — the lenders standing ready for a pair: the protocol's own list of
 * active, funded lender intents (`MetricsFacet.getActiveLenderIntents`),
 * read through the wallet's connection and narrowed to the pair. A standing
 * intent is not an offer the borrower can take: a matching service fills a
 * request against it when the request's terms fit the lender's limits, so
 * the page states what is ready and never promises a fill.
 */
import type { Abi, PublicClient } from 'viem';
import { AdminFacetABI, LenderIntentFacetABI } from '@vaipakam/contracts/abis';
import type { LifecycleTerms } from '../post/postModel';
import { CONFIG, METRICS } from './reads';

const INTENT = LenderIntentFacetABI as Abi;
const ADMIN = AdminFacetABI as Abi;

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
  /** What a fill against an intent needs from the network, read at the
   *  same block as the list: the matching switch and the standing-intent
   *  switch (the protocol refuses every intent fill with either off), and
   *  the keeper pause (the protocol's matching service fills nothing while
   *  it is on, though a lender or another filler still may). Null when one
   *  could not be read. */
  switches: { matching: boolean | null; intents: boolean | null; keepersPaused: boolean | null };
}

/** Whether a request can be filled against the standing lenders now: both
 *  switches on and the matching service running; either switch off (no
 *  fill at all); the service paused (a fill only by a lender or another
 *  filler); or not known because one of the three was unread. */
export type IntentMatching = 'on' | 'off' | 'paused' | 'unknown';

export function intentMatching(s: IntentsRead['switches']): IntentMatching {
  if (s.matching === false || s.intents === false) return 'off';
  if (s.matching === null || s.intents === null) return 'unknown';
  if (s.keepersPaused === true) return 'paused';
  if (s.keepersPaused === null) return 'unknown';
  return 'on';
}

/**
 * Reads the network's active lender intents, up to the view's cap, and
 * what a fill against them needs from the network. Every page and every
 * switch is read at one block: the list is a swap-and-pop set, so pages read at
 * different blocks could skip an intent that moved between them and still
 * look complete.
 */
export async function readLenderIntents(client: PublicClient, diamond: Hex): Promise<IntentsRead> {
  const blockNumber = await client.getBlockNumber();
  const flag = (abi: Abi, functionName: string) =>
    (client.readContract({ address: diamond, abi, functionName, blockNumber }) as Promise<boolean>).catch((): boolean | null => null);
  const switchesRead = Promise.all([flag(CONFIG, 'getPartialFillEnabled'), flag(INTENT, 'isLenderIntentEnabled'), flag(ADMIN, 'keepersPaused')]);
  const intents: IntentSummary[] = [];
  let total = 0n;
  let scanned = 0;
  for (let page = 0; page < INTENT_PAGES; page++) {
    const offset = BigInt(page * INTENT_PAGE);
    const [rows, all] = (await client.readContract({
      address: diamond,
      abi: METRICS,
      functionName: 'getActiveLenderIntents',
      args: [offset, BigInt(INTENT_PAGE)],
      blockNumber,
    })) as readonly [readonly IntentSummary[], bigint];
    total = all;
    intents.push(...rows);
    scanned += rows.length;
    if (BigInt(scanned) >= all || rows.length < INTENT_PAGE) break;
  }
  const [matching, intentSwitch, keepersPaused] = await switchesRead;
  return { intents, total, scanned, switches: { matching, intents: intentSwitch, keepersPaused } };
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
 * request. `limited` keeps only the intents whose lender lets only fillers it
 * has chosen fill against them (`requiresKeeperAuth`, true) or only the rest,
 * which any filler may fill (false); left out, it keeps both. The two are
 * stated apart, because whether the matching service is among a lender's
 * chosen fillers is not something this read knows.
 */
export function standingReady(intents: readonly IntentSummary[], lending: Hex, collateral: Hex, exclude?: Hex | null, limited?: boolean): StandingReady | null {
  let out: StandingReady | null = null;
  for (const i of intents) {
    if (!same(i.lendingAsset, lending) || !same(i.collateralAsset, collateral)) continue;
    if (exclude && same(i.owner, exclude)) continue;
    if (limited !== undefined && i.requiresKeeperAuth !== limited) continue;
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
