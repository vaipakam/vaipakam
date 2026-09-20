/**
 * How old is a published snapshot, and can we tell?
 *
 * WHY THIS IS ITS OWN FUNCTION (review round 38 P2). The Protocol
 * Console derived its "more than a day old" banner from
 * `!protocolConfigFresh(updatedAt)`, and that predicate is false for two
 * completely different reasons: a stamp genuinely older than a day, and
 * a stamp in the FUTURE beyond the clock-skew allowance. The banner
 * spoke for both, so a skewed or corrupted producer made the page say
 * "this snapshot is more than a day old" directly beside a provenance
 * sentence reporting the age as unknown — two contradictory claims about
 * governance values, on the surface whose entire purpose is telling a
 * reader how much to trust them.
 *
 * A FUTURE STAMP IS NOT AN AGE. It is a broken capture time, and the
 * only honest thing to say about it is that the age cannot be
 * determined — which is exactly what the page already says for a
 * snapshot carrying no stamp at all. The two arrive by different routes
 * and warrant identical advice, so they resolve to one state here.
 *
 * ONE CLOCK, INJECTED. `nowSec` is a parameter rather than a
 * `Date.now()` read so this shares the ticking clock the age sentence
 * renders from. Two surfaces reading two clocks is how one of them calls
 * a reading usable while the other calls it unknown — the round-22
 * finding this file must not reintroduce.
 */
import { CLOCK_SKEW_ALLOWANCE_SEC, CONFIG_MAX_AGE_SEC } from './indexer';

export type SnapshotAge =
  /** A real capture time, recent enough to present as current. */
  | 'usable'
  /** A real capture time, but at least `CONFIG_MAX_AGE_SEC` old. */
  | 'stale'
  /** No stamp, the zero sentinel, or a stamp ahead of the clock. */
  | 'unusable-stamp';

/**
 * @param updatedAtSec Unix SECONDS as published, or `undefined` when the
 *   response carried no stamp. Zero is the indexer's own sentinel for
 *   "capture time unknown", never a 1970 capture.
 * @param nowSec The caller's ticking clock, in seconds.
 */
export function resolveSnapshotAge(
  updatedAtSec: number | undefined,
  nowSec: number,
): SnapshotAge {
  if (typeof updatedAtSec !== 'number' || updatedAtSec <= 0) {
    return 'unusable-stamp';
  }
  const age = nowSec - updatedAtSec;
  if (age < -CLOCK_SKEW_ALLOWANCE_SEC) return 'unusable-stamp';
  if (age >= CONFIG_MAX_AGE_SEC) return 'stale';
  return 'usable';
}
