/**
 * "This loan is overdue" — the lender's forced close-out.
 *
 * `DefaultedFacet.triggerDefault` has been on-chain the whole time and
 * has never had a surface in this app, so a lender whose borrower
 * simply stopped paying could watch the grace period expire and had no
 * way to act on it from the product. This card is that way.
 *
 * ## Why it renders in states it cannot act on
 *
 * Every non-terminal readiness renders, including `unknown` and
 * `not-yet`. That is the opposite of the usual "hide what you can't
 * do" instinct, and it is deliberate: a lender cannot ask for a route
 * they have never been shown, and this capability stayed invisible for
 * exactly as long as nothing drew it. A card that explains what it is
 * waiting on is worth more here than a clean empty space.
 *
 * ## The one state that shows no button on purpose
 *
 * `ready-needs-route` is genuinely closable on-chain — a keeper could
 * do it this second — but the app cannot build the `AdapterCall[]` the
 * contract requires for liquid collateral, and `swapWithFailover`
 * reverts `NoEnabledSwapRoute` on an empty try-list rather than falling
 * back. So there is no submit button: offering one would sell the
 * lender a guaranteed revert at their own expense. The card says the
 * position is eligible and that the app is the limitation, because
 * blaming the protocol for an app gap would send them to the wrong
 * place for help.
 *
 * ## What this card never says
 *
 * No amount, ever — `triggerDefault` picks between an internal match, a
 * DEX sale and a full-collateral fallback while the transaction runs.
 * No exclusivity — the call is permissionless. And never that money
 * arrives on its own; closing sets the loan terminal and the lender
 * claims afterwards. Each of those would be a sentence the contract
 * does not support, on the one card whose whole job is telling somebody
 * how they get paid.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { AlertTriangle } from 'lucide-react';
import { copy } from '../content/copy';
import { captureTxError } from '../lib/errors';
import { useDiamondWrite, DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { useSanctionsCheck } from '../data/sanctions';
import { ConfirmReceipt } from './ConfirmReceipt';
import { settled } from '../contracts/ownReceipt';
import { DEFAULT_NOW_PERIOD_MS, useNowSec } from '../hooks/useNowSec';
import {
  forcedCloseSubmissionKey,
  isHoldingAfterSubmit,
  isUnaccounted,
  readForcedCloseSubmission,
  writeForcedCloseSubmission,
  type ForcedCloseDisposition,
  type ForcedCloseSubmission,
} from '../data/forcedCloseHold';
import {
  canSubmitFromApp,
  shouldRenderForcedClose,
  type ForcedCloseReadiness,
} from '../data/forcedClose';

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
const RECEIPT_WAIT_TIMEOUT_MS = 3 * 60_000;

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
const READINESS_READS = {
  predicate: (query: { queryKey: readonly unknown[] }) =>
    query.queryKey[0] === 'forcedClose' && query.queryKey[1] !== 'disposition',
} as const;

export function ForcedCloseCard({
  loanId,
  readiness,
  matchFallback,
  swapToRepayPossible,
  confirmOpen,
  onOpenConfirm,
  onCloseConfirm,
  busy,
  setBusy,
  onClosedOut,
  preSubmitBlock,
  resolvedBlock,
}: {
  loanId: string | number;
  /** Resolved by `decideForcedClose` from live reads — never derived
   *  in this component. The card renders the decision; it does not
   *  make it. */
  readiness: ForcedCloseReadiness;
  /** The block every polled fact behind `readiness` was evaluated at —
   *  `block.number` of the one aggregate `useForcedCloseReads` issues
   *  (#2098, #2131). Published on the card as `data-forced-close-block`
   *  beside `data-forced-close-state`, so a reader (a person with
   *  devtools, or the live drive) can check the state the card declares
   *  against the chain at the block it names, instead of inferring the
   *  state from prose and guessing the block.
   *
   *  `undefined` while the facts are unread, when the aggregate failed,
   *  or when the page has overridden `readiness` to `unknown` for a
   *  reason of its own — a declared block beside a state that was not
   *  resolved from facts read at it would be a claim, not a fact. Like
   *  `readiness`, never derived here. */
  resolvedBlock: bigint | undefined;
  /** Where the close-out lands if the internal-match candidate is gone
   *  by the time the transaction mines. Read ONLY on
   *  `ready-internal-match`. Resolved on the page by
   *  `forcedCloseWithoutMatch` — like `readiness`, never derived here. */
  matchFallback: ForcedCloseReadiness;
  /** Whether this loan's shape can carry a swap-to-repay intent at all.
   *
   *  `SwapToRepayIntentFacet` reverts `UnsupportedLoanShape` unless BOTH
   *  legs are ERC-20 and BOTH are Liquid, so a rental, NFT collateral,
   *  or an illiquid asset on either leg can never have one. `false` for
   *  a shape the contract rejects, `undefined` when the app has not read
   *  enough to say. Never derived here. */
  swapToRepayPossible: boolean | undefined;
  /** The page's single confirmation slot — opening this receipt closes
   *  any other, matching every other write card on the page. */
  confirmOpen: boolean;
  onOpenConfirm: () => void;
  onCloseConfirm: () => void;
  /** The page-wide write mutex, so two wallet prompts cannot race. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Lets the page refetch status after the loan goes terminal. */
  onClosedOut: () => void;
  /** The page's live sale-settlement re-check, run immediately before
   *  sending. Returns a message to show and abort on, or `null` to
   *  proceed.
   *
   *  Separate from the `triggerDefault` simulation below and NOT
   *  replaceable by it: the contract does not inspect the sale link at
   *  all, so a close-out that would strand an accepted sale's manual
   *  completion simulates and executes perfectly (round 32 P1). This is
   *  a product-level interlock, and it has to be asked as one. */
  preSubmitBlock: () => Promise<string | null>;
}) {
  const { write, ready } = useDiamondWrite();
  const { walletChain, address } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const sanctions = useSanctionsCheck();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
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
  const submissionKey = `${walletChain?.chainId ?? 'none'}:${String(loanId)}`;

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
    const persisted = readForcedCloseSubmission(walletChain?.chainId, loanId);
    setSubmissions((prev) =>
      persisted === null ? prev : { ...prev, [submissionKey]: persisted },
    );
  }

  const submitted =
    submissions[submissionKey] ??
    readForcedCloseSubmission(walletChain?.chainId, loanId);


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
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data === 'undetermined'
        ? 1_000
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
        // it is not allowed to say anything here.
        return 'undetermined';
      }
    },
  });

  const disposition = watch.data ?? null;

  /** The one value that identifies this transaction and cannot change
   *  identity between renders. */
  const submittedHash = submitted?.hash ?? null;

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
    if (disposition !== 'success' || submittedHash === null) return;
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
    // before this watcher processes the receipt — disables all seven
    // reads while the card stays mounted. They keep their PRE-CLOSE
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
    const chainId = walletChain?.chainId;
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
        if (prev[key]?.hash === persisted.hash) return prev;
        return { ...prev, [key]: persisted };
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [walletChain?.chainId, loanId]);

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
    if (disposition === 'success' && holdingAfterSubmit) return;
    writeForcedCloseSubmission(walletChain?.chainId, loanId, null);
  }, [
    disposition,
    submitted,
    holdingAfterSubmit,
    walletChain?.chainId,
    loanId,
  ]);

  if (!shouldRenderForcedClose(readiness)) return null;

  // The hold, and every reason its arms differ, is computed above and
  // documented in `data/forcedCloseHold` — the whole round-28-to-54
  // history lives with the case table rather than beside the render,
  // because arguing this predicate from a comment instead of from cases
  // is what broke it four rounds running.
  const submittable = canSubmitFromApp(readiness) && !holdingAfterSubmit;

  async function closeOut() {
    // Belt and braces on a money path: no render path may reach a
    // second submit while the first is unreconciled. The `disabled`
    // props above are the UI half; this is the half that survives a
    // future caller wiring the confirmation differently.
    if (holdingAfterSubmit || busy) return;
    setError(null);
    setBusy(true);
    try {
      // The empty try-list is correct for both submittable states, and
      // for different reasons. `ready-in-kind` — NFT rentals, illiquid
      // collateral, >110% LTV collapses — is routed to in-kind
      // disposition without a swap adapter ever being consulted.
      // `ready-internal-match` never reaches the swap branch either:
      // `attemptInternalMatchAutoDispatch` runs first and returns.
      // Anywhere else this array reverts `NoEnabledSwapRoute`, which is
      // why the button does not exist there.
      // The sale interlock FIRST, because it is the one the chain will
      // not enforce for us: `triggerDefault` terminalizes the loan
      // regardless of an accepted sale awaiting completion, so the
      // simulation below would happily approve the very transaction
      // that strands the buyer's principal.
      const saleBlock = await preSubmitBlock();
      if (saleBlock) {
        setError(saleBlock);
        return;
      }
      // A LIVE re-check, immediately before sending (round 28 P2). The
      // readiness above is a 30-second poll that the open confirmation
      // can outlive by minutes, and several of the facts behind it move
      // on their own: collateral can be re-priced from illiquid to
      // liquid, a collapsed LTV can recover below the threshold,
      // governance can pause. Each of those turns this exact empty
      // try-list from correct into a guaranteed revert — the paid
      // refusal the whole card exists to prevent. Simulating asks the
      // chain the only question that matters ("would this call succeed
      // right now?") instead of re-deriving the answer from a second
      // copy of the contract's branch rules.
      //
      // It also, without special-casing any of them, covers the gates
      // this decision does not model: `whenNotPaused`, the lender KYC
      // check on an enforcement-enabled deployment, and a consent flag
      // read a moment too early.
      if (publicClient && address) {
        await publicClient.simulateContract({
          address: walletChain!.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'triggerDefault',
          args: [BigInt(loanId), []],
          account: address,
        });
      }
      // STAMP ON THE HASH, NOT ON THE RECEIPT (round 47 P1).
      //
      // `write` resolves only after the receipt wait, and that wait can
      // time out or lose its RPC on a transaction that mined perfectly
      // well — `useDiamondWrite` says so in its own `onSubmitted` doc,
      // which is the hook this call was not using. Stamping after the
      // await meant that on any such failure `submitted` stayed null,
      // `finally` cleared the busy flag, and the confirmation came back
      // live under the lender with the same button.
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
      //
      // Recorded under the key for the chain and loan it was sent on, so
      // switching networks mid-flight no longer discards it (round 52
      // P1). The key is captured here rather than read at callback time
      // for the same reason it is recorded at all: it must describe
      // where the transaction WENT, not where the wallet happens to
      // point when the promise resolves.
      const key = submissionKey;
      const chainAtSend = walletChain?.chainId;

      // ROUND 54 P1 — THE LAST THING BEFORE THE WALLET: re-read the
      // device-local record, synchronously.
      //
      // Round 53's `storage` listener adopts another tab's submission,
      // and adoption is event-driven, which leaves two windows it cannot
      // close. Everything above this line is awaited — the sale
      // interlock, then a simulation — so a second tab that passed the
      // guard at the top of this function can sit here for seconds while
      // the first tab sends; and a marker written between this tab's
      // render and the listener being installed is never delivered at
      // all. In both, the guard was answered by state that had already
      // gone stale.
      //
      // Storage is the one record BOTH tabs see, and reading it costs a
      // synchronous string read. There is no window between this check
      // and the send for an event to be missed in.
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
        setError(copy.forcedClose.alreadySubmittedElsewhere);
        return;
      }

      await write('triggerDefault', [BigInt(loanId), []], {
        onSubmitted: (hash) => {
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
        },
      });
      onClosedOut();
      onCloseConfirm();
      void queryClient.invalidateQueries(READINESS_READS);
    } catch (err) {
      setError(captureTxError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Round 39 P2 — losing the match race does not always mean the
   *  close-out fails. `forcedCloseWithoutMatch` says which branch the
   *  contract reaches instead, and each one is a materially different
   *  outcome for the lender, so each gets named rather than folded into
   *  the commonest. `blocked-no-consent` groups with the failures on
   *  purpose: the in-kind branch reverts `LiquidationFailed` without
   *  both parties' consent, so nothing is recovered and only the fee is
   *  spent — the same thing that happens with no swap route. */
  /*  The rental arm is UNREACHABLE on the argument that made round 54's
   *  `matchRace: false` correct, and it is kept deliberately.
   *
   *  This is the fallback for a card already in `ready-internal-match`,
   *  which requires the chain's own `hasInternalMatchCandidate` to have
   *  answered true — and for a rental it cannot, for the three reasons
   *  written on that row. So a rental never reaches this branch.
   *
   *  Deleting it would make this expression depend on the chain's read
   *  agreeing with our model of the chain. It is the read that is
   *  authoritative: if that view ever returns true for a rental — a feed
   *  configured against a collection address, a future settlement path
   *  for non-fungible legs — this is exactly the sentence that should be
   *  shown, and its absence would fall through to `raceFallbackUnknown`
   *  on the one card that must not be vague about what the lender gets.
   *  An unreachable-but-correct branch costs a string; the alternative
   *  costs an explanation at the moment one is needed. */
  const raceOutcome =
    matchFallback === 'ready-in-kind'
      ? copy.forcedClose.raceFallbackInKind
      : matchFallback === 'ready-rental'
        ? copy.forcedClose.raceFallbackRental
        : matchFallback === 'ready-needs-route' ||
            matchFallback === 'blocked-no-consent'
          ? copy.forcedClose.raceFallbackFails
          : copy.forcedClose.raceFallbackUnknown;

  /** ONE EXHAUSTIVE TABLE, because choosing the set by hand is the bug.
   *
   *  Six findings on this PR were the same shape: a string true of one
   *  route, rendered on a set of routes picked by hand — the rental
   *  described as a collateral transfer, the race promising failure, the
   *  race disclosed in one direction, then disclosed on only some of the
   *  states it applies to. Every one of those was a `readiness === 'a'
   *  || readiness === 'b'` written while looking at a and b.
   *
   *  A LATER RUN OF FINDINGS (rounds 50, 53-56) was the same shape one
   *  layer out: the table stayed right and the PROSE beside it drifted,
   *  five times, each a sentence that restated a column instead of
   *  naming it. Two of those were introduced by fixing the previous one.
   *  So the rule for editing any comment in this file is the rule the
   *  table already enforces for the code — point at the column, never
   *  re-enumerate what is in it, and never state its size.
   *
   *  A `Record<ForcedCloseReadiness, …>` cannot be written that way: the
   *  compiler refuses it until every state has an entry, so adding a
   *  state forces a decision about every column rather than inheriting
   *  whatever the last `else` happened to be. The previous `body` chain
   *  ended in a bare `: copy.forcedClose.readyInKind`, which means a new
   *  state would have silently described itself as an in-kind transfer.
   *
   *  `not-applicable` is listed even though `shouldRenderForcedClose`
   *  returns false for it — exhaustiveness is the point, and an entry
   *  that says "never rendered" is information.
   *
   *  DO NOT HOIST THIS OUT OF THE COMPONENT. Rebuilding an object of
   *  string lookups on every render looks like an obvious thing to
   *  memoize or lift to module scope, and lifting it would be a bug:
   *  `copy` is a Proxy whose `get` calls `i18n.t(...)` at ACCESS time
   *  (`i18n/reactiveCopy.ts`), and `LanguageRemount` re-keys the tree on
   *  language change so components re-read it. A module-scope table
   *  resolves every string once, at import, in whatever language i18n
   *  had loaded then — which is English before the real bundle
   *  arrives. Every non-English reader would get English on this card
   *  and nowhere else, with nothing failing.
   *
   *  The cost being avoided is ten property reads per render on a card
   *  that renders once per position view. That is not worth a silent
   *  localization regression. */
  const PRESENTATION: Record<
    ForcedCloseReadiness,
    {
      body: string;
      /** May the heading say the loan is overdue? Only states downstream
       *  of an affirmative `defaultable` may (round 28 P2). */
      overdue: boolean;
      /** Does the execution-time match check apply to this state's
       *  stated outcome? True wherever the copy names what the lender
       *  gets AND `attemptInternalMatchAutoDispatch` (line 287) runs
       *  before the branch that would produce it. */
      matchRace: boolean;
      /** Does this state render the action block — the not-exclusive
       *  note, the outcome and claim notes, and the submit affordance
       *  below them? The two note fields are non-null exactly here. */
      actionBlock: boolean;
      /** Null where `actionBlock` is false. */
      outcomeNote: string | null;
      claimNote: string | null;
      rentalReceipt: boolean;
    }
  > = {
    'ready-in-kind': {
      body: copy.forcedClose.readyInKind,
      overdue: true,
      matchRace: true,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNote,
      claimNote: copy.forcedClose.claimNote,
      rentalReceipt: false,
    },
    'ready-needs-route': {
      body: copy.forcedClose.readyNeedsRoute,
      overdue: true,
      // No button here, but its whole message is that a sale must be
      // routed — which a match appearing makes wrong too.
      matchRace: true,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNote,
      claimNote: copy.forcedClose.claimNote,
      rentalReceipt: false,
    },
    'ready-internal-match': {
      body: copy.forcedClose.readyInternalMatch,
      overdue: true,
      // This state IS the match. Its own race warning covers losing it,
      // rendered separately.
      matchRace: false,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNoteInternalMatch,
      claimNote: copy.forcedClose.claimNoteInternalMatch,
      rentalReceipt: false,
    },
    'ready-rental': {
      body: copy.forcedClose.readyRental,
      overdue: true,
      // ROUND 54 P2 — FALSE, and the reasoning that made it true stopped
      // one step short. `LibMetricsHooks` does index every loan into
      // `assetPairActiveLoanIds` with no asset-type filter, so a rental
      // is in the table. Being in the table is not being matchable:
      //
      //  - `hasInternalMatchCandidate` scans the REVERSED pair,
      //    `assetPairActiveLoanIds[collateralAsset][principalAsset]`. A
      //    rental's principal IS the NFT, so every candidate in that
      //    bucket holds that NFT as its COLLATERAL.
      //  - Each candidate must then price both of its own assets through
      //    `tryGetAssetPrice`. An NFT collection has no feed, so the
      //    collateral leg returns `ok=false` and the candidate is
      //    skipped — every time, for every candidate in the bucket.
      //  - And `_settleLeg` moves both matched legs with
      //    `IERC20.safeTransfer` / `vaultWithdrawERC20`, so even a
      //    candidate that somehow passed could not be settled.
      //
      // So the race this flag warns about cannot be lost here: a rental
      // ends as a rental. Warning anyway asserted a settlement route and
      // a funds flow the protocol has no path to, on the card that is
      // meant to be exact about what the lender receives.
      matchRace: false,
      actionBlock: true,
      outcomeNote: copy.forcedClose.outcomeNoteRental,
      claimNote: copy.forcedClose.claimNote,
      rentalReceipt: true,
    },
    'blocked-no-consent': {
      body: copy.forcedClose.blockedNoConsent,
      overdue: true,
      // The sharpest one: this state claims the close-out is refused for
      // EVERYONE, and the match dispatch returns before the consent gate
      // is ever reached.
      matchRace: true,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    'not-yet': {
      body: copy.forcedClose.notYet,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    'blocked-sequencer': {
      body: copy.forcedClose.blockedSequencer,
      // ROUND 50 P3 — true, and it was the round-42 reordering that made
      // it true. `decideForcedClose` now resolves the repayment window
      // BEFORE sequencer health, mirroring the contract (the grace check
      // at DefaultedFacet:249 precedes the sequencer check at :260), so
      // this state is only reachable with `defaultable === true`. The
      // chain HAS said the term and grace elapsed; withholding the
      // overdue heading here discards a fact it established and renders
      // the conditional "If this loan is not repaid" over a loan that
      // demonstrably was not. The sequencer explanation in `body` is a
      // separate statement and is unaffected.
      overdue: true,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    'blocked-paused': {
      body: copy.forcedClose.blockedPaused,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    unknown: {
      body: copy.forcedClose.unknown,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
    // Never rendered — `shouldRenderForcedClose` returns false.
    'not-applicable': {
      body: copy.forcedClose.unknown,
      overdue: false,
      matchRace: false,
      actionBlock: false,
      outcomeNote: null,
      claimNote: null,
      rentalReceipt: false,
    },
  };
  const view = PRESENTATION[readiness];
  const receipt = view.rentalReceipt
    ? copy.forcedClose.rentalReceipt
    : copy.forcedClose.receipt;
  const outcomeNote = view.outcomeNote ?? copy.forcedClose.outcomeNote;
  const claimNote = view.claimNote ?? copy.forcedClose.claimNote;

  /** Which of the three matcher-incentive statements is true for THIS
   *  wallet. Read rather than assumed: `_executeTwoWayMatch` zeroes the
   *  incentive for a sanctioned matcher, and `triggerDefault` is a
   *  Tier-2 path that stays open to one, so the flagged case is a
   *  supported posture rather than an edge.
   *
   *  `ready === false` gets its own sentence instead of defaulting to
   *  either answer. Defaulting to "yours" would promise a transfer that
   *  may not happen; defaulting to "not paid" would tell an unflagged
   *  lender they are flagged. Neither is true yet, so the card says
   *  that. */
  const matcherIncentiveNote = !sanctions.ready
    ? copy.forcedClose.matcherIncentiveUnknown
    : sanctions.flagged
      ? copy.forcedClose.matcherIncentiveNotPaid
      : copy.forcedClose.matcherIncentiveYours;

  /** ROUND 50 P1 — the hold now outlives the wait, so the card has to
   *  say why. "Close-out submitted, give the page a moment" is true for
   *  the first three minutes and becomes a misdescription after them: at
   *  that point the app is not waiting for the page to catch up, it has
   *  stopped being able to account for the transaction. Leaving the
   *  optimistic wording there would present an indefinite disabled
   *  button as an ordinary pause, which is the shape of a hang. */
  /** What happened to the last close-out this card sent, when the chain
   *  has said it did NOT execute. Null while holding, and null for a
   *  success — a success changes the position, and the position speaks
   *  for itself. */
  const lastOutcome =
    disposition === 'reverted'
      ? copy.forcedClose.outcomeReverted
      : disposition === 'cancelled'
        ? copy.forcedClose.outcomeCancelled
        : disposition === 'replaced'
          ? copy.forcedClose.outcomeReplaced
          : null;

  const body = !holdingAfterSubmit
    ? view.body
    : unaccounted
      ? copy.forcedClose.submittedUnaccounted
      : copy.forcedClose.submitted;

  /** The overdue heading ONLY where the chain has actually said so
   *  (round 28 P2): `blocked-paused` is resolved BEFORE `defaultable`,
   *  so during a pause a loan three days into a ninety-day term reaches
   *  it, and mapping that to "This loan is overdue" put a false
   *  statement in the card's largest text. Now a column of the table
   *  above rather than a hand-listed set.
   *
   *  This note used to name `blocked-sequencer` alongside it. That
   *  stopped being true at round 42, when the resolver was reordered to
   *  mirror the contract and the repayment window moved AHEAD of the
   *  sequencer check — see that row for why it is overdue now. The
   *  reasoning here outlived the ordering it was reasoning about, which
   *  is the failure mode a hand-listed set had and a table column was
   *  meant to end; the table was right and the prose beside it was not
   *  (round 50 P3). */
  const overdueEstablished = view.overdue;

  return (
    // The resolved state and its block, STATED rather than left to be
    // inferred from copy (#2098, #2131). Same shape as the lender exit
    // chooser's `data-chooser-*` attributes (#1855): the card says what
    // it decided and as of which block, so a consumer that reads copy to
    // recover the state is reading a weaker source than the one the card
    // could simply publish. `data-forced-close-block` is omitted, not
    // zeroed, when there is no block to name — an absent attribute is
    // "unknown", where `0` would be a number.
    <section
      className="card"
      data-testid="forced-close-card"
      data-forced-close-state={readiness}
      data-forced-close-block={
        resolvedBlock === undefined ? undefined : String(resolvedBlock)
      }
    >
      <div className="card-title">
        <AlertTriangle aria-hidden />
        <h3 style={{ margin: 0 }}>
          {overdueEstablished
            ? copy.forcedClose.title
            : copy.forcedClose.titlePending}
        </h3>
      </div>

      <p className="muted" data-testid="forced-close-body">
        {body}
      </p>

      {/* The way out of an unaccounted transaction.
       
          Round 53's persistence closed a hole and opened a smaller one:
          the record used to die with the page, so a reload cleared a
          stuck hold by accident. Now it survives, and a lender whose
          transaction genuinely vanished had no route back to the action
          at all — the app refusing forever, on a funds path, over
          something it cannot itself verify.
       
          It cannot verify it, so it asks the one party who can. This is
          deliberately worded as the lender's statement about their own
          wallet rather than as a reset control, and it carries the cost
          of being wrong, because that is the honest shape of a question
          the app is not able to answer. */}
      {/* ROUND 63 P2 — say WHICH ending happened.
       
          The three non-success dispositions release the hold, and the
          card used to go straight back to its ordinary copy and button
          as though nothing had been submitted. It knows more than that:
          the chain told it whether the call reverted, whether the wallet
          cancelled it, or whether another transaction took its nonce.
          Discarding that leaves the lender to infer a funds-path outcome
          from a screen that looks untouched.
       
          Rendered beside the ordinary copy rather than in place of it,
          because the position IS actionable again — the note explains
          what happened to the last attempt, it does not describe the
          current state of the loan. Keyed on the disposition alone; the
          submission record has already been cleared by then, but the
          in-memory entry survives the session, which is exactly as long
          as this sentence is useful. */}
      {!holdingAfterSubmit && submitted !== null && lastOutcome !== null ? (
        <p className="field-hint" data-testid="forced-close-last-outcome">
          {lastOutcome}
        </p>
      ) : null}

      {/* This browser could not record the submission, so a reload will
          lose it. The hold on this mount is unaffected; what is lost is
          everything after a reload, which is exactly the protection
          round 53 added — so the lender is told rather than left to find
          out by being offered the button again. */}
      {holdingAfterSubmit && storageRefusedFor !== null &&
      storageRefusedFor === submittedHash ? (
        <p className="field-hint" data-testid="forced-close-not-stored">
          {copy.forcedClose.submitRecordNotStored}
        </p>
      ) : null}

      {holdingAfterSubmit && unaccounted ? (
        <div data-testid="forced-close-forget">
          <p className="field-hint">{copy.forcedClose.forgetSubmissionNote}</p>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              writeForcedCloseSubmission(walletChain?.chainId, loanId, null);
              setSubmissions((prev) => {
                const next = { ...prev };
                delete next[submissionKey];
                return next;
              });
            }}
          >
            {copy.forcedClose.forgetSubmission}
          </button>
        </div>
      ) : null}

      {/* The match-race warning is its OWN paragraph, not appended to
          the body with a space.
       
          Round 39 built it as `${body} ${raceIntro} ${raceOutcome}`,
          which joins three complete sentences with an ASCII space in
          every language. Japanese and Chinese end a sentence with `。`
          and do not follow it with one, so that produced a stray gap
          mid-paragraph in two of the ten locales — the same class of
          bug `provenanceAge` in copy.ts already carries a warning about,
          where a wrapper added punctuation the translation had supplied.
          The lead-in is now folded into each fallback string at
          authoring time — with a space for the locales that use one
          between sentences and none for Japanese and Chinese — so
          nothing is composed at runtime and there is no join
          character to get wrong. That matches `consentParts`, where
          even the ' and ' and the final '.' are localized strings
          rather than literals in the JSX. */}
      {readiness === 'ready-internal-match' && !holdingAfterSubmit ? (
        <p className="muted" data-testid="forced-close-race">
          {raceOutcome}
        </p>
      ) : null}

      {/* The SAME race, seen from the other side (round 44 P2). This card
          disclosed only match -> something-else. `triggerDefault`
          re-checks for an opposing position at DefaultedFacet.sol:287,
          after this card's read AND after the pre-submit simulation, so
          something-else -> match is equally live: a loan that read as
          in-kind, or as needing a routed sale, can settle as a match and
          repay the lent asset instead of moving collateral.

          Shown on every state whose copy names an outcome the contract
          could reach a different way — which is the `matchRace` column of
          the table above, and deliberately not a set restated here.

          It has been wrong in both directions, which is why it is a
          column. The first version covered `ready-in-kind` and
          `ready-needs-route` only — the same half-a-symmetric-disclosure
          mistake the finding was about, one cycle later. Widening it to
          every non-terminal state then swept in `ready-rental`, where the
          contract has no such path at all (see below). Both corrections
          were made by hand, and a third sentence restating the result is
          how the second one survived a round.

          `blocked-no-consent` is the sharpest of them: it says the
          close-out is refused FOR EVERYONE. The dispatch at
          DefaultedFacet.sol:287 returns before the consent-gated in-kind
          branch is ever reached, and `hasInternalMatchCandidate` filters
          only on status and matchable collateral — not on consent, not
          on asset type — so a candidate appearing makes that absolute
          claim false. Its copy now says "as things stand" and this
          sentence supplies the exception.

          `ready-rental` DOES NOT qualify, and this paragraph said the
          opposite until round 55 caught it — the row's own entry had
          already been corrected and this maintenance note beside the
          render condition still argued for restoring the warning, which
          is precisely how a hand-picked set grows back.

          The argument it used to make ends one step early. Rentals ARE
          indexed with no asset-type filter, and being indexed is not
          being matchable: the candidate scan reads the REVERSED pair, so
          every candidate holds the rented NFT as collateral; each is then
          required to price both of its own assets, which that leg cannot
          do; and `_settleLeg` moves both matched legs as ERC-20 anyway.
          Those steps are on the `ready-rental` row. So a rental ends as a
          rental, and its row says `matchRace: false` — which is the
          entire statement, and the sentence stops there. */}
      {view.matchRace && !holdingAfterSubmit ? (
        <p className="muted" data-testid="forced-close-match-may-appear">
          {copy.forcedClose.matchMayAppear}
        </p>
      ) : null}

      {/* Shown on every actionable state — a lender who cannot submit
          from here still needs to know a keeper may close it, so that
          finding the position already closed reads as normal rather than
          as loss.

          Its old comment said "both ready states" while the condition
          listed four, which is the same rot in miniature: the set grew
          and the sentence describing it did not. It is a table column
          now, so there is no set to describe. */}
      {!holdingAfterSubmit && view.actionBlock ? (
        <>
          <p className="field-hint">{copy.forcedClose.notExclusive}</p>
          <p className="field-hint">{outcomeNote}</p>
          <p className="field-hint">{claimNote}</p>
          {/* ROUND 50 P2 — its own paragraph, and its own eligibility.
              Only the internal-match route pays a matcher incentive at
              all, and only to a wallet the sanctions oracle has not
              flagged. Rendering it beside the claim note rather than
              inside it is what lets the two vary independently without
              composing a sentence at runtime. */}
          {readiness === 'ready-internal-match' ? (
            <p className="field-hint" data-testid="forced-close-incentive">
              {matcherIncentiveNote}
            </p>
          ) : null}
        </>
      ) : null}

      {submittable ? (
        <>
          {/* Shown only where a swap-to-repay intent could exist.
              `SwapToRepayIntentFacet` reverts `UnsupportedLoanShape`
              unless both legs are ERC-20 and both are Liquid, so a
              rental, NFT collateral, or an illiquid asset on either leg
              can never carry one.

              Round 40 exempted rentals alone, which left the note on an
              ERC-20 loan secured by NFT or illiquid collateral, where it
              is equally unreachable. I recorded that as a residual and
              judged the extra prop not worth it; round 41 disagreed, and
              was right — the whole point of the rule in the functional
              spec is that unreachable conditions appear only where they
              are reachable, and a partial application of it is just the
              same bug with a smaller blast radius.

              ASYMMETRIC ON PURPOSE: suppressed only on a POSITIVE `false`.
              An unread shape (`undefined`) still shows the note, because
              the two errors are not equal — displaying a conditional
              that never fires costs a sentence, while hiding a live one
              means a lender cancels the borrower's pending order without
              being told. */}
          {swapToRepayPossible !== false ? (
            <p className="field-hint">{copy.forcedClose.intentNote}</p>
          ) : null}
          {error ? (
            <div
              className="banner banner-danger"
              role="alert"
              style={{ marginBottom: 12 }}
            >
              {error}
            </div>
          ) : null}
          {!confirmOpen ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenConfirm}
              disabled={busy || !ready}
              data-testid="forced-close-submit"
            >
              {copy.forcedClose.submit}
            </button>
          ) : (
            <div style={{ marginTop: 8 }}>
              <ConfirmReceipt
                busy={busy}
                // ROUND 47 P1, SECOND HALF — found reviewing my own fix.
                // Stamping in `onSubmitted` gates `submittable`, which
                // gates the OUTER button — but that button is not
                // rendered while the confirmation is open, and after a
                // failed receipt wait the confirmation IS still open
                // (`onCloseConfirm` runs only on success). Its confirm
                // button is `disabled={busy || disabled}`, and this card
                // was passing only `busy` — which `finally` has just
                // cleared. So the exact retry the P1 describes stayed
                // one click away, through the panel rather than the
                // button.
                disabled={holdingAfterSubmit}
                confirmLabel={copy.forcedClose.submit}
                onBack={onCloseConfirm}
                onConfirm={closeOut}
                data={{
                  youReceive: receipt.youReceive,
                  youLock: receipt.youLock,
                  youMayOwe: receipt.youMayOwe,
                  youCanLose: receipt.youCanLose,
                  fees: receipt.fees,
                  whenThisEnds: receipt.whenThisEnds,
                }}
              />
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
