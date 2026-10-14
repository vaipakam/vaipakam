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
import { focusManager, onlineManager, useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { idleAware, onActivityResume } from '../lib/idle';

/** What a row may say about grace right now. `verdict` is set ONLY when the
 *  chain's answer is current; otherwise `read` says why it is not. */
export type GraceVerdict =
  | { read: 'current'; verdict: boolean }
  | { read: 'checking' | 'unavailable'; verdict: undefined };

/**
 * Root fix for #2475 review rounds 2 and 8–12. Each round found another
 * moment where a cached answer outlived the session that read it (an
 * error, a pause, a disconnect, a reconnect, a late reply, a remount, an
 * in-flight request reused, a chain switched away and back). They share
 * one cause: the answer lived in a cache whose lifetime was longer than
 * the observation that justified showing it. So the answer no longer
 * outlives that observation:
 *
 * - The query key carries a RESUME EPOCH that advances whenever the device
 *   regains connectivity or focus, or the session resumes from idle. A resume is a new key: no cached data,
 *   no shared in-flight request, a fresh read sent after the resume.
 * - `gcTime: 0` drops a key's answer as soon as nothing observes it, so a
 *   remounted row, or a chain switched away from and back to, starts from
 *   "checking" with a fresh read rather than from a remembered answer.
 *
 * What remains is a plain rule over one live query.
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

// Advances on every regain of connectivity, window focus or activity. Tracked here
// because TanStack would otherwise keep serving the pre-resume answer
// until its revalidating read lands.
let resumeEpoch = 0;
let wasOnline = onlineManager.isOnline();
let wasFocused = focusManager.isFocused();
onlineManager.subscribe((online) => {
  if (online && !wasOnline) resumeEpoch += 1;
  wasOnline = online;
});
focusManager.subscribe((focused) => {
  if (focused && !wasFocused) resumeEpoch += 1;
  wasFocused = focused;
});
// The first interaction after an idle stretch is a resume too: the poll had
// been stretched, so the answer in hand may be minutes old.
onActivityResume(() => {
  resumeEpoch += 1;
});
function subscribeResume(cb: () => void) {
  const offOnline = onlineManager.subscribe(cb);
  const offFocus = focusManager.subscribe(cb);
  const offActivity = onActivityResume(cb);
  return () => {
    offOnline();
    offFocus();
    offActivity();
  };
}
const getResumeEpoch = () => resumeEpoch;
const getOnline = () => onlineManager.isOnline();

export function useLoanPastGrace(loanId: number, enabled: boolean): GraceVerdict {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const epoch = useSyncExternalStore(subscribeResume, getResumeEpoch, getResumeEpoch);
  const online = useSyncExternalStore(subscribeResume, getOnline, getOnline);
  const q = useQuery({
    queryKey: ['loanPastGrace', readChain.chainId, loanId, epoch],
    enabled: enabled && Boolean(publicClient),
    // See the block comment above: an answer lives only as long as the
    // observation that read it.
    gcTime: 0,
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
  return graceVerdictFrom({ data: q.data, isError: q.isError, isPaused: q.isPaused, online });
}
