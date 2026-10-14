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

type GraceAnswer = { defaultable: boolean; requestedAt: number };

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
    // The answer carries when its request was SENT, so freshness can be
    // judged by when the chain was asked, not by when the reply landed.
    queryFn: async (): Promise<GraceAnswer> => {
      const requestedAt = Date.now();
      const defaultable = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'isLoanDefaultable',
        args: [BigInt(loanId)],
      })) as boolean;
      return { defaultable, requestedAt };
    },
  });
}

/** What a row may say about grace right now. `verdict` is set ONLY when the
 *  chain's answer is current; otherwise `read` says why it is not. */
export type GraceVerdict =
  | { read: 'current'; verdict: boolean }
  | { read: 'checking' | 'unavailable'; verdict: undefined };

/**
 * The single rule for when a cached answer may be shown (#2475 r2/r8/r9/
 * r10/r11 each found another way a stale answer outlived its moment, first
 * through TanStack's status flags, then through reply timing). The rule is
 * about the REQUEST: an answer is current only if the chain was asked after
 * the device last (re)gained connectivity (`connectedSince`, +Infinity
 * while offline), and the latest read did not fail or pause. A reply that
 * lands after a reconnect but was requested before it does not count; only
 * a read sent from the current connected session does.
 */
export function graceVerdictFrom(q: {
  answer: { defaultable: boolean; requestedAt: number } | undefined;
  isError: boolean;
  isPaused: boolean;
  connectedSince: number;
}): GraceVerdict {
  if (q.isError || q.isPaused || q.connectedSince === Number.POSITIVE_INFINITY) {
    return { read: 'unavailable', verdict: undefined };
  }
  if (q.answer === undefined || q.answer.requestedAt < q.connectedSince) {
    // Not asked yet in this connected session: a read is in flight or due.
    return { read: 'checking', verdict: undefined };
  }
  return { read: 'current', verdict: q.answer.defaultable };
}

// When connectivity was last REGAINED (0 = never lost in this session).
// Tracked directly: TanStack marks a query paused only when its next fetch
// starts, and clears that the moment it is back online, before the re-read
// lands.
let lastReconnectAt = 0;
let wasOnline = onlineManager.isOnline();
onlineManager.subscribe((online) => {
  if (online && !wasOnline) lastReconnectAt = Date.now();
  wasOnline = online;
});
function subscribeConnectivity(cb: () => void) {
  return onlineManager.subscribe(cb);
}
function connectedSince() {
  return onlineManager.isOnline() ? lastReconnectAt : Number.POSITIVE_INFINITY;
}

export function useLoanPastGrace(loanId: number, enabled: boolean): GraceVerdict {
  const q = useLoanPastGraceQuery(loanId, enabled);
  const since = useSyncExternalStore(subscribeConnectivity, connectedSince, connectedSince);
  return graceVerdictFrom({
    answer: q.data,
    isError: q.isError,
    isPaused: q.isPaused,
    connectedSince: since,
  });
}
