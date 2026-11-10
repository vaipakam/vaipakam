/**
 * The rate warning before posting an offer (#3357): the offer's rate beside
 * the rates recent loans on the same pair and term were agreed at, from the
 * index. An offer left open at a rate far from the market is the one a bot
 * takes when rates move, so a rate far from recent loans is said plainly
 * before anything is signed. It warns; it never blocks: the creator may have
 * a reason, and the index only reports what it has filed (RB-RATE-CHECK).
 *
 * Only agreed rates the index's ledger backs are counted (`initRateBps`,
 * null when the loan's terms are not confirmed), sale vehicles are left out
 * (a sale is not a fresh rate), and only loans that started in the last
 * {@link RATE_WINDOW_DAYS} days. Loans whose terms the index has not
 * confirmed are in no term's sample; the index counts them per pair
 * (`unplaced`) and the form states that count. The index echoes the scope it read under;
 * an answer whose scope is not the one asked for is refused rather than
 * compared, since an unscoped page would be the whole chain's loans.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { unplacedFrom, type Unplaced } from '../reads/world/unplaced';

type Hex = `0x${string}`;

/** How far back a loan counts as recent. */
export const RATE_WINDOW_DAYS = 30;
/** How many of the newest loans one read covers. */
export const RATE_SAMPLE = 100;
/** How far from the recent median a rate is "far off": 5 percentage points. */
export const RATE_FAR_BPS = 500n;

export interface RecentRates {
  /** Agreed rates of recent loans, in basis points, newest first. */
  rates: bigint[];
  /** Whether the read reached its sample cap, so older loans in the window
   *  were not read. */
  capped: boolean;
  /** Loans on the pair (any term, any time) whose agreed terms the index has
   *  not confirmed: it cannot place them in a term, so they are in no
   *  market's sample. Stated beside the comparison, so "no loans" never
   *  hides loans whose term is unknown. `capped`: at least `count`. */
  unplaced: Unplaced;
}

function bps(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new IndexerUnavailable('shape', 'A recent loan carried a rate that is not a whole number.');
}

/** The recent agreed rates on one pair and term. Throws the index's own
 *  failure, or a shape failure when the answer is not scoped as asked. */
export async function readRecentRates(indexer: IndexerClient, chainId: number, lending: Hex, collateral: Hex, durationDays: bigint, nowSec: number): Promise<RecentRates> {
  const l = lending.toLowerCase();
  const c = collateral.toLowerCase();
  const q = `chainId=${chainId}&limit=${RATE_SAMPLE}&lendingAsset=${l}&collateralAsset=${c}&durationDays=${durationDays.toString()}&excludeSaleVehicles=1`;
  const body = await indexer.getJson<{ loans?: unknown; scope?: unknown; unplaced?: unknown }>(`/loans/recent?${q}`);
  const scope = body.scope as Record<string, unknown> | undefined;
  if (
    !Array.isArray(body.loans) ||
    !scope ||
    String(scope.lendingAsset).toLowerCase() !== l ||
    String(scope.collateralAsset).toLowerCase() !== c ||
    Number(scope.durationDays) !== Number(durationDays) ||
    scope.excludeSaleVehicles !== true
  ) {
    throw new IndexerUnavailable('shape', 'The index did not read recent loans on this pair and term.');
  }
  const unplaced = unplacedFrom(body.unplaced);
  const since = Math.floor(nowSec) - RATE_WINDOW_DAYS * 86_400;
  const rates: bigint[] = [];
  for (const raw of body.loans as Record<string, unknown>[]) {
    const startAt = Number(raw.startAt);
    if (!Number.isFinite(startAt)) throw new IndexerUnavailable('shape', 'A recent loan carried no start time.');
    if (startAt < since) continue;
    const r = bps(raw.initRateBps);
    if (r !== null) rates.push(r);
  }
  return { rates, capped: body.loans.length >= RATE_SAMPLE, unplaced };
}

/** The middle rate (the lower of the two middles for an even count, so no
 *  rate is invented between two agreed ones). */
export function medianBps(rates: readonly bigint[]): bigint | null {
  if (rates.length === 0) return null;
  const sorted = [...rates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export type RateVerdict = { kind: 'none' } | { kind: 'near'; median: bigint; count: number } | { kind: 'far'; median: bigint; count: number; above: boolean };

/** How an offer's rate sits against recent agreed rates. */
export function rateVerdict(rateBps: bigint, rates: readonly bigint[]): RateVerdict {
  const median = medianBps(rates);
  if (median === null) return { kind: 'none' };
  const gap = rateBps > median ? rateBps - median : median - rateBps;
  if (gap > RATE_FAR_BPS) return { kind: 'far', median, count: rates.length, above: rateBps > median };
  return { kind: 'near', median, count: rates.length };
}
