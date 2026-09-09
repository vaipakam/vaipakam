/**
 * `isHoldingAfterSubmit` — the post-submit hold on the forced-close
 * action.
 *
 * Written as the regression suite for the review rounds that each fixed
 * this predicate and broke it again — 47, 48, 49, 50, then 52 moving the
 * success anchor and adding a disposition.
 * Every case below is labelled with the round whose defect it pins, so
 * a future edit that reintroduces one fails against the round that
 * found it rather than against an anonymous assertion.
 *
 * The two directions matter differently and both are here:
 *
 * - Releasing too EARLY re-offers a button while a close-out may still
 *   be live. That costs a fee at best, and acts against a partially
 *   settled residual at worst.
 * - Releasing too LATE — never — strands a lender on a residual that
 *   genuinely still needs closing, with no way back short of a reload.
 *
 * A predicate that only guards one of those passes half a suite and
 * ships the other bug, which is exactly how this went round after
 * round.
 */
import { describe, expect, it } from 'vitest';
import {
  isHoldingAfterSubmit,
  type ForcedCloseDisposition,
} from './forcedCloseHold';

const SUBMITTED_AT = 1_800_000_000_000;
/** A read that settled AFTER the submit — the card's evidence that the
 *  verdict on screen is post-close. */
const FRESH = SUBMITTED_AT + 1;
/** A read that settled BEFORE it, i.e. still describes the loan as it
 *  was when the close-out was sent. */
const STALE = SUBMITTED_AT - 1;
/** When a disposition was established — always AFTER the send, which is
 *  the whole point of round 52 P2: reads may legitimately refresh in
 *  between while still describing the pre-close loan. */
const DISPOSED_AT = SUBMITTED_AT + 30_000;
/** A read that settled after the DISPOSITION, i.e. the only reads that
 *  can describe the loan post-close. */
const AFTER_DISPOSAL = DISPOSED_AT + 1;
/** The case this file exists to pin twice over: newer than the send,
 *  older than the mine. Everything the app can see refreshed, and all of
 *  it still describes the loan before the close-out. */
const BETWEEN = SUBMITTED_AT + 15_000;

describe('isHoldingAfterSubmit — nothing outstanding', () => {
  it('does not hold when no close-out has been submitted', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: null,
        disposition: null,
        disposedAt: null,
        readsUpdatedAt: STALE,
      }),
    ).toBe(false);
  });

  // The card is mounted long before anything is submitted, and its
  // reads are older than any stamp that does not exist. Keying off the
  // timestamps alone would hold on first paint.
  it('does not hold on a stale read when nothing was submitted', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: null,
        disposition: 'undetermined',
        disposedAt: null,
        readsUpdatedAt: 0,
      }),
    ).toBe(false);
  });
});

describe('isHoldingAfterSubmit — disposition not yet established', () => {
  // ROUND 50 P1. Both of these released before the fix: the timeout
  // marked the transaction "gone" and the button came back while it
  // could still mine, queueing a second close-out behind a live first.
  it('holds while the first wait is still running', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: null,
        disposedAt: null,
        readsUpdatedAt: FRESH,
      }),
    ).toBe(true);
  });

  it('holds when the wait timed out without a disposition', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'undetermined',
        disposedAt: null,
        readsUpdatedAt: FRESH,
      }),
    ).toBe(true);
  });

  // The distinguishing case, and the reason a fresh read must not be
  // allowed to stand in for a disposition. Everything the app can see
  // has refreshed; the transaction is still unaccounted for. Releasing
  // here is the round-47 defect wearing the round-50 mask.
  it('holds on an undetermined transaction even when every read is fresh', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'undetermined',
        disposedAt: null,
        readsUpdatedAt: SUBMITTED_AT + 10 * 60_000,
      }),
    ).toBe(true);
  });
});

describe('isHoldingAfterSubmit — the close-out landed', () => {
  // ROUND 28 P2 — the reason the hold exists at all.
  it('holds after a success until a read postdates the submit', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: STALE,
      }),
    ).toBe(true);
  });

  // ROUND 29 — a partial internal match leaves the loan Active, so the
  // hold MUST end once the reads have caught up. The first version of
  // this hold never released and stranded exactly that residual.
  //
  // Asserted against a read that postdates the DISPOSITION, not the
  // send. Round 52 P2 moved that anchor, and this case moved with it —
  // the round-29 guarantee is "it eventually releases", not "it releases
  // against this particular timestamp", so tightening the anchor must
  // not be allowed to quietly weaken it into never releasing.
  it('releases after a success once a read postdates the disposition', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: AFTER_DISPOSAL,
      }),
    ).toBe(false);
  });

  // The boundary is deliberately EXCLUSIVE: a read bearing the same
  // millisecond as the disposition is not evidence that it postdates it.
  it('still holds when a read carries exactly the disposition timestamp', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: DISPOSED_AT,
      }),
    ).toBe(true);
  });

  // ROUND 52 P2 — THE case, and the one the previous anchor got wrong.
  // Anything can refresh the readiness queries between the send and the
  // mine: another card on the page, a window refocus, an ordinary poll.
  // Those reads postdate the SEND and still describe the pre-close loan,
  // so anchoring to `submittedAt` released the hold the instant success
  // arrived — straight onto the stale actionable route the hold exists
  // to suppress. Anchored to the disposition, it holds.
  it('holds after a success when the reads predate the mine but postdate the send', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: BETWEEN,
      }),
    ).toBe(true);
  });

  it('releases once a read postdates the DISPOSITION', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: AFTER_DISPOSAL,
      }),
    ).toBe(false);
  });

  // The fallback, exercised so it is a decision rather than an accident:
  // a success with no timestamp falls back to the submit stamp, which is
  // strictly weaker but never wrong in the unsafe direction relative to
  // having no test at all.
  it('falls back to the submit stamp when no disposition time is known', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: null,
        readsUpdatedAt: STALE,
      }),
    ).toBe(true);
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        disposedAt: null,
        readsUpdatedAt: FRESH,
      }),
    ).toBe(false);
  });
});

