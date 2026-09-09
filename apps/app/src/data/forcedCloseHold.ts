/**
 * Whether the forced-close card is still holding its action after a
 * submit — extracted from `ForcedCloseCard` so it can be tested.
 *
 * ## Why this is its own module
 *
 * This one predicate has been wrong in FOUR consecutive review rounds
 * (47, 48, 49, 50), each fix introducing the next round's defect, and
 * every one of them was a question about a small set of discrete cases
 * — the kind a table settles and prose does not. It sat inside a
 * component with no unit test, so each version was argued from its own
 * comment rather than from cases, and the comment was twice wrong about
 * the code directly beneath it.
 *
 * The history, because it is the specification:
 *
 * - **Round 28** asked for the hold. After a successful close-out the
 *   readiness reads keep serving pre-close values while they
 *   revalidate, so the button reappeared under the lender within the
 *   same second and invited a second wallet prompt on a terminal loan.
 * - **Round 29** caught that the first hold never released. A partial
 *   internal match settles part of the position and deliberately leaves
 *   the loan Active, so a permanent latch replaced an actionable card
 *   with "the loan is ending" on a residual that still needed closing.
 * - **Round 47/48** established that read timestamps are not evidence
 *   about a transaction: `readsUpdatedAt` is a MIN across reads, one of
 *   which does not poll, so the freshness rule failed in both
 *   directions — latching indefinitely on one path, releasing with the
 *   transaction unresolved on another.
 * - **Round 49** established that the endings are not interchangeable:
 *   the freshness arm belongs to success alone, because the other paths
 *   never reach the invalidation that would satisfy it.
 * - **Round 50** established the converse, and it is the subtle one:
 *   `undetermined` is NOT an ending. A transaction still pending has
 *   not been dropped, and releasing on a timer queues a second
 *   close-out behind a live first one.
 * - **Round 52** moved the success anchor off the SEND and onto the
 *   MINE. Reads can refresh between the two while still describing the
 *   pre-close loan, so the old anchor was already satisfied when success
 *   arrived — the slower the transaction, the more likely the wrong
 *   release. It also added `replaced`.
 * - **Round 53** made the record survive a reload rather than only a
 *   chain switch (see the store at the bottom of this file); keying it
 *   in component state answered one of those and not the other.
 *
 * ## The rule
 *
 * Hold while the disposition is unknown. Hold after a success until
 * EVERY read postdates the DISPOSITION — not the submit; that
 * distinction is round 52 and it is the easiest sentence in this file to
 * get wrong. Release on anything the chain has actually settled against
 * the close-out having happened.
 *
 * ROUND 57 P3 — "every", not "one", and the difference is the whole
 * reason `readsUpdatedAt` is a MINIMUM. The release condition is
 * `readsUpdatedAt > disposedAt`; when that value is the smallest
 * `dataUpdatedAt` across the card's reads, it exceeding the disposition
 * means every one of them does. This file declares itself the
 * specification, so "one read" was an invitation to swap the minimum for
 * a maximum — which would re-enable the action against a mixture of pre-
 * and post-close state, the exact thing round 28 asked for the hold to
 * prevent.
 */

import { makePendingMarkerStore } from '../lib/pendingMarker';

/** What the chain has established about a submitted close-out.
 *
 *  Three of these mean "the close-out did not execute" and all three
 *  release the hold, yet they stay separate because they are reached
 *  differently and a lender is owed the difference: the call itself
 *  failed, the wallet cancelled it, or something else took its place in
 *  the queue. Collapsing them would save a branch and lose the only
 *  thing the card can honestly say about what happened. */
export type ForcedCloseDisposition =
  | 'success'
  /** Our call executed and reverted. */
  | 'reverted'
  /** Replaced by a zero-value self-send at the same nonce. */
  | 'cancelled'
  /** A DIFFERENT transaction took the nonce, so ours can never execute
   *  (round 52 P2). Distinct from `cancelled` in how it is reached and
   *  in what it lets the card say, identical in consequence: the
   *  close-out did not happen, and the nonce is spent, so this is
   *  positive evidence rather than an unknown. `repriced` is deliberately
   *  NOT here — a Speed Up carries our own call at a higher gas price,
   *  so it resolves to `success` or `reverted` on its own receipt. */
  | 'replaced'
  | 'undetermined';

