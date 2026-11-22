/**
 * The rate curve (#3751, TermAverageAndLinkGuardsDesign §6 and §8): two
 * observed averages of loan rates for one asset, by term, from the index's
 * `GET /rates/curve` and `GET /rates/curve/history`.
 *
 *  - the OUTSIDE half is the term average the protocol reads from an
 *    outside rate source (`w × A24 + (1 − w) × A90`). Until the protocol's
 *    term-average view exists the index reports it `not-published` with no
 *    figure, and the page says so rather than showing one it cannot back;
 *  - the OWN-LOANS half is built from the platform's own repaid loans under
 *    the §8 rule, whose settings the index echoes on every answer. A point
 *    the rule cannot fill is WITHHELD with a named reason, never shown as
 *    zero, and the page states the rule from what the index sent, never
 *    from a copy kept here.
 *
 * Averages of what was observed: never advice, a forecast or an offer. The
 * parsers refuse an answer that is not the shape asked for (as an
 * `IndexerUnavailable('shape')`), so a malformed answer is stated as a
 * failure and never rendered as a figure.
 */
import { getAddress, isAddress } from 'viem';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

const DAY = 86_400;

/** The reference half's state while the term-average view does not exist. */
export const REFERENCE_NOT_PUBLISHED = 'not-published';
/** The own-loans withheld reason that means "not enough loans yet". */
export const NOT_ENOUGH_LOANS = 'not-enough-loans';
/** The terms the index publishes, and so the ones the history accepts. */
export const CURVE_TERMS = [7, 30, 90, 180, 365] as const;
/** The history windows the index accepts. */
export const HISTORY_RANGES = ['30d', '90d', '365d'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const DEFAULT_HISTORY_RANGE: HistoryRange = '90d';

export interface ReferenceTerm {
  days: number;
  /** As the index names it: `not-published`, `available`, `unavailable`,
   *  `unusual`, or another state stated as written. */
  state: string;
  valueBps: number | null;
  a24Bps: number | null;
  a90Bps: number | null;
  /** The weight on the 24-hour average, in basis points of one. */
  weightBps: number | null;
}

/** A point's loan durations in days, inclusive; a null end is open. */
export type TermRange = readonly [number, number | null];

export type OwnState = 'shown' | 'withheld' | 'not-computed';

export interface OwnFigure {
  state: OwnState;
  /** Why a point is withheld, as the index names it. */
  reason: string | null;
  p25Bps: number | null;
  medianBps: number | null;
  p75Bps: number | null;
  loans: number | null;
  lenders: number | null;
  borrowers: number | null;
  /** Loans in this point's look-back, past the minimum age, left out
   *  because the ledger has not confirmed their agreed terms. Zero is a
   *  count; null when the point was never computed, or when the index did
   *  not state it. Shown beside the figure, so a gap never reads as a quiet
   *  market. */
  unconfirmedLeftOut: number | null;
}

export interface OwnTerm extends OwnFigure {
  days: number;
  termRange: TermRange | null;
  lookbackDays: number | null;
}

/** The §8 rule as the index states it on every answer. */
export interface CurveRule {
  /** Scalar settings, in the index's order (`provisional` held apart). */
  settings: { key: string; value: string | number | boolean }[];
  provisional: boolean;
  excludes: string[];
  interestSources: string[];
  /** Settlements whose interest the rule cannot separate, so it is not
   *  counted (the index's words). */
  interestNotCounted: string[];
  points: { days: number; termRange: TermRange | null; lookbackDays: number | null }[];
}

export interface RateCurve {
  chainId: number;
  asset: Hex;
  notice: string;
  /** False when the index has never computed this asset (no loan of it in
   *  any look-back, or its pass has not run since the asset appeared). */
  computed: boolean;
  /** The UTC day the figures are for, as unix seconds at its start. */
  day: number | null;
  /** When the index computed them, in unix seconds. */
  asOf: number | null;
  reference: { source: string; terms: ReferenceTerm[] };
  ownLoans: { source: string; rule: CurveRule; terms: OwnTerm[] };
}

export interface HistoryRow {
  /** The UTC day, as unix seconds at its start. */
  day: number;
  reference: { state: string | null; valueBps: number | null };
  ownLoans: OwnFigure;
}

export interface RateHistory {
  chainId: number;
  asset: Hex;
  days: number;
  termRange: TermRange | null;
  lookbackDays: number | null;
  /** Only the days the index has written, newest first. A missing day is
   *  one not filled yet, never a zero. */
  rows: HistoryRow[];
}

type Obj = Record<string, unknown>;

function bad(what: string): never {
  throw new IndexerUnavailable('shape', `The index's rate curve answer is not in the expected shape (${what}).`);
}

function obj(v: unknown, what: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(what);
  return v as Obj;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) bad(what);
  return v;
}

