/**
 * Live protocol fee reads — the review receipts users sign against
 * must quote the DEPLOYED fee values, not compile-time defaults
 * (ConfigFacet.setFeesConfig can retune both). Falls back to the
 * deploy defaults only while the read is in flight; the `ready` flag
 * lets money-critical surfaces distinguish live from fallback.
 *
 * Bundle tuple indices per apps/defi useProtocolConfig BundleTuple:
 * [0] treasuryFeeBps (yield fee), [1] loanInitiationFeeBps,
 * [14] maxOfferDurationDays (createOffer rejects longer terms).
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { fetchProtocolConfig, protocolConfigFresh } from './indexer';

const TREASURY_FEE_BPS_DEFAULT = 100; // 1% of interest
const LIF_BPS_DEFAULT = 10; // 0.1% of principal
const MAX_OFFER_DURATION_DAYS_DEFAULT = 365; // deploy default; tunable [7d, 5y]

export interface ProtocolFees {
  /** Yield fee on lender interest, bps. */
  treasuryFeeBps: number;
  /** Borrower loan-initiation fee, bps. */
  loanInitiationFeeBps: number;
  /** Live createOffer duration cap in days — offers above it revert
   *  OfferDurationExceedsCap, so duration pickers must respect it. */
  maxOfferDurationDays: number;
  /** True once the values are live-read (not defaults). */
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
      const snap = await fetchProtocolConfig(readChain.chainId);
      if (snap && protocolConfigFresh(snap.updatedAt)) {
        return {
          treasuryFeeBps: Number(snap.bundle[0]),
          loanInitiationFeeBps: Number(snap.bundle[1]),
          maxOfferDurationDays: Number(snap.bundle[14]),
        };
      }
      const bundle = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getProtocolConfigBundle',
      })) as readonly unknown[];
      return {
        treasuryFeeBps: Number(bundle[0] as bigint),
        loanInitiationFeeBps: Number(bundle[1] as bigint),
        maxOfferDurationDays: Number(bundle[14] as bigint),
      };
    },
  });

  return {
    treasuryFeeBps: data?.treasuryFeeBps ?? TREASURY_FEE_BPS_DEFAULT,
    loanInitiationFeeBps: data?.loanInitiationFeeBps ?? LIF_BPS_DEFAULT,
    maxOfferDurationDays:
      data?.maxOfferDurationDays ?? MAX_OFFER_DURATION_DAYS_DEFAULT,
    ready: data !== undefined,
  };
}

export function bpsToPercentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** Direct LIVE read for submit paths — the hook above caches for five
 *  minutes, which is fine for display but not for the moment of
 *  signing/approving: governance can retune fees or lower the duration
 *  cap inside that window. Throws on read failure (fail closed). */
export async function readLiveProtocolFees(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<Pick<ProtocolFees, 'treasuryFeeBps' | 'loanInitiationFeeBps' | 'maxOfferDurationDays'>> {
  const bundle = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getProtocolConfigBundle',
  })) as readonly unknown[];
  return {
    treasuryFeeBps: Number(bundle[0] as bigint),
    loanInitiationFeeBps: Number(bundle[1] as bigint),
    maxOfferDurationDays: Number(bundle[14] as bigint),
  };
}
