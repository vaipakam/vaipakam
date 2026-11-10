/**
 * OFF-75 — a market's executed loans, from the index (the world rail,
 * RB-RAILS): the fills tape and the executed-rate chart.
 *
 * A fill is a loan agreed in the market, at the terms set when it opened.
 * The index files a loan under a term only when the chain's ledger backs its
 * agreed terms (`marketDurationDays`), reads the rate and the amount from
 * the snapshot taken at opening (`initRateBps`, `initPrincipal`), never from
 * the live loan that repayments and extensions rewrite, and leaves out the
 * bookkeeping loan a lender's sale opens (`excludeSaleVehicles`). A loan on
 * the pair whose terms it has not confirmed is in no market; the index
 * counts those (`unplaced`) and the desk states the count, so an empty
 * market never hides them.
 *
 * The chart reads the index's per-period candles for the market: only
 * periods that saw a fill are returned, and the desk draws nothing across
 * the others (RB-DESK-TAPE). Nothing here is a price the protocol reports.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { unplacedFrom, type Unplaced } from '../reads/world/unplaced';
import type { Market } from './markets';

type Json = Record<string, unknown>;
type MarketTerms = Pick<Market, 'lending' | 'collateral' | 'durationDays'>;

/** How many of the market's newest loans the tape reads. */
export const TAPE_LIMIT = 20;

/** One loan agreed in the market. */
export interface Fill {
  loanId: bigint;
  /** When the loan opened, Unix seconds (the block's time as the index
   *  recorded it). */
  startAt: number;
  /** The rate agreed at opening. */
  rateBps: bigint;
  /** The amount lent at opening; null when the index has not confirmed it. */
  principal: bigint | null;
}

export interface Tape {
  /** Newest first. */
  fills: Fill[];
  /** Rows the index returned that could not be read here, or that are not
   *  this market's fills. */
  unread: number;
  /** The market has older loans than the tape read. */
  more: boolean;
  unplaced: Unplaced;
}

function whole(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v);
  throw new Error('not a whole number');
}

function big(v: unknown): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new Error('not a whole number');
}

/** Reads one tape row, or throws when it is not a fill of this market. */
export function fillFrom(o: Json, m: MarketTerms): Fill {
  if (String(o.lendingAsset).toLowerCase() !== m.lending.toLowerCase()) throw new Error('another lending token');
  if (String(o.collateralAsset).toLowerCase() !== m.collateral.toLowerCase()) throw new Error('another collateral token');
  if (o.isSaleVehicle !== false) throw new Error('a sale vehicle');
  // The index names the market it filed the loan under; a loan it placed in
  // no market, or in another term, is not this market's fill.
  if (whole(o.marketDurationDays) !== m.durationDays) throw new Error('another term');
  if (o.initRateBps === null || o.initRateBps === undefined) throw new Error('no agreed rate');
  return {
    loanId: big(o.loanId),
    startAt: whole(o.startAt),
    rateBps: big(o.initRateBps),
    principal: o.initPrincipal === null || o.initPrincipal === undefined ? null : big(o.initPrincipal),
  };
}

function scopeIs(scope: unknown, m: MarketTerms): boolean {
  const s = scope as Json | null | undefined;
  return (
    !!s &&
    typeof s === 'object' &&
    String(s.lendingAsset).toLowerCase() === m.lending.toLowerCase() &&
    String(s.collateralAsset).toLowerCase() === m.collateral.toLowerCase() &&
    Number(s.durationDays) === m.durationDays &&
    s.excludeSaleVehicles === true
  );
}

/** The market's newest loans. Throws the index's own failure, or a shape
 *  failure when the answer is not scoped to the market: an unscoped page is
 *  the whole chain's loans, which would read as this market's. */
export async function readTape(indexer: IndexerClient, chainId: number, m: MarketTerms): Promise<Tape> {
  const q = new URLSearchParams({
    chainId: String(chainId),
    limit: String(TAPE_LIMIT),
    lendingAsset: m.lending.toLowerCase(),
    collateralAsset: m.collateral.toLowerCase(),
    durationDays: String(m.durationDays),
    excludeSaleVehicles: '1',
  });
  const body = await indexer.getJson<{ loans?: unknown; scope?: unknown; unplaced?: unknown; nextBefore?: unknown }>(`/loans/recent?${q.toString()}`);
  if (!Array.isArray(body.loans) || !scopeIs(body.scope, m)) {
    throw new IndexerUnavailable('shape', 'The index did not read the loans of this market.');
  }
  const unplaced = unplacedFrom(body.unplaced);
  const fills: Fill[] = [];
  let unread = 0;
  for (const raw of body.loans) {
    try {
      fills.push(fillFrom(raw as Json, m));
    } catch {
      unread += 1;
    }
  }
  fills.sort((a, b) => b.startAt - a.startAt || (a.loanId > b.loanId ? -1 : a.loanId < b.loanId ? 1 : 0));
  const next = body.nextBefore;
  const more = next !== null && next !== undefined && body.loans.length >= TAPE_LIMIT;
  return { fills, unread, more, unplaced };
}

