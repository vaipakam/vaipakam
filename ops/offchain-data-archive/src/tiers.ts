/**
 * The archive's prefix families, and how the healthcheck addresses them.
 *
 * WHY THIS IS ITS OWN MODULE (#1476). The healthcheck used to hard-code
 * the daily prefix, so the monthly and yearly families — written by the
 * same backup pass, on the same credential, under the same threat model
 * — were never examined by anything. A green weekly PASS therefore
 * asserted a coverage it did not have, and `lifecycle-policy.mjs` went
 * on to justify the monthly retention floor with "the detector will
 * catch it" when there was no detector.
 *
 * Keeping the table here, with NO imports, does two things: every tier
 * is described in one place so a family cannot be silently omitted, and
 * the file is loadable by `node --test` directly (Worker modules pull in
 * `crypto`/`b2`/`env`, which need the bundler). The logic most likely to
 * be wrong — calendar stepping and sibling-key derivation — is therefore
 * the logic that is actually unit-tested.
 */

export type TierName = 'daily' | 'monthly' | 'yearly';

export interface TierSpec {
  tier: TierName;
  manifestPrefix: string;
  archivePrefix: string;
  /** Period keys to try, newest first. */
  periodKeys: (now: number) => string[];
  /**
   * Whether finding nothing at all should fail the run.
   *
   * Monthly: yes. An object is written on the 1st of every month, so two
   * months of lookback finding nothing means the monthly write has
   * stopped. A deployment younger than one month also trips this; that
   * is a self-resolving false page, and far cheaper than staying silent
   * about a monthly write that has genuinely stopped.
   *
   * Yearly: no. An object is written on Jan 1 only, so a deployment that
   * has not lived through one legitimately has none — a normal state
   * lasting up to a year, which cannot be paged weekly without training
   * the operator to ignore the alert. It is still REPORTED on every run
   * rather than omitted, so the absence stays visible instead of being
   * implied by a bare PASS.
   */
  absenceIsFailure: boolean;
}

/** `YYYY-MM-DD` for `n` days before `now` (UTC). */
export function dayKey(now: number, daysAgo: number): string {
  return new Date(now - daysAgo * 86400_000).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM` for `n` months before `now` (UTC).
 *
 * Anchored to the 1st before stepping. `setUTCMonth` clamps by rolling
 * FORWARD when the target month is shorter, so stepping back one month
 * from the 31st of March would land in March again (Feb 31 → Mar 3) and
 * the lookback would check the same month twice — silently halving the
 * window on exactly the dates a monthly write is most likely missed.
 */
export function monthKey(now: number, monthsAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 7);
}

/** `YYYY` for `n` years before `now` (UTC). Anchored for the same reason
 *  as `monthKey` — Feb 29 stepped back a year is not a date. */
export function yearKey(now: number, yearsAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCMonth(0);
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  return d.toISOString().slice(0, 4);
}

export const TIERS: TierSpec[] = [
  {
    tier: 'daily',
    manifestPrefix: 'manifests/',
    archivePrefix: 'archives/',
    // 0..2 tolerates a single missed nightly without paging.
    periodKeys: (now) => [dayKey(now, 0), dayKey(now, 1), dayKey(now, 2)],
    absenceIsFailure: true,
  },
  {
    tier: 'monthly',
    manifestPrefix: 'manifests-monthly/',
    archivePrefix: 'archives-monthly/',
    // Written on the 1st. The previous month covers a run early on the
    // 1st itself, before that night's cron has fired.
    periodKeys: (now) => [monthKey(now, 0), monthKey(now, 1)],
    absenceIsFailure: true,
  },
  {
    tier: 'yearly',
    manifestPrefix: 'manifests-yearly/',
    archivePrefix: 'archives-yearly/',
    // Written on Jan 1. The previous year covers the whole of a year
    // whose Jan 1 write has not happened yet.
    periodKeys: (now) => [yearKey(now, 0), yearKey(now, 1)],
    absenceIsFailure: false,
  },
];

/**
 * The archive key that pairs with a manifest key, for a given tier.
 *
 * Derived from the SPEC rather than by rewriting `manifests/` to
 * `archives/`. That rewrite is the trap this function exists to remove:
 * the pattern does not match `manifests-monthly/`, so it would leave the
 * prefix untouched and dereference a `.bin` under the MANIFEST prefix —
 * surfacing as a GET 404 reported as a missing archive, on a tier that
 * was perfectly healthy. A daily-only healthcheck could never hit it,
 * which is exactly why extending to more tiers is where it would bite.
 */
export function siblingArchiveKey(spec: TierSpec, manifestKey: string): string {
  if (!manifestKey.startsWith(spec.manifestPrefix)) {
    throw new Error(
      `manifest key ${manifestKey} is not under ${spec.manifestPrefix} ` +
        `(tier ${spec.tier})`,
    );
  }
  return (
    spec.archivePrefix +
    manifestKey.slice(spec.manifestPrefix.length).replace(/\.json$/, '.bin')
  );
}
