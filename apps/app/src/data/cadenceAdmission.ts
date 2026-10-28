/**
 * Which periodic-interest schedules an offer on given terms may carry, and
 * why each closed one is closed (#2524), read from
 * `OfferPreviewFacet.previewCadenceAdmission`.
 *
 * Offer creation runs one cadence rule (`LibCadenceAdmission`, #3009): the
 * protocol switch, both legs liquid ERC-20, the yearly floor on a loan
 * longer than a year, the principal threshold, and an interval shorter
 * than the loan. The preview returns that rule's verdict for every
 * cadence, with the exact error creation would raise for each refused
 * one, so the create form offers only what creation accepts and keeps no
 * copy of the rule. Liquidity is classified live, so the answer can move
 * with the oracle, the switch or the threshold while the form is open; the
 * review's own `createOffer` simulation is the last check before signing.
 *
 * The preview reads exactly the figures `createOffer` will send — the
 * caller passes the payload's own `amount`, which for a lender offer is
 * its smallest fill rather than the headline — so the threshold row values
 * the same number creation values.
 *
 * It covers the cadence rule only: an offer refused for its duration or
 * its amounts is refused whatever this says.
 */
import { useQuery } from '@tanstack/react-query';
import { decodeErrorResult, type Address, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { isMissingSelectorError } from '../contracts/preflights';
import { numeraireOf, type Numeraire } from './numeraire';

/** `LibVaipakam.PeriodicInterestCadence`, in enum order. */
export const CADENCES = [0, 1, 2, 3, 4] as const;
export const CADENCE_NONE = 0;

/** `LibVaipakam.intervalDays`, for wording a refusal only. */
const INTERVAL_DAYS: Record<number, number> = { 1: 30, 2: 90, 3: 180, 4: 365 };

/** The terms the preview reads, taken from the `createOffer` payload. */
export interface CadenceTerms {
  lendingAsset: Address;
  amount: bigint;
  assetType: number;
  collateralAsset: Address;
  collateralAssetType: number;
  durationDays: number;
}

/** Why one cadence is closed, in the terms the form words it in. */
export type CadenceRefusal =
  /** The protocol switch is off: only "once, at repayment". */
  | { kind: 'switched-off' }
  /** A leg is not a liquid ERC-20; `principalLiquid` / `collateralLiquid`
   *  say which, from the error's own arguments. */
  | { kind: 'illiquid'; principalLiquid: boolean; collateralLiquid: boolean }
  /** A loan longer than a year must pay at least yearly. */
  | { kind: 'yearly-floor' }
  /** The offer's smallest loan is valued below the finer-cadence
   *  threshold (both 1e18 numeraire units). */
  | { kind: 'below-threshold'; principalNumeraire: bigint; threshold: bigint }
  /** The cadence's interval is not shorter than the loan. */
  | { kind: 'interval'; intervalDays: number }
  /** A refusal this app cannot word (an error it does not know, or one
   *  it cannot decode). Still a refusal, never an admission. */
  | { kind: 'other' }
  /** The rule could not be evaluated (the check reverted with no data).
   *  The contract does not count that as an admission, so neither does
   *  the form. */
  | { kind: 'unevaluated' };

export interface CadenceVerdict {
  cadence: number;
  admitted: boolean;
  /** `null` exactly when `admitted`. */
  refusal: CadenceRefusal | null;
}

export interface CadencePreview {
  periodicInterestEnabled: boolean;
  bothLegsQualify: boolean;
  annualFloorApplies: boolean;
  cadences: CadenceVerdict[];
  /** The reference currency the threshold is stated in; `null` when its
   *  symbol could not be read or decoded. */
  numeraire: Numeraire | null;
}

/** The read as the form consumes it. `unserved`: a Diamond cut before
 *  #3009 has no preview selector, a fact about the deployment no retry
 *  changes. */
export type CadenceAdmission =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'failed' }
  | { kind: 'unserved' }
  | { kind: 'known'; preview: CadencePreview };

interface RawPreview {
  periodicInterestEnabled: boolean;
  bothLegsQualify: boolean;
  annualFloorApplies: boolean;
  cadences: readonly { cadence: number; admitted: boolean; refusal: Hex }[];
}

