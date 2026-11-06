/**
 * OFF-14 — the periodic-interest schedule an offer may carry. The protocol
 * decides which schedules are open for given terms (its cadence admission
 * rule); the app asks it through `previewCadenceAdmission`, which runs the
 * same rule offer creation enforces and returns each refusal's own revert
 * data, so the form offers exactly what creation will accept and names why
 * the rest are closed. Nothing here re-derives the rule: a refusal is only
 * classified from the error the protocol raised, for its sentence.
 */
import { decodeErrorResult, type Abi, type PublicClient } from 'viem';
import { OFFER_PREVIEW } from './reads';
import { interestAtDue } from './model';
import { formatScaled } from '../ui/format';
import type { CopyAccess, CopyKey } from '../copy/useCopy';

type Hex = `0x${string}`;

/** `LibVaipakam.PeriodicInterestCadence`, by enum position: 0 is interest at
 *  repayment, then every month, quarter, six months and year. */
export const CADENCES = [0, 1, 2, 3, 4] as const;
export type Cadence = (typeof CADENCES)[number];
/** Each schedule's period in days (`LibVaipakam.intervalDays`). */
export const INTERVAL_DAYS: Readonly<Record<Cadence, number>> = { 0: 0, 1: 30, 2: 90, 3: 180, 4: 365 };

/** The copy key naming each schedule ("monthly"…). */
export const CADENCE_NAME: Readonly<Record<Exclude<Cadence, 0>, CopyKey>> = {
  1: 'borrow.cadenceMonthly',
  2: 'borrow.cadenceQuarterly',
  3: 'borrow.cadenceSemiAnnual',
  4: 'borrow.cadenceAnnual',
};

export function isCadence(n: number): n is Cadence {
  return (CADENCES as readonly number[]).includes(n);
}

/** Why the protocol closed a schedule on these terms, from its own error. */
export type CadenceRefusal =
  /** `PeriodicInterestDisabled`: the switch is off (RB-SWITCH class 1a). */
  | { kind: 'switch-off' }
  /** `CadenceNotAllowedForIlliquid`: a leg is unpriced or not an ERC-20. */
  | { kind: 'unpriced' }
  /** `CadenceNotAllowed` on interest at repayment: a loan over a year must
   *  pay at least every year. */
  | { kind: 'needs-annual' }
  /** `CadenceNotAllowed` with the principal below the threshold: both
   *  figures, in the numeraire (1e18). */
  | { kind: 'below-threshold'; principal: bigint; threshold: bigint }
  /** `CadenceNotAllowed` otherwise: the period is not shorter than the loan. */
  | { kind: 'period-too-long'; periodDays: number; durationDays: number }
  /** No data, or data this build cannot decode: not an admission. */
  | { kind: 'unknown'; code: string };

export interface CadenceVerdict {
  cadence: Cadence;
  admitted: boolean;
  refusal: CadenceRefusal | null;
}

export interface CadenceAdmission {
  /** The protocol switch (`periodicInterestEnabled`). */
  enabled: boolean;
  verdicts: readonly CadenceVerdict[];
}

/** The terms the rule reads. `amount` is the smallest principal the offer
 *  may fund (the lower end of a range), which the threshold values. */
export interface CadenceTerms {
  lendingAsset: Hex;
  amount: bigint;
  assetType: number;
  collateralAsset: Hex;
  collateralAssetType: number;
  durationDays: number;
}

/** The cadence errors the protocol raises, by name. */
export const CADENCE_ERRORS: ReadonlySet<string> = new Set(['PeriodicInterestDisabled', 'CadenceNotAllowedForIlliquid', 'CadenceNotAllowed']);

/**
 * Classifies a cadence refusal from the protocol's decoded error. The order
 * of the `CadenceNotAllowed` cases follows the error's own arguments
 * (cadence, duration, principal value, threshold): a refused `None` can only
 * be the multi-year floor, a principal under the threshold names both
 * figures, and what is left is the period rule. Null for an error that is
 * not a cadence refusal.
 */
