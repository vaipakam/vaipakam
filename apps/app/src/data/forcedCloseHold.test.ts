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
  isUnaccounted,
  type ForcedCloseDisposition,
} from './forcedCloseHold';

const SUBMITTED_AT = 1_800_000_000_000;

/** The post-success refresh has come back — every readiness read now
 *  reflects the closed position, so the verdict on screen is safe to act
 *  on. ROUND 59 P2 replaced a comparison of two wall-clock stamps with
 *  this, because a device clock corrected backwards falsified that
 *  comparison however it was written. */
const REFRESHED = true;
/** It has not. Either it is still in flight, or nothing triggered it —
 *  and both mean the figures on screen may still be the pre-close ones. */
const NOT_REFRESHED = false;

describe('isHoldingAfterSubmit — nothing outstanding', () => {
  it('does not hold when no close-out has been submitted', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: null,
        disposition: null,
        readsRefreshedSinceDisposition: NOT_REFRESHED,
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
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
        readsRefreshedSinceDisposition: REFRESHED,
      }),
    ).toBe(true);
  });

  it('holds when the wait timed out without a disposition', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'undetermined',
        readsRefreshedSinceDisposition: REFRESHED,
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
      }),
    ).toBe(true);
  });

  // The round-29 guarantee — it MUST eventually release — and the
  // boundary case that used to sit beside it are now both expressed
  // against the completion signal below, because neither survives as a
  // timestamp question. There is no "same millisecond as the
  // disposition" any more: the refresh has either come back or it has
  // not.

  // ROUND 52 P2 was about WHICH wall-clock stamp the reads had to
  // postdate — the send or the mine — and round 59 removed the question
  // by removing the stamps. The property it protected is now structural:
  // the refresh is fired when the disposition is established, so waiting
  // for its completion is waiting for something strictly after the mine.
  // There is no longer an anchor to set wrongly, which is why this reads
  // as two cases instead of five.
  it('holds after a success until the refresh it triggered comes back', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        readsRefreshedSinceDisposition: NOT_REFRESHED,
      }),
    ).toBe(true);
  });

  // ROUND 29 — it MUST eventually release. A partial internal match
  // settles part of the position and leaves the loan Active, so a hold
  // that never ends replaces an actionable card with "the loan is
  // ending" on a residual that still needs closing.
  it('releases once that refresh has completed', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        readsRefreshedSinceDisposition: REFRESHED,
      }),
    ).toBe(false);
  });

  // ROUND 59 P2, stated as the invariant rather than as a scenario: the
  // release depends on NOTHING but the completion signal. The old arm
  // ordered two `Date.now()` stamps, so a device clock corrected
  // backwards between the disposition and the reads completing made a
  // completed read look older than the disposition it followed, and the
  // hold latched on a live residual. A boolean has no ordering to
  // falsify — this case exists so that reintroducing any clock input to
  // this arm has to break a test.
  it('depends only on the refresh signal, on both sides', () => {
    const holds = (readsRefreshedSinceDisposition: boolean) =>
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        readsRefreshedSinceDisposition,
      });
    expect(holds(NOT_REFRESHED)).toBe(true);
    expect(holds(REFRESHED)).toBe(false);
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
      }),
    ).toBe(false);
  });

  // The refresh arm must not leak onto these three. Same inputs as the
  // success cases above, opposite answer — which is the whole content
  // of round 49, now over the widened set. None of these paths triggers
  // a refresh, so if the arm applied here it would latch forever.
  it('ignores the refresh signal entirely on the non-executing endings', () => {
    for (const disposition of ['reverted', 'cancelled', 'replaced'] as const) {
      for (const refreshed of [REFRESHED, NOT_REFRESHED]) {
        expect(
          isHoldingAfterSubmit({
            submittedAt: SUBMITTED_AT,
            disposition,
            readsRefreshedSinceDisposition: refreshed,
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
    // With the post-success refresh COMPLETED, so every established
    // ending releases and only the unknown holds. Adding a
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

  it('holds only for an unestablished disposition once the refresh is back', () => {
    for (const [disposition, expected] of Object.entries(ALL) as [
      ForcedCloseDisposition,
      boolean,
    ][]) {
      expect(
        isHoldingAfterSubmit({
          submittedAt: SUBMITTED_AT,
          disposition,
          readsRefreshedSinceDisposition: REFRESHED,
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
        readsRefreshedSinceDisposition: NOT_REFRESHED,
        }),
      ).toBe(expected);
    }
  });
});

/**
 * `isUnaccounted` — round 57 P2.
 *
 * The bug: the card computed this as `Date.now() - submittedAt`, so a
 * device clock corrected BACKWARD after the submit kept the value
 * negative until wall time caught up. That is not cosmetic. A dropped
 * transaction never produces a disposition, so the hold never releases
 * on evidence, and the only way back to the action is the lender saying
 * their wallet no longer shows it — a control that appears only when
 * this is true. A backward jump therefore left a real position
 * permanently unclosable from the app.
 */
describe('isUnaccounted', () => {
  const THRESHOLD = 3 * 60_000;
  const SUBMITTED_AT = 1_000_000;

  it('is false before the threshold on either measure', () => {
    expect(
      isUnaccounted({
        monotonicMs: 60_000,
        submittedAt: SUBMITTED_AT,
        nowWall: SUBMITTED_AT + 60_000,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(false);
  });

  it('is true once the wall clock passes the threshold', () => {
    expect(
      isUnaccounted({
        monotonicMs: 0,
        submittedAt: SUBMITTED_AT,
        nowWall: SUBMITTED_AT + THRESHOLD + 1,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(true);
  });

  // THE REGRESSION. The clock moved back an hour after the submit, so
  // the wall measure is deeply negative; the monotonic one is what has
  // to carry it.
  it('is true on monotonic elapsed alone when the clock moved BACKWARD', () => {
    expect(
      isUnaccounted({
        monotonicMs: THRESHOLD + 1,
        submittedAt: SUBMITTED_AT,
        nowWall: SUBMITTED_AT - 3_600_000,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(true);
  });

  // The same shape reached the other way: the marker was written while
  // the clock was wrongly in the future, then the clock was corrected.
  it('is true despite a persisted stamp from the future', () => {
    expect(
      isUnaccounted({
        monotonicMs: THRESHOLD + 1,
        submittedAt: SUBMITTED_AT + 86_400_000,
        nowWall: SUBMITTED_AT,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(true);
  });

  // A negative wall measure contributes NOTHING rather than dominating.
  // If it were allowed to win, the max would be negative and the escape
  // hatch would stay hidden — the defect itself.
  it('does not let a negative wall measure suppress a monotonic one', () => {
    expect(
      isUnaccounted({
        monotonicMs: 0,
        submittedAt: SUBMITTED_AT,
        nowWall: SUBMITTED_AT - 3_600_000,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(false);
  });

  // A returning lender sees the true state at once rather than waiting
  // out the threshold again: the mount is new, so monotonic is 0, and
  // the wall measure carries it.
  it('is true immediately after a reload of a long-outstanding submit', () => {
    expect(
      isUnaccounted({
        monotonicMs: 0,
        submittedAt: SUBMITTED_AT,
        nowWall: SUBMITTED_AT + 86_400_000,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(true);
  });

  it('treats a non-finite measure as no evidence rather than as elapsed', () => {
    expect(
      isUnaccounted({
        monotonicMs: Number.NaN,
        submittedAt: Number.NaN,
        nowWall: SUBMITTED_AT,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(false);
  });

  // Exactly at the threshold is not past it — the boundary is stated so
  // a later `>=` cannot drift in unnoticed.
  it('is false exactly at the threshold', () => {
    expect(
      isUnaccounted({
        monotonicMs: THRESHOLD,
        submittedAt: SUBMITTED_AT,
        nowWall: SUBMITTED_AT + THRESHOLD,
        thresholdMs: THRESHOLD,
      }),
    ).toBe(false);
  });
});