/** Word one refusal from the revert data creation would raise. Pure. */
export function refusalOf(
  data: Hex,
  cadence: number,
  durationDays: number,
): CadenceRefusal {
  if (data === '0x') return { kind: 'unevaluated' };
  let name: string;
  let args: readonly unknown[];
  try {
    const decoded = decodeErrorResult({ abi: DIAMOND_ABI_VIEM, data });
    name = decoded.errorName;
    args = decoded.args ?? [];
  } catch {
    return { kind: 'other' };
  }
  switch (name) {
    case 'PeriodicInterestDisabled':
      return { kind: 'switched-off' };
    case 'CadenceNotAllowedForIlliquid':
      // LiquidityStatus: 0 = Liquid, 1 = Illiquid.
      return {
        kind: 'illiquid',
        principalLiquid: Number(args[0]) === 0,
        collateralLiquid: Number(args[1]) === 0,
      };
    case 'CadenceNotAllowed': {
      // One error carries three refusals; its own arguments say which.
      // Only the wording is chosen here: the verdict is the contract's.
      const principal = args[2] as bigint;
      const threshold = args[3] as bigint;
      const multiYear = durationDays > 365;
      if (multiYear && cadence === CADENCE_NONE) return { kind: 'yearly-floor' };
      const belowThreshold = principal < threshold;
      if (belowThreshold && (!multiYear || cadence !== 4)) {
        return { kind: 'below-threshold', principalNumeraire: principal, threshold };
      }
      const intervalDays = INTERVAL_DAYS[cadence];
      return intervalDays === undefined ? { kind: 'other' } : { kind: 'interval', intervalDays };
    }
    default:
      return { kind: 'other' };
  }
}

/** Decode the preview. Pure, so the decoding is tested without a chain. */
export function decodeCadencePreview(
  raw: RawPreview,
  durationDays: number,
  numeraireWord: string | null,
): CadencePreview {
  return {
    periodicInterestEnabled: raw.periodicInterestEnabled,
    bothLegsQualify: raw.bothLegsQualify,
    annualFloorApplies: raw.annualFloorApplies,
    cadences: raw.cadences.map((c) => ({
      cadence: Number(c.cadence),
      admitted: c.admitted,
      refusal: c.admitted ? null : refusalOf(c.refusal, Number(c.cadence), durationDays),
    })),
    numeraire: numeraireWord === null ? null : numeraireOf(numeraireWord),
  };
}

/** Whether `cadence` may be posted on what the form knows. Admitted only
 *  on a known verdict that admits it. With no verdict (checking, failed,
 *  or a Diamond without the preview), only "once, at repayment" passes,
 *  which is what every offer carried before the picker; creation still
 *  refuses it where the yearly floor binds, and the review's simulation
 *  says so. */
export function cadenceAllowed(admission: CadenceAdmission, cadence: number): boolean {
  if (admission.kind === 'known') {
    return admission.preview.cadences.some((c) => c.cadence === cadence && c.admitted);
  }
  return cadence === CADENCE_NONE;
}

/**
 * Read the preview for `terms`, or stay idle while they are incomplete
 * (`null`). Each change to the terms is a new read; the cadence is not
 * part of them, so choosing one costs no read.
 */
export function useCadenceAdmission(terms: CadenceTerms | null): {
  admission: CadenceAdmission;
  retry: () => void;
} {
  const { readChain } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });
  const query = useQuery({
    queryKey: [
      'cadenceAdmission',
      readChain.chainId,
      terms?.lendingAsset.toLowerCase(),
      terms?.amount.toString(),
      terms?.assetType,
      terms?.collateralAsset.toLowerCase(),
      terms?.collateralAssetType,
      terms?.durationDays,
    ],
    enabled: terms !== null && Boolean(readClient),
    staleTime: 15_000,
    refetchInterval: idleAware(30_000),
    queryFn: async () => {
      const t = terms!;
      const [raw, word] = await Promise.all([
        readClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'previewCadenceAdmission',
          args: [
            t.lendingAsset,
            t.amount,
            t.assetType,
            t.collateralAsset,
            t.collateralAssetType,
            BigInt(t.durationDays),
          ],
        }) as Promise<RawPreview>,
        // The unit only names the threshold; failing to read it costs the
        // name, never the verdict.
        (
          readClient!.readContract({
            address: readChain.diamondAddress,
            abi: DIAMOND_ABI_VIEM,
            functionName: 'getNumeraireSymbol',
          }) as Promise<string>
        ).catch(() => null),
      ]);
      return decodeCadencePreview(raw, t.durationDays, word);
    },
    // A missing selector will not appear on a retry.
    retry: (failures, err) => !isMissingSelectorError(err) && failures < 2,
  });
  return { admission: admissionOf(terms, query), retry: () => void query.refetch() };
}

/** The query's state as the form reads it. Exported for the tests. */
export function admissionOf(
  terms: CadenceTerms | null,
  q: { data: CadencePreview | undefined; error: unknown; isError: boolean },
): CadenceAdmission {
  if (terms === null) return { kind: 'idle' };
  // An answer counts only while the latest fetch succeeded: a cached
  // admission outliving a failed refresh is not a current one.
  if (q.isError) return isMissingSelectorError(q.error) ? { kind: 'unserved' } : { kind: 'failed' };
  if (q.data === undefined) return { kind: 'checking' };
  return { kind: 'known', preview: q.data };
}
