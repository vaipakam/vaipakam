/**
 * The forced close-out's SUBMISSION LIFECYCLE — what happens between the
 * lender pressing the button and the card being able to trust its own
 * verdict again (#2090).
 *
 * `ForcedCloseCard` carried all of this inline: the hold that suppresses a
 * second close-out while the first may still be live, the device-local
 * record that survives a reload, the cross-tab adoption, the watcher that
 * establishes the transaction's disposition independently of the write
 * promise, and the refresh that releases the hold once every readiness
 * read has come back. That code was wrong in review rounds 47 through 50,
 * then 52, 53, 57 and 59, and in every case the fix was argued from the
 * comment above it rather than from cases.
 *
 * The predicate half was extracted first, to `forcedCloseHold.ts`, with a
 * case table, and those defects stopped. This module is the other half:
 * the effect ordering, the query-cache interaction (cancel, reset,
 * generation snapshots, invalidate) and the one-shot-per-hash watcher, in
 * a hook a test can drive directly (`useForcedCloseSubmission.test.ts`)
 * instead of only through a rendered card.
 *
 * It is an EXTRACTION. The behaviour, and every reason for it, moved here
 * unchanged — the round notes below are the specification, which is why
 * they travelled with the code rather than being summarised.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type PublicClient,
} from 'viem';
import { settled } from '../contracts/ownReceipt';
import { DEFAULT_NOW_PERIOD_MS, useNowSec } from '../hooks/useNowSec';
import {
  dispositionFromNonce,
  dispositionRetryMs,
  forcedCloseSubmissionKey,
  isHoldingAfterSubmit,
  isUnaccounted,
  mayHaveChangedPosition,
  readForcedCloseSubmission,
  writeForcedCloseSubmission,
  type ForcedCloseDisposition,
  type ForcedCloseSubmission,
} from './forcedCloseHold';

/** How long a close-out may go unaccounted for before the card SAYS SO.
 *
 *  ROUND 50 P1 — this is not a deadline on the action, and that
 *  distinction is the finding. It used to be a give-up: three minutes
 *  elapsed and the card released the hold and re-offered the button.
 *  Elapsed time is not evidence about a transaction. A transaction
 *  pending past this bound has not been dropped — it is pending, and it
 *  can still mine — so releasing on the clock re-opened the
 *  duplicate-submit window the hold exists to close, and did it in the
 *  worst case: a second close-out queued behind a first that then lands,
 *  spending a fee on a terminal loan or acting on a partially settled
 *  residual.
 *
 *  ROUND 54 P2 — and it is no longer a deadline on the WAIT either,
 *  which is where the last of its authority went. Rounds 50 and 53 had
 *  it bound one `settled` call, with the next starting a second later.
 *  Both of those understated the cost, because viem's own default
 *  deadline is the same three minutes: the wait did not merely pause, it
 *  ENDED, and replacement detection ends with it. viem classifies a
 *  reprice or a cancel by re-reading the original transaction from the
 *  mempool, so a wait started after that transaction stopped being
 *  pending has nothing left to reconcile against — it polls a hash that
 *  will never have a receipt and reports `undetermined` for good, on a
 *  close-out that was in fact cancelled or sped up.
 *
 *  So the wait now runs continuously (`timeout: 0`) and this constant
 *  drives PRESENTATION only: after it, the card stops saying "give the
 *  page a moment" and says plainly that it can no longer account for the
 *  transaction, while the same single wait keeps watching. Nothing about
 *  the hold, the evidence, or the action depends on it. */
export const RECEIPT_WAIT_TIMEOUT_MS = 3 * 60_000;

/** The readiness reads this card's verdict is computed from — every
 *  `['forcedClose', …]` query EXCEPT the disposition watcher.
 *
 *  ROUND 61 (self-review) — the exclusion is load-bearing, not tidiness.
 *  The watcher lives under the same prefix (`['forcedClose',
 *  'disposition', …]`), so a bare prefix invalidation matches it too —
 *  and its query function is an UNBOUNDED wait (`timeout: 0`, round 54).
 *
 *  Awaiting that is a hang waiting to happen. The success effect below
 *  awaits its invalidation to learn that the reads have caught up; if the
 *  active watcher key has meanwhile moved to a still-PENDING transaction
 *  — a second close-out, or a chain switch back to a loan carrying a live
 *  submission — the refetch it would be waiting on never resolves, so the
 *  completion never fires and the hold never releases. That is the
 *  round-29 latch by a third route, after the `[submitted]` dependency
 *  (round 58) and the mounted-flag cleanup (round 60).
 *
 *  All three were the same shape: an effect awaiting or depending on
 *  something it had itself disturbed. Here the effect would have been
 *  waiting on the very query whose result triggered it. */
export const READINESS_READS = {
  predicate: (query: { queryKey: readonly unknown[] }) =>
    query.queryKey[0] === 'forcedClose' && query.queryKey[1] !== 'disposition',
} as const;


/** What the card reads from, and calls into, the lifecycle. */
export interface ForcedCloseSubmissionState {
  /** The close-out sent for this chain and loan, from this mount or from
   *  the device-local record; `null` when there is none. */
  submitted: ForcedCloseSubmission | null;
  /** What the chain has established about `submitted`; `null` while no
   *  wait has answered. */
  disposition: ForcedCloseDisposition | null;
  /** The action is held: a close-out may still be live, or its success
   *  has not yet been reflected in every readiness read. */
  holding: boolean;
  /** The transaction has been outstanding long enough that "give the page
   *  a moment" would be a misdescription. */
  unaccounted: boolean;
  /** This browser refused to store the record of `submitted`, so a reload
   *  will lose it. */
  storageRefused: boolean;
  /** The last step before the wallet is asked. Returns the `onSubmitted`
   *  handler to pass to the write, or `null` when a close-out for this
   *  position is already on record — adopted here, and not to be sent
   *  again. */
  prepareSend: () => ((hash: `0x${string}`) => void) | null;
  /** Ask every readiness read again, after the write resolved. */
  refreshReadiness: () => void;
  /** The lender's statement that the unaccounted transaction is gone from
   *  their wallet: drop the record and release the hold. */
  forget: () => void;
}

