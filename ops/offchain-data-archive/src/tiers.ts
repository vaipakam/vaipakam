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
  /**
   * Which periods MUST be present, given what actually is and the clock.
   *
   * This replaced a fixed "look back N periods" lookback, which could not
   * distinguish a period that never arrived from one that has aged out —
   * so a failed monthly cut was masked by the previous month for the rest
   * of that month, and then never reported again once the next cut
   * succeeded. A permanent archive gap behind green weekly reports.
   */
  missingRequired: (present: string[], now: number) => string[];
  /**
   * Whether finding NOTHING AT ALL under the family should fail the run.
   *
   * This is only about a family that has never been written. Once one has,
   * `missingRequired` governs — an established family that disappears is a
   * failure for every tier, including yearly.
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
 * from the 31st of March would land in March again (Feb 31 -> Mar 3).
 */
export function monthKey(now: number, monthsAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return d.toISOString().slice(0, 7);
}

/** `YYYY` for `n` years before `now` (UTC). Anchored for the same reason. */
export function yearKey(now: number, yearsAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCMonth(0);
  d.setUTCFullYear(d.getUTCFullYear() - yearsAgo);
  return d.toISOString().slice(0, 4);
}

/** The period segment of a manifest key: `<prefix><period>/<nonce>.json`. */
export function periodOf(spec: TierSpec, manifestKey: string): string | null {
  if (!manifestKey.startsWith(spec.manifestPrefix)) return null;
  const rest = manifestKey.slice(spec.manifestPrefix.length);
  const seg = rest.split('/')[0];
  return seg.length > 0 && rest.includes('/') ? seg : null;
}

/** Every `YYYY` from `from` to `to` inclusive. */
function yearRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let y = Number(from); y <= Number(to); y++) out.push(String(y));
  return out;
}

export const TIERS: TierSpec[] = [
  {
    tier: 'daily',
    manifestPrefix: 'manifests/',
    archivePrefix: 'archives/',
    // A single missed nightly must not page, so the requirement is that
    // SOME night in the last three landed. Older days are not required:
    // the daily tier ages out by design, so their absence is expected.
    missingRequired: (present, now) => {
      const recent = [dayKey(now, 0), dayKey(now, 1), dayKey(now, 2)];
      return recent.some((d) => present.includes(d)) ? [] : recent;
    },
    absenceIsFailure: true,
  },
  {
    tier: 'monthly',
    manifestPrefix: 'manifests-monthly/',
    archivePrefix: 'archives-monthly/',
    // The PREVIOUS month is REQUIRED, not a fallback. Treating it as a
    // fallback is what let a failed cut hide: in the month it failed the
    // previous month satisfied the check, and from the next month on
    // nothing looked at it again.
    //
    // The current month is required too, except on the 1st itself, which
    // is the only moment the cron may genuinely not have run yet — that
    // race is the entire reason a fallback existed.
    missingRequired: (present, now) => {
      const req = [monthKey(now, 1)];
      if (new Date(now).getUTCDate() !== 1) req.push(monthKey(now, 0));
      return req.filter((m) => !present.includes(m));
    },
    absenceIsFailure: true,
  },
  {
    tier: 'yearly',
    manifestPrefix: 'manifests-yearly/',
    archivePrefix: 'archives-yearly/',
    // NOTHING ages out here — the yearly prefixes carry no lifecycle rule,
    // and that absence IS the indefinite retention the legal-audit tier
    // depends on. So every year from the first one written onward must
    // still be present, and a gap anywhere in that range is a failure.
    //
    // A blanket "yearly absence is fine" exemption made an admin deletion
    // or a lifecycle rule drifting onto these prefixes indistinguishable
    // from a young deployment, permanently. The exemption is only for a
    // family that has never been written at all.
    missingRequired: (present, now) => {
      if (present.length === 0) return [];
      const earliest = present.slice().sort()[0];
      const req = yearRange(earliest, yearKey(now, 1));
      // The current year is required once its Jan 1 has passed; on Jan 1
      // itself the cron may not have run.
      const d = new Date(now);
      if (!(d.getUTCMonth() === 0 && d.getUTCDate() === 1)) {
        req.push(yearKey(now, 0));
      }
      return req.filter((y) => !present.includes(y));
    },
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

/** What a prefix listing produced. A failure is NOT an empty listing. */
export type Listing =
  | { ok: true; keys: string[] }
  | { ok: false; error: string };

export interface TierVerdict {
  /** True when the tier is already decided and no object need be fetched. */
  done: boolean;
  ok?: boolean;
  absent?: boolean;
  reason?: string;
  /** Set when `done` is false: the period to verify in full. */
  newestPeriod?: string;
  present?: string[];
}

/**
 * Decide a tier from its listing alone, before any object is fetched.
 *
 * Pure and in this module deliberately: the three ways a tier is decided
 * without fetching anything — the listing failed, a required period is
 * gone, or the family was never written — are exactly the three that were
 * wrong, and keeping them here is what makes them testable at all.
 *
 * Order is load-bearing, in two different ways.
 *
 * A failed listing is decided FIRST because treating it as an empty one
 * made an unreadable prefix indistinguishable from an absent family —
 * which on the yearly tier, whose absence is excused, produced a green
 * PASS over an S3 outage.
 *
 * Missing-required is decided BEFORE absence because of what the absence
 * message CLAIMS. "Never written" is only knowable for a tier nothing
 * deletes — the yearly one. The daily and monthly tiers age out, so an
 * empty listing there is far more likely to mean the cron stopped than
 * that it never ran, and asserting the latter would send an operator
 * looking for a deployment problem instead of a dead cron. Both orders
 * FAIL those tiers; only this one says something true about why. That
 * distinction is the entire difference the ordering makes, and a test
 * asserts the reason text rather than just the verdict.
 */
export function classifyListing(
  spec: TierSpec,
  listing: Listing,
  now: number,
): TierVerdict {
  if (!listing.ok) {
    return {
      done: true,
      ok: false,
      absent: false,
      reason:
        `could not list ${spec.manifestPrefix}: ${listing.error} — ` +
        `treated as a failure, NOT as an empty tier`,
    };
  }

  const present = [
    ...new Set(
      listing.keys.map((k) => periodOf(spec, k)).filter((p): p is string => !!p),
    ),
  ].sort();

  const missing = spec.missingRequired(present, now);
  if (missing.length > 0) {
    return {
      done: true,
      ok: false,
      absent: present.length === 0,
      reason:
        `${spec.tier} archive missing for ${missing.join(', ')} ` +
        `(present: ${present.length === 0 ? 'none' : present.join(', ')})`,
    };
  }

  if (present.length === 0) {
    return {
      done: true,
      absent: true,
      ok: !spec.absenceIsFailure,
      reason:
        `no ${spec.tier} archive has ever been written — nothing verified ` +
        `for this tier (expected only until this deployment lives through ` +
        `its first ${spec.tier === 'yearly' ? 'Jan 1' : 'cycle'})`,
    };
  }

  return { done: false, newestPeriod: present[present.length - 1], present };
}
