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

/**
 * The first period each long tier is known to have written — DECLARED,
 * not inferred.
 *
 * Inferring the baseline from the surviving keys is circular, and the
 * circularity is exactly what an attacker or a mis-set lifecycle rule
 * exploits: delete the oldest yearly object and the inferred baseline
 * advances to the next one, so the deleted year stops being required;
 * delete the whole family and there is nothing left to infer from at all,
 * so "nothing is missing" and the tier passes. A detector whose
 * expectations are derived from what survived cannot report a deletion.
 *
 * These are operator-declared facts about the deployment. Unset is
 * tolerated — a fresh deployment has no baseline to state — but the tier
 * then REPORTS that its deletion detection is degraded rather than
 * implying full coverage.
 */
export interface ArchiveBaseline {
  /** `YYYY-MM` of the first monthly cut this deployment wrote. */
  monthly?: string;
  /** `YYYY` of the first yearly cut this deployment wrote. */
  yearly?: string;
}

/**
 * How many completed months of monthly archive should still exist.
 *
 * Derived from the declared lifecycle: monthly objects are hidden 334
 * days after upload, so roughly eleven completed months are still live at
 * any moment. Requiring only the current and previous month meant that
 * deleting, say, April's snapshot in June went unnoticed forever — May
 * and June were present, nothing else was asked about, and April had ten
 * months of expected life left.
 *
 * Deliberately CONSERVATIVE. 334 days is 10.97 mean months, NOT eleven —
 * I set this to 11 on the reasoning that it was already a month under
 * twelve, and the cross-file test caught it: requiring an eleventh
 * completed month demands one that may legitimately have just aged out,
 * which is a false page on a weekly schedule. That test exists because
 * this constant and the retention days live in different files and
 * nothing else ties them together.
 */
export const MONTHLY_RETAINED_MONTHS = 10;

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
  missingRequired: (
    present: string[],
    now: number,
    baseline: ArchiveBaseline,
  ) => string[];
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

/**
 * The canonical shape of each tier's period segment.
 *
 * Load-bearing against a HOSTILE key, not just a malformed one. The
 * write-only B2 credential can create objects, so a holder of it can
 * upload `manifests-yearly/-999999999/attack.json`. An unvalidated
 * segment became the start of a required-period RANGE, and expanding it
 * is a synchronous loop of ~a billion iterations — enough to exhaust the
 * scheduled invocation before the per-tier catch or the Telegram alert
 * runs, and to take the Monday backup sharing that invocation with it.
 *
 * Rejecting the segment here means a foreign key cannot enter the period
 * set at all, which is a narrower and more durable guarantee than
 * bounding the loop that consumed it.
 */
const PERIOD_SHAPE: Record<TierName, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
  yearly: /^\d{4}$/,
};

/**
 * Is this segment a real calendar period, not merely the right width?
 *
 * A width check alone accepts `9999-99`, which sorts above every genuine
 * month — so it becomes `newestPeriod`, and the tier then fetches and
 * parses an ATTACKER-CHOSEN manifest instead of the real newest backup.
 * The shape check stopped the range explosion; it did not stop selection.
 */
export function isRealPeriod(tier: TierName, seg: string): boolean {
  if (!PERIOD_SHAPE[tier].test(seg)) return false;
  if (tier === 'yearly') {
    const y = Number(seg);
    return y >= 2000 && y <= 2999;
  }
  const [y, m] = seg.split('-').map(Number);
  if (y < 2000 || y > 2999) return false;
  if (m < 1 || m > 12) return false;
  if (tier === 'monthly') return true;
  // Round-trip through Date: rejects Feb 30 and friends, which a
  // range check on the day number alone accepts.
  const iso = `${seg}T00:00:00.000Z`;
  const parsed = new Date(iso);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === seg;
}

/** The period segment of a manifest key: `<prefix><period>/<nonce>.json`. */
export function periodOf(spec: TierSpec, manifestKey: string): string | null {
  if (!manifestKey.startsWith(spec.manifestPrefix)) return null;
  const rest = manifestKey.slice(spec.manifestPrefix.length);
  if (!rest.includes('/')) return null;
  const seg = rest.split('/')[0];
  return isRealPeriod(spec.tier, seg) ? seg : null;
}

/**
 * Every `YYYY` from `from` to `to` inclusive.
 *
 * Bounded independently of `PERIOD_SHAPE`. The shape check is what stops
 * a hostile segment reaching here, but a range expander that loops on
 * whatever it is handed is one regression away from being a denial of
 * service again, and this one runs synchronously inside a scheduled
 * invocation shared with the nightly backup. Two independent guards for
 * one failure is proportionate when the failure takes the backup with it.
 */