export interface ForcedCloseHoldInput {
  /** When the close-out was submitted, or `null` if none is
   *  outstanding for this card, chain and loan. */
  submittedAt: number | null;
  /** The disposition so far — `null` while the first wait is still
   *  running, which is as unknown as `undetermined` and holds for the
   *  same reason. */
  disposition: ForcedCloseDisposition | null;
  /** When the disposition was ESTABLISHED, or `null` while there is
   *  none.
   *
   *  ROUND 52 P2 — the success arm used to compare against
   *  `submittedAt`, and that is the wrong anchor. Anything can refresh
   *  the readiness queries between the send and the mine: another card
   *  on the page, a window refocus, an ordinary poll. Those reads
   *  postdate the SEND while still describing the pre-close loan, so on
   *  a slow transaction `readsUpdatedAt > submittedAt` was already true
   *  when success arrived, and the hold released instantly onto the
   *  stale route it exists to suppress.
   *
   *  The mine is what the reads have to postdate, and this is the
   *  earliest moment the app can know of it. It is never earlier than
   *  the mine, so the test is conservative in the safe direction. */
  disposedAt: number | null;
  /** The MINIMUM `dataUpdatedAt` across the reads the card's readiness
   *  is computed from. A minimum rather than a maximum on purpose: the
   *  question is whether EVERY input postdates the close-out, and one
   *  stale read is enough to make the verdict pre-close. */
  readsUpdatedAt: number;
}

export function isHoldingAfterSubmit(input: ForcedCloseHoldInput): boolean {
  if (input.submittedAt === null) return false;

  // Nothing established yet. Round 50's finding: this is the one case
  // where saying "no disposition, so treat it as failed" costs real
  // money — the transaction can still mine, and the second close-out
  // queued behind it pays a fee for nothing at best.
  if (input.disposition === null || input.disposition === 'undetermined') {
    return true;
  }

  // The close-out landed. The position has changed, so hold until the
  // readiness verdict on screen was computed from post-close data —
  // round 28's reason, and the only arm this condition belongs to
  // (round 49).
  if (input.disposition === 'success') {
    // Falls back to the submit stamp only if a success somehow arrives
    // without a timestamp. That is a strictly weaker test, so it is a
    // fallback and not the rule — see `disposedAt`.
    return input.readsUpdatedAt <= (input.disposedAt ?? input.submittedAt);
  }

  // `reverted`, `cancelled` and `replaced`: the chain says the close-out
  // did not execute. Nothing changed, a retry is legitimate, and applying the
  // freshness arm here latches the action shut for good, because
  // neither path reaches the invalidation that would advance
  // `readsUpdatedAt`.
  return false;
}

/**
 * Has the close-out been outstanding long enough that the card should
 * stop calling it an ordinary pause?
 *
 * ## Why this is not `Date.now() - submittedAt`
 *
 * ROUND 57 P2. It was, and a device clock that moves BACKWARD after the
 * submit — an NTP correction, a manual change, a marker written while
 * the clock was wrong and read after it was fixed — made that
 * subtraction negative and kept it negative until wall time caught up.
 *
 * That is not a cosmetic bug, because of what this value gates. A
 * transaction that was genuinely dropped never produces a disposition,
 * so the hold never releases on evidence; the ONLY way back to the
 * action is the lender saying their wallet no longer shows the
 * transaction, and that control appears only when this is true. A
 * backward clock jump therefore leaves a real position permanently
 * unclosable from the app, with no route out — for as long as the offset
 * lasts, which for a mis-set clock can be months.
 *
 * ## The rule
 *
 * Take the LARGER of two elapsed measures, so neither can block:
 *
 * - **Monotonic**, ticked by the card from when this mount first saw
 *   the submission. `performance.now()` is immune to clock changes, and
 *   it is the measure that guarantees the escape hatch eventually
 *   appears. It restarts on remount, which is conservative in the safe
 *   direction: a reload costs at most one more threshold's wait.
 * - **Wall clock**, from the record's own stamp. This is what makes a
 *   returning lender see the true state immediately rather than waiting
 *   out the threshold again. A negative or non-finite value contributes
 *   NOTHING rather than dominating — that is the clock-correction case,
 *   and a measurement that cannot be right must not be allowed to speak.
 *
 * The trade this accepts, stated because it is real: a clock that jumps
 * FORWARD makes the wall measure large, so the card may say it has lost
 * track of a transaction sent moments ago. On a fresh mount that case is
 * indistinguishable from the ordinary "submitted an hour ago, then
 * reloaded", which is common and legitimate — so it is not filtered out.
 * The cost is bounded: it changes wording and offers the lender a
 * control whose copy states plainly what it costs to use wrongly. The
 * cost in the other direction was an unclosable position.
 */
