/**
 * #3319 — the lenders standing ready for a pair: the protocol's own list of
 * active, funded lender intents (`MetricsFacet.getActiveLenderIntents`),
 * read through the wallet's connection and narrowed to the pair. A standing
 * intent is not an offer the borrower can take: a matching service fills a
 * request against it when the request's terms fit the lender's limits, so
 * the page states what is ready and never promises a fill.
 */
import type { PublicClient } from 'viem';
import { METRICS } from './reads';

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
}

/** Reads the network's active lender intents, up to the view's cap. */
export async function readLenderIntents(client: PublicClient, diamond: Hex): Promise<IntentsRead> {
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
    })) as readonly [readonly IntentSummary[], bigint];
    total = all;
    intents.push(...rows);
    scanned += rows.length;
    if (BigInt(scanned) >= all || rows.length < INTENT_PAGE) break;
  }
  return { intents, total, scanned };
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

/** Narrows the read to the pair; null when no lender stands ready on it. */
export function standingReady(intents: readonly IntentSummary[], lending: Hex, collateral: Hex): StandingReady | null {
  let out: StandingReady | null = null;
  for (const i of intents) {
    if (!same(i.lendingAsset, lending) || !same(i.collateralAsset, collateral)) continue;
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