/**
 * Cap a period list before it reaches an alert.
 *
 * The write credential can create manifest keys for thousands of valid
 * historical dates with no sibling archive, and every one would land in
 * the reason string. Telegram rejects or truncates past 4096 characters
 * (`ops/mesh-watcher/src/telegram.ts` enforces the same limit), so an
 * unbounded list does not merely read badly — it is how the alert about
 * the very upload that caused it fails to arrive.
 */
export const MAX_LISTED_PERIODS = 12;

export function summarisePeriods(periods: string[]): string {
  if (periods.length <= MAX_LISTED_PERIODS) return periods.join(', ');
  const shown = periods.slice(0, MAX_LISTED_PERIODS).join(', ');
  return `${shown} (+${periods.length - MAX_LISTED_PERIODS} more)`;
}

const MAX_YEAR_SPAN = 200;

function yearRange(from: string, to: string): string[] {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isInteger(a) || !Number.isInteger(b) || b - a > MAX_YEAR_SPAN) {
    throw new Error(
      `implausible yearly range ${from}..${to} — refusing to expand it`,
    );
  }
  const out: string[] = [];
  for (let y = a; y <= b; y++) out.push(String(y));
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
    missingRequired: (present, now, baseline) => {
      // Every month still inside retention, not just the last two.
      // The floor of the required range. A DECLARED baseline is the real
      // answer; with none, fall back to the earliest month actually
      // present, because demanding every month of the retention window
      // from a deployment younger than it reports FAILED where the
      // documented result is COVERAGE DEGRADED — turning the optional
      // setting into a required one and burying the notice that says so.
      const floor = baseline.monthly ?? present.slice().sort()[0];
      const req: string[] = [];
      for (let back = MONTHLY_RETAINED_MONTHS; back >= 1; back--) {
        const m = monthKey(now, back);
        if (floor && m < floor) continue;
        req.push(m);
      }
      // The current month too, except on the 1st itself: that is the only
      // moment the cron may genuinely not have run yet, and it is the
      // entire reason a fallback ever existed.
      if (new Date(now).getUTCDate() !== 1) {
        const cur = monthKey(now, 0);
        if (!floor || cur >= floor) req.push(cur);
      }
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
    missingRequired: (present, now, baseline) => {
      // The declared baseline is what makes deletion detectable. Falling
      // back to the earliest SURVIVING key is the circular version: it
      // cannot notice that the oldest year is the one that went missing,
      // and with the family emptied there is nothing to infer from.
      const earliest = baseline.yearly ?? present.slice().sort()[0];
      if (!earliest) return [];
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
  /** Set when the tier passes but its coverage is knowably incomplete. */
  degraded?: string;
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
/**
 * Why this tier's coverage is incomplete, if it is.
 *
 * Shared by the absence path and the healthy path. It was only on the
 * healthy one, so the case where deletion detection is MOST obviously
 * unavailable — an empty family with no declared baseline — returned a
 * bare pass with no disclosure at all.
 */
function degradedReason(
  spec: TierSpec,
  baseline: ArchiveBaseline,
): string | undefined {
  if (spec.tier === 'daily') return undefined;
  if (baseline[spec.tier as 'monthly' | 'yearly']) return undefined;
  return (
    `no declared first-${spec.tier} baseline — deletion of the oldest ` +
    `periods is undetectable until one is set`
  );
}

export function classifyListing(
  spec: TierSpec,
  listing: Listing,
  now: number,
  baseline: ArchiveBaseline = {},
  archiveKeys?: Listing,
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

  // A period AFTER the current one cannot have been written by the nightly
  // cron, so it is either a clock fault or an upload chosen to sort above
  // every genuine period and capture `newestPeriod`.
  const currentPeriod =
    spec.tier === 'daily'
      ? dayKey(now, 0)
      : spec.tier === 'monthly'
        ? monthKey(now, 0)
        : yearKey(now, 0);
  const present = [
    ...new Set(
      listing.keys
        .map((k) => periodOf(spec, k))
        .filter((p): p is string => !!p && p <= currentPeriod),
    ),
  ].sort();

  const missing = spec.missingRequired(present, now, baseline);
  if (missing.length > 0) {
    return {
      done: true,
      ok: false,
      absent: present.length === 0,
      reason:
        `${spec.tier} archive missing for ${summarisePeriods(missing)} ` +
        `(present: ${present.length === 0 ? 'none' : summarisePeriods(present)})`,
    };
  }

  if (present.length === 0) {
    return {
      done: true,
      absent: true,
      ok: !spec.absenceIsFailure,
      degraded: degradedReason(spec, baseline),
      reason:
        `no ${spec.tier} archive has ever been written — nothing verified ` +
        `for this tier (expected only until this deployment lives through ` +
        `its first ${spec.tier === 'yearly' ? 'Jan 1' : 'cycle'})`,
    };
  }

  // A period counts as present from its MANIFEST. The manifest is a few
  // hundred bytes describing an archive that may no longer be there —
  // an individual deletion or asymmetric lifecycle drift removes one
  // without the other, and only the newest period's archive is fetched.
  // So every required period is checked to still have a sibling archive.
  if (archiveKeys) {
    if (!archiveKeys.ok) {
      return {
        done: true,
        ok: false,
        absent: false,
        reason:
          `could not list ${spec.archivePrefix}: ${archiveKeys.error} — ` +
          `treated as a failure, NOT as an empty tier`,
      };
    }
    // Compare ACTUAL KEYS, not period labels. Reducing both sides to
    // periods says "this month has a manifest and this month has an
    // archive" — which is satisfied by `manifest/A.json` beside
    // `archive/B.bin`, where neither is restorable with the other.
    const archiveSet = new Set(archiveKeys.keys);
    // A period is orphaned only when NO manifest in it has its sibling —
    // one superseded upload losing its pair is not a lost backup.
    const pairedPeriods = new Set(
      listing.keys
        .filter((k) => archiveSet.has(siblingArchiveKey(spec, k)))
        .map((k) => periodOf(spec, k))
        .filter((p): p is string => !!p),
    );
    const orphaned = present.filter((p) => !pairedPeriods.has(p));
    if (orphaned.length > 0) {
      return {
        done: true,
        ok: false,
        absent: false,
        reason:
          `${spec.tier} manifest with NO archive beside it for ` +
          `${summarisePeriods(orphaned)} — the backup it describes is gone`,
      };
    }
  }

  return {
    done: false,
    newestPeriod: present[present.length - 1],
    present,
    // Stated, not implied: without a declared baseline this tier cannot
    // report that its OLDEST periods were deleted, because its
    // expectations come from what survived.
    degraded: degradedReason(spec, baseline),
  };
}

/**
 * Reject an operator baseline that is not a real, non-future period.
 *
 * These are hand-set strings and a typo does not fail loudly — it fails
 * SILENTLY AND IN THE WRONG DIRECTION. `ARCHIVE_FIRST_MONTHLY=2026-13`
 * compares above every genuine month, so every retained month is treated
 * as predating the deployment and nothing is required; and because the
 * value is truthy, the degraded-coverage disclosure is suppressed too. A
 * single mistyped digit turns the tier's checks off and removes the
 * warning that would have said so.
 */
export function validateBaseline(
  baseline: ArchiveBaseline,
  now: number,
):
  | { ok: true; baseline: ArchiveBaseline; byTier: Record<string, string> }
  | { ok: false; baseline: ArchiveBaseline; byTier: Record<string, string>; errors: string[] } {
  const errors: string[] = [];
  // Attributed PER TIER, so a bad monthly value cannot take the daily and
  // yearly checks down with it.
  const byTier: Record<string, string> = {};
  const checked: ArchiveBaseline = {};
  const specs: [keyof ArchiveBaseline, TierName, string][] = [
    ['monthly', 'monthly', monthKey(now, 0)],
    ['yearly', 'yearly', yearKey(now, 0)],
  ];
  for (const [key, tier, current] of specs) {
    const v = baseline[key];
    if (v === undefined || v === '') continue;
    if (!isRealPeriod(tier, v)) {
      const msg = `ARCHIVE_FIRST_${key.toUpperCase()}="${v}" is not a valid ${tier} period`;
      errors.push(msg);
      byTier[tier] = msg;
      continue;
    }
    if (v > current) {
      const msg = `ARCHIVE_FIRST_${key.toUpperCase()}="${v}" is in the future (now ${current})`;
      errors.push(msg);
      byTier[tier] = msg;
      continue;
    }
    checked[key] = v;
  }
  return errors.length > 0
    ? { ok: false, baseline: checked, byTier, errors }
    : { ok: true, baseline: checked, byTier };
}

/**
 * The manifest to verify in full: newest in `period` whose archive still
 * exists.
 *
 * The surviving-archive filter is the point. `classifyListing`
 * deliberately tolerates one superseded manifest losing its pair, because
 * the period remains restorable through the other — and selecting the
 * newest of ALL manifests then picked that orphan and paged on its
 * missing sibling, failing on exactly the state declared benign one
 * function earlier. Two rules about the same tolerance, in two places,
 * disagreeing; this is the one place now.
 */
export function newestVerifiableManifest<
  T extends { key: string; lastModified: string },
>(
  spec: TierSpec,
  entries: T[],
  archiveKeys: Set<string>,
  period: string,
): T | null {
  const candidates = entries
    .filter((e) => periodOf(spec, e.key) === period)
    .filter((e) => archiveKeys.has(siblingArchiveKey(spec, e.key)));
  if (candidates.length === 0) return null;
  // Newest by LastModified — covers the "uploaded twice by an attacker"
  // case where an honest and a malicious manifest share a period.
  return candidates.slice().sort((a, b) =>
    b.lastModified.localeCompare(a.lastModified),
  )[0];
}

