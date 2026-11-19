/**
 * #3649 — the loan initiation fee's TERM RULE, as the protocol applies it.
 * The fee is not one flat rate: it depends on the loan's agreed term, under
 * four settings the protocol reports (`getLoanInitiationFeeTerms`):
 *
 * - the base rate for a term up to the base term;
 * - from there a straight line to the yearly rate at the one-year point;
 * - past the one-year point, the yearly rate pro rata (yearly × term / year).
 *
 * The rate is a fraction of one basis point; the fee on an amount is
 * `amount × num / (den × 10 000)`, rounded down, as the protocol charges it.
 * A maker's signed fee cap is compared with the rate rounded UP.
 */
import { type Abi, type PublicClient } from 'viem';
import { FeeLevelsFacetABI } from '@vaipakam/contracts/abis';

type Hex = `0x${string}`;

const FEE_LEVELS = FeeLevelsFacetABI as Abi;
const BPS = 10_000n;

/** The four settings in force, defaults already resolved by the protocol. */
export interface LifTerms {
  /** Rate for a term up to `baseTermDays`, in basis points. */
  baseBps: bigint;
  /** The longest term charged the base rate, in days. */
  baseTermDays: bigint;
  /** Rate at `yearDays`, and the yearly rate pro rata beyond it. */
  yearlyBps: bigint;
  /** The rule's one-year point, in days. */
  yearDays: bigint;
}

export async function readLifTerms(client: PublicClient, diamond: Hex): Promise<LifTerms> {
  const [baseBps, baseTermDays, yearlyBps, yearDays] = (await client.readContract({
    address: diamond,
    abi: FEE_LEVELS,
    functionName: 'getLoanInitiationFeeTerms',
  })) as readonly [bigint, bigint, bigint, bigint];
  return { baseBps, baseTermDays, yearlyBps, yearDays };
}

/** The rate for an agreed term of `termDays`, as `num / den` basis points. */
export function lifRateFraction(terms: LifTerms, termDays: number | bigint): { num: bigint; den: bigint } {
  const t = BigInt(termDays);
  const { baseBps: b, baseTermDays: t0, yearlyBps: y, yearDays: d } = terms;
  if (t <= t0) return { num: b, den: 1n };
  if (t <= d) return { num: b * (d - t) + y * (t - t0), den: d - t0 };
  return { num: y * t, den: d };
}

/** The fee on `amount` for `termDays`, before any discount, rounded down. */
export function lifFeeOf(amount: bigint, terms: LifTerms, termDays: number | bigint): bigint {
  const { num, den } = lifRateFraction(terms, termDays);
  return (amount * num) / (den * BPS);
}

/** The rate in whole basis points, rounded up: what a maker's cap must admit. */
export function lifRateBpsUp(terms: LifTerms, termDays: number | bigint): bigint {
  const { num, den } = lifRateFraction(terms, termDays);
  return (num + den - 1n) / den;
}

/** The rate for `termDays` as a percent, without the sign, to at most three
 *  decimals and rounded UP, so it is never below the rate charged: "0.2",
 *  "0.209". */
export function lifRateText(terms: LifTerms, termDays: number | bigint): string {
  const { num, den } = lifRateFraction(terms, termDays);
  const thousandths = (num * 10n + den - 1n) / den;
  const whole = thousandths / 1000n;
  const frac = (thousandths % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Whether two reads of the settings agree. */
export function sameLifTerms(a: LifTerms, b: LifTerms): boolean {
  return a.baseBps === b.baseBps && a.baseTermDays === b.baseTermDays && a.yearlyBps === b.yearlyBps && a.yearDays === b.yearDays;
}
