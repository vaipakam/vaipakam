/**
 * #3751 — the public rate curve: the figures built from the platform's OWN
 * loans, under the standing rule of TermAverageAndLinkGuardsDesign.md §8,
 * with the settings the design thread gave on 2026-11-19 (all provisional,
 * all named below, all stated on every response in `ownLoans.rule`).
 *
 * Side-effect-free (no Env, no D1) so the rule is unit-testable; the pass
 * and the routes that use it live in `rateCurveRoutes.ts`.
 *
 *   1. Which loans: ERC-20 on both legs, not a lender-sale vehicle, agreed
 *      terms confirmed by the ledger (the one placement rule,
 *      marketPlacement.ts), two known, different opening parties (the
 *      #3879 counting rule, `figureRules.ts`: the parties the opening event
 *      named, so a later sale or handover moves a loan neither in nor out;
 *      a loan with one address on both sides, or whose opening parties are
 *      unknown, is left out and counted on its own line per point),
 *      started inside the point's look-back, at least the
 *      minimum age old, and CLOSED BY REPAYMENT by the as-of time. Open
 *      loans are out for now: an open loan would weigh only by interest it
 *      has already paid mid-loan, and the indexer does not yet keep that
 *      figure for every route. Defaults and liquidations are out: their
 *      interest may never have been paid. A loan whose rate came from a
 *      link is out too; no such loan exists on any deployment yet, so the
 *      rule has nothing to remove until the link kind is built.
 *   2. Weight: the interest PAID on the loan, so every unit of weight has
 *      paid the yield fee. Read from the settlement events the indexer
 *      already records (see `paidInterestOf`). A loan whose closing route
 *      reports no interest figure (refinance, swap-to-repay) weighs nothing
 *      and drops out, which the rule states.
 *   3. Cap: no one wallet carries more than `walletShareCapBps` of the
 *      weight, counted separately on the lender side and the borrower side.
 *   4. Minimum: a point with fewer than `minLenders` distinct lenders or
 *      `minBorrowers` distinct borrowers is withheld ("not enough loans
 *      yet").
 *   5. Figure: a weighted quartile band (25th, median, 75th), never a mean.
 *
 * Rates are annual basis points (the loans' `init_rate_bps`).
 */

import { openingPartiesOf } from './figureRules';

/** The curve's points, in days. */
export const CURVE_TERMS = [7, 30, 90, 180, 365] as const;
export type CurveTerm = (typeof CURVE_TERMS)[number];

/** Which loan durations each curve point stands for, inclusive. A point is
 *  labelled by this range, never as one term. */
export const TERM_RANGES: Readonly<Record<CurveTerm, readonly [number, number | null]>> =
  Object.freeze({
    7: [1, 14],
    30: [15, 60],
    90: [61, 135],
    180: [136, 270],
    365: [271, null],
  });

/** The settings of the §8 rule (design thread, 2026-11-19). Provisional;
 *  stated on every response. */
export const OWN_LOANS_RULE = Object.freeze({
  /** A point counts loans that STARTED within the larger of this many days
   *  and `lookbackTermMultiple` times its term. */
  lookbackMinDays: 90,
  lookbackTermMultiple: 2,
  /** A loan younger than this is left out. */
  minAgeDays: 3,
  /** One wallet's largest share of the weight, per side. */
  walletShareCapBps: 2_000,
  minLenders: 5,
  minBorrowers: 5,
  loans: 'closed-by-repayment',
  weight: 'interest-paid',
  figure: 'weighted-quartiles',
});

/** A point's look-back in days: the larger of 90 and twice its term. */
export function lookbackDays(term: CurveTerm): number {
  return Math.max(OWN_LOANS_RULE.lookbackMinDays, OWN_LOANS_RULE.lookbackTermMultiple * term);
}

/** The longest look-back any point uses. */
export const MAX_LOOKBACK_DAYS = Math.max(...CURVE_TERMS.map(lookbackDays));

/** The loan fields the rule reads. */
export interface CurveLoanRow {
  loan_id: number;
  lender: string;
  borrower: string;
  status: string;
  start_at: number;
  terminal_at: number | null;
  init_rate_bps: number | null;
  init_duration_days: number | null;
  init_terms_unbacked: number | null;
  /** The parties the loan's opening event named (migration 0118); null =
   *  not established. */
  init_lender: string | null;
  init_borrower: string | null;
}

/** One interest payment the indexer recorded for a loan. */
export interface PaidInterestEvent {
  loan_id: number;
  kind: string;
  args_json: string;
  block_at: number | null;
}

