/**
 * Live protocol fee reads — the review receipts users sign against
 * must quote the DEPLOYED fee values, not compile-time defaults
 * (ConfigFacet.setFeesConfig can retune both). Falls back to the
 * deploy defaults only while the read is in flight; the `ready` flag
 * lets money-critical surfaces distinguish live from fallback.
 *
 * Every value is read from the configuration bundle BY NAME
 * (`treasuryFeeBps`, `loanInitiationFeeBps`, `maxOfferDurationDays`), from
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

const TREASURY_FEE_BPS_DEFAULT = 200; // 2% of interest (#1352 fee freeze)
const LIF_BPS_DEFAULT = 20; // 0.2% of principal (#1352 fee freeze)
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
      const snap = await fetchFreshConfigValues(readChain.chainId);
      if (snap) {
        try {
          return feesFrom(snap);
        } catch {
          // A snapshot missing one of the three: the chain read below.
        }
      }
      return readLiveProtocolFees(publicClient!, readChain.diamondAddress);
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

/** Direct LIVE read for submit paths — the hook above caches for five
 *  minutes, which is fine for display but not for the moment of
 *  signing/approving: governance can retune fees or lower the duration
 *  cap inside that window. Throws on read failure (fail closed). */
export async function readLiveProtocolFees(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<Pick<ProtocolFees, 'treasuryFeeBps' | 'loanInitiationFeeBps' | 'maxOfferDurationDays'>> {
  return feesFrom(await readConfigBundleLive(publicClient, diamondAddress));
}

/** The three fee fields from named bundle values; throws when any is absent
 *  or not an integer, so neither source can substitute a guess. */
function feesFrom(
  values: object,
): Pick<ProtocolFees, 'treasuryFeeBps' | 'loanInitiationFeeBps' | 'maxOfferDurationDays'> {
  return {
    treasuryFeeBps: bundleInteger(values, 'treasuryFeeBps'),
    loanInitiationFeeBps: bundleInteger(values, 'loanInitiationFeeBps'),
    maxOfferDurationDays: bundleInteger(values, 'maxOfferDurationDays'),
  };
}