export function useForcedCloseSubmission({
  chainId,
  loanId,
  publicClient,
  onClosedOut,
}: {
  /** The chain the WALLET is on — where a close-out is sent. `undefined`
   *  is folded into the key rather than special-cased. */
  chainId: number | undefined;
  loanId: string | number;
  /** For the disposition watcher. The watch waits while it is absent. */
  publicClient: PublicClient | undefined;
  /** Lets the page refetch status after a close-out succeeds. */
  onClosedOut: () => void;
}): ForcedCloseSubmissionState {
  const queryClient = useQueryClient();
  /** Stamped when a close-out confirms, and released as soon as the
   *  reads have caught up with it.
   *
   *  Round 28 P2 asked for the hold: the refetch after a successful
   *  close is fire-and-forget, so TanStack keeps serving
   *  `defaultable: true` and the old route verdict while it
   *  revalidates, and `useLoan` can hold a still-Active indexed row
   *  for longer still. Without it the button reappeared under the
   *  lender within the same second and invited a second wallet prompt
   *  for a loan that is now terminal.
   *
   *  Round 29 caught what the FIRST version of that hold got wrong: it
   *  never released. `triggerDefault` can succeed on a PARTIAL internal
   *  match, which settles part of the position and deliberately leaves
   *  the loan Active — this card's own copy now says so. A permanent
   *  latch answered that by replacing an actionable card with "the
   *  loan is ending" forever, on a residual that genuinely still needs
   *  closing.
   *
   *  So the hold is bounded by EVIDENCE rather than by time or by
   *  optimism: it covers exactly the window between the submit and the
   *  first read that postdates it. Once `readsUpdatedAt` passes the
   *  stamp, the verdict on screen was computed from post-close data
   *  and is trustworthy either way — a terminal loan unmounts the card
   *  through the page's own reconciliation, and a live residual gets
   *  its button back.
   *
   *  ROUND 52 P1 — a MAP keyed by chain and loan, not a single slot.
   *  `PositionDetailsInner` is keyed by loan id alone, so a chain switch
   *  keeps this component mounted (round 29's second finding), and the
   *  previous version answered that by CLEARING the slot on any chain or
   *  loan change. Clearing discards the only record of a live
   *  transaction. A lender who switches networks while a close-out is
   *  pending and then switches back arrives with `submitted` null: the
   *  transaction is no longer watched, the readiness reads still say the
   *  loan is closable because it is still Active, and the button is
   *  offered again over a close-out that may be about to mine.
   *
   *  Keying preserves what clearing destroyed while keeping the property
   *  round 29 asked for — loan N on the destination chain has its own
   *  key and no entry, so it is not shown as closed. Nothing is
   *  discarded; the current key simply selects what to look at. It also
   *  removes the render-phase `setSubmitted(null)` that implemented the
   *  clearing, which was a state write during render. */
  const [submissions, setSubmissions] = useState<
    Record<string, ForcedCloseSubmission>
  >({});

  /** The submission whose device-local record this browser REFUSED to
   *  store (round 54 P2), or `null` when no write is known to have
   *  failed.
   *
   *  ROUND 59 P3 — a hash, not a component-wide boolean. As a boolean it
   *  never reset: a refused write for one chain-and-loan left the card
   *  claiming, for every later identity it displayed, that reloading
   *  would lose a record which was in fact sitting in storage. Naming the
   *  transaction it applies to makes the warning true by construction and
   *  needs no reset path — a different submission simply does not
   *  match. */
  const [storageRefusedFor, setStorageRefusedFor] = useState<string | null>(
    null,
  );

  /** Identity of the position this card is currently showing.
   *
   *  `undefined` chain is folded into the key rather than special-cased:
   *  a submission made with no wallet chain cannot be confused with one
   *  made on a real chain, which is the property that matters. */
  const submissionKey = `${chainId ?? 'none'}:${String(loanId)}`;

  /** ROUND 53 P1 — hydrated from device-local storage, not just from
   *  this component's lifetime.
   *
   *  Round 52 keyed the in-memory map by chain and loan, which fixed a
   *  chain switch and nothing else: the map is component state, so a
   *  reload or a navigation away from the route destroys it exactly as
   *  clearing it did, and returning re-offers the button over a
   *  transaction that may still be mining. A reload is the likelier of
   *  the two.
   *
   *  Re-seeded as a render-phase ADJUSTMENT rather than in an effect,
   *  the same shape `useLoanSalePending` uses (#1520): React re-runs the
   *  render before painting, so the previous identity's record is never
   *  displayed, where the effect version committed one frame carrying
   *  it. The lazy initializer alone would freeze the first identity.
   *
   *  ROUND 58 P2 — seeded to `null`, so the FIRST mount seeds too.
   *  Initialising this to `submissionKey` meant the adjustment fired only
   *  on a later key CHANGE, and a card mounted straight onto a persisted
   *  record never put it in the map at all: `submitted` then came from
   *  the storage read below, which builds a NEW OBJECT on every render.
   *
   *  That churn is invisible until something depends on the identity,
   *  and then it is severe. The unaccounted timer's effect took
   *  `[submitted]`, so its own `setOutstanding` re-rendered the card,
   *  handed the effect a different object, and tore down the interval it
   *  had just started — pinning the monotonic measure at roughly one
   *  period and never letting it reach the threshold. The round-57 fix
   *  was therefore inert in precisely the case it was written for: a
   *  persisted record whose wall stamp is in the future. */
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== submissionKey) {
    setSeededFor(submissionKey);
    const persisted = readForcedCloseSubmission(chainId, loanId);
    setSubmissions((prev) =>
      persisted === null ? prev : { ...prev, [submissionKey]: persisted },
    );
  }

  const submitted =
    submissions[submissionKey] ??
    readForcedCloseSubmission(chainId, loanId);


  /** What the chain has established about the submitted close-out.
   *
   *  ROUND 52 P2 — this delegates to `contracts/ownReceipt.settled`,
   *  the repository's existing answer to exactly this question and a
   *  more careful one than the inline version it replaces. Round 50
   *  rebuilt a subset of it here and got the replacement cases wrong:
   *
   *  - `replaced` — a DIFFERENT transaction took the nonce, so our call
   *    can never execute. The inline version fell through to reading the
   *    replacement's receipt, so an unrelated transaction that happened
   *    to succeed reported as a successful CLOSE-OUT. Not a wrong hold:
   *    a wrong assertion that the loan closed.
   *  - `repriced` — a Speed Up carries our own call at a higher gas
   *    price, so its receipt IS ours and its status is the answer. The
   *    inline version got this right only by accident of checking
   *    `cancelled` alone; widening it without the repriced/replaced
   *    distinction would have broken it in the other direction.
   *
   *  `settled` also carries a belt-and-braces case the inline version
   *  had no equivalent for: a receipt under a hash we did not submit,
   *  with no `onReplaced` reason to explain it, is treated as `replaced`
   *  rather than waved through.
   *
   *  Two definitions of "did our transaction take effect" is the same
   *  defect round 52 raised about the live-driver credential check, one
   *  layer up. There is one now.
   *
   *  The timeout is applied HERE rather than passed to `settled`: it is
   *  this card's policy about when to stop waiting and say so, not a
   *  fact about settlement, and `settled` deliberately has no opinion
   *  about it. */
  const watch = useQuery<ForcedCloseDisposition>({
    queryKey: ['forcedClose', 'disposition', submissionKey, submitted?.hash],
    enabled: submitted !== null && Boolean(publicClient),
    retry: false,
    // ROUND 54 P2 — ONE CONTINUOUS WAIT. Rounds 50 and 53 both bounded
    // the wait and restarted it, first after three minutes and then
    // after one second, and the second was an improvement on the first
    // without being a fix: any gap at all can contain the reprice or
    // cancel whose detection needs the original transaction to still be
    // pending, and the restarted wait then has nothing to reconcile
    // against. Passing `timeout: 0` removes the gap rather than
    // shortening it — the wait viem started keeps running until it has
    // an answer.
    //
    // The interval is retained ONLY to restart a wait that FAILED (an
    // RPC drop surfaces as `undetermined`). A final disposition stops
    // it, because nothing later changes one.
    //
    // THE COST, stated rather than glossed: viem's poller for a hash
    // lives until that wait settles, and nothing here can cancel it —
    // `waitForTransactionReceipt` takes no abort signal, so leaving this
    // page keeps one receipt poll per block alive for a transaction that
    // never resolves. That is the price of the property above, and it is
    // the right way round: a poll costs an RPC call, while the bounded
    // version cost the ability to tell a lender their close-out was
    // cancelled, and re-offered a funds-moving button on the strength of
    // not knowing.
    //
    // #2086 — the restart BACKS OFF (`dispositionRetryMs`). A hash the
    // node no longer has (the orphaned case after a reload) makes viem's
    // wait give up every time, and a fixed one-second restart turned that
    // into a request loop for as long as the page stayed open.
    // `dataUpdateCount` counts the answers so far; while the disposition
    // is unknown every one of them was `undetermined`.
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data === 'undetermined'
        ? dispositionRetryMs(query.state.dataUpdateCount)
        : false,
    queryFn: async (): Promise<ForcedCloseDisposition> => {
      try {
        const r = await settled(publicClient!, submitted!.hash, {
          timeout: 0,
        });
        // `reason` is already the vocabulary this card holds on:
        // 'reverted' | 'cancelled' | 'replaced'.
        return r.ok ? 'success' : r.reason;
      } catch {
        // A read that failed. It says nothing about the transaction, so
        // it is not allowed to say anything here. (The nonce
        // reconciliation below is NOT run from here: a hash the node no
        // longer has does not make this wait fail, it keeps it waiting,
        // so a catch-only reconciliation never ran in the case it was
        // for — Codex #3040 r1.)
        return 'undetermined';
      }
    },
  });

  /** #2086 — the disposition from the sender's nonce. `undetermined`
   *  unless the nonce is known and the reads give positive evidence; the
   *  rule is `dispositionFromNonce`. */
  async function reconcileByNonce(
    s: ForcedCloseSubmission,
  ): Promise<ForcedCloseDisposition> {
    if (s.sender === undefined || s.nonce === undefined || !publicClient) {
      return 'undetermined';
    }
    const [accountNonce, receipt, transaction] = await Promise.all([
      publicClient
        .getTransactionCount({ address: s.sender, blockTag: 'latest' })
        .catch(() => null),
      publicClient
        .getTransactionReceipt({ hash: s.hash })
        .then((r) => (r.status === 'success' ? ('success' as const) : ('reverted' as const)))
        .catch((err: unknown) =>
          err instanceof TransactionReceiptNotFoundError ? ('absent' as const) : ('unknown' as const),
        ),
      publicClient
        .getTransaction({ hash: s.hash })
        .then(() => 'visible' as const)
        .catch((err: unknown) =>
          err instanceof TransactionNotFoundError ? ('absent' as const) : ('unknown' as const),
        ),
    ]);
    return dispositionFromNonce({ receipt, accountNonce, nonce: s.nonce, transaction });
  }

  /** #2086 — the sender and nonce of the submitted transaction, read back
   *  from the chain while it is still visible and added to the record, so
   *  a reload can reconcile by nonce. The wallet returns only a hash, and
   *  an injected wallet assigns the nonce itself, so the transaction is
   *  the one place both can be read.
   *
   *  Polled until the node has the transaction (a public node can lag
   *  the wallet's own by a few seconds), backing off like the wait does,
   *  since a hash the node has dropped will never be found; stopped once
   *  the record carries them or the disposition is settled. Keyed under
   *  `['forcedClose', 'disposition', …]` so the readiness invalidation
   *  passes over it, as it does the wait. */
  const identity = useQuery<{
    hash: `0x${string}`;
    sender: `0x${string}`;
    nonce: number;
  } | null>({
    queryKey: ['forcedClose', 'disposition', submissionKey, submitted?.hash, 'identity'],
    enabled:
      submitted !== null &&
      submitted.nonce === undefined &&
      Boolean(publicClient) &&
      (watch.data === undefined || watch.data === 'undetermined'),
    retry: false,
    refetchInterval: (query) =>
      query.state.data == null ? dispositionRetryMs(query.state.dataUpdateCount) : false,
    queryFn: async () => {
      try {
        const hash = submitted!.hash;
        const tx = await publicClient!.getTransaction({ hash });
        return { hash, sender: tx.from, nonce: tx.nonce };
      } catch {
        return null; // not visible yet, or the read failed
      }
    },
  });
  const identityData = identity.data ?? null;

  /** The one value that identifies this transaction and cannot change
   *  identity between renders. */
  const submittedHash = submitted?.hash ?? null;

  /** The sender and nonce, once read back, become part of the SUBMISSION
   *  (#2086, Codex #3040 r2): the in-memory entry and the device record
   *  both take them, and every reader uses `submitted` alone.
   *
   *  They used to be derived from the identity query on each render, which
   *  made a fact already learned depend on a read that can regress: a
   *  refetch on reconnect, after the node has dropped the transaction,
   *  answers `null`, and the nonce disappeared with it, switching the
   *  reconciliation off for good. A learned identity is now stored once
   *  and the identity query stops, since it is enabled only while the
   *  submission lacks one. Only onto the submission it was read for: the
   *  answer carries its hash, and a newer submission under the same key
   *  does not inherit another transaction's nonce. */
  useEffect(() => {
    if (identityData === null) return;
    const { hash, sender, nonce } = identityData;
    const learn = (s: ForcedCloseSubmission | null | undefined) =>
      s !== null && s !== undefined && s.hash === hash && s.nonce === undefined;
    const stored = readForcedCloseSubmission(chainId, loanId);
    setSubmissions((prev) => {
      const current = prev[submissionKey] ?? stored;
      return learn(current)
        ? { ...prev, [submissionKey]: { ...current!, sender, nonce } }
        : prev;
    });
    if (learn(stored)) {
      writeForcedCloseSubmission(chainId, loanId, { ...stored!, sender, nonce });
    }
  }, [identityData, submissionKey, chainId, loanId]);

  /** #2086 — the nonce reconciliation, run ALONGSIDE the live wait rather
   *  than after it (Codex #3040 r1).
   *
   *  It used to run only when the wait failed, and in the case it exists
   *  for the wait never fails: after a reload, a hash the node no longer
   *  has leaves viem's `waitForTransactionReceipt` watching blocks for
   *  good (`timeout: 0`), because with no copy of the original it has
   *  nothing to classify a replacement against and no reason to give up.
   *  So the reconciliation polls on its own, backing off like the
   *  restarts do, until it has an answer or the wait has one.
   *
   *  It does not race the wait to a vaguer answer: `dispositionFromNonce`
   *  answers `superseded` only once the node no longer has our
   *  transaction, which is when the wait cannot tell a cancel from a
   *  Speed Up any more. Before that, the wait's own answer stands. */
  const reconcile = useQuery<ForcedCloseDisposition>({
    queryKey: ['forcedClose', 'disposition', submissionKey, submitted?.hash, 'nonce'],
    enabled:
      submitted !== null &&
      submitted.nonce !== undefined &&
      Boolean(publicClient) &&
      (watch.data === undefined || watch.data === 'undetermined'),
    retry: false,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data === 'undetermined'
        ? dispositionRetryMs(query.state.dataUpdateCount)
        : false,
    // The options are refreshed every render, so this reads the
    // submission as it stands when the poll runs.
    queryFn: () => reconcileByNonce(submitted!),
  });

  /** The wait's answer when it has one; otherwise the reconciliation's.
   *  An `undetermined` from either is not an answer. */
  const answered = (d: ForcedCloseDisposition | undefined) =>
    d !== undefined && d !== 'undetermined' ? d : undefined;
  const disposition: ForcedCloseDisposition | null =
    answered(watch.data) ?? answered(reconcile.data) ?? watch.data ?? reconcile.data ?? null;

  /** Every submission whose post-success refresh has come back.
   *
   *  ROUND 59 P2 — keyed by hash rather than a bare boolean so a flag set
   *  for a previous close-out cannot release the hold on the next one.
   *
   *  ROUND 63 P2 — and a SET rather than one slot. A single slot is not
   *  merely imprecise across a chain switch, it is order-dependent: with
   *  refreshes in flight for two submissions, a slower completion for the
   *  superseded one overwrites the current one's and puts the hold back
   *  on. The success effect will not retry, because `invalidatedFor`
   *  already holds that hash and none of its dependencies changed, so a
   *  live residual stays locked until a remount. Completions are facts
   *  about their own transaction and never expire; keeping them all is
   *  both cheaper to reason about and correct. */
  const [refreshedFor, setRefreshedFor] = useState<Record<string, true>>({});

  /** Ticks, so the "we have lost track of this" posture below arrives on
   *  its own rather than waiting for something unrelated to re-render the
   *  card. Coarse (30s) against a three-minute threshold. */
  const nowSec = useNowSec();

  /** Whether the card is still holding its action, computed HERE rather
   *  than beside the render.
   *
   *  ROUND 54 P2 — it moved up because an effect below needs it: the
   *  device-local record may not be cleared while a success is still
   *  holding. It is a pure call over values already in hand, so its
   *  position is free; every reason for it lives at
   *  `data/forcedCloseHold`, which is where the case table is.
   *
   *  The one thing worth repeating here is why the arms differ, because
   *  it is the part four consecutive rounds got wrong: SUCCESS holds
   *  until the refresh it triggered has come back (round 28 — otherwise
   *  the button is re-offered against pre-close figures), an unknown or
   *  failed wait holds because nothing has been established (round 50),
   *  and `reverted` / `cancelled` / `replaced` release at once because
   *  the chain has said the close-out did not execute and a retry is
   *  legitimate (round 49). */
  const holdingAfterSubmit = isHoldingAfterSubmit({
    submittedAt: submitted?.at ?? null,
    disposition,
    // ROUND 59 P2 — the COMPLETION of the refresh, not an ordering of
    // wall-clock stamps. Keyed by hash so a stale flag from a previous
    // submission cannot release the hold on this one.
    readsRefreshedSinceDisposition:
      submittedHash !== null && refreshedFor[submittedHash] === true,
  });

  /** `holdingAfterSubmit`, readable from a long-lived event handler.
   *
   *  ROUND 61 P1 — the cross-tab `storage` listener is installed once and
   *  closes over the render that installed it, so it cannot see the live
   *  value. It needs to, because whether another tab's clear may be acted
   *  on depends entirely on whether THIS tab has finished reconciling. */
  const holdingRef = useRef(holdingAfterSubmit);
  useEffect(() => {
    holdingRef.current = holdingAfterSubmit;
  });

  /** The transaction has been outstanding long enough that "give the page
   *  a moment" would be a misdescription.
   *
   *  ROUND 54 P2 — this used to BE the disposition: a three-minute wait
   *  timed out, reported `undetermined`, and that value drove both the
   *  copy and the way out. Splitting them lets the wait run continuously
   *  (see `refetchInterval` above) while the card still says something
   *  after three minutes. A failed wait is included because it is the
   *  same thing from the reader's side — the app cannot account for the
   *  transaction — even though its cause is ours rather than the
   *  chain's. */
  /** How long THIS mount has held the submission, on a monotonic clock.
   *
   *  ROUND 57 P2 — the wall clock alone could not be trusted with this,
   *  because it gates the only route out of a hold that evidence will
   *  never release; `isUnaccounted` carries that reasoning.
   *
   *  Ticked into state rather than read during render, and the lint rule
   *  that forces this is right on both counts it raises:
   *  `performance.now()` is an impure call, and a ref holding the answer
   *  would not re-render the card when the answer changed. A ticking
   *  value is what "elapsed time" actually is here — the same shape
   *  `useNowSec` has for the wall clock, at the same 30s period against a
   *  three-minute threshold.
   *
   *  Carries the hash it was measured for, so a second close-out on this
   *  position starts its own clock instead of inheriting the first one's,
   *  and a value left over from a previous submission is ignored rather
   *  than counted. */
  const [outstanding, setOutstanding] = useState<{
    hash: string;
    ms: number;
  } | null>(null);
  //  Depends on the HASH, not on the submission object (round 58 P2).
  //  The seeding above now keeps that object stable, and this effect must
  //  not rely on it having done so: a timer that restarts whenever its
  //  own tick re-renders the card measures nothing, and it fails silently
  //  — the value simply never crosses the threshold. Two independent
  //  reasons to get this wrong, so it is pinned to the one value that
  //  cannot change without the transaction changing.
  useEffect(() => {
    if (submittedHash === null) return;
    const startedAt = performance.now();
    const id = setInterval(
      () =>
        setOutstanding({
          hash: submittedHash,
          ms: performance.now() - startedAt,
        }),
      DEFAULT_NOW_PERIOD_MS,
    );
    return () => clearInterval(id);
  }, [submittedHash]);

  const unaccounted =
    submitted !== null &&
    (disposition === null || disposition === 'undetermined') &&
    isUnaccounted({
      monotonicMs:
        outstanding !== null && outstanding.hash === submitted.hash
          ? outstanding.ms
          : 0,
      submittedAt: submitted.at,
      // Read from `nowSec` rather than `Date.now()` so the value is
      // stable within a render pass — the reason `useNowSec` exists.
      nowWall: nowSec * 1000,
      thresholdMs: RECEIPT_WAIT_TIMEOUT_MS,
    });

  /** ROUND 53 P2 — the invalidation must follow the WATCHER, not only
   *  the write.
   *
   *  `closeOut` invalidates after `await write(...)` resolves, so a write
   *  that rejects — an RPC drop, a receipt wait that timed out — skips it
   *  entirely. The transaction can still mine, and this watcher then
   *  establishes `success` independently. At that point the hold requires
   *  every readiness read to postdate the disposition, and `consent`
   *  carries `staleTime: 10 * 60_000` with no `refetchInterval`, so
   *  nothing would ever advance it: after a PARTIAL match the live
   *  residual stays locked with success already known. That is the
   *  round-29 latch again, reached through the round-52 anchor.
   *
   *  Keyed by hash so it fires once per transaction rather than on every
   *  render while success is on screen, and it is deliberately
   *  fire-and-forget — the hold releases on the resulting timestamps, not
   *  on this promise.
   */
  //  A REF, not state: this value is never read during render, and
  //  `react-hooks/set-state-in-effect` (rightly) rejects the state
  //  version — a setState here would schedule a second render for a
  //  bookkeeping flag nothing displays.
  /** Submissions whose post-success refresh has been requested but not
   *  yet observed to complete: hash -> per-query generation snapshot. */
  const refreshTargets = useRef<Map<string, Map<string, number>>>(new Map());
  const invalidatedFor = useRef<string | null>(null);
  /** ROUND 60 P1 — the parent's callback held through a ref so its
   *  IDENTITY is not a dependency of the effect below.
   *
   *  `PositionDetails` passes an inline arrow, so every parent render
   *  produces a new function. Depending on it meant `onClosedOut()` —
   *  which starts parent refetches — re-rendered the parent, changed the
   *  identity, and tore this effect down while its own invalidation was
   *  still in flight. The replacement effect then found `invalidatedFor`
   *  already holding the hash and declined to retry, so nothing ever
   *  recorded the refresh: the round-29 LATCH, on a residual a partial
   *  internal match had left live. The effect triggered the teardown that
   *  cancelled its own completion. */
  const onClosedOutRef = useRef(onClosedOut);
  useEffect(() => {
    onClosedOutRef.current = onClosedOut;
  });
  useEffect(() => {
    // #2086 — `superseded` refreshes too: the nonce moved on under a
    // transaction that may have been our own call sped up.
    if (!mayHaveChangedPosition(disposition) || submittedHash === null) return;
    if (invalidatedFor.current === submittedHash) return;
    invalidatedFor.current = submittedHash;
    // ROUND 59 P2 — AWAITED, and its completion is what releases the
    // hold. `invalidateQueries` settles once the refetches it triggered
    // have settled, errors included, so this cannot latch on a failing
    // read the way a timestamp comparison could latch on a clock.
    //
    // ROUND 60 P1 — and NOT guarded by a mounted flag. The flag looked
    // like hygiene and was the latch: it cancelled a completion this
    // effect's own `onClosedOut()` had caused to be interrupted. It is
    // not needed, because the value written is KEYED BY HASH — a
    // resolution arriving for a superseded transaction cannot release
    // the hold on the current one, since the consumer compares the two.
    // Correctness here comes from what is written, not from whether the
    // writer is still current.
    // ROUND 63 P1 — completion is OBSERVED, not awaited.
    //
    // Round 62 fixed one competing invalidation by ordering these two
    // calls; round 63 found a third invalidation site — the `write`
    // continuation in `closeOut` — that no ordering here can cover.
    // That is the honest end of the promise approach: `refetchQueries`
    // defaults to `cancelRefetch: true`, a cancelled fetch RESOLVES
    // against the reverted cache, and a promise that resolves on being
    // cancelled cannot be told apart from one that resolves on success.
    // Any future caller invalidating these queries would defeat it
    // again, which makes correctness depend on code in other files not
    // changing.
    //
    // So the completion signal is now a GENERATION check, which is what
    // round 59 actually asked for and what I should have built then.
    // Snapshot each readiness query's `dataUpdateCount +
    // errorUpdateCount` before invalidating; the refresh is complete
    // when every one of them has ADVANCED. Those counters increment
    // only on a real settle — `query.js` reverts to `#revertState` on a
    // cancellation without touching them — so a cancelled-and-restarted
    // refetch counts once, when it finally lands, and no number of
    // competing invalidations can fake it. It is also clock-free, which
    // is what round 59 was about.
    // ROUND 64 P2 — snapshot ONLY what the invalidation will actually
    // refetch, which is not the same set `findAll` returns.
    //
    // `refetchQueries` acts on ACTIVE queries and skips
    // `isDisabled()`/`isStatic()` ones. `useForcedCloseReads` creates a
    // disabled `liquidity` query while collateral metadata is still
    // unknown, and a cached entry for another position can be inactive —
    // neither will refetch, so neither counter ever advances, so the
    // completion never fires. That is the round-29 latch again, lasting
    // until the entry is garbage-collected (five minutes by default) with
    // every current readiness read long since finished.
    //
    // Matching the filter to the one `refetchQueries` uses makes the
    // snapshot a description of the work being awaited rather than of the
    // cache. An empty result then means nothing will refetch — so there
    // is nothing to wait for, and the target completes rather than
    // waiting for an event that cannot arrive.
    // ROUND 65 P1 — CANCEL FIRST, so the advance we wait for cannot come
    // from a read that started before the close-out landed.
    //
    // A counter advancing proves a fetch SETTLED; it does not prove that
    // fetch began after the mine, and the two come apart on exactly the
    // path this record exists for. Reload with a pending close-out and
    // the readiness queries are on their FIRST load — `state.data ===
    // undefined` — where `Query.fetch` returns the in-flight retryer
    // promise instead of restarting, `cancelRefetch` notwithstanding
    // (`query.js:184-193`). That pre-mine read then settles, advances the
    // counter, clears the invalidation, and nothing refetches again: the
    // hold releases with no post-success read at all, which after a
    // partial match re-offers the residual under the old match copy.
    //
    // `cancelQueries` reverts in-flight fetches without advancing
    // counters, so cancelling before snapshotting leaves nothing running
    // that could satisfy the target spuriously. Everything counted after
    // that started after the success.
    // ROUND 66 P2 — what will NOT refetch is DISCARDED, not merely
    // skipped.
    //
    // Round 64 excluded the non-refetching queries from the wait, which
    // stopped the latch and left a second hole: inactivity here is
    // REVERSIBLE. `useForcedCloseReads` is enabled on the page's
    // `effectivelyActive`, so a close-out that lands the loan in
    // `FallbackPending` — seen by the live-status rail or another tab
    // before this watcher processes the receipt — disables the readiness
    // aggregate (one query since #2148; seven before it) while the card
    // stays mounted. It keeps its PRE-CLOSE
    // cache. The active set is then empty, the target completes on the
    // spot, and if the borrower later cures back to Active those
    // queries reactivate and serve the old readings to a card whose
    // hold has already been released: action copy, and a submit
    // control, built from facts the close-out invalidated.
    //
    // Waiting on them instead is not the fix — a disabled query never
    // refetches, so that is the round-29 latch by the other door. The
    // resolution is to stop the stale reading being servable at all:
    // remove it, so a reactivated read starts from nothing, resolves to
    // `unknown` while it fetches, and cannot assert a route. An empty
    // active set is then a truthful "nothing to wait for", because
    // nothing stale survives it.
    onClosedOutRef.current();
    void queryClient.cancelQueries(READINESS_READS).then(() => {
      const cache = queryClient.getQueryCache();
      const willRefetch = new Set(
        cache
          .findAll({ ...READINESS_READS, type: 'active' })
          .filter((q) => !q.isDisabled() && !q.isStatic()),
      );
      // Two ways to drop a stale reading, and the difference matters.
      //
      // `cache.remove` deletes the entry, but nothing tells an OBSERVER
      // its query is gone: `QueryObserver` holds `#currentQuery`
      // directly and only rebuilds on the next render, when
      // `setOptions` re-runs `build()`. A disabled read with a live
      // observer would therefore keep serving its pre-close value until
      // some unrelated re-render happened to clear it — the correctness
      // of this card resting on whether the PAGE re-rendered.
      //
      // `query.reset()` dispatches `setState`, which calls
      // `onQueryUpdate()` on every observer and notifies the cache
      // (`query.js:405-411`). The reader is told, synchronously, that
      // it has no reading — which is what makes the resumed check
      // resolve to `unknown` rather than to a route.
      //
      // So: reset what someone is reading, remove what no one is. The
      // second is not merely tidier — `reset()` clears the gc timeout
      // (`removable.js:7-9`), so an observerless entry reset instead of
      // removed would sit in the cache with nothing scheduled to
      // collect it.
      for (const q of cache.findAll(READINESS_READS)) {
        if (willRefetch.has(q)) continue;
        if (q.getObserversCount() > 0) q.reset();
        else cache.remove(q);
      }
      if (willRefetch.size === 0) {
        // Nothing will refetch, and nothing stale survives to be
        // served — so there is genuinely nothing to wait for. Said
        // outright rather than left to an empty target completing on
        // the next cache tick, which would make the release depend on
        // some other query happening to move.
        setRefreshedFor((prev) => ({ ...prev, [submittedHash]: true }));
      } else {
        refreshTargets.current.set(
          submittedHash,
          new Map(
            [...willRefetch].map((q) => [
              q.queryHash,
              q.state.dataUpdateCount + q.state.errorUpdateCount,
            ]),
          ),
        );
      }
      void queryClient.invalidateQueries(READINESS_READS);
    });
  }, [disposition, submittedHash, queryClient]);

  /** Watches the readiness queries for the generation advance the effect
   *  above is waiting on (round 63 P1).
   *
   *  A cache subscription rather than a promise, for the reason written
   *  there: only a refetch that actually SETTLES advances these
   *  counters, so this cannot be satisfied by a cancellation, by a
   *  competing invalidation, or by a clock. It is also inherently
   *  per-submission — several targets can be outstanding at once and
   *  each completes on its own evidence.
   *
   *  No synchronous check on mount: this effect is declared after the
   *  one that registers a target, so within a commit the subscription is
   *  in place before any refetch it must observe can settle. */
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    return cache.subscribe(() => {
      if (refreshTargets.current.size === 0) return;
      const done: string[] = [];
      for (const [hash, snapshot] of refreshTargets.current) {
        const advanced = [...snapshot].every(([queryHash, before]) => {
          const q = cache.get(queryHash);
          // A query that no longer exists cannot serve stale readiness,
          // so it does not hold the completion open.
          if (q === undefined) return true;
          return q.state.dataUpdateCount + q.state.errorUpdateCount > before;
        });
        if (advanced) done.push(hash);
      }
      if (done.length === 0) return;
      for (const hash of done) refreshTargets.current.delete(hash);
      setRefreshedFor((prev) => {
        const next = { ...prev };
        for (const hash of done) next[hash] = true;
        return next;
      });
    });
  }, [queryClient]);

  /** Another tab's submission, adopted here.
   *
   *  Self-review after round 53. Persisting the record fixed losing it
   *  across a reload, and left a second way to not have it: a lender
   *  with this position open in TWO tabs. The tab that submits writes the
   *  record; the other tab's key has not changed, so it never re-seeds,
   *  keeps `submitted` null, and offers the button over a live close-out.
   *  Same duplicate submit as the round-52 and round-53 findings, reached
   *  by a third route — and the one route the two fixes for those cannot
   *  cover, because neither the key nor the mount changes.
   *
   *  `storage` fires only in OTHER tabs of the same origin, which is
   *  exactly the gap. Matching on our own key rather than parsing every
   *  event is what `PendingMarkerStore.key()` exists for, and a null key
   *  (a whole-storage clear) concerns us too — the same shape `Recover`
   *  follows. */
  useEffect(() => {
    if (chainId === undefined) return;
    const ownKey = forcedCloseSubmissionKey(chainId, loanId);
    const key = `${chainId}:${String(loanId)}`;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== ownKey) return;
      const persisted = readForcedCloseSubmission(chainId, loanId);
      setSubmissions((prev) => {
        // ROUND 61 P1 — a remote clear is a SIGNAL, not an instruction.
        //
        // Dropping our own record on it was wrong, and my earlier
        // reasoning for keeping it was wrong in an instructive way: I
        // argued the pre-send simulation was the backstop, having checked
        // whether the re-offered action would FAIL. On a partial internal
        // match it does not fail — the loan is deliberately still Active,
        // so `triggerDefault` simulates and executes fine. What is stale
        // is the DESCRIPTION: this tab still holds cached
        // `ready-internal-match` copy promising settlement in the lent
        // asset, while the same empty-route call now takes the in-kind
        // fallback. The lender confirms one outcome and gets another.
        //
        // A simulation cannot catch that, because the transaction is
        // legitimate. Only this tab's own post-success refresh can, which
        // is exactly what the hold already waits for. So the clear is
        // ignored while we are still holding: the other tab knows its
        // transaction is disposed of, and knows nothing about whether OUR
        // reads have caught up.
        //
        // Once this tab is no longer holding, dropping the record is
        // right and keeps the round-53 property — a settled transaction
        // is not re-watched on the next visit.
        if (persisted === null) {
          if (prev[key] === undefined) return prev;
          if (holdingRef.current) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }
        const held = prev[key];
        if (held?.hash === persisted.hash) {
          // The same transaction. Another tab may have read back its
          // sender and nonce since this tab adopted it (#2086), and this
          // tab's node may no longer be able to: take them, so this tab
          // can reconcile by nonce on its own (Codex #3040 r1).
          if (held.nonce !== undefined || persisted.nonce === undefined) return prev;
          return { ...prev, [key]: { ...held, sender: persisted.sender, nonce: persisted.nonce } };
        }
        return { ...prev, [key]: persisted };
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [chainId, loanId]);

  /** ROUND 53 P1 — the device-local record is cleared once the
   *  transaction is DISPOSED of, not when the card unmounts. Leaving it
   *  would make every later visit to this position re-watch a settled
   *  transaction, and on a partial match that means holding the residual
   *  shut behind a disposition that was already acted on.
   *
   *  ROUND 54 P2 — but a SUCCESS is not disposed of the moment its
   *  receipt arrives. The hold deliberately continues until one readiness
   *  read postdates it (round 28), and this effect was deleting the
   *  record at the start of that window rather than the end. Inside it,
   *  navigating away and back — or simply reloading — found no record,
   *  stopped watching, and re-offered the action against readiness values
   *  computed before the close. That is the round-53 hole with a smaller
   *  mouth: the persistence fixed losing the record across a reload and
   *  then threw it away early on the one path where the hold outlives the
   *  receipt.
   *
   *  So the record now survives exactly as long as the hold it backs. The
   *  three non-success dispositions still clear immediately — the chain
   *  has said the close-out did not execute, `isHoldingAfterSubmit`
   *  releases at once, and keeping a record of a transaction that did
   *  nothing would only re-watch it on the next visit. */
  useEffect(() => {
    if (disposition === null || disposition === 'undetermined') return;
    if (submitted === null) return;
    if (mayHaveChangedPosition(disposition) && holdingAfterSubmit) return;
    writeForcedCloseSubmission(chainId, loanId, null);
  }, [
    disposition,
    submitted,
    holdingAfterSubmit,
    chainId,
    loanId,
  ]);


  /** The last step before the wallet is asked, and the record it starts.
   *
   *  The key is captured HERE, at send time, rather than read when the
   *  hash arrives (round 52 P1): it must describe where the transaction
   *  WENT, not where the wallet happens to point when the promise
   *  resolves, so switching networks mid-flight does not discard it. */
  function prepareSend(): ((hash: `0x${string}`) => void) | null {
    const key = submissionKey;
    const chainAtSend = chainId;

    // ROUND 54 P1 — THE LAST THING BEFORE THE WALLET: re-read the
    // device-local record, synchronously.
    //
    // Round 53's `storage` listener adopts another tab's submission,
    // and adoption is event-driven, which leaves two windows it cannot
    // close. Everything the card does before this is awaited — the sale
    // interlock, then a simulation — so a second tab that passed the
    // guard at the top of its submit can sit there for seconds while
    // the first tab sends; and a marker written between this tab's
    // render and the listener being installed is never delivered at
    // all. In both, the guard was answered by state that had already
    // gone stale.
    //
    // Storage is the one record BOTH tabs see, and reading it costs a
    // synchronous string read. There is no window between this check
    // and the send for an event to be missed in — provided the caller
    // sends straight after it, with no await between.
    //
    // What this does NOT claim to be is an atomic reservation. Two
    // tabs reaching this line in the same tick both read null and both
    // send. That race is intrinsic to Web Storage, which offers no
    // compare-and-set; narrowing it from seconds to a tick is the
    // whole of what is available here, and saying so is better than
    // implying a lock.
    const alreadySent = readForcedCloseSubmission(chainAtSend, loanId);
    if (alreadySent !== null) {
      setSubmissions((prev) => ({ ...prev, [key]: alreadySent }));
      return null;
    }

    // STAMP ON THE HASH, NOT ON THE RECEIPT (round 47 P1).
    //
    // `write` resolves only after the receipt wait, and that wait can
    // time out or lose its RPC on a transaction that mined perfectly
    // well — `useDiamondWrite` says so in its own `onSubmitted` doc.
    // Stamping after the await meant that on any such failure
    // `submitted` stayed null, the busy flag cleared, and the
    // confirmation came back live under the lender with the same button.
    //
    // A retry then re-simulates against a chain where the first
    // close-out may not have landed YET, so the simulation passes and
    // a second `triggerDefault` is queued. That second call either
    // burns a network fee reverting on a now-terminal loan, or — after
    // a PARTIAL first settlement — runs for real against the residual.
    // Neither is something to risk because a receipt wait timed out.
    //
    // So the stamp goes down the moment a hash exists. The hold it
    // starts is released by the TRANSACTION's disposition, never by
    // elapsed time (round 50 P1).
    return (hash) => {
      const record = { at: Date.now(), hash };
      setSubmissions((prev) => ({ ...prev, [key]: record }));
      // ROUND 53 P1 — also to device-local storage, so a reload or a
      // navigation away does not lose the only record of a live
      // transaction. In-memory FIRST and unconditionally: a browser
      // that refuses storage (private mode, quota, storage disabled)
      // must still get the within-session hold, which is the larger
      // half of the protection.
      //
      // ROUND 54 P2 — and when storage refuses, SAY SO. The store
      // returns false precisely so a caller on a funds path can care,
      // and discarding that made the card's posture a guess: this
      // mount is protected by state, a reload is not, and the lender
      // is the only one who can act on that difference. The note it
      // raises is the honest version of what round 53 fixed —
      // "reloading loses track of this" is true again in this
      // browser, so it is stated rather than assumed away.
      if (!writeForcedCloseSubmission(chainAtSend, loanId, record)) {
        setStorageRefusedFor(hash);
      }
    };
  }

  return {
    submitted,
    disposition,
    holding: holdingAfterSubmit,
    unaccounted,
    storageRefused: storageRefusedFor !== null && storageRefusedFor === submittedHash,
    prepareSend,
    // Fire-and-forget: the hold releases on the watcher's success and the
    // refresh IT observes, never on this promise.
    refreshReadiness: () => void queryClient.invalidateQueries(READINESS_READS),
    forget: () => {
      writeForcedCloseSubmission(chainId, loanId, null);
      setSubmissions((prev) => {
        const next = { ...prev };
        delete next[submissionKey];
        return next;
      });
    },
  };
}
