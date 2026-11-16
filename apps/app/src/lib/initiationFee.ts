/**
 * #3649 — the loan initiation fee's TERM RULE, as the contracts apply it
 * (`LibInitiationFee`). The fee is not one flat rate: it depends on the
 * agreed term of the loan, under four settings the Diamond reports through
 * `FeeLevelsFacet.getLoanInitiationFeeTerms`:
 *
 * - `baseBps` (B) for a term up to `baseTermDays` (T0);
 * - from there a straight line to `yearlyBps` (Y) at `yearDays` (D);
 * - past `yearDays`, the yearly rate pro rata: Y × term / D.
 *
 * The rate is a fraction of one basis point (`num / den`); the fee on a
 * principal is `principal × num / (den × 10_000)`, rounded down, exactly as
 * the contract charges it. A maker's signed fee cap is compared with the
 * rate rounded UP (`lifRateBpsUp`), the loan record stamps it rounded DOWN.
 *
 * Every figure here is computed from settings READ from the Diamond. There
 * is no default set in the app: a surface without the read shows the fee as
 * not yet known rather than a guessed rate (#3649 follow-up — a single flat
 * fallback could not be right for a term-scaled fee).
 */

/** The four settings in force, defaults already resolved by the contract. */
export interface LifTerms {
  /** Rate for a term up to `baseTermDays`, bps. */
  baseBps: number;
  /** The longest term charged the base rate, days. */
  baseTermDays: number;
  /** Rate at `yearDays`, and the yearly rate pro rata beyond it, bps. */
  yearlyBps: number;
  /** The one-year point of the rule, days. */
  yearDays: number;
}

const BASIS_POINTS = 10_000n;

/** The rate for an agreed term of `termDays`, as `num / den` basis points. */
export function lifRateFraction(terms: LifTerms, termDays: number): { num: bigint; den: bigint } {
  const t = BigInt(Math.max(0, Math.trunc(termDays)));
  const b = BigInt(terms.baseBps);
  const t0 = BigInt(terms.baseTermDays);
  const y = BigInt(terms.yearlyBps);
  const d = BigInt(terms.yearDays);
  if (t <= t0) return { num: b, den: 1n };
  if (t <= d) return { num: b * (d - t) + y * (t - t0), den: d - t0 };
  return { num: y * t, den: d };
}

/** The rate in whole basis points, rounded up (what a fee cap must admit). */
export function lifRateBpsUp(terms: LifTerms, termDays: number): number {
  const { num, den } = lifRateFraction(terms, termDays);
  return Number((num + den - 1n) / den);
}

/** The rate in whole basis points, rounded down (the loan record's stamp). */
export function lifRateBpsDown(terms: LifTerms, termDays: number): number {
  const { num, den } = lifRateFraction(terms, termDays);
  return Number(num / den);
}

/** The initiation fee on `principal` for `termDays`, before any discount,
 *  rounded down exactly as the contract charges it. */
export function lifFeeOf(principal: bigint, terms: LifTerms, termDays: number): bigint {
  const { num, den } = lifRateFraction(terms, termDays);
  return (principal * num) / (den * BASIS_POINTS);
}

/** The rate for `termDays` as a percentage string with up to three decimals
 *  ("0.2%"; a rate of 0.2082% is shown as "0.209%"). Rounded UP, so the
 *  figure shown is never below the rate charged. */
export function formatLifRate(terms: LifTerms, termDays: number): string {
  return `${lifRatePercentText(terms, termDays)}%`;
}

/** {@link formatLifRate} without the percent sign, for copy templates that
 *  write the sign themselves ("0.2", "0.209"). */
export function lifRatePercentText(terms: LifTerms, termDays: number): string {
  const { num, den } = lifRateFraction(terms, termDays);
  // bps / 100 = percent; three decimals of percent = num × 10 / den, rounded up.
  const thousandths = (num * 10n + den - 1n) / den;
  const whole = thousandths / 1000n;
  const frac = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}

/** Whether two reads of the settings agree (a reviewed quote is still live). */
export function sameLifTerms(a: LifTerms | null, b: LifTerms | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.baseBps === b.baseBps &&
    a.baseTermDays === b.baseTermDays &&
    a.yearlyBps === b.yearlyBps &&
    a.yearDays === b.yearDays
  );
}
