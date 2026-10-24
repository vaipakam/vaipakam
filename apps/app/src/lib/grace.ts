/**
 * Grace-window schedule — ONE encoding of LibVaipakam.gracePeriod's
 * compile-time default buckets, shared by the display label
 * (offerSchema.gracePeriodLabel) and the submit-time gate
 * (contracts/preflights.readGraceSecondsLive). Keeping seconds and
 * labels derived from the same table is what stops the shown grace
 * and the enforced grace from drifting apart.
 */

/** Mirrors LibVaipakam.gracePeriod's zero-bucket default schedule. */
export function defaultGraceSeconds(durationDays: number): bigint {
  if (durationDays < 7) return 3_600n;
  if (durationDays < 30) return 86_400n;
  if (durationDays < 90) return 3n * 86_400n;
  if (durationDays < 180) return 7n * 86_400n;
  if (durationDays < 365) return 14n * 86_400n;
  return 30n * 86_400n;
}

/** One governance grace bucket, as `ConfigFacet.getGraceBuckets` returns it. */
export interface GraceBucket {
  maxDurationDays: bigint;
  graceSeconds: bigint;
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
 * on a chain that publishes none.
 */
export function graceSecondsFromBuckets(
  buckets: readonly GraceBucket[],
  durationDays: number | bigint,
): bigint {
  const days = BigInt(durationDays);
  if (buckets.length > 0) {
    for (const b of buckets) {
      if (b.maxDurationDays === 0n) return b.graceSeconds; // catch-all
      if (days < b.maxDurationDays) return b.graceSeconds;
    }
    return buckets[buckets.length - 1].graceSeconds;
  }
  return defaultGraceSeconds(Number(days));
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
