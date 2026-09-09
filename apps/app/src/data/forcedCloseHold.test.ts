/**
 * `isHoldingAfterSubmit` — the post-submit hold on the forced-close
 * action.
 *
 * Written as the regression suite for four consecutive review rounds
 * that each fixed this predicate and broke it again (47, 48, 49, 50).
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

describe('isHoldingAfterSubmit — nothing outstanding', () => {
  it('does not hold when no close-out has been submitted', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: null,
        disposition: null,
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
        readsUpdatedAt: FRESH,
      }),
    ).toBe(true);
  });

  it('holds when the wait timed out without a disposition', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'undetermined',
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
        readsUpdatedAt: STALE,
      }),
    ).toBe(true);
  });

  // ROUND 29 — a partial internal match leaves the loan Active, so the
  // hold MUST end once the reads have caught up. The first version of
  // this hold never released and stranded exactly that residual.
  it('releases after a success once a read postdates the submit', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        readsUpdatedAt: FRESH,
      }),
    ).toBe(false);
  });

  // The boundary is deliberately EXCLUSIVE: a read bearing the same
  // millisecond as the submit is not evidence that it postdates it.
  it('still holds when a read carries exactly the submit timestamp', () => {
    expect(
      isHoldingAfterSubmit({
        submittedAt: SUBMITTED_AT,
        disposition: 'success',
        readsUpdatedAt: SUBMITTED_AT,
      }),
    ).toBe(true);
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
        readsUpdatedAt: STALE,
      }),
    ).toBe(false);
  });

  // The freshness arm must not leak onto these two. Same inputs as the
  // success cases above, opposite answer — which is the whole content
  // of round 49.
  it('ignores read freshness entirely on the non-executing endings', () => {
    for (const disposition of ['reverted', 'cancelled'] as const) {
      for (const readsUpdatedAt of [0, STALE, SUBMITTED_AT, FRESH]) {
        expect(
          isHoldingAfterSubmit({
            submittedAt: SUBMITTED_AT,
            disposition,
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
    // held (unknown), held (unknown), released, released — against a
    // FRESH read, so success releases and only the unknowns hold.
    success: false,
    reverted: false,
    cancelled: false,
    undetermined: true,
  };

  it('holds only for an unestablished disposition once reads are fresh', () => {
    for (const [disposition, expected] of Object.entries(ALL) as [
      ForcedCloseDisposition,
      boolean,
    ][]) {
      expect(
        isHoldingAfterSubmit({
          submittedAt: SUBMITTED_AT,
          disposition,
          readsUpdatedAt: FRESH,
        }),
      ).toBe(expected);
    }
  });

  it('holds for everything except the two non-executing endings when reads are stale', () => {
    const staleExpected: Record<ForcedCloseDisposition, boolean> = {
      success: true,
      reverted: false,
      cancelled: false,
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
          readsUpdatedAt: STALE,
        }),
      ).toBe(expected);
    }
  });
});