/** The chart's periods: how far back it reads and how wide one step is.
 *  The index serves these combinations of `range` and `interval`. */
export const CHART_PERIODS = ['7d', '30d', '90d', 'all'] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];
export const PERIOD_STEP: Readonly<Record<ChartPeriod, { interval: '1h' | '4h' | '1d'; seconds: number; days: number | null }>> = {
  '7d': { interval: '1h', seconds: 3_600, days: 7 },
  '30d': { interval: '4h', seconds: 14_400, days: 30 },
  '90d': { interval: '1d', seconds: 86_400, days: 90 },
  all: { interval: '1d', seconds: 86_400, days: null },
};

export function parsePeriod(v: string | null): ChartPeriod {
  return (CHART_PERIODS as readonly string[]).includes(v ?? '') ? (v as ChartPeriod) : '30d';
}

/** One period that saw at least one fill. */
export interface Candle {
  /** The period's start, Unix seconds. */
  t: number;
  /** The rates of its first, highest, lowest and last fill. */
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  fills: number;
  /** The amounts lent, added up, over the fills whose amount is confirmed. */
  principalTotal: bigint;
  /** Fills whose amount is not confirmed, so not added in. */
  unrecorded: number;
}

export interface Candles {
  /** Oldest first; periods with no fill are absent. */
  candles: Candle[];
  /** Periods the index returned that could not be read here. */
  unread: number;
  /** The index read only the market's newest loans, so the oldest periods
   *  are not drawn. */
  truncated: boolean;
  unplaced: Unplaced;
  /** The width of one period, in seconds. */
  stepSec: number;
}

export function candleFrom(o: Json): Candle {
  const c: Candle = {
    t: whole(o.t),
    open: big(o.open),
    high: big(o.high),
    low: big(o.low),
    close: big(o.close),
    fills: whole(o.fills),
    principalTotal: big(o.principalTotal),
    unrecorded: whole(o.unrecordedPrincipalFills),
  };
  const inside = (r: bigint) => r >= c.low && r <= c.high;
  if (c.fills === 0 || !inside(c.open) || !inside(c.close)) throw new Error('not a candle');
  return c;
}

/** The market's executed rates over the period. Throws the index's own
 *  failure. */
export async function readCandles(indexer: IndexerClient, chainId: number, m: MarketTerms, period: ChartPeriod): Promise<Candles> {
  const step = PERIOD_STEP[period];
  const q = new URLSearchParams({
    chainId: String(chainId),
    lendingAsset: m.lending.toLowerCase(),
    collateralAsset: m.collateral.toLowerCase(),
    durationDays: String(m.durationDays),
    interval: step.interval,
    range: period,
  });
  const body = await indexer.getJson<{ buckets?: unknown; unplaced?: unknown; truncated?: unknown }>(`/loans/rate-candles?${q.toString()}`);
  if (!Array.isArray(body.buckets)) throw new IndexerUnavailable('shape', 'The index answered without a rate series.');
  const unplaced = unplacedFrom(body.unplaced);
  const candles: Candle[] = [];
  let unread = 0;
  for (const raw of body.buckets) {
    try {
      candles.push(candleFrom(raw as Json));
    } catch {
      unread += 1;
    }
  }
  candles.sort((a, b) => a.t - b.t);
  return { candles, unread, truncated: body.truncated === true, unplaced, stepSec: step.seconds };
}

/** Runs of periods that follow one another with no empty period between;
 *  the chart joins steps only inside a run, so a gap is never drawn over. */
export function runs(candles: readonly Candle[], stepSec: number): Candle[][] {
  const out: Candle[][] = [];
  for (const c of candles) {
    const run = out[out.length - 1];
    const prev = run?.[run.length - 1];
    if (run && prev && c.t === prev.t + stepSec) run.push(c);
    else out.push([c]);
  }
  return out;
}
