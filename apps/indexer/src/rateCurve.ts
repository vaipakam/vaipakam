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
 *      marketPlacement.ts), lender and borrower different addresses (the
 *      self-trade rule), started inside the point's look-back, at least the
 *      minimum age old, WHATEVER its status (design ruling 2026-11-19).
 *      Every loan weighs by the interest it has paid so far, open or
 *      closed: one that paid interest and then defaulted or was liquidated
 *      keeps that weight, and interest its close-out delivered counts once
 *      delivered; interest a payment left undelivered is taken back by its
 *      own statement. A status filter would move the band on a liquidation
 *      for a reason that is not a rate, and lean it toward loans that ended
 *      well. (Before #3755 no event stated the figure for every route, so
 *      only repaid loans counted.) A loan whose agreed terms the ledger has
 *      not confirmed is out because its rate is not known. A loan whose rate came from a
 *      link is out too; no such loan exists on any deployment yet, so the
 *      rule has nothing to remove until the link kind is built.
 *   2. Weight: the interest PAID on the loan up to the as-of time, so
 *      every unit of weight has paid the yield fee. Read from the per-loan
 *      statements every interest payment emits (`LoanInterestPaid` less
 *      `LoanInterestUndelivered`, #3755, kept by the indexer in
 *      `loan_interest_events`; see `loanInterest.ts`), so every route counts
 *      the same way. A loan that has paid no interest weighs nothing and
 *      drops out. A deployment older than #3755 states nothing, so its
 *      loans weigh nothing and its points read "not enough loans".
 *   3. Cap: no one wallet carries more than `walletShareCapBps` of the
 *      weight, counted separately on the lender side and the borrower side.
 *   4. Minimum: a point with fewer than `minLenders` distinct lenders or
 *      `minBorrowers` distinct borrowers is withheld ("not enough loans
 *      yet").
 *   5. Figure: a weighted quartile band (25th, median, 75th), never a mean.
 *
 * Rates are annual basis points (the loans' `init_rate_bps`).
 */

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
  loans: 'any-status',
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
  /** The loan's current duration; places an unconfirmed loan on a point
   *  when it carries no initiation duration at all. */
  duration_days?: number | null;
}

/** The kinds of `loan_interest_events` row the weight reads, and the
 *  events they come from; stated on every response. */
export const PAID_INTEREST_SOURCES = Object.freeze(['LoanInterestPaid', 'less LoanInterestUndelivered'] as const);

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
  /** Loans in this point's look-back, at least the minimum age old, left
   *  out because the ledger has not confirmed their agreed terms, so their
   *  rate is not known. Stated beside the figure (zero included) so a gap
   *  in the indexer's record never reads as a quiet market. Such a loan is
   *  placed on a point by its unconfirmed duration, the best figure held. */
  unconfirmed: number;
  lenders: number;
  borrowers: number;
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

/** Whether a loan started inside `term`'s look-back and is at least the
 *  minimum age old at `asOf`. */
function inWindow(row: CurveLoanRow, term: CurveTerm, asOf: number): boolean {
  return (
    row.start_at <= asOf - OWN_LOANS_RULE.minAgeDays * 86_400 && row.start_at >= asOf - lookbackDays(term) * 86_400
  );
}

/**
 * The loan's weighted rate as of `asOf` (unix seconds), or null when the
 * loan is not counted. Rule steps 1 and 2. `paid` is the interest paid on
 * it up to `asOf` (`interestPaidByLoan`).
 */
export function loanWeight(
  row: CurveLoanRow,
  term: CurveTerm,
  paid: bigint | undefined,
  asOf: number,
): Weighted | null {
  if (row.init_terms_unbacked !== 0) return null;
  const rate = row.init_rate_bps;
  if (rate == null || rate < 0) return null;
  const lender = row.lender.toLowerCase();
  const borrower = row.borrower.toLowerCase();
  if (lender === borrower) return null;
  if (!inWindow(row, term, asOf)) return null;
  if (paid === undefined || paid <= 0n) return null;
  // Only the RATIO between loans of one asset matters, so a float is
  // precise enough for the weight.
  const weight = Number(paid);
  if (!Number.isFinite(weight) || weight <= 0) return null;
  return { rate, weight, lender, borrower };
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
  const unconfirmed = new Map<CurveTerm, number>();
  for (const row of rows) {
    if (row.init_terms_unbacked !== 0) {
      const d = row.init_duration_days ?? row.duration_days ?? null;
      const t = d == null ? null : curveTermFor(d);
      if (t !== null && inWindow(row, t, asOf)) unconfirmed.set(t, (unconfirmed.get(t) ?? 0) + 1);
      continue;
    }
    const term = row.init_duration_days == null ? null : curveTermFor(row.init_duration_days);
    if (term === null) continue;
    const w = loanWeight(row, term, paid.get(row.loan_id), asOf);
    if (!w) continue;
    const list = byTerm.get(term) ?? [];
    list.push(w);
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
      unconfirmed: unconfirmed.get(days) ?? 0,
      lenders,
      borrowers,
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
