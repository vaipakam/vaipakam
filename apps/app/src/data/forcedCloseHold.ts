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
 *
 * ## The rule
 *
 * Hold while the disposition is unknown; hold after a success until one
 * read postdates the submit; release on anything the chain has actually
 * settled against the close-out having happened.
 */

/** What the chain has established about a submitted close-out.
 *
 *  `cancelled` is separate from `reverted` because they are reached
 *  differently — a wallet replaced the send with a no-op, rather than
 *  the call itself failing — even though both mean the close-out did
 *  not execute and both release the hold. Keeping them apart is what
 *  lets the caller tell a lender which happened. */
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
