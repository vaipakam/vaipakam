/**
 * How old a reading is, against a clock the CALLER supplies — shared by the
 * indexer's freshness line and the contract reading on /analytics, so the
 * two ages on the page follow one rule.
 */
import { copy } from '../../content/copy';
import { CLOCK_SKEW_ALLOWANCE_SEC } from '../../data/indexer';

/**
 * The age, from a timestamp in seconds (`undefined` = unknown).
 *
 * `nowSec` is a parameter rather than a `Date.now()` read inside here on
 * purpose. Reading the clock during render freezes the answer at whenever
 * React happened to render: a visitor who leaves this page open would sit
 * on "12s ago" for hours, which is worse than showing no age at all —
 * this page states the age precisely so that stale figures cannot pass as
 * current, and a frozen age is the failure it exists to prevent, wearing
 * the mask of the fix. `useNowSec` is the app's existing ticking clock and
 * its own docstring names this exact bug.
 */
export function ageLabel(updatedAtSec: number | undefined, nowSec: number): string {
  if (typeof updatedAtSec !== 'number') return copy.analytics.unknown;
  const secs = nowSec - updatedAtSec;
  // A STAMP FROM THE FUTURE IS UNKNOWN, NOT BRAND NEW (review round 22
  // P2). `Math.max(0, …)` turned a negative age into "0s ago" — so a
  // skewed or corrupted timestamp was rendered as the most current
  // reading this page can show, which is the precise inverse of the
  // rule it exists to honour: an unknown age must never pass as a fresh
  // one. A small allowance keeps ordinary clock differences readable.
  if (secs < -CLOCK_SKEW_ALLOWANCE_SEC) return copy.analytics.unknown;
  if (secs < 0) return copy.analytics.ageSeconds(0);
  if (secs < 90) return copy.analytics.ageSeconds(secs);
  if (secs < 5400) return copy.analytics.ageMinutes(Math.round(secs / 60));
  return copy.analytics.ageHours(Math.round(secs / 3600));
}