/** A finite number, or null for null/absent; anything else is refused. */
function numOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return bad(what);
}

function num(v: unknown, what: string): number {
  const n = numOrNull(v, what);
  if (n === null) bad(what);
  return n;
}

function strOrNull(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return bad(what);
}

function str(v: unknown, what: string): string {
  const s = strOrNull(v, what);
  if (s === null) bad(what);
  return s;
}

function strings(v: unknown, what: string): string[] {
  if (v === undefined || v === null) return [];
  return arr(v, what).map((x, i) => str(x, `${what} ${i}`));
}

function asset(v: unknown): Hex {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) bad('asset');
  return getAddress(v);
}

/** `[min, max]` with an open (null) top end; anything else is refused. */
function termRange(v: unknown, what: string): TermRange | null {
  if (v === undefined || v === null) return null;
  const a = arr(v, what);
  if (a.length !== 2) bad(what);
  const min = num(a[0], `${what} start`);
  const max = numOrNull(a[1], `${what} end`);
  if (min < 0 || (max !== null && max < min)) bad(what);
  return [min, max];
}

function ownFigure(o: Obj, what: string): OwnFigure {
  const state = o.state;
  if (state !== 'shown' && state !== 'withheld' && state !== 'not-computed') bad(`${what} state`);
  const f: OwnFigure = {
    state,
    reason: strOrNull(o.reason, `${what} reason`),
    p25Bps: numOrNull(o.p25Bps, `${what} lower quartile`),
    medianBps: numOrNull(o.medianBps, `${what} median`),
    p75Bps: numOrNull(o.p75Bps, `${what} upper quartile`),
    loans: numOrNull(o.loans, `${what} loans`),
    lenders: numOrNull(o.lenders, `${what} lenders`),
    borrowers: numOrNull(o.borrowers, `${what} borrowers`),
    unconfirmedLeftOut: numOrNull(o.unconfirmedLeftOut, `${what} unconfirmed left out`),
  };
  // A shown point must carry its median: one without would read as a
  // figure the index did not give.
  if (f.state === 'shown' && f.medianBps === null) bad(`${what} is shown with no median`);
  return f;
}

function referenceTerm(v: unknown, i: number): ReferenceTerm {
  const o = obj(v, `reference term ${i}`);
  return {
    days: num(o.days, `reference term ${i} days`),
    state: str(o.state, `reference term ${i} state`),
    valueBps: numOrNull(o.valueBps, `reference term ${i} value`),
    a24Bps: numOrNull(o.a24Bps, `reference term ${i} 24-hour average`),
    a90Bps: numOrNull(o.a90Bps, `reference term ${i} 90-day average`),
    weightBps: numOrNull(o.weightBps, `reference term ${i} weight`),
  };
}

function ownTerm(v: unknown, i: number): OwnTerm {
  const o = obj(v, `own-loans term ${i}`);
  return {
    days: num(o.days, `own-loans term ${i} days`),
    termRange: termRange(o.termRange, `own-loans term ${i} range`),
    lookbackDays: numOrNull(o.lookbackDays, `own-loans term ${i} look-back`),
    ...ownFigure(o, `own-loans term ${i}`),
  };
}

const RULE_LISTS = new Set(['provisional', 'excludes', 'interestSources', 'interestNotCounted', 'points']);

/** The rule's statement: its scalar settings in the index's order, and the
 *  lists it names. A nested setting this app does not know is refused
 *  rather than half-stated. */
