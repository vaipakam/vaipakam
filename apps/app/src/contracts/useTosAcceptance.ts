/**
 * On-chain Terms-of-Service gating (#1961).
 *
 * Reads whether the connected wallet has accepted the ToS version
 * currently in force, plus that version and its content hash so the
 * acceptance transaction can be anchored to the exact text the user was
 * shown. `accept()` submits `acceptTerms(version, hash)`.
 *
 * WHY THIS EXISTS AT ALL — the frontend gate IS the enforcement. The
 * contracts record acceptance and expose the in-force version, and
 * delegate gating to the client by design: there is no per-action
 * `_assertTosAccepted` at any entry point. So with no gate here,
 * governance activating a ToS version would have no effect on user
 * behaviour whatsoever — a configured legal requirement applying to
 * nobody. That is why every branch below fails CLOSED.
 *
 * PORTED from the retired `apps/defi` hook, with two deliberate changes.
 *
 * 1. `hasAcceptedCurrentTerms(address)` replaces reading the user's
 *    record and comparing it here. The retired hook compared VERSIONS
 *    client-side; the contract compares version AND hash
 *    (`LegalFacet.sol:165`), so a version bump whose content ALSO
 *    changed is caught on both fields rather than the number alone.
 *    Reimplementing a predicate the contract already exposes is how the
 *    client and the chain come to disagree.
 *
 *    Codex review round 1 corrected an overstatement here: I wrote that
 *    a hash rotation at an UNCHANGED version re-prompts. It cannot be
 *    reached — `setCurrentTos` reverts unless `newVersion >
 *    currentTosVersion` (`LegalFacet.sol:140`), so governance cannot
 *    rotate a hash in place. The contract's hash comparison is defence
 *    on the bump path, not a same-version mechanism.
 * 2. Staleness is TanStack Query's, not a hand-rolled sequence counter.
 *    The retired hook carried `reqSeq` (#828 r2) so a read resolving
 *    after the wallet changed could not apply its result to the new
 *    wallet. Keying the query on the address and chain makes that
 *    structural: a superseded query's data is never the active query's
 *    data, so there is no window to get wrong.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from './diamond';
import { isVerdictStale } from './tosGate';

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

export interface TosAcceptanceState {
  /** True iff the wallet may pass the gate: the read SUCCEEDED and said
   *  either that no ToS is in force or that this wallet has accepted the
   *  one that is. Never true from a pending or failed read — see
   *  `readOk`. */
  hasAccepted: boolean;
  /** True once an on-chain read has completed successfully. While false
   *  (first load, or after an error) the gate must not open. */
  readOk: boolean;
  /** In-force ToS version. 0 means no ToS is in force. */
  currentVersion: number;
  /** In-force ToS content hash. */
  currentHash: `0x${string}`;
  /** True while a read is in flight and no successful result is held. */
  loading: boolean;
  /** Last error from a read or from the acceptance transaction. */
  error: string | null;
  /** Submit `acceptTerms` against the version and hash read from chain. */
  accept: () => Promise<void>;
  /** Re-read the on-chain state. */
  reload: () => Promise<void>;
  /** True while an acceptance transaction is in flight. */
  submitting: boolean;
}

