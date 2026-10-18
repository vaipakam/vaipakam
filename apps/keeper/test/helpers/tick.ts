import type { PassTick } from '../../src/passSchedule';

/** A tick whose deadline is far off: for a test that drives a pass's entry
 *  point and is not about the run deadline. */
export function farTick(): PassTick {
  return { scheduledTimeMs: undefined, deadlineMs: Date.now() + 60 * 60_000 };
}