describe('isHoldingAfterSubmit — the close-out did not execute', () => {
  // ROUND 49 P1. Both of these held forever before the fix. Neither
  // path reaches the invalidation that advances `readsUpdatedAt`, and
  // the consent read does not poll, so the freshness arm had nothing
  // to satisfy it and the action never came back.
  it('releases immediately on a revert, even with every read stale', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'reverted',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: STALE,
      }),
    ).toBe(false);
  });

  // ROUND 50 P2 — a cancellation is positive evidence, not an unknown.
  // It is reached through a replacement rather than a failed call, and
  // its receipt reports `status: 'success'`, so a version of this that
  // reads the receipt instead of the disposition holds here (or worse,
  // reports the close-out as done).
  it('releases immediately on a cancellation, even with every read stale', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'cancelled',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: STALE,
      }),
    ).toBe(false);
  });

  // ROUND 52 P2 — a DIFFERENT transaction took the nonce, so ours can
  // never execute. `ownReceipt.settled` already classified this
  // correctly; the card's inline copy of that logic handled only
  // `cancelled` and read the replacement's receipt instead, so an
  // unrelated successful transaction at the same nonce reported as a
  // successful close-out. That is the worst of the three outcomes: it
  // does not merely hold or release wrongly, it asserts the loan closed
  // when nothing of ours ran.
  it('releases immediately on an unrelated nonce replacement', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'replaced',
        disposedAt: DISPOSED_AT,
        readsUpdatedAt: STALE,
      }),
    ).toBe(false);
  });

  // The freshness arm must not leak onto these three. Same inputs as the
  // success cases above, opposite answer — which is the whole content
  // of round 49, now over the widened set.
  it('ignores read freshness entirely on the non-executing endings', () => {
    for (const disposition of ['reverted', 'cancelled', 'replaced'] as const) {
      for (const readsUpdatedAt of [0, STALE, SUBMITTED_AT, FRESH, AFTER_DISPOSAL]) {
        expect(
          isHoldingAfterSubmit({
            submittedAt: SUBMITTED_AT,
            disposition,
            disposedAt: DISPOSED_AT,
            readsUpdatedAt,
          }),
        ).toBe(false);
      }
    }
  });
});

describe('isHoldingAfterSubmit — exhaustive over the disposition space', () => {
  // Names every disposition explicitly rather than iterating a derived
  // list: adding a fifth one to the union should make this fail to
  // compile, so the new case gets a decision here instead of falling
  // into whichever branch it lands in.
  const ALL: Record<ForcedCloseDisposition, boolean> = {
    // Against a read that postdates the DISPOSITION, so every
    // established ending releases and only the unknown holds. Adding a
    // member to the union breaks this literal, which is the point: the
    // new case gets a decision here rather than falling into whichever
    // branch it happens to land in. That is not hypothetical — round
    // 52's `replaced` arrived exactly this way and this table refused to
    // compile until it was answered.
    success: false,
    reverted: false,
    cancelled: false,
    replaced: false,
    undetermined: true,
  };

  it('holds only for an unestablished disposition once reads postdate the disposition', () => {
    for (const [disposition, expected] of Object.entries(ALL) as [
      ForcedCloseDisposition,
      boolean,
    ][]) {
      expect(
        isHoldingAfterSubmit({
          submittedAt: SUBMITTED_AT,
          disposition,
          disposedAt: DISPOSED_AT,
          readsUpdatedAt: AFTER_DISPOSAL,
        }),
      ).toBe(expected);
    }
  });

  it('holds for everything except the three non-executing endings when reads are stale', () => {
    const staleExpected: Record<ForcedCloseDisposition, boolean> = {
      success: true,
      reverted: false,
      cancelled: false,
      replaced: false,
      undetermined: true,
    };
    for (const [disposition, expected] of Object.entries(staleExpected) as [
      ForcedCloseDisposition,
      boolean,
    ][]) {
      expect(
        isHoldingAfterSubmit({
          submittedAt: SUBMITTED_AT,
          disposition,
          disposedAt: DISPOSED_AT,
        readsUpdatedAt: STALE,
        }),
      ).toBe(expected);
    }
  });
});
