/**
 * Live protocol fee reads — the review receipts users sign against
 * must quote the DEPLOYED fee values, not compile-time defaults
 * (ConfigFacet.setFeesConfig can retune both). Falls back to the
 * deploy defaults only while the read is in flight; the `ready` flag
 * lets money-critical surfaces distinguish live from fallback.
 *
 * The loan initiation fee is TERM-SCALED (#3649): its rate depends on the
 * agreed term, under four settings read from
 * `FeeLevelsFacet.getLoanInitiationFeeTerms` (see `lib/initiationFee`). It
 * has NO deploy-default fallback: until that read returns, `lifTerms` is
 * null and every surface shows the fee as not yet known. One flat default
 * rate could only be right for the shortest terms.
 *
 * The other values are read from the configuration bundle BY NAME
 * (`treasuryFeeBps`, `maxOfferDurationDays`), from
 * the snapshot's labelled values or through the shared bundle reader. They
 * were read by tuple position until #2812, which took two flags out of the
 * middle of the bundle and moved `maxOfferDurationDays` from position 14 to
 * 12.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { useActiveChain } from '../chain/useActiveChain';
import { fetchFreshConfigValues } from './indexer';
import { bundleInteger, readConfigBundleLive } from './protocol';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import type { LifTerms } from '../lib/initiationFee';

const TREASURY_FEE_BPS_DEFAULT = 500; // 5% of interest (#3649 fee levels; 2% under the #1352 freeze)
const MAX_OFFER_DURATION_DAYS_DEFAULT = 365; // deploy default; tunable [7d, 5y]

export interface ProtocolFees {
  /** Yield fee on lender interest, bps. */
  treasuryFeeBps: number;
  /** The borrower loan-initiation fee's term rule (#3649), or null until
   *  it is read — never a guessed default. */
  lifTerms: LifTerms | null;
  /** Live createOffer duration cap in days — offers above it revert
   *  OfferDurationExceedsCap, so duration pickers must respect it. */
  maxOfferDurationDays: number;
  /** True once the values are live-read (not defaults), the initiation
   *  fee's terms included. */
  ready: boolean;
}

export function useProtocolFees(): ProtocolFees {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['protocolFees', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // RPC read-diet PR B (design §4.2.1) — DISPLAY reads come from
      // the indexer's config snapshot first (zero per-user RPC; the
      // indexer refreshes it on config events + a slow backstop) and
      // fall back to the live chain read when the snapshot is absent,
      // stale, or the indexer is down. Submit paths never come here —
      // readLiveProtocolFees below stays chain-only (L51–52).
      // The initiation fee's term settings are not in the snapshot, so
      // they are one chain read either way.
      const snap = await fetchFreshConfigValues(readChain.chainId);
      if (snap) {
        try {
          const base = feesFrom(snap);
          return {
            ...base,
            lifTerms: await readLifTerms(publicClient!, readChain.diamondAddress),
          };
        } catch {
          // A snapshot missing a value, or the terms read failing: the
          // whole chain read below.
        }
      }
      return readLiveProtocolFees(publicClient!, readChain.diamondAddress);
    },
  });

  return {
    treasuryFeeBps: data?.treasuryFeeBps ?? TREASURY_FEE_BPS_DEFAULT,
    lifTerms: data?.lifTerms ?? null,
    maxOfferDurationDays:
      data?.maxOfferDurationDays ?? MAX_OFFER_DURATION_DAYS_DEFAULT,
    ready: data !== undefined,
  };
}

/** Direct LIVE read for submit paths — the hook above caches for five
 *  minutes, which is fine for display but not for the moment of
 *  signing/approving: governance can retune fees or lower the duration
 *  cap inside that window. Throws on read failure (fail closed). */
export async function readLiveProtocolFees(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<LiveProtocolFees> {
  const [values, lifTerms] = await Promise.all([
    readConfigBundleLive(publicClient, diamondAddress),
    readLifTerms(publicClient, diamondAddress),
  ]);
  return { ...feesFrom(values), lifTerms };
}

/** What a live read returns: every value present, the terms included. */
export type LiveProtocolFees = Pick<ProtocolFees, 'treasuryFeeBps' | 'maxOfferDurationDays'> & {
  lifTerms: LifTerms;
};

/** The initiation fee's four settings in force (defaults resolved by the
 *  contract). Throws on read failure (fail closed). */
export async function readLifTerms(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<LifTerms> {
  const out = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanInitiationFeeTerms',
  })) as readonly [bigint, bigint, bigint, bigint];
  return {
    baseBps: Number(out[0]),
    baseTermDays: Number(out[1]),
    yearlyBps: Number(out[2]),
    yearDays: Number(out[3]),
  };
}

/** The bundle's fee fields from named values; throws when any is absent or
 *  not an integer, so neither source can substitute a guess. */
function feesFrom(
  values: object,
): Pick<ProtocolFees, 'treasuryFeeBps' | 'maxOfferDurationDays'> {
  return {
    treasuryFeeBps: bundleInteger(values, 'treasuryFeeBps'),
    maxOfferDurationDays: bundleInteger(values, 'maxOfferDurationDays'),
  };
}
