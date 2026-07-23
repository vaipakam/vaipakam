/**
 * Full VPFI fee-entitlement tariff reads (#1355 / M2 PR-8).
 *
 * Three read surfaces back the Full opt-in UI:
 *  - `useFeeEntitlementConfig` — the kill-switch + live tariff constants.
 *    The whole opt-in surface renders ONLY while `enabled` is true: with
 *    the flag off a presented Full authorization is a FAILED opt-in on
 *    chain (revert unless that party pre-allowed a downgrade), so
 *    showing the control while dark could only produce reverts or
 *    silent downgrades the user never wanted.
 *  - `useCStarQuote` — the live notional `C*` for a prospective loan.
 *    `numeraireOk === false` means the list LIF can't be priced; a Full
 *    opt-in on such a loan fails on chain, so the UI must disable the
 *    opt-in rather than let the user sign one.
 *  - `useFeeEntitlement` — a settled loan's stamped record (per-party
 *    modes + absorbed tariffs) for the Loan Details display. A loan
 *    that never touched the tariff/discount path is UNSTAMPED, which
 *    the contract identifies by `openDays == 0` (the stamp always
 *    writes `openDays >= 1`) — never by `cStarOpen == 0`, which is a
 *    legitimate stamped value for a reward-ineligible loan.
 *
 * The quote is display-tier: the value the chain charges at fill is
 * re-derived there, and the signed `maxCStar` ceiling — not this quote
 * — is what bounds the pull from the user's vault.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { Address } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { signalAware } from '../chain/railHealth';

/** Mirrors `LibVaipakam.FeeEntitlementMode`. */
export const FEE_MODE_NONE = 0;
export const FEE_MODE_HOLD_ONLY = 1;
export const FEE_MODE_FULL = 2;

export interface FeeEntitlementConfig {
  enabled: boolean;
  kPerLifYear: bigint;
  rewardHaircutBps: number;
  /** True once the values are live-read (not the dark default). */
  ready: boolean;
}

/**
 * The Full-tariff kill-switch + constants. Defaults to DISABLED while
 * the read is in flight or failing — the safe side: the opt-in surface
 * stays hidden rather than inviting an authorization the chain would
 * reject.
 */
export function useFeeEntitlementConfig(): FeeEntitlementConfig {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['feeEntitlementConfig', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [enabled, kPerLifYear, rewardHaircutBps] =
        (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getFeeEntitlementConfig',
        })) as readonly [boolean, bigint, bigint];
      return {
        enabled,
        kPerLifYear,
        rewardHaircutBps: Number(rewardHaircutBps),
      };
    },
  });

  return {
    enabled: data?.enabled ?? false,
    kPerLifYear: data?.kPerLifYear ?? 0n,
    rewardHaircutBps: data?.rewardHaircutBps ?? 0,
    ready: data !== undefined,
  };
}

export interface CStarQuote {
  /** Notional tariff per Full party, VPFI wei (18-dec). */
  cStar: bigint;
  /** False ⇒ the list LIF can't be priced — Full would fail on chain. */
  numeraireOk: boolean;
}

/**
 * Live `C*` quote for a prospective loan. Refetches on the shared
 * signal-aware cadence so the figure tracks oracle moves while the
 * review screen is open; the signed `maxCStar` ceiling protects the
 * user against moves between the last quote and the fill.
 */
export function useCStarQuote(input: {
  lendingAsset: Address | undefined;
  principal: bigint | undefined;
  durationDays: number | undefined;
  /** Gate the read off entirely (e.g. while the feature is dark). */
  enabled?: boolean;
}) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const on =
    (input.enabled ?? true) &&
    Boolean(publicClient) &&
    Boolean(input.lendingAsset) &&
    input.principal !== undefined &&
    input.principal > 0n &&
    input.durationDays !== undefined &&
    input.durationDays > 0;

  return useQuery({
    queryKey: [
      'cStarQuote',
      readChain.chainId,
      input.lendingAsset?.toLowerCase(),
      input.principal?.toString(),
      input.durationDays,
    ],
    enabled: on,
    refetchInterval: signalAware(30_000),
    queryFn: async (): Promise<CStarQuote> => {
      const [cStar, numeraireOk] = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'quoteCStar',
        args: [input.lendingAsset!, input.principal!, BigInt(input.durationDays!)],
      })) as readonly [bigint, boolean];
      return { cStar, numeraireOk };
    },
  });
}

export interface FeeEntitlementRecord {
  borrowerMode: number;
  lenderMode: number;
  openDays: number;
  borrowerTariffPaid: bigint;
  lenderTariffPaid: bigint;
  cStarOpen: bigint;
  /** True iff the loan carries a stamp at all (`openDays >= 1`). */
  stamped: boolean;
}

/** A loan's stamped fee-entitlement record (Loan Details display). */
export function useFeeEntitlement(loanId: number | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['feeEntitlement', readChain.chainId, loanId],
    enabled: Boolean(publicClient) && loanId !== undefined,
    staleTime: 60_000,
    queryFn: async (): Promise<FeeEntitlementRecord> => {
      const fe = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getFeeEntitlement',
        args: [BigInt(loanId!)],
      })) as {
        borrowerMode: number;
        lenderMode: number;
        openDays: number;
        borrowerTariffPaid: bigint;
        lenderTariffPaid: bigint;
        cStarOpen: bigint;
      };
      return {
        borrowerMode: Number(fe.borrowerMode),
        lenderMode: Number(fe.lenderMode),
        openDays: Number(fe.openDays),
        borrowerTariffPaid: fe.borrowerTariffPaid,
        lenderTariffPaid: fe.lenderTariffPaid,
        cStarOpen: fe.cStarOpen,
        stamped: Number(fe.openDays) >= 1,
      };
    },
  });
}
