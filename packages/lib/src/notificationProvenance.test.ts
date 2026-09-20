/**
 * The shared provenance marker (#2101 / #2190 r5).
 *
 * It lives in this package because the Worker that WRITES it and the app
 * that RENDERS it must agree on one string, and neither owns it. The
 * failure this prevents is silent: a rename on the writing side leaves a
 * reader matching nothing, the row still renders, and it simply renders
 * without the correction note — a months-old default presented as news of
 * the moment, with nothing red anywhere.
 */
import { describe, expect, it } from 'vitest';
import {
  isReconciledNotification,
  NOTIF_EVENT_KIND_RECONCILED,
} from './notificationProvenance';

describe('isReconciledNotification', () => {
  it('recognises the marker the repair writes', () => {
    expect(isReconciledNotification(NOTIF_EVENT_KIND_RECONCILED)).toBe(true);
  });

  it('does NOT treat a cron-derived calendar row as a correction', () => {
    // The notifications table already uses `null` for those, and the two
    // mean different things to a reader: a reminder is worked out from a
    // date the platform knows, a correction is something it has just
    // discovered and cannot date.
    expect(isReconciledNotification(null)).toBe(false);
    expect(isReconciledNotification(undefined)).toBe(false);
  });

  it('does NOT treat a real event row as a correction', () => {
    for (const eventName of ['LoanRepaid', 'LoanDefaulted', 'InternalMatchExecuted']) {
      expect(isReconciledNotification(eventName)).toBe(false);
    }
  });
});
