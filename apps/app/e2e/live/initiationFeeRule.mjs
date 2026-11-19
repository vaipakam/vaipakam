/**
 * #3649 — the loan initiation fee's TERM RULE for the live drives, the same
 * rule the contracts charge (`LibInitiationFee`) and the app shows
 * (`src/lib/initiationFee.ts`). The drives run under plain node and cannot
 * import the app's TypeScript, so the rule is written here once more;
 * `initiationFeeRule.test.mjs` pins it to the app's module over a grid of
 * settings and terms, so the two cannot drift.
 *
 * The fee is not one flat rate. Under the four settings the Diamond reports
 * (`getLoanInitiationFeeTerms`): the base rate up to the base term, a
 * straight line from there to the yearly rate at the one-year point, and the
 * yearly rate pro rata beyond it. A drive never assumes the base rate holds
 * for its term — it reads the settings and computes the rate at that term.
 */

const BPS = 10_000n;

/**
 * The settings from `getLoanInitiationFeeTerms`'s answer (a tuple in output
 * order: baseBps, baseTermDays, yearlyBps, yearDays) as named bigints.
 * @param {readonly [bigint|number, bigint|number, bigint|number, bigint|number]} r
 */
export function lifTermsOf(r) {
  if (!Array.isArray(r) || r.length !== 4) throw new Error(`initiationFeeRule: getLoanInitiationFeeTerms answered ${String(r)}`);
  const [baseBps, baseTermDays, yearlyBps, yearDays] = r.map((x) => BigInt(x));
  return { baseBps, baseTermDays, yearlyBps, yearDays };
}

/** The rate for an agreed term of `termDays`, as `num / den` basis points. */
export function lifRateFraction(terms, termDays) {
  const t = BigInt(termDays);
  const b = BigInt(terms.baseBps);
  const t0 = BigInt(terms.baseTermDays);
  const y = BigInt(terms.yearlyBps);
  const d = BigInt(terms.yearDays);
  if (t <= t0) return { num: b, den: 1n };
  if (t <= d) return { num: b * (d - t) + y * (t - t0), den: d - t0 };
  return { num: y * t, den: d };
}

/** The fee on `amount` for `termDays`, before any discount, rounded down
 *  exactly as the contract charges it. */
export function lifFeeOf(amount, terms, termDays) {
  const { num, den } = lifRateFraction(terms, termDays);
  return (BigInt(amount) * num) / (den * BPS);
}

/** The rate in whole basis points, rounded up (what a signed fee cap admits). */
export function lifRateBpsUp(terms, termDays) {
  const { num, den } = lifRateFraction(terms, termDays);
  return (num + den - 1n) / den;
}

/** The rate as the app prints it, without the sign: percent to at most three
 *  decimals, rounded UP ("0.2", "0.209"). */
export function lifRatePercentText(terms, termDays) {
  const { num, den } = lifRateFraction(terms, termDays);
  const thousandths = (num * 10n + den - 1n) / den;
  const whole = thousandths / 1000n;
  const frac = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** One line naming the settings, for a drive's log. */
export function describeLifTerms(terms) {
  return (
    `${terms.baseBps} bps up to ${terms.baseTermDays} days, a straight line to ${terms.yearlyBps} bps at ` +
    `${terms.yearDays} days, that rate pro rata beyond`
  );
}
