/**
 * The published-retention ceilings, in ONE place, applied by EVERY writer.
 *
 * WHY THIS FILE EXISTS. The ceiling was first added inside
 * `apply-bucket-lifecycle.mjs`, which left `setup-backblaze.mjs` — the other,
 * documented path that calls `b2_update_bucket` — free to push a
 * policy-violating declaration straight to production. A guard that one of two
 * writers honours is not a guard; it is a guard-shaped comment. Both scripts
 * import `assertPolicyCeilings` and neither can write without it.
 *
 * WHAT THE CEILINGS ARE, AND WHERE THEY COME FROM. These are not tuning
 * preferences. `docs/Terms/PrivacyPolicy.md` and the rendered privacy page both
 * state: "nightly backup archives are kept 30 days and monthly archives 12
 * months, after which they age out automatically", and that support tickets are
 * "excluded from the monthly and yearly archives, so a ticket's backup copies
 * live only in the 30-day nightly tier". `backup.ts` implements that exclusion.
 *
 * So the daily prefixes' worst-case object lifetime IS the ticket promise, and
 * the monthly prefixes' IS the 12-month promise.
 *
 * WORST CASE IS THE SUM OF BOTH TERMS. A version is deleted
 * `daysFromHidingToDeleting` after it is hidden, and it is hidden either by the
 * age rule OR by being superseded by a newer upload at the same key. Reasoning
 * about `daysFromUploadingToHiding` alone is exactly the mistake that put the
 * live bucket at a 60-day daily worst case while looking correct.
 *
 * WHY THE DAILY CEILING IS 29 AND NOT 30. The B2 clock starts at UPLOAD, and a
 * ticket can be deleted from D1 between `backup.ts` exporting it and
 * `putObject` finishing — the agent's prune runs every minute, the archive is
 * built and uploaded in the same pass. So the object can outlive the row's
 * deletion by the whole lifetime PLUS that gap. The gap is minutes; a full day
 * of headroom makes the arithmetic hold without depending on it.
 *
 * WHY THE RECOVERY TERM HAS A FLOOR. `daysFromHidingToDeleting` is the window
 * in which a SUPERSEDED version can still be recovered — which is the only
 * defence against a forged overwrite, since the Worker's B2 key holds
 * `writeFiles` but not `deleteFiles` (an attacker can shadow an archive, never
 * delete one). The detector is the WEEKLY healthcheck, Monday 09:00 UTC. At
 * exactly 7 days a forgery landing just after one Monday becomes eligible for
 * deletion as the next Monday's alert fires — the alert and the deletion race,
 * which is no window at all. The floor is 8 so detection is strictly inside it,
 * and the declaration should sit above that to leave an operator time to act.
 */

/** Prefixes whose retention is bounded by the 30-day ticket promise. */
export const DAILY_PREFIXES = ['archives/', 'manifests/'];
/** Prefixes whose retention is bounded by the 12-month promise. */
export const MONTHLY_PREFIXES = ['archives-monthly/', 'manifests-monthly/'];

/** Published: nightly archives kept 30 days. Minus a day for the prune race. */
export const DAILY_MAX_TOTAL_DAYS = 29;
/** Published: monthly archives kept 12 months. */
export const MONTHLY_MAX_TOTAL_DAYS = 365;
/**
 * Recovery-window floors, PER TIER, because the two tiers have different
 * detectors — and the monthly tier has none at all (#1471 r6).
 *
 * Daily: the weekly healthcheck (Mon 09:00 UTC) examines
 * `manifests/<recent dates>/`, so 8 days puts detection strictly inside the
 * window.
 *
 * Monthly: `healthcheck.ts` NEVER looks at the monthly prefixes. So a monthly
 * overwrite is not detected by anything today, and a 9-day window could not be
 * justified by "the detector will catch it" — there is no detector. Until
 * #1476 extends the healthcheck, the window has to be long enough that the
 * next monthly cycle is still inside it, which is why the floor is 31 rather
 * than 8. That is a weaker guarantee, stated as such rather than dressed up.
 */
export const MIN_RECOVERY_DAYS_DAILY = 8;
export const MIN_RECOVERY_DAYS_MONTHLY = 31;

