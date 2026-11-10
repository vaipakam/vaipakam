/**
 * #3319 — the borrower's view of a pair's open offers as a rate ladder, and
 * the optional limits that narrow it. Both are presentation only: every row
 * stays one offer, taken whole at its own terms, and the review shows those
 * terms before anything is signed. Nothing here ranks offers by any figure
 * the protocol did not report.
 */
import { roleTerms } from './acceptTerms';
import { parseRateBps } from '../post/postModel';
import type { MatchRow } from './matches';

/** The reader's own limits on the list. Null means no limit. */
export interface BorrowLimits {
  maxRateBps: bigint | null;
  maxLtvBps: bigint | null;
}

export interface Filtered {
  shown: MatchRow[];
  /** Offers hidden because their rate is above the reader's highest rate. */
  aboveRate: number;
  /** Offers hidden because their loan-to-value is above the reader's highest. */
  aboveLtv: number;
  /** Offers the loan-to-value limit could not check (the ratio was not
   *  worked out, or a leg is illiquid): kept in the list, never hidden on a
   *  figure that is not there. */
  ltvUnchecked: number;
}

/**
 * Hides the offers above the reader's limits and counts them, so the page
 * can say how many it hid. An offer whose loan-to-value is not a figure is
 * kept and counted apart: hiding it would claim a ratio the protocol did not
 * report.
 */
export function applyLimits(rows: readonly MatchRow[], limits: BorrowLimits): Filtered {
  const out: Filtered = { shown: [], aboveRate: 0, aboveLtv: 0, ltvUnchecked: 0 };
  for (const row of rows) {
    if (limits.maxRateBps !== null && roleTerms(row.offer).rateBps > limits.maxRateBps) {
      out.aboveRate += 1;
      continue;
    }
    if (limits.maxLtvBps !== null) {
      if (row.ltv.kind !== 'bps') out.ltvUnchecked += 1;
      else if (row.ltv.bps > limits.maxLtvBps) {
        out.aboveLtv += 1;
        continue;
      }
    }
    out.shown.push(row);
  }
  return out;
}

/** One step of the ladder: every offer at one rate, in the list's order. */
export interface LadderStep {
  rateBps: bigint;
  rows: MatchRow[];
  /** The smallest and largest amount one offer at this rate lends. */
  minAmount: bigint;
  maxAmount: bigint;
}

/**
 * The offers grouped by rate, lowest first. Within a step the list's own
 * order holds (offers you can take first, then the larger amount). The
 * amounts are per offer, never summed: one borrow takes one offer whole, so
 * a total across offers is not an amount anyone can borrow.
 */
export function rateLadder(rows: readonly MatchRow[]): LadderStep[] {
  const steps = new Map<bigint, LadderStep>();
  for (const row of rows) {
    const { rateBps, amount } = roleTerms(row.offer);
    const step = steps.get(rateBps);
    if (step) {
      step.rows.push(row);
      if (amount < step.minAmount) step.minAmount = amount;
      if (amount > step.maxAmount) step.maxAmount = amount;
    } else steps.set(rateBps, { rateBps, rows: [row], minAmount: amount, maxAmount: amount });
  }
  return [...steps.values()].sort((a, b) => (a.rateBps < b.rateBps ? -1 : a.rateBps > b.rateBps ? 1 : 0));
}

/** A typed limit as a percentage, in basis points: empty is no limit, zero
 *  is a limit of zero, and anything else unreadable is an error to show. */
export function parseLimit(text: string): { ok: true; value: bigint | null } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: null };
  const r = parseRateBps(text);
  if (r.ok) return { ok: true, value: r.value };
  if (r.error === 'zero') return { ok: true, value: 0n };
  return { ok: false };
}