export function useTosAcceptance(): TosAcceptanceState {
  const { address, readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const { write } = useDiamondWrite();
  const queryClient = useQueryClient();
  const [writeError, setWriteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A clock the gate can read without calling `Date.now()` during
  // render, which `react-hooks/purity` rightly rejects. Starts at 0 —
  // read as "no age known yet", which cannot make a fresh verdict look
  // stale — and the effect fills it immediately.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // Ticked from the interval only — setting state directly in the
    // effect body is what `react-hooks/set-state-in-effect` forbids, and
    // it is unnecessary here: 0 reads as "no age known yet", and a
    // verdict cannot be too old before the first tick anyway.
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Memoised so the callbacks below can depend on it honestly rather
  // than on the primitives it is built from — a fresh array each render
  // would either churn every callback or need a suppression, and a
  // suppression here is how the cache key and the invalidation key come
  // to disagree.
  const queryKey = useMemo(
    () => ['tosAcceptance', readChain.chainId, address?.toLowerCase() ?? null] as const,
    [readChain.chainId, address],
  );

  const query = useQuery({
    queryKey,
    // No wallet ⇒ nothing to check. The gate passes an unconnected
    // visitor through (the pages handle that state themselves), so the
    // read would be answering a question nobody asked.
    enabled: Boolean(publicClient) && Boolean(address),
    // The gate is a legal control, not a data view: re-read rather than
    // serve a cached verdict across a session in which governance may
    // have installed a new version.
    staleTime: 30_000,
    // Codex review round 1 P1: `staleTime` marks a query stale, it does
    // not refetch. The app disables `refetchOnWindowFocus` globally and
    // this query is not among `LiveChainSync`'s invalidated roots, so a
    // wallet that accepted v1 and left the tab open would have kept its
    // verdict indefinitely after governance installed v2. This gate has
    // to ask again on its own.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Deliberately NOT retried into a false verdict — an error is a
    // closed gate with a retry button the user drives, which is
    // honest about not knowing. `retry: false` keeps that immediate.
    retry: false,
    queryFn: async () => {
      // Codex review round 1 P2: both calls are PINNED to one block.
      // Unpinned, `setCurrentTos` landing between them returns
      // `hasAcceptedCurrentTerms: true` for the old version alongside
      // the NEW version and hash — a combination that opens the gate on
      // terms the wallet never accepted, and displays the new text
      // beside an acceptance of the old. Issuing them together is not
      // the same as evaluating them together; only the block pin makes
      // the pair a snapshot.
      const blockNumber = await publicClient!.getBlockNumber();
      const [accepted, current] = await Promise.all([
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'hasAcceptedCurrentTerms',
          args: [address!],
          blockNumber,
        }) as Promise<boolean>,
        publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getCurrentTos',
          blockNumber,
        }) as Promise<readonly [number, `0x${string}`]>,
      ]);
      return {
        accepted,
        version: Number(current[0]),
        hash: current[1],
      };
    },
  });

  const reload = useCallback(async () => {
    setWriteError(null);
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const accept = useCallback(async () => {
    if (!query.data) return;
    setSubmitting(true);
    setWriteError(null);
    try {
      // The version and hash come from the SAME read that told us the
      // wallet has not accepted — so the transaction is anchored to the
      // text the modal displayed, not to whatever is in force by the
      // time it mines. A version installed mid-flow makes this call
      // revert rather than silently record consent to unseen terms.
      await write('acceptTerms', [query.data.version, query.data.hash]);
      await queryClient.invalidateQueries({ queryKey });
      // Codex review round 1 P2: one immediate re-read is not enough.
      // A public RPC can still serve the parent block for seconds after
      // a receipt, so the refetch can return the pre-transaction
      // `false` and leave a wallet that HAS paid staring at the prompt,
      // liable to pay again for a no-op. The repository's own write
      // path schedules a delayed second invalidation for exactly this;
      // this query is not among its roots, so it schedules its own.
      // Fire-and-forget on purpose: `submitting` must not stay true for
      // four seconds after the transaction is already mined.
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey });
      }, 4_000);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [query.data, write, queryClient, queryKey]);

  // Self-review before review round 1: a DISABLED query is `isPending`
  // in TanStack v5 — status 'pending', fetchStatus 'idle' — so a wallet
  // connected while `usePublicClient` returns undefined sat on the
  // "checking" card forever, with no retry and no way out. Fail-closed
  // was right; offering no exit was not. Treating it as a failed read
  // keeps the gate shut AND gives the user the retry.
  const clientMissing = Boolean(address) && !publicClient;
  // A successful verdict is only trusted while it is fresh — see
  // `MAX_VERDICT_AGE_MS`. Past the bound the gate holds closed and asks
  // again rather than keeping the app open on an answer old enough for
  // the terms to have changed underneath it.
  const stale =
    query.isSuccess && nowMs > 0 && isVerdictStale(query.dataUpdatedAt, nowMs);
  const readOk = query.isSuccess && !stale;
  return {
    hasAccepted: readOk && query.data.accepted,
    readOk,
    currentVersion: query.data?.version ?? 0,
    currentHash: query.data?.hash ?? ZERO_HASH,
    loading: (query.isPending || stale) && !clientMissing,
    error:
      writeError ??
      (query.error instanceof Error ? query.error.message : null),
    accept,
    reload,
    submitting,
  };
}