export function parseRule(v: unknown): CurveRule {
  const o = obj(v, 'own-loans rule');
  const settings = Object.entries(o)
    .filter(([key]) => !RULE_LISTS.has(key))
    .map(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return { key, value };
      return bad(`own-loans rule setting ${key}`);
    });
  if (o.provisional !== undefined && typeof o.provisional !== 'boolean') bad('own-loans rule provisional');
  return {
    settings,
    provisional: o.provisional === true,
    excludes: strings(o.excludes, 'own-loans rule excludes'),
    interestSources: strings(o.interestSources, 'own-loans rule interest sources'),
    interestNotCounted: strings(o.interestNotCounted, 'own-loans rule interest not counted'),
    points: (o.points === undefined ? [] : arr(o.points, 'own-loans rule points')).map((p, i) => {
      const q = obj(p, `own-loans rule point ${i}`);
      return {
        days: num(q.days, `own-loans rule point ${i} days`),
        termRange: termRange(q.termRange, `own-loans rule point ${i} range`),
        lookbackDays: numOrNull(q.lookbackDays, `own-loans rule point ${i} look-back`),
      };
    }),
  };
}

/** `GET /rates/curve` for one asset, checked against the scope asked for. */
export function parseRateCurve(body: unknown, want: { chainId: number; asset: Hex }): RateCurve {
  const o = obj(body, 'answer');
  const chainId = num(o.chainId, 'chainId');
  const a = asset(o.asset);
  if (chainId !== want.chainId || a.toLowerCase() !== want.asset.toLowerCase()) bad('it describes another network or asset than the one asked for');
  if (typeof o.computed !== 'boolean') bad('computed');
  const ref = obj(o.reference, 'reference');
  const own = obj(o.ownLoans, 'ownLoans');
  const day = numOrNull(o.day, 'day');
  return {
    chainId,
    asset: a,
    notice: str(o.notice, 'notice'),
    computed: o.computed,
    day: day === null ? null : day * DAY,
    asOf: numOrNull(o.asOf, 'asOf'),
    reference: { source: str(ref.source, 'reference source'), terms: arr(ref.terms, 'reference terms').map(referenceTerm) },
    ownLoans: { source: str(own.source, 'ownLoans source'), rule: parseRule(own.rule), terms: arr(own.terms, 'own-loans terms').map(ownTerm) },
  };
}

function historyRow(v: unknown, i: number): HistoryRow {
  const o = obj(v, `history row ${i}`);
  const ref = obj(o.reference, `history row ${i} reference`);
  return {
    day: num(o.day, `history row ${i} day`) * DAY,
    reference: { state: strOrNull(ref.state, `history row ${i} reference state`), valueBps: numOrNull(ref.valueBps, `history row ${i} reference value`) },
    ownLoans: ownFigure(obj(o.ownLoans, `history row ${i} own loans`), `history row ${i} own loans`),
  };
}

/** `GET /rates/curve/history` for one term, checked against the scope asked for. */
export function parseRateHistory(body: unknown, want: { chainId: number; asset: Hex; days: number }): RateHistory {
  const o = obj(body, 'history answer');
  const chainId = num(o.chainId, 'history chainId');
  const a = asset(o.asset);
  const days = num(o.days, 'history term');
  if (chainId !== want.chainId || a.toLowerCase() !== want.asset.toLowerCase() || days !== want.days)
    bad('the history describes another network, asset or term than the one asked for');
  const rows = arr(o.rows, 'history rows').map(historyRow);
  rows.sort((x, y) => y.day - x.day);
  return { chainId, asset: a, days, termRange: termRange(o.termRange, 'history range'), lookbackDays: numOrNull(o.lookbackDays, 'history look-back'), rows };
}

export async function readRateCurve(indexer: IndexerClient, chainId: number, asset: Hex): Promise<RateCurve> {
  const q = new URLSearchParams({ chainId: String(chainId), asset: asset.toLowerCase() });
  return parseRateCurve(await indexer.getJson<unknown>(`/rates/curve?${q.toString()}`), { chainId, asset });
}

export async function readRateHistory(indexer: IndexerClient, chainId: number, asset: Hex, days: number, range: HistoryRange): Promise<RateHistory> {
  const q = new URLSearchParams({ chainId: String(chainId), asset: asset.toLowerCase(), days: String(days), range });
  return parseRateHistory(await indexer.getJson<unknown>(`/rates/curve/history?${q.toString()}`), { chainId, asset, days });
}

/** Whether the reference half has no figure at all and every point says
 *  the view is not published (the state until the contract view exists). */
export function referenceNotPublished(curve: RateCurve): boolean {
  return curve.reference.terms.length === 0 || curve.reference.terms.every((t) => t.state === REFERENCE_NOT_PUBLISHED && t.valueBps === null);
}

/** A basis-point figure as a percent text, two places at most. */
export function bpsPercent(bps: number): string {
  const v = Math.round(bps) / 100;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