export function isUnaccounted(input: {
  /** Milliseconds this mount has held the submission, measured on a
   *  monotonic clock. Zero before the first tick, and zero when no
   *  measurement for this transaction exists yet — both of which are
   *  "no monotonic evidence", which is what a zero contributes. */
  monotonicMs: number;
  /** The record's wall-clock submit stamp. */
  submittedAt: number;
  /** The current wall-clock time. */
  nowWall: number;
  thresholdMs: number;
}): boolean {
  const wall = input.nowWall - input.submittedAt;
  const elapsed = Math.max(
    Number.isFinite(input.monotonicMs) && input.monotonicMs > 0
      ? input.monotonicMs
      : 0,
    Number.isFinite(wall) && wall > 0 ? wall : 0,
  );
  return elapsed > input.thresholdMs;
}

/** Device-local record of a close-out this browser broadcast.
 *
 *  ROUND 53 P1 — round 52 keyed the submission by chain and loan, which
 *  fixed a chain switch and nothing else, because the map was component
 *  state. A reload or a navigation away from `/positions/:loanId`
 *  destroys it just as completely as clearing it did, and returning then
 *  presents the button over a transaction that may still be mining. A
 *  reload is the more likely of the two by some margin.
 *
 *  It uses the same `makePendingMarkerStore` every other "remember what I
 *  just broadcast" record in this app uses (sale listing, offset,
 *  refinance, stuck-token recovery) rather than a private one, so the
 *  keying scheme, the storage-refused behaviour and the cross-tab key
 *  shape are defined once. This is the SAFETY tier of that store's two:
 *  losing the record does not merely cost an affordance, it re-offers a
 *  funds-moving action over an unresolved transaction — so `write`
 *  reports whether it landed and the caller is expected to care.
 *
 *  The value is `<hash>:<submittedAtMs>`. Both halves are needed: the
 *  hash is what gets watched, and the timestamp is the fallback anchor
 *  when a disposition arrives without one. */

const submitMarker = makePendingMarkerStore('app.forcedCloseSubmit');

export interface ForcedCloseSubmission {
  hash: `0x${string}`;
  at: number;
}

/** The literal storage key a record lives under.
 *
 *  Exposed so a caller can recognise its OWN key in a cross-tab
 *  `storage` event without duplicating the naming scheme — the reason
 *  `PendingMarkerStore` exposes `key()` at all (#1547 r8), and the shape
 *  `Recover` already follows. */
export function forcedCloseSubmissionKey(
  chainId: number,
  loanId: string | number,
): string {
  return submitMarker.key(chainId, String(loanId));
}

export function readForcedCloseSubmission(
  chainId: number | undefined,
  loanId: string | number,
): ForcedCloseSubmission | null {
  if (chainId === undefined) return null;
  const raw = submitMarker.read(chainId, String(loanId));
  if (raw === null) return null;
  // Tolerant of a malformed record rather than throwing on it: a value
  // this browser cannot parse is one it cannot act on either, and a
  // parse error here would take down the whole card. Treated as "no
  // record", which is the same posture as storage being unavailable.
  const at = raw.lastIndexOf(':');
  if (at <= 0) return null;
  const hash = raw.slice(0, at);
  const ts = Number(raw.slice(at + 1));
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash) || !Number.isFinite(ts) || ts <= 0) {
    return null;
  }
  return { hash: hash as `0x${string}`, at: ts };
}

/** @returns false when storage refused the write (private mode, quota,
 *  storage disabled) — the caller must not treat that as recorded. */
export function writeForcedCloseSubmission(
  chainId: number | undefined,
  loanId: string | number,
  submission: ForcedCloseSubmission | null,
): boolean {
  if (chainId === undefined) return false;
  return submitMarker.write(
    chainId,
    String(loanId),
    submission === null ? null : `${submission.hash}:${submission.at}`,
  );
}
