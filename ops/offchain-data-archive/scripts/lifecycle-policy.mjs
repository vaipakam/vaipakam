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
 * WHAT THE WINDOW ACTUALLY GUARANTEES — it is an UPPER BOUND, not a floor per
 * incident (#1471 r12). `daysFromHidingToDeleting` counts from the moment a
 * version became non-current, and that happens two ways: superseded by a new
 * upload at the same key, OR hidden by the age rule. Only the first restarts
 * the clock. So a version the age rule hid on day 20 is deleted on day 29
 * whatever happens afterwards: an attacker who overwrites it on day 28 leaves
 * about ONE day of recovery, not nine.
 *
 * The window therefore reads: up to N days, decaying to zero as a version
 * approaches its own deletion date. Within a total lifetime the privacy promise
 * caps (see above), that decay cannot be designed away — extending the recovery
 * term shortens the current-version window by the same amount.
 *
 * Why this is still worth having, stated rather than assumed: the archive an
 * attacker gains most from forging is the NEWEST one, because that is what a
 * restore reaches for — and the newest archive is current, not aged-hidden, so
 * it gets the full window. Recovery time decays exactly as an archive's restore
 * value decays. What the window does NOT cover is a targeted overwrite of a
 * nearly-expired archive; bounding that needs immutability (Object Lock or
 * retention, #1469) rather than lifecycle arithmetic.
 *
 * The floor below is derived from the CADENCE of the only routine inspection
 * these objects get — the healthcheck, which runs on Mondays off the daily cron — and
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

/**
 * The ONLY rule fields B2 accepts. Shared, because both writers need it and a
 * second copy is the defect this module exists to prevent (#1471 r11).
 *
 * A field outside this set is either a typo or a capability we have not wired.
 * Either way it must not pass silently: `apply-bucket-lifecycle.mjs` projects
 * each rule onto a fixed shape before comparing and before writing, so an
 * unrecognised field was DROPPED — `--check` then reported a match while the
 * declaration asked for something the bucket never received. Review exercised
 * that with `daysFromUploadingToDeleting` and got a clean exit 0.
 */
export const B2_RULE_FIELDS = Object.freeze([
  'fileNamePrefix',
  'daysFromUploadingToHiding',
  'daysFromHidingToDeleting',
  'daysFromStartingToCancelingUnfinishedLargeFiles',
]);

/** Prefixes whose retention is bounded by the 30-day ticket promise. */
export const DAILY_PREFIXES = ['archives/', 'manifests/'];
/** Prefixes whose retention is bounded by the 12-month promise. */
export const MONTHLY_PREFIXES = ['archives-monthly/', 'manifests-monthly/'];

/**
 * Prefixes that must carry NO rule — their indefinite retention IS that absence,
 * for legal-audit durability. Module-level beside the others because it is a
 * policy constant, not a local (#1471 r13: it was declared inside the function
 * AFTER its first use, which is a TDZ error that broke every invocation).
 */
export const YEARLY_PREFIXES = ['archives-yearly/', 'manifests-yearly/'];

/** Published: nightly archives kept 30 days. Minus a day for the prune race. */
export const DAILY_MAX_TOTAL_DAYS = 29;
/** Published: monthly archives kept 12 months. */
export const MONTHLY_MAX_TOTAL_DAYS = 365;
/**
 * Recovery-window floors, kept PER TIER because their CEILINGS differ and a
 * future divergence should have somewhere to land. The two values are equal
 * today and that is not a coincidence: since #1476 both tiers are inspected by
 * the same weekly healthcheck, so the same derivation produces the same
 * number. They were unequal while only the daily tier had a detector (#1471
 * r6).
 *
 * Daily: 8 is the weekly healthcheck's cadence (Mon 09:00 UTC) plus a day.
 * Read that as the interval at which SOMETHING routinely looks at these
 * objects — not as response time after an alert. Per the note above, the
 * healthcheck cannot raise one for an authenticated forgery, so the floor is
 * "the window outlives one full cycle of the only routine inspection there
 * is", which is the weakest defensible reading and the honest one.
 *
 * Monthly: the SAME derivation as daily, since #1476. `healthcheck.ts` now
 * verifies the newest monthly archive + manifest on the same weekly run, so
 * the monthly prefixes get the same routine inspection the daily ones do and
 * the floor is the same cycle-plus-slack figure.
 *
 * Before #1476 the check examined only `manifests/<recent dates>/`, so a
 * monthly overwrite was detected by nothing and the floor could not be
 * justified by detection at all — it was 31 purely so the window outlasted
 * the monthly write cadence. Note which way that argument ran: the weaker
 * guarantee was ACKNOWLEDGED in this comment while the number quietly stood
 * in for a detector that did not exist. The floor moved only once the
 * detector it names actually existed, not before.
 *
 * Both floors remain floors of USEFULNESS, not sufficiency: neither tier's
 * check can raise an alert for an authenticated forgery (#1473).
 */
export const MIN_RECOVERY_DAYS_DAILY = 8;
export const MIN_RECOVERY_DAYS_MONTHLY = 8;

/**
 * Throws unless every declared rule is within its published ceiling.
 *
 * @param {{rules: Array<Object>}} decl parsed `bucket-lifecycle.json`
 * @param {(msg: string) => never} fail caller's fatal-error function, so each
 *        script reports in its own voice and exits its own way
 */
export function assertPolicyCeilings(decl, fail) {
  for (const r of decl.rules) {
    const unknown = Object.keys(r).filter((k) => !B2_RULE_FIELDS.includes(k));
    if (unknown.length) {
      fail(
        `bucket-lifecycle.json rule "${r.fileNamePrefix}" declares field(s) B2 ` +
          `does not accept: ${unknown.join(', ')}. A misspelling here is ` +
          `silently DROPPED by the apply path's projection, so the check would ` +
          `report a match while the bucket never received it. Fix the spelling, ` +
          `or add the field to B2_RULE_FIELDS here only if b2_update_bucket ` +
          `genuinely accepts it.`,
      );
    }
  }

  // NO DUPLICATE PREFIXES (#1471 r14). `new Map()` keeps the LAST entry for a
  // repeated key, so two rules for `archives/` collapse to one for the ceiling
  // and floor checks while BOTH are forwarded to B2 — making validation
  // order-dependent. Review exercised exactly that: an over-limit rule followed
  // by the valid one passed, and reversing them failed. A validator whose
  // verdict depends on array order is not a validator.
  const seen = new Set();
  for (const r of decl.rules) {
    const p = String(r.fileNamePrefix ?? '');
    if (seen.has(p)) {
      fail(
        `bucket-lifecycle.json declares MORE THAN ONE rule for "${p}". B2 receives ` +
          `every rule in the array, but the ceiling and floor checks index by ` +
          `prefix and would only see one of them — so whichever came last would ` +
          `decide whether the other is allowed. Declare exactly one rule per ` +
          `prefix.`,
      );
    }
    seen.add(p);
  }

  const byPrefix = new Map(decl.rules.map((r) => [r.fileNamePrefix, r]));

  // THE YEARLY PREFIXES MUST CARRY NO RULE (#1471 r10). Their indefinite
  // retention IS the absence of a rule — and this validator iterated only the
  // daily and monthly groups, so a rule accidentally declared for
  // `archives-yearly/` or `manifests-yearly/` was ignored here and forwarded
  // to B2 by both writers. That would silently start expiring the legal-audit
  // durability tier. The healthcheck does read these prefixes since #1476, but
  // it verifies the newest object against its manifest — it cannot report that
  // an object which should still exist has been aged out, and no promise caps
  // this tier either. So a rule here still expires the tier with no other
  // signal; reading it is not the same as noticing it shrink.
  // PREFIX MATCHING, NOT EQUALITY (#1471 r11). B2 applies a rule to every key
  // UNDER its prefix, so `archives-yearly/2025/` expires yearly objects just as
  // surely as `archives-yearly/` would — and an exact-membership test let it
  // straight through. Review exercised exactly that with a two-day deletion.

  for (const r of decl.rules) {
    const p = String(r.fileNamePrefix ?? '');
    if (YEARLY_PREFIXES.some((y) => p === y || p.startsWith(y))) {
      fail(
        `bucket-lifecycle.json declares a rule for "${r.fileNamePrefix}". The ` +
          `yearly prefixes must have NO rule — their indefinite retention is ` +
          `exactly that absence, and it exists for legal-audit durability. Any ` +
          `rule here starts expiring that tier, and nothing else would report ` +
          `it: the healthcheck verifies the newest object under those prefixes ` +
          `(#1476) but cannot notice one that has been aged out, and no ` +
          `published promise bounds them.`,
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

  // NESTED RULES UNDER *ANY* BOUNDED PREFIX (#1471 r12). r11 fixed this for the
  // yearly prefixes and left the same hole on the bounded ones: `byPrefix` is an
  // exact-match map, so a rule for `archives/2025/` was neither matched as the
  // daily prefix nor rejected — while B2 applies it to daily objects, under a
  // ceiling nothing checked. Same defect, other half of the same function.
  // OVERLAP IN BOTH DIRECTIONS (#1471 r13). r12 tested only whether a rule sits
  // BENEATH a managed prefix, which missed the more dangerous direction: a
  // PARENT rule. `fileNamePrefix: ""` matches every object in the bucket and
  // `"archives"` matches both `archives/` and `archives-monthly/` — neither is
  // nested under a managed prefix, so both passed, and review exercised both.
  // A parent rule is worse than a nested one because it silently governs the
  // yearly prefixes too, whose whole guarantee is having no rule at all.
  const MANAGED = [...DAILY_PREFIXES, ...MONTHLY_PREFIXES, ...YEARLY_PREFIXES];
  for (const r of decl.rules) {
    const p = String(r.fileNamePrefix ?? '');
    if (MANAGED.includes(p)) continue;
    const clash = MANAGED.find((m) => p.startsWith(m) || m.startsWith(p));
    if (clash) {
      const nested = p.startsWith(clash);
      fail(
        `bucket-lifecycle.json declares a rule "${p}" that OVERLAPS the managed ` +
          `prefix "${clash}" (${nested ? 'nested beneath it' : 'a parent of it'}). ` +
          `B2 applies a rule to every key under its prefix, while the ceiling and ` +
          `floor checks key on the EXACT managed prefixes — so an overlapping rule ` +
          `governs those objects with no bound enforced. ` +
          `${p === '' ? 'An empty prefix matches the entire bucket, including the ' +
            'yearly tier whose guarantee is having no rule at all. ' : ''}` +
          `Declare retention on the managed prefixes themselves.`,
      );
    }
  }

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

      // THE MONTHLY PROMISE IS A FLOOR AS WELL AS A CEILING (#1471 r13). "Monthly
      // archives are kept 12 months" commits us to retaining them that long, not
      // merely to deleting them by then — the legal-audit durability story rests
      // on it. r12 checked only `total > max`, so shortening monthly to 1 + 31
      // was accepted and would have discarded eleven months of records the
      // published promise covers. The daily tier gets no equivalent floor: its
      // 30-day statement is a deletion commitment, under-retaining it breaches
      // nothing, and its recovery-window floor is enforced separately below.
      if (MONTHLY_PREFIXES.includes(prefix) && total < max) {
        fail(
          `bucket-lifecycle.json "${prefix}": worst-case lifetime is ${total} days ` +
            `(${hide} + ${del}), UNDER the ${max}-day commitment. ${promise} — that ` +
            `is a promise to KEEP them that long, so a shorter total discards ` +
            `records we have said we retain. If the intent is genuinely to shorten ` +
            `monthly retention, the published policy has to change first.`,
        );
      }

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
              : `The monthly prefixes get the same WEEKLY healthcheck as the ` +
                `daily ones since #1476, so this floor is the same ` +
                `cycle-plus-slack figure: under 8 days the window can close ` +
                `inside a single inspection cycle. It cannot raise an alert ` +
                `for an authenticated forgery either (#1473).`),
        );
      }
    }
  }
}
