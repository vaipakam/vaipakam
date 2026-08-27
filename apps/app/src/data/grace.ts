/**
 * UX-004 — the loan's grace window, surfaced to the UI. The window was
 * previously read only at repay-submit time, so a past-due borrower
 * could never see how long they had before liquidation became
 * possible. Grace buckets are governance config that rarely changes —
 * but this value feeds the grace-expired ACTION gate (not just copy),
 * so the cache is kept to minutes: a governance change during an
 * incident must not gate a borrower on an hour-old bucket (Codex
 * #1166 r4).
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { readGraceSecondsLive } from '../contracts/preflights';
import { idleAware } from '../lib/idle';

export function useGraceSeconds(durationDays: number | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['graceSeconds', readChain.chainId, durationDays],
    enabled: durationDays !== undefined && Boolean(publicClient),
    staleTime: 5 * 60 * 1000,
    refetchInterval: idleAware(10 * 60 * 1000),
    queryFn: () =>
      readGraceSecondsLive({
        publicClient: publicClient!,
        diamondAddress: readChain.diamondAddress,
        durationDays: durationDays!,
      }),
  });
}

/** "2d 4h" / "5h 12m" / "under a minute" — for grace countdowns. */
export function formatRemaining(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