/**
 * The events that report interest paid, and the field that carries it.
 * Each payment is reported by exactly ONE of them, so summing cannot count
 * one twice:
 *   - `LoanSettlementBreakdown.interest` — the interest settled when a loan
 *     is repaid in full or preclosed (RepayFacet, PrecloseFacet);
 *   - `InterestPaymentBooked.settled` — interest paid mid-loan without
 *     touching principal, by the periodic sale or the payment reserve
 *     (`LibInterestPayment`, the one booking of both).
 * `PeriodicInterestSettled` is NOT read: it marks a period closing and
 * restates interest already booked above.
 */
export const PAID_INTEREST_FIELDS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    LoanSettlementBreakdown: 'interest',
    InterestPaymentBooked: 'settled',
  }),
);

/** Interest paid per loan up to `asOf`, from the recorded events. */
export function paidInterestOf(events: PaidInterestEvent[], asOf: number): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const e of events) {
    if (!Object.hasOwn(PAID_INTEREST_FIELDS, e.kind)) continue;
    if (e.block_at == null || e.block_at > asOf) continue;
    let v: bigint;
    try {
      const raw = (JSON.parse(e.args_json) as Record<string, unknown>)[PAID_INTEREST_FIELDS[e.kind]];
      v = BigInt(raw as string);
    } catch {
      continue;
    }
    if (v <= 0n) continue;
    out.set(e.loan_id, (out.get(e.loan_id) ?? 0n) + v);
  }
  return out;
}

/** Why a point is not shown: too few distinct lenders or borrowers, or the
 *  pass could not read the point's whole look-back (its loan scan hit the
 *  row cap), so a figure would describe only part of it. */
export type WithheldReason = 'not-enough-loans' | 'history-incomplete';

export interface OwnTermFigure {
  days: CurveTerm;
  /** The loan durations this point stands for, inclusive; null = no upper end. */
  termRange: readonly [number, number | null];
  /** This point's look-back in days. */
  lookbackDays: number;
  state: 'shown' | 'withheld';
  reason: WithheldReason | null;
  p25Bps: number | null;
  medianBps: number | null;
  p75Bps: number | null;
  /** Loans counted at this point (after every exclusion). */
  loans: number;
  lenders: number;
  borrowers: number;
  /** Loans that met every other step-1 test at this point but are left out
   *  by the counting rule: one address on both sides at opening. */
  oneAddress: number;
  /** Likewise, left out because the opening parties are unknown. */
  openingPartiesUnknown: number;
}

/** The curve point a loan of `durationDays` belongs to, or null. */
export function curveTermFor(durationDays: number): CurveTerm | null {
  if (!Number.isInteger(durationDays) || durationDays < 1) return null;
  for (const t of CURVE_TERMS) {
    const [lo, hi] = TERM_RANGES[t];
    if (durationDays >= lo && (hi === null || durationDays <= hi)) return t;
  }
  return null;
}

interface Weighted {
  rate: number;
  weight: number;
  lender: string;
  borrower: string;
}

/** How rule steps 1 and 2 treat one loan at one as-of time: counted with
 *  its weight, left out by the counting rule (and counted on its own line),
 *  or not in scope at all. */
export type LoanVerdict =
  | { kind: 'counted'; weight: Weighted }
  | { kind: 'left-out'; why: 'one-address' | 'parties-unknown' }
  | null;

/**
 * Rule steps 1 and 2 for one loan as of `asOf` (unix seconds). `paid` is
 * the interest paid on it up to `asOf`. The counting rule's party test runs
 * LAST, so a loan is counted as left out only when it met every other test
 * and would otherwise have been counted.
 */
export function classifyLoan(
  row: CurveLoanRow,
  term: CurveTerm,
  paid: bigint | undefined,
  asOf: number,
): LoanVerdict {
  if (row.init_terms_unbacked !== 0) return null;
  const rate = row.init_rate_bps;
  if (rate == null || rate < 0) return null;
  if (row.start_at > asOf - OWN_LOANS_RULE.minAgeDays * 86_400) return null;
  if (row.start_at < asOf - lookbackDays(term) * 86_400) return null;
  // Closed by repayment by `asOf`.
  if (row.status !== 'repaid' || row.terminal_at == null || row.terminal_at > asOf) return null;
  if (paid === undefined || paid <= 0n) return null;
  // Only the RATIO between loans of one asset matters, so a float is
  // precise enough for the weight.
  const weight = Number(paid);
  if (!Number.isFinite(weight) || weight <= 0) return null;
  // The counting rule (#3879): the opening event's parties, never the
  // current holders. They also stand for the loan in the wallet cap and the
  // distinct-party minimum, since they are who agreed the rate.
  const lender = row.init_lender?.toLowerCase() ?? null;
  const borrower = row.init_borrower?.toLowerCase() ?? null;
  const parties = openingPartiesOf(lender, borrower);
  if (parties === 'unknown') return { kind: 'left-out', why: 'parties-unknown' };
  if (parties === 'one') return { kind: 'left-out', why: 'one-address' };
  return { kind: 'counted', weight: { rate, weight, lender: lender!, borrower: borrower! } };
}

