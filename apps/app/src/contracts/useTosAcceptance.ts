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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { useDiamondWrite } from './diamond';
import {
  isVerdictStale,
  MAX_VERDICT_AGE_MS,
  MAX_VERDICT_FUTURE_MS,
  tosQueryKey,
  VERDICT_CLOCK_TICK_MS,
  type TosVerdictData,
} from './tosGate';
import {
  MAX_FUTURE_SKEW_MS,
  acceptanceIsPinned,
  acceptanceReconciliationRemainingMs,
  acceptanceReconciling,
  acceptanceScope,
  adoptReceiptPin,
  holdAcceptanceForReconciliation,
  monotonicNow,
  onAcceptanceHoldsChanged,
  retireDifferingPin,
  retireSupersededPin,
} from './tosAcceptancePin';
import {
  buildAcceptancePinFrame,
  buildAcceptanceReadHintFrame,
  freshVerdict,
  scheduleExpiryRevalidation,
} from './tosAcceptanceSync';
import { publishAcceptancePin } from '../chain/receiptSync';
import { friendlyContractError } from '@vaipakam/lib';
import { captureTxError, translateContractError } from '../lib/errors';
import { copy } from '../content/copy';

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
  /** True while the acceptance OFFER is held for reconciliation
   *  (#2004 round 37 P1): unverifiable evidence arrived that an
   *  acceptance already happened — an out-of-window frame, a read
   *  hint, an unanchorable local receipt — and the authoritative
   *  reads it scheduled have not had their window to land. The gate
   *  itself is untouched (fail-closed as ever); only the Accept
   *  button is withheld, so a lagging RPC's cached `false` cannot
   *  offer a redundant paid re-acceptance during the seconds the
   *  reads need. Bounded — see `ACCEPTANCE_RECONCILIATION_HOLD_MS`. */
  reconciling: boolean;
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

  // The reconciliation hold as OBSERVABLE state (round 38 P2). The
  // hold lives in module state, which React cannot see — and with a
  // cached `false` verdict already in place, the invalidation that
  // accompanies a hold changes only query properties this hook does
  // not track, so nothing re-rendered and the Accept button stayed
  // enabled through the very window the hold exists to cover. Armed
  // holds therefore NOTIFY: the subscription below re-renders this
  // hook the moment one is armed, and — release having no event — a
  // timer re-samples at the hold's remaining life, so the button
  // re-enables within moments of expiry. Monotonic throughout, like
  // the hold itself (round 38's other P2): a wall-clock deadline
  // would be moved by exactly the corrections this module defends
  // against.
  const [reconciling, setReconciling] = useState(false);
  useEffect(() => {
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      const remaining = acceptanceReconciliationRemainingMs(scope);
      setReconciling(remaining > 0);
      clearTimeout(releaseTimer);
      if (remaining > 0) releaseTimer = setTimeout(sync, remaining + 50);
    };
    // Seeded via a timeout, not the effect body — the same
    // `set-state-in-effect` rule as the gate clock above; a hold
    // armed before this mount (a broadcast during boot) is picked up
    // here.
    const seed = setTimeout(sync, 0);
    const unsubscribe = onAcceptanceHoldsChanged(sync);
    return () => {
      clearTimeout(seed);
      clearTimeout(releaseTimer);
      unsubscribe();
    };
  }, [scope]);

  // A held click must not outlive its wallet context (round 39 P2):
  // the hold-wait below spans seconds, and a user who switches
  // accounts, switches networks, or disconnects during it leaves the
  // continuation holding the OLD scope, query key and write closure —
  // which would then open a wallet request for an account and
  // deployment the rendered UI no longer represents. Each scope
  // change (and unmount — the cleanup runs for both) bumps the epoch;
  // the continuation samples it at entry and abandons itself silently
  // after every await once it no longer matches.
  const acceptEpoch = useRef(0);
  useEffect(() => {
    return () => {
      acceptEpoch.current += 1;
    };
  }, [scope]);

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
    queryFn: async ({ signal }) => {
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
      // A node-confirmed read at a HIGHER version — or a different
      // hash at the same version — retires a live pin it supersedes
      // (#2004 round 17 P1): left in the map, that pin waits for a
      // LATER refetch through a still-lagging RPC and converts its
      // truthful `false` back into `accepted: true` under terms this
      // read just proved are no longer in force. A lower-version
      // read retires nothing — that is the lagging node the pin
      // exists to correct. Only a read TanStack will actually COMMIT
      // may retire (round 28 P1): an invalidation cancels this query
      // for cache purposes while the RPC promises run on, and a
      // cancelled read's result — discarded from the cache — must not
      // leave its side effect behind, retiring a live pin whose
      // pin-backed verdict then coasts with a superseded, silent
      // expiry timer.
      if (!signal.aborted) retireSupersededPin(scope, version, current[1]);
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
      // The consult is gated on the signal too (round 29 P1, beyond
      // the retirement gate): `acceptanceIsPinned` DELETES an expired
      // pin it observes, and a cancelled read's continuation doing
      // that deletion hands the expiry timer a `superseded`
      // observation — silence — while the still-fresh pinBacked
      // verdict the timer would have aged coasts on. A cancelled
      // read's verdict is discarded anyway, so it has no business
      // touching pin state at all.
      const correctLag =
        !signal.aborted &&
        !accepted &&
        acceptanceIsPinned(scope, version, current[1], Date.now());
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
      // The non-trusting submission lock (rounds 37 and 38, both
      // P1). A live reconciliation hold means unverifiable evidence
      // arrived that an acceptance ALREADY happened — an
      // out-of-window frame, a read hint, this tab's own unanchorable
      // receipt — and the authoritative reads it scheduled may not
      // have landed yet. The UI disables the button on the same hold;
      // this backstop covers the click that races the disable — and
      // it waits out the WHOLE hold rather than trusting the first
      // refusal (round 38 P1): the immediate read can hit the same
      // lagging RPC the DELAYED read exists to outwait, so one
      // `false` inside the hold is not "settled". The wait re-checks
      // the cache each second, bailing the moment any landed read
      // says accepted; only once the hold has fully elapsed does one
      // final awaited read decide. Nothing is trusted — no gate
      // opens, no verdict is written — the wallet is just not charged
      // while the evidence is still being reconciled. A `false` still
      // standing after the hold is the chain's answer, and the write
      // proceeds; the contract still anchors it to the displayed
      // version and reverts on stale terms.
      const heldAtEntry = acceptanceReconciling(scope);
      const epoch = acceptEpoch.current;
      for (;;) {
        const remaining = acceptanceReconciliationRemainingMs(scope);
        if (remaining <= 0) break;
        if (queryClient.getQueryData<TosVerdictData>(queryKey)?.accepted) return;
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(remaining + 50, 1_000));
        });
        // The wallet context may have moved during the sleep (round
        // 39 P2) — a continuation for a scope this hook no longer
        // renders applies nothing and asks the wallet for nothing.
        if (acceptEpoch.current !== epoch) return;
      }
      if (heldAtEntry) {
        const before =
          queryClient.getQueryState<TosVerdictData>(queryKey)?.dataUpdatedAt ?? 0;
        await queryClient.invalidateQueries({ queryKey });
        if (acceptEpoch.current !== epoch) return;
        const settled = queryClient.getQueryState<TosVerdictData>(queryKey);
        // The final recheck must have actually SUCCEEDED (round 39
        // P1): `invalidateQueries` swallows refetch errors — the
        // promise resolves, `getQueryData` keeps serving the retained
        // refusal, and treating that as "settled" submits the payment
        // without ever obtaining the promised final chain answer. A
        // real answer moves `dataUpdatedAt` and leaves no error;
        // anything else aborts into the error banner, where the user
        // can retry — honest about not knowing, like every other
        // failed read in this gate.
        if (
          !settled ||
          settled.error !== null ||
          settled.data === undefined ||
          settled.dataUpdatedAt <= before
        ) {
          throw settled?.error ?? new Error(copy.legalGate.readErrorBody);
        }
        if (settled.data.accepted) return;
        // Governance can move DURING the hold (round 39 P2): the
        // recheck may have replaced `false` v3 with `false` v4, and
        // the closure's captured `query.data` still holds v3.
        // Submitting v3 would revert (the contract anchors to the
        // current version) — and silently submitting v4 instead is
        // worse, recording consent to terms the user never saw. So a
        // drifted verdict ABORTS with the same localized message the
        // reverted transaction would have produced, minus the wallet
        // round-trip; the re-rendered prompt already shows the new
        // version for a fresh, informed click.
        if (
          settled.data.version !== query.data.version ||
          settled.data.hash !== query.data.hash
        ) {
          setWriteError(
            friendlyContractError({ name: 'InvalidTosVersion' }, translateContractError) ??
              copy.errors.txFailed,
          );
          return;
        }
      }
      // The version and hash come from the SAME read that told us the
      // wallet has not accepted — so the transaction is anchored to the
      // text the modal displayed, not to whatever is in force by the
      // time it mines. A version installed mid-flow makes this call
      // revert rather than silently record consent to unseen terms.
      // The pin's anchor is stamped BEFORE the write is awaited — not
      // at submission's `onSubmitted` callback, and not when this
      // continuation resumes (#2004 rounds 12 P2 and 36 P1). Round 12
      // established why not at resume: anchored there, an acceptance
      // orphaned during a post-mine suspension would be rebroadcast
      // with a brand-new 90-second window. Round 36 moved it off the
      // `onSubmitted` callback for the same failure one layer down:
      // that callback runs in `writeContract`'s promise CONTINUATION,
      // and a mobile or external wallet backgrounding the page while
      // it handles the request delays the continuation until resume —
      // potentially after the transaction has already MINED. Stamped
      // there, submission and settlement collapse to near-zero
      // interval: `anchorConsistent` is vacuously true and the anchor
      // looks fresh, handing an old — possibly already orphaned —
      // receipt a full pin window plus an adoptable broadcast frame.
      // The pre-await stamp is the one moment guaranteed to precede
      // real submission without depending on the page executing any
      // continuation. It can only make the window START EARLY, by the
      // wallet-prompt dwell — the safe direction: a dwell long enough
      // to expire the anchor makes `adoptReceiptPin` refuse it, and
      // the read-hint broadcast plus the always-scheduled reads carry
      // the case, exactly like an expired frame.
      const submittedAt = Date.now();
      const submittedAtMono = monotonicNow();
      const { receipt } = await write('acceptTerms', [
        query.data.version,
        query.data.hash,
      ]);
      // The receipt's chain position — (mined block, transaction
      // index) — travels with the pin and the broadcast frame (#2004
      // rounds 14–15): it is what remote receivers order frames by,
      // since wall stamps do not survive a clock correction and the
      // version counter does not survive a rollback.
      const receiptBlock = Number(receipt.blockNumber);
      const receiptTxIndex = receipt.transactionIndex;
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
      // Anchored at the PRE-WRITE stamp, and deliberately ONLY there.
      // When the stamp is untrustworthy — expired (a transaction pending past
      // the pin window: congestion, a late speed-up) or future-dated
      // beyond the skew allowance (a backward clock correction) — the
      // adoption guards refuse it outright and the always-scheduled
      // reads carry the case. Rounds 16–22 of review tried to rebuild
      // a trustworthy anchor from RPC block samples for the
      // long-pending case, and every construction fell to the same
      // wall: a replaced block at the receipt's height (round 18), a
      // regressive latest sample (round 21), a cross-fork pair from a
      // split transport fallback (round 22) — ancestry is simply not
      // provable from unpinned samples. What retired the idea rather
      // than patched it again is that the window it defended is
      // empty: the pin exists to correct nodes LAGGING by seconds,
      // and a receipt already older than the whole TTL is visible to
      // every such node — by the time a re-anchor could matter, there
      // is no lag left for a pin to correct, so a refused anchor
      // costs nothing the immediate and delayed reads don't recover.
      const pinnedAt = submittedAt;
      // The anchor must not have CROSSED a clock discontinuity
      // between the pre-write stamp and settlement (round 34 P1;
      // stamped pre-await since round 36 — see above): stamped on
      // both clocks at once, its two elapsed measures agree
      // whenever the interval was ordinary — awake, or a plain sleep
      // (both clocks advance, or the wall bound catches the nap
      // through the TTL check) — and disagree exactly when a
      // correction landed mid-flight, where the wall-apparent age
      // understates or overstates the real one by an unknowable
      // amount. An inconsistent anchor supports no pin: adoption is
      // refused and the always-scheduled reads carry the case, the
      // same posture as every other unmeasurable interval. (This is
      // what closes the sparing gap: a pin never stored cannot be
      // wrongly spared by its adoption order.)
      const anchorConsistent =
        Math.abs(monotonicNow() - submittedAtMono - (Date.now() - submittedAt)) <=
        MAX_FUTURE_SKEW_MS;
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
      const fresh = freshVerdict(queryClient, queryKey, Date.now());
      // A fresh NODE-CONFIRMED read that disagrees conflicts (#2004
      // round 12 P1, narrowed in round 17 P2) — on version in either
      // direction, with no height carve-out (round 15 P1: height is
      // not ancestry, and a legal gate resolves the unprovable tie by
      // believing the read and re-reading). A PIN-BACKED differing
      // entry does not conflict: it is the sync rail's own product —
      // another tab's frame that landed while this acceptance sat
      // pending — and hearsay must not veto the one piece of evidence
      // that is not hearsay, a receipt this tab watched settle.
      // Mirrors the receiver's round-16 rule; the beaten pin-backed
      // verdict is aged below once the receipt adopts, so the gates
      // stop honouring it while the reads settle which acceptance
      // stands. Equal version and hash is the one non-conflict: a
      // fresh refusal there is the lag this whole module corrects.
      const conflicted =
        fresh !== undefined &&
        !fresh.pinBacked &&
        (fresh.version !== acceptedVersion || fresh.hash !== query.data.hash);
      // Trusted adoption for the tab's own receipt (#2004 round 15
      // P2, restoring round 13's path minus its comparison): a
      // just-settled receipt supersedes any incumbent pin outright —
      // every attempt to ORDER the two fell to a case its marker
      // could not see (version to a rollback, wall stamps to a clock
      // correction, height to a shorter replacement chain). The one
      // refusal left is the anchor's own expiry: a continuation
      // resuming from a suspension longer than the TTL applies
      // nothing, and the reads below carry the case.
      const adopted =
        !conflicted &&
        anchorConsistent &&
        adoptReceiptPin(
          scope,
          acceptedVersion,
          query.data.hash,
          pinnedAt,
          receiptBlock,
          receiptTxIndex,
          Date.now(),
        );
      // A BELIEVED receipt that could not be pinned still supersedes
      // differing hearsay (round 36 P1). When the anchor is outside
      // its bounds or inconsistent, the branches above install no pin
      // and write no verdict — but a differing incumbent pin (another
      // tab's frame that landed while this transaction sat pending)
      // and the fresh pinBacked verdict resting on it then SURVIVE a
      // settlement this tab watched disprove them: in a rollback
      // where this receipt settled for the restored terms, the
      // orphaned terms' pin kept correcting reads and its verdict
      // kept both gates open until the incumbent TTL if the
      // authoritative reads hung. The receipt's authority to
      // supersede does not depend on its anchor — only what it may
      // INSTALL does — so the differing hearsay is retired and its
      // verdict aged, with nothing installed in their place; the
      // always-scheduled reads decide what is true. Same-terms
      // hearsay is kept: it corroborates the receipt and carries its
      // own valid machinery.
      if (!conflicted && !adopted) {
        retireDifferingPin(scope, acceptedVersion, query.data.hash);
        // The verdict to age is read DIRECTLY from the cache, not
        // through `freshVerdict` (round 37 P1): the same backward
        // clock correction that makes `anchorConsistent` false can
        // leave the incumbent entry's `dataUpdatedAt` beyond the
        // five-second future allowance, so `fresh` is undefined here
        // — and gating the aging on it deleted the pin while leaving
        // its verdict un-aged, with the expiry timer observing
        // `superseded` and exiting silently. As wall time caught up,
        // that orphaned future-stamped verdict became fresh AGAIN and
        // reopened both gates for the rest of the verdict window.
        // Aging is idempotent and harmless on an already-stale entry,
        // so the direct read is safe in every case.
        const cur = queryClient.getQueryData<TosVerdictData>(queryKey);
        if (
          cur?.pinBacked &&
          (cur.version !== acceptedVersion || cur.hash !== query.data.hash)
        ) {
          // Aged, not deleted, mirroring the receiver's round-16/20
          // rule — and past the render-clock slack, so the gate's
          // lagging `nowMs` cannot read it as fresh for a tick.
          queryClient.setQueryData<TosVerdictData>(queryKey, cur, {
            updatedAt: Date.now() - MAX_VERDICT_AGE_MS - VERDICT_CLOCK_TICK_MS - 1_000,
          });
        }
        // With no pin installed, this tab's OWN next lagging read can
        // re-arm its prompt too (round 37 P1) — hold the acceptance
        // offer for the reconciliation window, exactly as the
        // receivers of the read-hint broadcast below hold theirs.
        holdAcceptanceForReconciliation(scope);
      }

      // No freshness bar on the cache write for the receipt — it IS
      // the outcome, anchored; a stale or empty entry is simply
      // seeded (round 1's acting-tab prerogative) — EXCEPT a fresh
      // MATCHING acceptance, which is preserved (round 12 P2,
      // mirroring the receiver's round-11 rule): rewriting it
      // pinBacked would volunteer node-given truth for expiry aging.
      // MATCHING is load-bearing (round 26 P2): since round 17 the
      // conflict guard lets a DIFFERING pin-backed `accepted: true`
      // through — another tab's acceptance that landed mid-pend — and
      // skipping the write on its `accepted` flag left this tab
      // holding hearsay for the wrong version with both gates closed
      // until a read landed. The receipt's own verdict is the
      // supersession: writing it replaces the beaten hearsay outright,
      // which is why no separate aging step exists on this path (the
      // receiver ages instead, because its cache write is gated on an
      // exact match and cannot replace).
      const cacheAdopted =
        adopted &&
        !(
          fresh !== undefined &&
          fresh.accepted &&
          fresh.version === acceptedVersion &&
          fresh.hash === query.data.hash
        );
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
      //
      // Gated on BELIEF — `!conflicted` — not on whether the PIN was
      // adoptable (round 23 P2, refining round 12's rule). The two
      // diverge exactly when the anchor is outside its bounds: a
      // transaction that sat pending past the pin window mines a
      // perfectly real acceptance whose stamp no pin may carry — and
      // staying silent left every other tab's enabled Accept button
      // standing until its 60-second poll, the redundant payment this
      // whole feature exists to prevent. Broadcasting it is safe
      // without any window because the receivers' own guards decide
      // what a frame may do: an in-window frame adopts, an expired or
      // future-dated one is a READ HINT — immediate and delayed
      // authoritative reads, nothing adopted — which is precisely
      // what a just-mined long-pending acceptance needs other tabs to
      // do. What this tab refuses to BELIEVE (a conflicted receipt),
      // it must not ask other tabs to act on; what it believes but
      // cannot anchor, it may still report, because a reported
      // acceptance is a hint to read, never a command to trust. The
      // frame carries the Diamond the acceptance was mined against
      // (round 3 P1), so a tab configured for a different deployment
      // of the same chain drops it.
      if (!conflicted && address) {
        // An INCONSISTENT anchor is announced as a non-adoptable read
        // hint, never as a pin frame (round 35 P1): its wall-apparent
        // age is in-window while its true age is unknowable, and a
        // receiver — which never observed the submission — would
        // adopt it as a fresh pin its own heartbeat cannot indict.
        // The hint tells every tab an acceptance happened and to go
        // read, which is everything an unanchorable acceptance can
        // honestly ask of them.
        publishAcceptancePin(
          anchorConsistent
            ? buildAcceptancePinFrame(
                readChain.chainId,
                readChain.diamondAddress,
                address,
                acceptedVersion,
                query.data.hash,
                pinnedAt,
                receiptBlock,
                receiptTxIndex,
              )
            : buildAcceptanceReadHintFrame(
                readChain.chainId,
                readChain.diamondAddress,
                address,
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
        // `now` is the REAL clock, not the anchor (round 18 P2): a
        // chain-age anchor can already be most of a window old, and
        // scheduling as if it were fresh left the first check a full
        // cadence away while the pin had seconds to live.
        scheduleExpiryRevalidation(
          queryClient,
          queryKey,
          scope,
          acceptedVersion,
          query.data.hash,
          pinnedAt,
          Date.now(),
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
  // The RENDER-clock tolerance is passed explicitly (round 29 P1):
  // `nowMs` lags the real clock by up to a tick, and the predicate's
  // default is now the bare skew for real-clock callers like the
  // write gate.
  const stale =
    query.isSuccess &&
    nowMs > 0 &&
    isVerdictStale(query.dataUpdatedAt, nowMs, MAX_VERDICT_AGE_MS, MAX_VERDICT_FUTURE_MS);
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
    reconciling,
  };
}
