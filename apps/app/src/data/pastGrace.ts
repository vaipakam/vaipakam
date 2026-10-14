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
 * The single rule for when a cached answer may still be shown (#2475
 * r2/r8/r9 — each round found another way a stale `data` outlived the
 * read that produced it, so the rule lives here and nowhere else).
 * TanStack keeps the last `data` through an error, through a paused fetch,
 * and while the browser is offline with no fetch yet attempted; in every
 * one of those the protocol's current answer is not in hand, and governance
 * may have changed the grace schedule meanwhile.
 */
export function graceVerdictFrom(q: {
  data: boolean | undefined;
  isError: boolean;
  isPaused: boolean;
  online: boolean;
}): GraceVerdict {
  if (q.isError || q.isPaused || !q.online) return { read: 'unavailable', verdict: undefined };
  if (q.data === undefined) return { read: 'checking', verdict: undefined };
  return { read: 'current', verdict: q.data };
}

function subscribeOnline(cb: () => void) {
  return onlineManager.subscribe(cb);
}
function isOnline() {
  return onlineManager.isOnline();
}

export function useLoanPastGrace(loanId: number, enabled: boolean): GraceVerdict {
  const q = useLoanPastGraceQuery(loanId, enabled);
  // Tracked directly: TanStack only marks a query paused when its NEXT fetch
  // starts, so a cached `true` would otherwise outlive a disconnect until
  // the next interval.
  const online = useSyncExternalStore(subscribeOnline, isOnline, isOnline);
  return graceVerdictFrom({ data: q.data, isError: q.isError, isPaused: q.isPaused, online });
}