/** The loan's weighted rate as of `asOf`, or null when it is not counted
 *  (out of scope, or left out by the counting rule). */
export function loanWeight(
  row: CurveLoanRow,
  term: CurveTerm,
  paid: bigint | undefined,
  asOf: number,
): Weighted | null {
  const v = classifyLoan(row, term, paid, asOf);
  return v?.kind === 'counted' ? v.weight : null;
}

/**
 * Cap every wallet's share of the weight at `capBps`, on the lender side
 * and the borrower side separately (rule step 3). A wallet over the cap has
 * its loans scaled down; that lowers the total, so the pass repeats until
 * nothing is over (bounded). A side with fewer wallets than 1/cap cannot
 * satisfy the cap; the minimum-count gate withholds such a point before
 * this runs.
 */
export function capWalletShares<T extends { weight: number; lender: string; borrower: string }>(
  items: T[],
  capBps: number,
): T[] {
  const out = items.map((i) => ({ ...i }));
  const cap = capBps / 10_000;
  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const side of ['lender', 'borrower'] as const) {
      const total = out.reduce((s, i) => s + i.weight, 0);
      if (total <= 0) return out;
      const byWallet = new Map<string, number>();
      for (const i of out) byWallet.set(i[side], (byWallet.get(i[side]) ?? 0) + i.weight);
      if (byWallet.size * cap < 1) continue;
      const limit = cap * total;
      for (const [wallet, w] of byWallet) {
        if (w > limit * (1 + 1e-9)) {
          const f = limit / w;
          for (const i of out) if (i[side] === wallet) i.weight *= f;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}

/** The weighted `q` quantile (0..1): the smallest rate at which the
 *  cumulative weight reaches q of the total. Always an observed rate. */
export function weightedQuantile(items: { rate: number; weight: number }[], q: number): number | null {
  const sorted = items.filter((i) => i.weight > 0).sort((a, b) => a.rate - b.rate);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (sorted.length === 0 || total <= 0) return null;
  const target = q * total;
  let acc = 0;
  for (const i of sorted) {
    acc += i.weight;
    if (acc >= target * (1 - 1e-12)) return i.rate;
  }
  return sorted[sorted.length - 1].rate;
}

/** Every curve point's own-loans figure for ONE asset as of `asOf`. */
export function ownLoansCurve(
  rows: CurveLoanRow[],
  paid: Map<number, bigint>,
  asOf: number,
  /** The earliest loan start the caller's scan is complete from; a point
   *  whose look-back reaches before it is withheld. Omit = complete. */
  coveredFrom = Number.NEGATIVE_INFINITY,
): OwnTermFigure[] {
  const rule = OWN_LOANS_RULE;
  const byTerm = new Map<CurveTerm, Weighted[]>();
  const leftOut = new Map<CurveTerm, { oneAddress: number; openingPartiesUnknown: number }>();
  for (const row of rows) {
    const term = row.init_duration_days == null ? null : curveTermFor(row.init_duration_days);
    if (term === null) continue;
    const v = classifyLoan(row, term, paid.get(row.loan_id), asOf);
    if (!v) continue;
    if (v.kind === 'left-out') {
      const c = leftOut.get(term) ?? { oneAddress: 0, openingPartiesUnknown: 0 };
      if (v.why === 'one-address') c.oneAddress++;
      else c.openingPartiesUnknown++;
      leftOut.set(term, c);
      continue;
    }
    const list = byTerm.get(term) ?? [];
    list.push(v.weight);
    byTerm.set(term, list);
  }
  return CURVE_TERMS.map((days) => {
    const list = byTerm.get(days) ?? [];
    const lenders = new Set(list.map((i) => i.lender)).size;
    const borrowers = new Set(list.map((i) => i.borrower)).size;
    const base = {
      days,
      termRange: TERM_RANGES[days],
      lookbackDays: lookbackDays(days),
      loans: list.length,
      lenders,
      borrowers,
      oneAddress: leftOut.get(days)?.oneAddress ?? 0,
      openingPartiesUnknown: leftOut.get(days)?.openingPartiesUnknown ?? 0,
    };
    const incomplete = asOf - lookbackDays(days) * 86_400 < coveredFrom;
    if (incomplete || lenders < rule.minLenders || borrowers < rule.minBorrowers) {
      return {
        ...base,
        state: 'withheld',
        reason: incomplete ? 'history-incomplete' : 'not-enough-loans',
        p25Bps: null,
        medianBps: null,
        p75Bps: null,
      };
    }
    const capped = capWalletShares(list, rule.walletShareCapBps);
    return {
      ...base,
      state: 'shown',
      reason: null,
      p25Bps: weightedQuantile(capped, 0.25),
      medianBps: weightedQuantile(capped, 0.5),
      p75Bps: weightedQuantile(capped, 0.75),
    };
  });
}
