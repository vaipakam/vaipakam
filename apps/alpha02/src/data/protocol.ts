/**
 * Live protocol config reads. Copy that quotes a fee/buffer must use
 * these, never a hardcoded number — governance can retune them.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import type { PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { fetchProtocolConfig, protocolConfigFresh } from './indexer';
import { readGraceSecondsLive } from '../contracts/preflights';
import { defaultGraceSeconds, formatGraceSeconds } from '../lib/grace';

/** Deploy default (5%) — display fallback only. Money paths must use
 *  {@link readRentalBufferBps} or gate on `ready`. */
const RENTAL_BUFFER_BPS_DEFAULT = 500;

/** Direct read of the LIVE buffer — for submit paths. Throws on read
 *  failure instead of substituting a default: an under-read buffer
 *  under-approves the renter's prepay and the accept reverts AFTER the
 *  user signed (governance can raise the buffer to 2,000 bps). */
export async function readRentalBufferBps(
  publicClient: PublicClient,
  diamondAddress: `0x${string}`,
): Promise<number> {
  const bundle = (await publicClient.readContract({
    address: diamondAddress,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getProtocolConfigBundle',
  })) as readonly unknown[];
  return Number(bundle[6] as bigint);
}

/** NFT-rental prepay buffer in bps (tuple index 6 of
 *  `getProtocolConfigBundle` — see apps/defi useProtocolConfig's
 *  BundleTuple). `ready` is false while the value is still the
 *  fallback — display may proceed, signing must not. */
export function useRentalBufferBps(): { bps: number; ready: boolean } {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });

  const { data } = useQuery({
    queryKey: ['rentalBufferBps', readChain.chainId],
    enabled: Boolean(publicClient),
    staleTime: 5 * 60_000,
    // RPC read-diet PR B — display from the indexer snapshot (bundle
    // index 6), chain fallback; submit paths use readRentalBufferBps
    // directly and never come here.
    queryFn: async () => {
      const snap = await fetchProtocolConfig(readChain.chainId);
      if (snap && protocolConfigFresh(snap.updatedAt)) {
        return Number(snap.bundle[6]);
      }
      return readRentalBufferBps(publicClient!, readChain.diamondAddress);
    },
  });

  return { bps: data ?? RENTAL_BUFFER_BPS_DEFAULT, ready: data !== undefined };
}

/** LIVE grace label for receipts — governance can override the
 *  default schedule with buckets, and the shown grace must match the
 *  window repayment is actually judged against. The label falls back
 *  to the default-schedule wording while loading (identical on
 *  deploys with no buckets configured) so DISPLAY can proceed, but
 *  `ready` stays false until the live bucket answer lands — SIGNING
 *  must gate on it, exactly like {@link useRentalBufferBps}: on a
 *  chain with retuned buckets the fallback label is a wrong term. */
export function useGraceLabel(durationDays: number): {
  label: string;
  ready: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data, isError, refetch } = useQuery({
    queryKey: ['graceSeconds', readChain.chainId, durationDays],
    enabled: Boolean(publicClient) && durationDays > 0,
    staleTime: 5 * 60_000,
    queryFn: () =>
      readGraceSecondsLive({
        publicClient: publicClient!,
        diamondAddress: readChain.diamondAddress,
        durationDays,
      }),
  });
  return {
    label: formatGraceSeconds(data ?? defaultGraceSeconds(durationDays)),
    ready: data !== undefined,
    isError,
    refetch: () => void refetch(),
  };
}

/** The protocol's range/partial-fill master flags
 *  (`ConfigFacet.getMasterFlags`) — governance kill switches for the
 *  range-order machinery. `partialFill` gates `matchOffers` at runtime,
 *  so the desk's crossable-band surface (#1131 slice B) must key on it:
 *  a band whose Execute action the contract refuses is a lie. */
export interface MasterFlags {
  rangeAmount: boolean;
  rangeRate: boolean;
  partialFill: boolean;
}

/** Long-staleTime read of the master flags. `data === undefined` covers
 *  loading AND read failure — consumers of the ADVISORY surfaces treat
 *  that as "flags unknown → show nothing" (fail closed: rendering a
 *  matchable band while the kill switch might be OFF is worse than
 *  briefly hiding a real one). */
export function useMasterFlags(): { data: MasterFlags | undefined } {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { data } = useQuery({
    queryKey: ['masterFlags', readChain.chainId],
    enabled: Boolean(publicClient),
    // Governance kill-switch — flips rarely; 10 min bounds the window a
    // just-flipped switch keeps the band visible (the Execute write
    // would revert harmlessly inside it).
    staleTime: 10 * 60_000,
    // RPC read-diet PR B — snapshot-first: a governance flip emits a
    // config event, so the snapshot updates within ~one ingest scan —
    // typically FRESHER than this hook's own 10-min staleTime window.
    // The crossable band's execute path still live-checks before the
    // write, so the advisory surface never turns a stale flag into a
    // doomed transaction.
    queryFn: async (): Promise<MasterFlags> => {
      const snap = await fetchProtocolConfig(readChain.chainId);
      if (
        snap &&
        protocolConfigFresh(snap.updatedAt) &&
        snap.masterFlags.length >= 3
      ) {
        return {
          rangeAmount: Boolean(snap.masterFlags[0]),
          rangeRate: Boolean(snap.masterFlags[1]),
          partialFill: Boolean(snap.masterFlags[2]),
        };
      }
      const [rangeAmount, rangeRate, partialFill] =
        (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getMasterFlags',
        })) as readonly [boolean, boolean, boolean];
      return { rangeAmount, rangeRate, partialFill };
    },
  });
  return { data };
}

/** Renter's total up-front payment for a rental:
 *  dailyFee × days, plus the refundable buffer. Mirrors OfferFacet's
 *  pull (`amount * durationDays * (BPS + buffer) / BPS`). */
export function totalRentalPrepay(
  dailyFeeWei: bigint,
  durationDays: number,
  bufferBps: number,
): bigint {
  const base = dailyFeeWei * BigInt(durationDays);
  return (base * (10_000n + BigInt(bufferBps))) / 10_000n;
}
