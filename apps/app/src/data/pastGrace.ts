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
import { useState, useSyncExternalStore } from 'react';
import { focusManager, onlineManager, useQuery } from '@tanstack/react-query';
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
    // The verdict is withheld after a refocus, reconnect or remount until a
    // read sent after it lands (see `graceVerdictFrom`), so this query opts
    // back into the revalidation the app turns off globally; one read per
    // mounted open row (rows are windowed).
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchOnMount: true,
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
 * The single rule for when a cached answer may be shown. Review rounds r2,
 * r8, r9, r10 and r11 on #2475 each found another way a stale answer
 * outlived its moment: an error, a paused fetch, a disconnect, a reconnect,
 * a late reply, a remount. They share one cause, so they share one rule,
 * about the REQUEST: an answer is current only if the chain was asked after
 * the row's current observation began (`validSince`): the later of when
 * this row mounted and when the device last regained connectivity or
 * focus. TanStack serves cached `data` at each of those moments while it
 * revalidates, and governance may have changed the grace schedule in
 * between. +Infinity means offline, and an errored or paused latest read is
 * unavailable whatever it last returned.
 */
export function graceVerdictFrom(q: {
  answer: { defaultable: boolean; requestedAt: number } | undefined;
  isError: boolean;
  isPaused: boolean;
  validSince: number;
}): GraceVerdict {
  if (q.isError || q.isPaused || q.validSince === Number.POSITIVE_INFINITY) {
    return { read: 'unavailable', verdict: undefined };
  }
  if (q.answer === undefined || q.answer.requestedAt < q.validSince) {
    // Not asked yet in this observation: the revalidating read is in
    // flight or due (stale-on-mount / on-focus / on-reconnect refetch).
    return { read: 'checking', verdict: undefined };
  }
  return { read: 'current', verdict: q.answer.defaultable };
}

// When the device last RESUMED: regained connectivity or window focus
// (0 = neither lost in this session). Tracked directly, because TanStack
// keeps showing cached `data` through both transitions until its
// revalidating read lands.
let lastResumeAt = 0;
let wasOnline = onlineManager.isOnline();
let wasFocused = focusManager.isFocused();
onlineManager.subscribe((online) => {
  if (online && !wasOnline) lastResumeAt = Date.now();
  wasOnline = online;
});
focusManager.subscribe((focused) => {
  if (focused && !wasFocused) lastResumeAt = Date.now();
  wasFocused = focused;
});
function subscribeResume(cb: () => void) {
  const offOnline = onlineManager.subscribe(cb);
  const offFocus = focusManager.subscribe(cb);
  return () => {
    offOnline();
    offFocus();
  };
}
function resumedSince() {
  return onlineManager.isOnline() ? lastResumeAt : Number.POSITIVE_INFINITY;
}

export function useLoanPastGrace(loanId: number, enabled: boolean): GraceVerdict {
  const q = useLoanPastGraceQuery(loanId, enabled);
  const [mountedAt] = useState(() => Date.now());
  const resumed = useSyncExternalStore(subscribeResume, resumedSince, resumedSince);
  return graceVerdictFrom({
    answer: q.data,
    isError: q.isError,
    isPaused: q.isPaused,
    validSince: Math.max(mountedAt, resumed),
  });
}