export function classifyCadenceError(errorName: string, args: readonly unknown[] | null): CadenceRefusal | null {
  if (errorName === 'PeriodicInterestDisabled') return { kind: 'switch-off' };
  if (errorName === 'CadenceNotAllowedForIlliquid') return { kind: 'unpriced' };
  if (errorName !== 'CadenceNotAllowed') return null;
  if (args === null || args.length < 4) return { kind: 'unknown', code: errorName };
  const cadence = Number(args[0]);
  const days = Number(args[1]);
  const principal = args[2] as bigint;
  const threshold = args[3] as bigint;
  if (!isCadence(cadence)) return { kind: 'unknown', code: errorName };
  if (cadence === 0) return { kind: 'needs-annual' };
  const multiYearAnnual = days > 365 && cadence === 4;
  if (principal < threshold && !multiYearAnnual) return { kind: 'below-threshold', principal, threshold };
  return { kind: 'period-too-long', periodDays: INTERVAL_DAYS[cadence], durationDays: days };
}

/** One refusal from the revert data the preview collected for it; empty
 *  data means the rule could not be evaluated, which is not an admission. */
export function cadenceRefusal(data: Hex): CadenceRefusal {
  if (data === '0x') return { kind: 'unknown', code: 'no data' };
  try {
    const { errorName, args } = decodeErrorResult({ abi: OFFER_PREVIEW as Abi, data });
    return classifyCadenceError(errorName, args ?? []) ?? { kind: 'unknown', code: errorName };
  } catch {
    return { kind: 'unknown', code: data.slice(0, 10) };
  }
}

interface RawAdmission {
  periodicInterestEnabled: boolean;
  cadences: readonly { cadence: number; admitted: boolean; refusal: Hex }[];
}

export async function readCadenceAdmission(client: PublicClient, diamond: Hex, t: CadenceTerms): Promise<CadenceAdmission> {
  const raw = (await client.readContract({
    address: diamond,
    abi: OFFER_PREVIEW,
    functionName: 'previewCadenceAdmission',
    args: [t.lendingAsset, t.amount, t.assetType, t.collateralAsset, t.collateralAssetType, BigInt(t.durationDays)],
  })) as RawAdmission;
  const verdicts = raw.cadences
    .filter((c) => isCadence(Number(c.cadence)))
    .map((c) => {
      const cadence = Number(c.cadence) as Cadence;
      return { cadence, admitted: c.admitted, refusal: c.admitted ? null : cadenceRefusal(c.refusal) };
    });
  return { enabled: raw.periodicInterestEnabled, verdicts };
}

/** Whether a schedule is open on the terms the admission was read for. While
 *  the admission is not known, only interest at repayment is offered. */
export function cadenceOpen(a: CadenceAdmission | null, cadence: Cadence): boolean {
  if (a === null) return cadence === 0;
  return a.verdicts.find((v) => v.cadence === cadence)?.admitted === true;
}

/** One full period's interest on `principal` at `rateBps`, exactly as the
 *  protocol expects it (`expectedInterestForPeriod`); 0 at repayment. */
export function periodInterest(principal: bigint, rateBps: bigint, cadence: Cadence): bigint {
  return cadence === 0 ? 0n : interestAtDue(principal, rateBps, BigInt(INTERVAL_DAYS[cadence]));
}

/** The grace a missed period gets before anyone may settle it by selling
 *  collateral: the protocol looks it up by the period's length less a day
 *  (`settleAllowedFromAt`). */
export function periodGraceLookupDays(cadence: Cadence): number {
  return cadence === 0 ? 0 : INTERVAL_DAYS[cadence] - 1;
}

/** Why a schedule is closed, as one sentence with every figure the
 *  protocol gave (RB-FUNDS: the principal and the threshold both named). */
export function cadenceRefusalText(r: CadenceRefusal, unit: string, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  switch (r.kind) {
    case 'switch-off':
      return copy.text('cadence.offSwitch');
    case 'unpriced':
      return copy.text('cadence.offUnpriced');
    case 'needs-annual':
      return copy.text('cadence.offAnnual');
    case 'below-threshold':
      return copy.format('cadence.offThreshold', { principal: formatScaled(r.principal), threshold: formatScaled(r.threshold), unit });
    case 'period-too-long':
      return copy.format('cadence.offPeriod', { period: String(r.periodDays), days: String(r.durationDays) });
    default:
      return copy.format('cadence.offUnknown', { code: r.code });
  }
}
