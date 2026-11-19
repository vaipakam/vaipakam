/**
 * An Auto-lend's past, from the index (`GET /loans/slot-history`): how much of
 * the last period its capital was out on loans, and the range of rates
 * comparable loans were agreed at, with the slot's own minimum beside it.
 *
 * It is a record of past loans, never a forecast, and it never suggests a
 * different rate: the owner reads where the slot stood and decides. A share
 * the index cannot back (no record at the period's start, an unreadable or
 * too-long record) is stated as unavailable with its reason, and a thin
 * sample is stated as too few loans to compare, so a missing figure never
 * reads as a zero.
 *
 * The answer is refused unless it names the slot that was asked for: an
 * unscoped answer would describe someone else's Auto-lend.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';

type Hex = `0x${string}`;

export type LentShare =
  | { available: true; periodStart: number; periodEnd: number; daysOfRecord: number; shareBps: number | null }
  | { available: false; periodStart: number; periodEnd: number; daysOfRecord: number; reason: 'no-record-at-period-start' | 'unreadable-record' | 'record-too-long' };

export type RateComparison =
  | { enough: true; loanCount: number; borrowerCount: number; lowestBps: bigint; highestBps: bigint; halfAmountBps: bigint }
  | { enough: false };

export interface SlotRates {
  periodStart: number;
  periodEnd: number;
  slotMinimumBps: bigint;
  minLoans: number;
  minBorrowers: number;
  comparison: RateComparison;
  excluded: { selfLoans: number; belowMinimumFill: number; partiesUnknown: number };
  truncated: boolean;
}

export interface SlotHistory {
  lentShare: LentShare;
  rates: SlotRates;
}

/** What the read could say: the history, or that the index has no record of
 *  this slot yet (a 404, a stated answer rather than an outage). */
export type SlotHistoryRead = { kind: 'history'; history: SlotHistory } | { kind: 'not-indexed' };

const SHARE_REASONS = new Set(['no-record-at-period-start', 'unreadable-record', 'record-too-long']);

function bad(what: string): never {
  throw new IndexerUnavailable('shape', `The index's Auto-lend history ${what}.`);
}
function int(v: unknown, what: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  return bad(`carried ${what} that is not a whole number`);
}
function big(v: unknown, what: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return bad(`carried ${what} that is not a whole number`);
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object') return bad(`had no ${what}`);
  return v as Record<string, unknown>;
}

/** The share, checked: a share outside 0-100% is refused. */
export function parseLentShare(v: unknown): LentShare {
  const s = obj(v, 'lent share');
  const base = { periodStart: int(s.periodStart, 'a period start'), periodEnd: int(s.periodEnd, 'a period end'), daysOfRecord: int(s.daysOfRecord, 'a day count') };
  if (s.available === true) {
    const shareBps = s.shareBps === null ? null : int(s.shareBps, 'a share');
    if (shareBps !== null && shareBps > 10_000) bad('carried a share above the whole period');
    return { available: true, ...base, shareBps };
  }
  if (s.available === false && typeof s.reason === 'string' && SHARE_REASONS.has(s.reason)) return { available: false, ...base, reason: s.reason as Extract<LentShare, { available: false }>['reason'] };
  return bad('carried a lent share it does not explain');
}

/** The rate range, checked: the lowest must not exceed the highest. */
export function parseSlotRates(v: unknown): SlotRates {
  const r = obj(v, 'rates');
  const c = obj(r.comparison, 'comparison');
  let comparison: RateComparison;
  if (c.enough === true) {
    const lowestBps = big(c.lowestBps, 'a lowest rate');
    const highestBps = big(c.highestBps, 'a highest rate');
    const halfAmountBps = big(c.halfAmountBps, 'a middle rate');
    if (lowestBps > highestBps || halfAmountBps < lowestBps || halfAmountBps > highestBps) bad('carried a rate range out of order');
    comparison = { enough: true, loanCount: int(c.loanCount, 'a loan count'), borrowerCount: int(c.borrowerCount, 'a borrower count'), lowestBps, highestBps, halfAmountBps };
  } else if (c.enough === false) comparison = { enough: false };
  else return bad('carried a comparison it does not explain');
  const x = obj(r.excluded, 'exclusions');
  return {
    periodStart: int(r.periodStart, 'a period start'),
    periodEnd: int(r.periodEnd, 'a period end'),
    slotMinimumBps: big(r.slotMinimumBps, 'a slot minimum'),
    minLoans: int(r.minLoans, 'a loan threshold'),
    minBorrowers: int(r.minBorrowers, 'a borrower threshold'),
    comparison,
    excluded: { selfLoans: int(x.selfLoans, 'an exclusion count'), belowMinimumFill: int(x.belowMinimumFill, 'an exclusion count'), partiesUnknown: int(x.partiesUnknown, 'an exclusion count') },
    truncated: r.truncated === true,
  };
}

export interface SlotRef {
  chainId: number;
  owner: Hex;
  lendingAsset: Hex;
  collateralAsset: Hex;
  slot: number;
}

/** Reads one Auto-lend's history. Throws the index's own failure, or a shape
 *  failure when the answer does not name the slot asked for. */
export async function readSlotHistory(indexer: IndexerClient, ref: SlotRef): Promise<SlotHistoryRead> {
  const q = `chainId=${ref.chainId}&owner=${ref.owner.toLowerCase()}&lendingAsset=${ref.lendingAsset.toLowerCase()}&collateralAsset=${ref.collateralAsset.toLowerCase()}&slot=${ref.slot}`;
  let body: Record<string, unknown>;
  try {
    body = await indexer.getJson<Record<string, unknown>>(`/loans/slot-history?${q}`);
  } catch (e) {
    if (e instanceof IndexerUnavailable && e.status === 404) return { kind: 'not-indexed' };
    throw e;
  }
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (body.chainId !== ref.chainId || !same(body.owner, ref.owner) || !same(body.lendingAsset, ref.lendingAsset) || !same(body.collateralAsset, ref.collateralAsset) || body.slot !== ref.slot)
    bad('named a different Auto-lend than the one asked for');
  if (body.basis !== 'past-loans-not-a-forecast') bad('did not state its basis');
  return { kind: 'history', history: { lentShare: parseLentShare(body.lentShare), rates: parseSlotRates(body.rates) } };
}
