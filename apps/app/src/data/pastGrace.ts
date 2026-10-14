/**
 * Whether a loan's grace period has ended, on the chain's word (#2463
 * follow-up). `DefaultedFacet.isLoanDefaultable(loanId)` is the same read
 * the forced-close card gates on; the grace length behind it is
 * governance-configurable, so no client-side clock can stand in for it.
 *
 * Read for every open loan row (rows are windowed, so a list costs one
 * read per visible open position), and not only for rows this device's
 * clock calls overdue: the contract uses the chain's clock. A failed or
 * pending read is an ERROR, never `false`: the row then keeps its
 * time-based badge (by this device's clock), rather than asserting either
 * way what the chain has not said.
 *
 * What a `true` establishes is TIME eligibility only. `triggerDefault` can
 * still refuse for reasons this read does not see (a pause, a sequencer
 * outage, a KYC gate), so copy built on it says the close-out "may" be
 * possible and defers to the position page.
 */
import { useSyncExternalStore } from 'react';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware } from '../lib/idle';

function useLoanPastGraceQuery(loanId: number, enabled: boolean) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  return useQuery({
    queryKey: ['loanPastGrace', readChain.chainId, loanId],
    enabled: enabled && Boolean(publicClient),
    // Polled in BOTH states. A `true` is not final: governance can lengthen
    // the grace schedule (`setGraceBuckets` / `clearGraceBuckets`), which
    // re-derives an open loan's deadline and can reopen ordinary repayment.
    // A minute is fine-grained enough for a list badge, stretched once the
    // session goes idle so an unattended Positions tab does not keep every
    // mounted row reading forever.
    refetchInterval: idleAware(60_000),
    queryFn: () =>
      publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isLoanDefaultable',
        args: [BigInt(loanId)],
      }) as Promise<boolean>,
  });
}

/** What a row may say about grace right now. `verdict` is set ONLY when the
 *  chain's answer is current; otherwise `read` says why it is not. */
export type GraceVerdict =
  | { read: 'current'; verdict: boolean }
  | { read: 'checking' | 'unavailable'; verdict: undefined };

/**
 * The single rule for when a cached answer may be shown (#2475 r2/r8/r9/r10
 * each found another way a stale `data` outlived the read behind it, by
 * reasoning about TanStack's status flags). The rule is now about the
 * ANSWER, not the flags: it is current only if it was fetched after the
 * most recent loss of connectivity (`connectedSince`, +Infinity while
 * offline) and the latest read did not fail or pause. So a disconnect
 * drops a cached answer at once, and a reconnect does not restore it; only
 * a read that completes after reconnecting does.
 */
export function graceVerdictFrom(q: {
  data: boolean | undefined;
  dataUpdatedAt: number;
  isError: boolean;
  isPaused: boolean;
  connectedSince: number;
}): GraceVerdict {
  if (q.isError || q.isPaused || q.connectedSince === Number.POSITIVE_INFINITY) {
    return { read: 'unavailable', verdict: undefined };
  }
  if (q.data === undefined) return { read: 'checking', verdict: undefined };
  // Answered before the last disconnect: not current, and a fresh read is
  // in flight or due, so the honest state is "checking".
  if (q.dataUpdatedAt <= q.connectedSince) return { read: 'checking', verdict: undefined };
  return { read: 'current', verdict: q.data };
}

// When connectivity was last lost (0 = never in this session). Tracked
// directly: TanStack only marks a query paused when its NEXT fetch starts,
// and clears that the moment it is back online, before the re-read lands.
let lastOfflineAt = 0;
onlineManager.subscribe((online) => {
  if (!online) lastOfflineAt = Date.now();
});
function subscribeConnectivity(cb: () => void) {
  return onlineManager.subscribe(cb);
}
function connectedSince() {
  return onlineManager.isOnline() ? lastOfflineAt : Number.POSITIVE_INFINITY;
}

export function useLoanPastGrace(loanId: number, enabled: boolean): GraceVerdict {
  const q = useLoanPastGraceQuery(loanId, enabled);
  const since = useSyncExternalStore(subscribeConnectivity, connectedSince, connectedSince);
  return graceVerdictFrom({
    data: q.data,
    dataUpdatedAt: q.dataUpdatedAt,
    isError: q.isError,
    isPaused: q.isPaused,
    connectedSince: since,
  });
}
