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
import {
  isVerdictStale,
  tosQueryKey,
  VERDICT_CLOCK_TICK_MS,
  type TosVerdictData,
} from './tosGate';
import { acceptanceIsPinned, acceptanceScope, adoptOrderedPin } from './tosAcceptancePin';
import {
  buildAcceptancePinFrame,
  freshVerdict,
  scheduleExpiryRevalidation,
} from './tosAcceptanceSync';
import { publishAcceptancePin } from '../chain/receiptSync';
import { captureTxError } from '../lib/errors';

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
    // Review round 5 P2: seeded on the next macrotask as well as ticked,
    // because "a verdict cannot be too old before the first tick" was
    // only true on a FIRST mount. Remounting — a connected wallet coming
    // back from three minutes on an exempt route — resets this clock but
    // not TanStack's cached `dataUpdatedAt`, so the age check was
    // disabled while the cache was at its stalest, and the stated
    // three-minute bound did not apply for the first 15 seconds.
    //
    // Still not set in the effect BODY, which
    // `react-hooks/set-state-in-effect` forbids; a timeout callback is
    // the same immediacy without the violation.
    const tick = () => setNowMs(Date.now());
    const seed = setTimeout(tick, 0);
    const id = setInterval(tick, VERDICT_CLOCK_TICK_MS);
    return () => {
      clearTimeout(seed);
      clearInterval(id);
    };
  }, []);

  // Memoised so the callbacks below can depend on it honestly rather
  // than on the primitives it is built from — a fresh array each render
  // would either churn every callback or need a suppression, and a
  // suppression here is how the cache key and the invalidation key come
  // to disagree.
  const queryKey = useMemo(
    () => tosQueryKey(readChain.chainId, address),
    [readChain.chainId, address],
  );

  // Identifies ONE wallet on ONE chain, and is what the acceptance pin
  // is stamped with. Acceptance is recorded per network and per wallet,
  // so a pin that could outlive a switch would let a second wallet — or
  // the same wallet on another chain — inherit an acceptance it never
  // made, which is the one thing this whole module exists to prevent.
  const scope = acceptanceScope(readChain.chainId, address);

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
      const version = Number(current[0]);
      // A read that says "not accepted" at the SAME version this
      // session already mined an acceptance for is known to be behind
      // the chain, not informative about it — a public RPC serving the
      // parent block. Correcting it here, at the single point where
      // data enters the cache, is what keeps the gate and the write
      // gate telling a user the same thing.
      //
      // Narrow on purpose, and narrow by MATCHING rather than by being
      // revoked: the pin carries its own wallet, chain and version, and
      // applies only where all three agree. A governance bump reads
      // through untouched and re-prompts as it should; another wallet
      // or another chain never matches it at all.
      //
      // Sound because on-chain acceptance is write-only —
      // `LegalFacet.acceptTerms` records and nothing clears it, and
      // `setCurrentTos` refuses any version that does not strictly
      // increase. So at a matching version, `false` from a node can
      // only mean that node is behind.
      // Version AND hash (#2004 round 4 P1) — matching the number
      // alone would let a pin from a reorged-out branch correct a
      // `false` that is truthfully about different text at the same
      // version, which is why the contract compares both fields too.
      const correctLag =
        !accepted && acceptanceIsPinned(scope, version, current[1], Date.now());
      return {
        accepted: accepted || correctLag,
        version,
        hash: current[1],
        // A corrected verdict rests on the pin, not on this node's
        // answer, and is aged out at the pin's expiry unless a later
        // read confirms it (#2004 round 9 P2). A genuinely confirmed
        // `true` carries no flag.
        ...(correctLag ? { pinBacked: true } : {}),
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
      // Review round 10 P2: the acceptance is CONFIRMED at this point —
      // `write` returns only after the receipt is settled — but the
      // reads that follow can still be behind it. A public RPC serving
      // the parent block answers `accepted: false`, and until round 10
      // that answer put the prompt and an enabled Accept button back in
      // front of a user who had just paid, for at least the four
      // seconds to the delayed re-read and longer if that read lagged
      // too. Paying twice for `acceptTerms` buys nothing but a second
      // timestamp.
      //
      // So the mined result is pinned and written into the cache —
      // but through the same ORDERED adoption every pin takes since
      // #2001 (#2004 round 2 P1). "My own receipt is the newest fact I
      // hold" stopped being true the moment acceptances started
      // arriving from other tabs: a slow RPC can resolve this `write`
      // AFTER governance installed a newer version and another tab's
      // acceptance of it was already applied here, and an
      // unconditional pin + cache write would then reopen both gates
      // under obsolete terms. Ordering refuses exactly that case; a
      // refused local receipt is real but superseded, and the
      // invalidation below re-reads the newer truth.
      const acceptedVersion = query.data.version;
      const pinnedAt = Date.now();
      // A fresh read is used here to REJECT a conflicting receipt,
      // never to REQUIRE a matching one (#2004 round 5 P1 shaped by
      // round 6 P2). The asymmetry with the receiver is deliberate and
      // is the round-1 asymmetry again: a frame is untrusted evidence
      // and must clear the freshness bar, while a mined receipt for
      // this exact version and hash is self-authenticating — the
      // transaction reverts on stale terms, so it proves they were in
      // force at mine time. Requiring a fresh matching entry here
      // (round 5's first cut) silently re-opened the bug this PR
      // exists to fix: a wallet prompt held open past the 180s bound,
      // or an errored refetch, made `fresh` undefined, and the valid
      // receipt was neither patched nor broadcast — the other tab's
      // enabled Accept button stood until its own poll.
      //
      // What a fresh read CAN do is conflict: a newer version, or the
      // same version under a different hash (the reorged-governance
      // case, round 6 P1), each mean this tab has READ past the
      // receipt — an ordinary read installs no pin, so ordering alone
      // cannot see that — and a conflicted receipt applies nothing,
      // with the invalidations below re-reading the newer truth.
      const fresh = freshVerdict(queryClient, queryKey, pinnedAt);
      const conflicted =
        fresh !== undefined &&
        (fresh.version > acceptedVersion ||
          (fresh.version === acceptedVersion && fresh.hash !== query.data.hash));
      const adopted =
        !conflicted &&
        adoptOrderedPin(scope, acceptedVersion, query.data.hash, pinnedAt, pinnedAt);
      // No freshness bar on the cache write for the receipt — it IS
      // the outcome, anchored; a stale or empty entry is simply
      // seeded, which round 1 already argued is the acting tab's
      // prerogative.
      const cacheAdopted = adopted;
      if (cacheAdopted) {
        // Not optimism about an unknown outcome — it is the outcome,
        // anchored to a receipt this call waited for. Writing it here
        // rather than holding it in component state matters because
        // the write gate reads this same cache entry: without it, the
        // wallet that just accepted would be refused its next
        // non-exit write.
        queryClient.setQueryData<TosVerdictData>(queryKey, {
          accepted: true,
          version: acceptedVersion,
          hash: query.data.hash,
          // Receipt-anchored, but a reorg can orphan the receipt too —
          // aged out at the pin's expiry unless a node confirms it
          // first (#2004 round 9 P2).
          pinBacked: true,
        });
      }
      // #2001: the pin and the cache write above are per-TAB, so a
      // second tab holding this wallet still shows its own prompt with
      // an enabled Accept button — and `acceptTerms` happily mines a
      // second time, charging gas for a newer timestamp. Broadcast the
      // pin itself (never a bare invalidation, which would refetch
      // against a lagging RPC with nothing to correct it) so every
      // open tab applies the same correction this one just did. The
      // acting tab's `pinnedAt` travels with it: the 90s bound must
      // expire at the same moment everywhere, or a reorged acceptance
      // stays papered over in whichever tab heard about it last.
      // Gated on the CACHE decision, not on pin adoption alone (#2004
      // round 3 P1): an ordinary refetch installs no pin, so a local
      // v3 receipt settling after this tab's own read discovered v4
      // can win ordering while the cache guard rightly refuses it —
      // and a receiving tab still cached at v3 would have written
      // `accepted: true` from the broadcast. What this tab refuses to
      // believe about a receipt, it must not ask other tabs to
      // believe either. The frame carries the Diamond the acceptance
      // was mined against (round 3 P1), so a tab configured for a
      // different deployment of the same chain drops it.
      if (cacheAdopted && address) {
        publishAcceptancePin(
          buildAcceptancePinFrame(
            readChain.chainId,
            readChain.diamondAddress,
            address,
            acceptedVersion,
            query.data.hash,
            pinnedAt,
          ),
        );
      }
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
      // #2004 rounds 8+9 (both P2): at the pin's expiry, a verdict
      // still resting on the pin is aged past the verdict bound and
      // re-read — see `scheduleExpiryRevalidation`. Scheduled only
      // when a pin was adopted; a superseded receipt installed none.
      if (adopted) {
        scheduleExpiryRevalidation(
          queryClient,
          queryKey,
          scope,
          acceptedVersion,
          query.data.hash,
          pinnedAt,
          pinnedAt,
        );
      }
      // The awaited immediate read comes LAST (round 10 P2): both
      // timers above must already be armed when it starts, because a
      // hung RPC here — the exact failure the expiry revalidation
      // exists to contain — would otherwise prevent the timers that
      // contain it from ever being scheduled.
      await queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      // Codex review round 2 P2: through the SHARED mapper, like every
      // other Diamond write. Raw viem text skipped the localized
      // contract-error catalog — which already carries an actionable
      // `InvalidTosVersion` message for the case where governance
      // installs a new version while the wallet prompt is open, exactly
      // the failure this flow is most likely to hit — and skipped the
      // diagnostics sink, so a support report from a gated user would
      // have omitted the transaction that blocked them.
      setWriteError(captureTxError(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    query.data,
    write,
    queryClient,
    queryKey,
    scope,
    address,
    readChain.chainId,
    readChain.diamondAddress,
  ]);

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
    // Still gated on `readOk`: the lag correction lives in `queryFn`,
    // so a failed or stale read closes the gate exactly as it always
    // did. Correcting a read the app HAS is a different thing from
    // opening the gate on a read it does not have.
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
