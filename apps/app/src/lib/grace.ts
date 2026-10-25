/**
 * Grace-window schedule — ONE encoding of LibVaipakam.gracePeriod's
 * compile-time default buckets, shared by the display label
 * (offerSchema.gracePeriodLabel) and the submit-time gate
 * (contracts/preflights.readGraceSecondsLive). Keeping seconds and
 * labels derived from the same table is what stops the shown grace
 * and the enforced grace from drifting apart.
 */

import {
  defaultGraceSeconds as defaultGraceSecondsShared,
  graceSecondsFromBuckets as graceSecondsFromBucketsShared,
  type GraceBucket,
} from '@vaipakam/lib/loanClock';

export type { GraceBucket };

/** Mirrors LibVaipakam.gracePeriod's zero-bucket default schedule. The
 *  table lives once, in `@vaipakam/lib/loanClock`, beside the deadlines
 *  it feeds (#2808); this keeps the app's number-typed call sites. */
export function defaultGraceSeconds(durationDays: number): bigint {
  return defaultGraceSecondsShared(BigInt(durationDays));
}

/**
 * The grace window for a duration, from the bucket set the chain
 * publishes — mirroring the contract's walk: the first bucket whose
 * threshold strictly exceeds `durationDays` wins, and a trailing
 * `maxDurationDays == 0` entry is the catch-all. A malformed set with no
 * match falls back to the LAST entry, as the contract does. An EMPTY set
 * is the compile-time default schedule, which IS the live config (the
 * contract's own zero-bucket path), not a missing one.
 *
 * Pure, so the live review drive can be checked against it (#1557): its
 * first draft treated an empty set as zero grace and skipped every loan
 * on a chain that publishes none. The walk itself is the shared one in
 * `@vaipakam/lib/loanClock` (#2808).
 */
export function graceSecondsFromBuckets(
  buckets: readonly GraceBucket[],
  durationDays: number | bigint,
): bigint {
  return graceSecondsFromBucketsShared(buckets, BigInt(durationDays));
}

/** Human label for a grace window in seconds ("1 hour", "3 days",
 *  "2 weeks", "30 days"). Used for receipt copy. */
export function formatGraceSeconds(seconds: bigint): string {
  const s = Number(seconds);
  if (s < 3_600) return `${Math.max(1, Math.round(s / 60))} minutes`;
  if (s < 86_400) {
    const h = Math.round(s / 3_600);
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  const days = Math.round(s / 86_400);
  if (days === 1) return '1 day';
  if (days === 7) return '1 week';
  if (days === 14) return '2 weeks';
  return `${days} days`;
}