/**
 * Throws unless every declared rule is within its published ceiling.
 *
 * @param {{rules: Array<Object>}} decl parsed `bucket-lifecycle.json`
 * @param {(msg: string) => never} fail caller's fatal-error function, so each
 *        script reports in its own voice and exits its own way
 */
export function assertPolicyCeilings(decl, fail) {
  const byPrefix = new Map(decl.rules.map((r) => [r.fileNamePrefix, r]));

  const groups = [
    { prefixes: DAILY_PREFIXES, max: DAILY_MAX_TOTAL_DAYS,
      floor: MIN_RECOVERY_DAYS_DAILY, promise:
        'PrivacyPolicy.md: nightly archives kept 30 days, and a support ' +
        "ticket's backup copies live only in that tier" },
    { prefixes: MONTHLY_PREFIXES, max: MONTHLY_MAX_TOTAL_DAYS,
      floor: MIN_RECOVERY_DAYS_MONTHLY, promise:
        'PrivacyPolicy.md: monthly archives kept 12 months, then age out' },
  ];

  for (const { prefixes, max, floor, promise } of groups) {
    for (const prefix of prefixes) {
      const r = byPrefix.get(prefix);

      // ABSENT is not "unconstrained", it is "no rule", and B2 keeps such
      // versions forever. Skipping a missing prefix let the declaration pass
      // while ticket-bearing objects were retained indefinitely — the failure
      // was silent and in the unsafe direction.
      if (!r) {
        fail(
          `bucket-lifecycle.json declares no rule for "${prefix}". Without one ` +
            `B2 retains those versions indefinitely, which breaks a published ` +
            `promise (${promise}). Declare the prefix explicitly.`,
        );
      }

      const hide = r.daysFromUploadingToHiding;
      const del = r.daysFromHidingToDeleting;

      // `null` means "no rule for this transition" to B2 — i.e. unbounded —
      // and the earlier check coerced it to 0, turning unbounded into
      // apparently-free. Both terms must be real numbers.
      for (const [name, v] of [
        ['daysFromUploadingToHiding', hide],
        ['daysFromHidingToDeleting', del],
      ]) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
          fail(
            `bucket-lifecycle.json "${prefix}": ${name} is ${JSON.stringify(v)}. ` +
              `B2 treats an absent or null term as UNBOUNDED, so this cannot be ` +
              `left open on a prefix bound by a published promise (${promise}).`,
          );
        }
      }

      const total = hide + del;
      if (total > max) {
        fail(
          `bucket-lifecycle.json "${prefix}": worst-case lifetime is ${total} ` +
            `days (${hide} to hide + ${del} to delete), over the ${max}-day ` +
            `ceiling.\nThat ceiling comes from a published promise, not a ` +
            `preference — ${promise}. Both terms count, because a version is ` +
            `deleted ${del} days after it is hidden and it is hidden either by ` +
            `age OR by being superseded at the same key.\nBring the sum to ` +
            `${max} or below. For the daily tier the only way past the ceiling ` +
            `is to remove \`support_tickets\` from that tier in backup.ts ` +
            `(#1474) — a product decision, not a config one.`,
        );
      }

      // The floor applies to EVERY tier, not just the daily one (#1471 r6).
      // Scoping it to daily left the monthly prefixes free to carry a window
      // shorter than anything that could notice an overwrite in them.
      if (del < floor) {
        fail(
          `bucket-lifecycle.json "${prefix}": daysFromHidingToDeleting is ${del}, ` +
            `under the ${floor}-day floor for this tier.\nThat term is the ONLY ` +
            `window in which a superseded (possibly forged-over) object can be ` +
            `recovered.\n` +
            (DAILY_PREFIXES.includes(prefix)
              ? `The daily detector is the WEEKLY healthcheck, so at 7 days a ` +
                `forgery landing just after one Monday becomes deletable as the ` +
                `next Monday's alert fires — the alert races the deletion (#1469).`
              : `There is NO detector for the monthly prefixes: healthcheck.ts ` +
                `examines only \`manifests/<recent dates>/\`. So this window ` +
                `cannot be justified by detection at all, and must at least ` +
                `outlast the monthly write cadence (#1476).`),
        );
      }
    }
  }
}
