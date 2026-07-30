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
 * WHAT THE DETECTOR ACTUALLY DETECTS. `healthcheck.ts` checks the newest
 * archive against its manifest — hash, size, decryptability. That catches
 * corruption and a BLIND overwrite. It does NOT catch an authenticated
 * forgery: a compromised Worker yields both B2 credential pairs and
 * `BACKUP_ENCRYPTION_KEY` from one environment, so an attacker can enumerate
 * the genuine nonce and write a self-consistent encrypted pair at that key,
 * and every check passes. The floors below are therefore a floor of
 * USEFULNESS — time for a human or an out-of-band signal to notice — not a
 * sufficiency argument. #1473 is what closes the forgery case.
 *
 * WHY THE RECOVERY TERM HAS A FLOOR. `daysFromHidingToDeleting` is the window
 * in which a SUPERSEDED version can still be recovered — the only defence
 * against a forged overwrite, since the Worker's write key holds `writeFiles`
 * but not `deleteFiles` (an attacker can shadow an archive, never delete one).
 *
 * The floor is derived from the CADENCE of the only routine inspection these
 * objects get — the healthcheck, which runs on Mondays off the daily cron — and
 * NOT from any alert. Per the note above, no alert fires for an authenticated
 * forgery. So the floor says: the window must outlive one full inspection
 * cycle, which is 7 days plus a day of slack. Under it, a window can open and
 * close entirely between two inspections.
 *
 * Read that as the weakest defensible bound, not as response time. An earlier
 * revision of this comment derived the floor from "the next Monday's alert
 * fires — the alert and the deletion race", which was the framing the note
 * above retires; it survived three rounds of corrections in three other files
 * before being caught here (#1471 r6/r7/r8/r9). The declaration should sit
 * above the floor so a human has room to act on an out-of-band signal.
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
 * Daily: 8 is the weekly healthcheck's cadence (Mon 09:00 UTC) plus a day.
 * Read that as the interval at which SOMETHING routinely looks at these
 * objects — not as response time after an alert. Per the note above, the
 * healthcheck cannot raise one for an authenticated forgery, so the floor is
 * "the window outlives one full cycle of the only routine inspection there
 * is", which is the weakest defensible reading and the honest one.
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

  // THE YEARLY PREFIXES MUST CARRY NO RULE (#1471 r10). Their indefinite
  // retention IS the absence of a rule — and this validator iterated only the
  // daily and monthly groups, so a rule accidentally declared for
  // `archives-yearly/` or `manifests-yearly/` was ignored here and forwarded
  // to B2 by both writers. That would silently start expiring the legal-audit
  // durability tier, which is the one tier nothing else would notice: no
  // healthcheck reads it (#1476) and no promise caps it, so there is no other
  // signal.
  const YEARLY_PREFIXES = ['archives-yearly/', 'manifests-yearly/'];
  for (const r of decl.rules) {
    if (YEARLY_PREFIXES.includes(r.fileNamePrefix)) {
      fail(
        `bucket-lifecycle.json declares a rule for "${r.fileNamePrefix}". The ` +
          `yearly prefixes must have NO rule — their indefinite retention is ` +
          `exactly that absence, and it exists for legal-audit durability. Any ` +
          `rule here starts expiring that tier, and nothing else would report ` +
          `it: no healthcheck examines those prefixes (#1476) and no published ` +
          `promise bounds them.`,
      );
    }
  }

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
              ? `The only routine inspection of these objects is the WEEKLY ` +
                `healthcheck, so under 8 days the window can close inside a ` +
                `single inspection cycle. Note it cannot raise an alert for an ` +
                `authenticated forgery at all (#1473) — this floor buys a full ` +
                `cycle of routine looking, not response time (#1469).`
              : `There is NO detector for the monthly prefixes: healthcheck.ts ` +
                `examines only \`manifests/<recent dates>/\`. So this window ` +
                `cannot be justified by detection at all, and must at least ` +
                `outlast the monthly write cadence (#1476).`),
        );
      }
    }
  }
}
