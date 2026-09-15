/**
 * Memory of the loan rows a reconciliation pass could not settle (#2212).
 *
 * The pass examines one or three rows a turn and reports, for that turn, the
 * rows it could not settle. #2211 used that report directly to withhold
 * reminders — which narrowed the window without closing it, because on the
 * NEXT turn the row is not in the report at all: the exclusion is empty for
 * its id and the unretractable reminder is minted anyway.
 *
 * The aliasing is the defect. "What this pass examined" is not "what is
 * currently unsettled", and any fix reading only the current pass carries it
 * — including the cruder one of deferring the whole sweep whenever the
 * report is dirty, which fails identically and costs every healthy loan on
 * the chain its reminders as well.
 *
 * So the unsettled state is remembered until a later pass settles it. Two
 * halves, and the second is the one to get right: a marker that is never
 * cleared silently withholds a healthy loan's reminders forever, which is the
 * mirror image of the defect this fixes.
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { ReconcileReport } from './loanReconcile';

/**
 * How long a row may sit quarantined before it stops being a blip.
 *
 * Not an expiry — nothing is released on a timer, because time does not
 * settle a row against the chain. It is the threshold at which the operator
 * is told, since a row unsettled for this long is a ghost nobody has
 * resolved rather than an RPC having a bad minute.
 */
export const QUARANTINE_STALE_SECONDS = 6 * 60 * 60;

/**
 * How many held rows to NAME in one warning.
 *
 * A cap is needed — a chain with hundreds of held rows must not emit a
 * hundred-line log line — but the cap is why the TOTAL is counted separately.
 * Naming twenty and saying nothing else would let everything behind them
 * suppress reminders while never appearing anywhere.
 */
export const STALE_REPORT_LIMIT = 20;

/** Which of the four ways a row failed to settle. Kept, not flattened. */
export type QuarantineReason = 'unread' | 'write-failed' | 'orphan' | 'unknown-status';

/** Every row this pass could not settle, each with WHY. */
export function unsettledRows(report: ReconcileReport): { loanId: number; reason: QuarantineReason }[] {
  return [
    ...report.unread.map((loanId) => ({ loanId, reason: 'unread' as const })),
    ...report.writeFailed.map((loanId) => ({ loanId, reason: 'write-failed' as const })),
    ...report.unresolvable.map((loanId) => ({ loanId, reason: 'orphan' as const })),
    ...report.unknownStatus.map((u) => ({ loanId: u.loanId, reason: 'unknown-status' as const })),
  ];
}

/**
 * Rows this pass DID settle, and which may therefore be released.
 *
 * Everything it examined, minus everything it could not settle. A repaired
 * row is settled (it is terminal now); a row another writer terminalized is
 * settled for the same reason; a row examined and found genuinely running is
 * settled, which is the ordinary case and the one that releases a transient
 * read failure from quarantine on the next lap.
 *
 * Derived by subtraction rather than listed, deliberately: a new failure
 * bucket added to the report would otherwise be released here by default —
 * marked unsettled by one function and cleared by the other, on the same
 * pass, with nothing failing. Subtraction makes the new bucket quarantine
 * correctly the moment `unsettledRows` knows about it.
 */
export function settledRows(report: ReconcileReport): number[] {
  const unsettled = new Set(unsettledRows(report).map((r) => r.loanId));
  return [
    ...new Set([
      ...report.examined.filter((id) => !unsettled.has(id)),
      ...report.repaired.map((r) => r.loanId),
      ...report.superseded,
    ]),
  ].filter((id) => !unsettled.has(id));
}

/**
 * The quarantine writes for one pass, as statements.
 *
 * Statements rather than awaited calls so the whole set commits as ONE D1
 * transaction: the marks and the releases describe a single pass's findings,
 * and half of them landing would leave a row released by a pass that also
 * found it unsettled, or vice versa.
 *
 * **What this does NOT get, stated rather than implied:** they cannot ride
 * the repairs' own transactions. Each repair commits during the pass, while
 * this set is derived from the report the pass produces at the END — so the
 * two are necessarily separate commits. If the isolate dies in between, the
 * quarantine for that pass is lost.
 *
 * That is bounded and self-healing rather than silent: the row is still
 * unsettled, so the next time the rotation examines it the mark is written
 * again. The exposure is one rotation's worth of reminders for a row the
 * platform has not confirmed — which is strictly better than the per-pass
 * exclusion this replaces, and not a guarantee, and the difference is worth
 * a reader's time.
 */
export function quarantineStatements(
  db: D1Database,
  chainId: number,
  report: ReconcileReport,
  nowSec: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const { loanId, reason } of unsettledRows(report)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO loan_reconcile_quarantine
             (chain_id, loan_id, reason, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(chain_id, loan_id) DO UPDATE SET
             reason = excluded.reason,
             last_seen_at = excluded.last_seen_at`,
        )
        // `first_seen_at` is deliberately NOT in the update list. It is the
        // operator's whole signal — minutes means a transient read, days
        // means a ghost nobody resolved — and an upsert that refreshed it on
        // every re-observation would erase exactly that.
        .bind(chainId, loanId, reason, nowSec, nowSec),
    );
  }
  // ONE STATEMENT PER ROW, not an interpolated `IN (...)` list. The pass
  // examines one or three rows a turn, so the list is a handful and the
  // saving is nil — while an interpolated statement leaves the reach of the
  // #1149 SQL-vs-schema guard, which reads static prepare sites. Paying a
  // guard's worth of coverage for nothing is a bad trade, and the guard's
  // own escape hatch ("raise the pin with a test covering the dynamic
  // shape") is for cases that cannot be written statically. This can.
  for (const loanId of settledRows(report)) {
    statements.push(
      db
        .prepare(`DELETE FROM loan_reconcile_quarantine WHERE chain_id = ? AND loan_id = ?`)
        .bind(chainId, loanId),
    );
  }
  return statements;
}

/**
 * Release every held row whose loan is no longer live (#2213 r15
 * `4013952990`).
 *
 * THE DURABLE CLEANUP PATH, and the reason the close-out no longer needs one.
 * A row is released at close-out, in the same batch as the rest of it — except
 * when the table's existence could not be established, where naming it would
 * fail that batch. r14 answered that with a single follow-up delete, and a
 * single retry is not a retry path: if it also failed, the loan was terminal
 * by then, had left the set the reconciliation rotation selects from, and its
 * row was held and reported stale forever.
 *
 * Sweeping instead of retrying closes the whole class rather than that one
 * door. A release missed for ANY reason — an unknown probe, a failed
 * statement, a tick that died between the two — is picked up here on the next
 * pass, because the condition is a fact about the row rather than a memory of
 * what went wrong.
 *
 * Releasing is right, not merely tidy: the reminder surfaces select live rows,
 * so a held row for a terminal loan withholds nothing and only clutters the
 * stale report — burying the rows that DO need a person.
 *
 * One statement, static, no interpolation (the #1149 guard reads prepare
 * sites), and no per-row work regardless of how many rows accumulated.
 */
export async function releaseTerminalQuarantine(
  db: D1Database,
  chainId: number,
): Promise<void> {
  // WHY THIS IS `EXISTS(ended)` AND NOT `NOT EXISTS(still running)` (#2213
  // r30 `4017166980`, refuted with a caveat — see below and #2222).
  //
  // The two look equivalent and differ on exactly one case: a quarantine
  // entry whose `loans` row is absent. Releasing those would be wrong, and
  // the sibling test pins it: an ORPHAN — the chain denying a loan the
  // platform fabricated — may legitimately have no row in D1 either, and it
  // is the single most important thing this table keeps visible. Nothing
  // proves it ended, so it stays held and stays in the stale report, which is
  // where a person needs to see it. A blanket release would delete precisely
  // the rows the quarantine exists to surface, and do it silently.
  //
  // The finding's residual concern is real and is NOT addressed here: once an
  // operator resolves an orphan by deleting the fabricated row, this entry
  // has nothing left to match and lingers in the report for good. "Row
  // absent" cannot distinguish that from the unresolved orphan above, so the
  // fix needs a way to tell them apart rather than a different predicate.
  await db
    .prepare(
      `DELETE FROM loan_reconcile_quarantine
        WHERE chain_id = ?
          AND EXISTS (
            SELECT 1 FROM loans l
             WHERE l.chain_id = loan_reconcile_quarantine.chain_id
               AND l.loan_id  = loan_reconcile_quarantine.loan_id
               AND l.status NOT IN ('active', 'fallback_pending')
          )`,
    )
    .bind(chainId)
    .run();
}

/**
 * Tell the operator about rows that have been quarantined too long.
 *
 * The quarantine is silent by design in the ordinary case: a read fails, the
 * row is held back for a lap, the next lap settles it, nobody needs to know.
 * What must NOT be silent is a row that stays — that is a position the
 * platform is still publishing as open while the chain says otherwise, or
 * cannot say at all.
 *
 * (An earlier version of this sentence said "and no amount of retrying will
 * resolve it". That is the retired claim the report below is careful NOT to
 * make, and it survived HERE while being corrected twice in the release note
 * — the fourth place it lived. A row can cross the threshold without having
 * been re-examined at all, and may settle the moment it is.)
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT CLAIM (#2213 r1 `4011674991`,
 * `4011675003`):
 *
 * 1. **It does not say a source "has not recovered."** A row can cross the
 *    threshold without having been looked at again: the rotation examines a
 *    few rows a turn, so on a chain with more loans than a lap can cover in
 *    six hours, `first_seen_at` being old says nothing about whether the
 *    original failure persists. `last_seen_at` is what separates those, so
 *    both are reported and the wording is left to the evidence.
 * 2. **It does not imply that the rows it names are all of them.** A listing
 *    capped at 20 and ordered oldest-first returns the SAME twenty every
 *    time, so anything behind them would suppress reminders indefinitely
 *    while never being named. The total is counted separately and the
 *    overflow is stated, so "20 shown" can never read as "20 exist".
 */
export async function reportStaleQuarantine(
  db: D1Database,
  chainId: number,
  nowSec: number,
): Promise<void> {
  const cutoff = nowSec - QUARANTINE_STALE_SECONDS;
  const total = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM loan_reconcile_quarantine
        WHERE chain_id = ? AND first_seen_at <= ?`,
    )
    .bind(chainId, cutoff)
    .first<{ n: number }>();
  const n = total?.n ?? 0;
  if (n === 0) return;
  const rows = await db
    .prepare(
      `SELECT loan_id, reason, first_seen_at, last_seen_at
         FROM loan_reconcile_quarantine
        WHERE chain_id = ? AND first_seen_at <= ?
        ORDER BY first_seen_at ASC LIMIT ?`,
    )
    .bind(chainId, cutoff, STALE_REPORT_LIMIT)
    .all<{ loan_id: number; reason: string; first_seen_at: number; last_seen_at: number }>();
  const shown = rows.results ?? [];
  const described = shown
    .map((r) => {
      const heldHours = Math.floor((nowSec - r.first_seen_at) / 3600);
      // WHAT THIS COLUMN ACTUALLY IS: the last time an unsettled sighting was
      // successfully WRITTEN — not the last time a pass looked (#2213 r23
      // `4015375760`).
      //
      // The two come apart exactly when the upsert batch fails, which is a
      // case this PR made reachable and then reported on: the pass examined
      // the row minutes ago, only recording it failed, so the column keeps an
      // older value. Calling that "last examined" then tells an operator the
      // row is merely waiting for the rotation — the one reading that sends
      // them away from a row whose bookkeeping is broken.
      const sinceRecorded = Math.floor((nowSec - r.last_seen_at) / 3600);
      return (
        `loan ${r.loan_id} (${r.reason}, held ${heldHours}h, ` +
        `last recorded unsettled ${sinceRecorded}h ago)`
      );
    })
    .join('; ');
  const overflow = n > shown.length ? ` (+${n - shown.length} more not listed)` : '';
  console.warn(
    `[loanQuarantine] chain ${chainId}: ${n} loan(s) held back from reminders ` +
      `for over ${QUARANTINE_STALE_SECONDS / 3600}h — ${described}${overflow}. ` +
      `A row recorded recently is still failing; one recorded long ago is ` +
      `either waiting for the rotation to reach it or being examined and not ` +
      `written — the quarantine WRITE failure above says which, and this ` +
      `column cannot. An orphan needs a person either way.`,
  );
}


/* ────────────────────────────────────────────────────────────────────────────
 * The table's NAME, its availability probe, and the exclusion fragment.
 *
 * Moved here from `@vaipakam/lib/reminderEligibility` in #2213 r22
 * (`4015173433`). They were in the shared package while both reminder lanes
 * consulted the quarantine; this PR moved the periodic lane to asking the
 * chain directly, which left an indexer-owned D1 table name and SQL fragment
 * sitting in a package module whose only other contents were chain-state
 * arithmetic the agent reads. Every consumer of these three is in this Worker.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The table the memory lives in. Named once so a rename cannot half-land. */
export const QUARANTINE_TABLE = 'loan_reconcile_quarantine';

/**
 * A `WHERE`-clause fragment excluding quarantined loans.
 *
 * Correlates on the OUTER query's own columns, so the caller passes the alias
 * its `loans` table is selected under. No binds, so it composes with any
 * parameter list.
 *
 * Belongs in SQL rather than a post-select filter: every caller applies a
 * `LIMIT`, and a quarantined row filtered afterwards has already occupied a
 * slot that an eligible row behind it needed.
 */
export function quarantineExclusionSql(loansAlias = 'loans'): string {
  return `NOT EXISTS (
            SELECT 1 FROM ${QUARANTINE_TABLE} q
             WHERE q.chain_id = ${loansAlias}.chain_id
               AND q.loan_id = ${loansAlias}.loan_id
          )`;
}

/** The single D1 method the probe needs, so this stays runtime-agnostic. */
export interface QuarantineProbeDb {
  prepare(query: string): { first<T>(): Promise<T | null> };
}

/**
 * Whether the quarantine memory is there — or whether the question failed.
 *
 * THREE ANSWERS, not two (#2213 r13 `4013570995`). `'absent'` and `'unknown'`
 * were one value until this round, and collapsing them is the same defect the
 * agent's cursor read had: a transient failure looked like a definite "the
 * table is not there", so the sweep dropped the exclusion, announced that the
 * migration was missing, and minted unretractable reminders for exactly the
 * loans being held back.
 *
 * The two callers then take OPPOSITE safe directions from `'unknown'`, which
 * is why this returns the fact rather than a boolean:
 *
 * - The reminder sweep DEFERS. It is about to send something it cannot
 *   retract, so an unanswered question is not permission.
 * - A close-out batch OMITS the release, exactly as it does for `'absent'`.
 *   Naming a table that might not exist would fail the whole batch, and that
 *   batch advances the chain cursor — so the cautious direction there is to
 *   write less, not to stop.
 */
export type QuarantineAvailability = 'present' | 'absent' | 'unknown';

/**
 * Build a "has migration 0049 landed on this database?" probe.
 *
 * A FACTORY because the answer is cached per isolate and each Worker must
 * hold its own — a module-level cache shared by import would be fine today
 * and wrong the moment two databases are involved.
 *
 * **Why a probe and not a caught error.** The canonical deploy scripts
 * publish a Worker BEFORE applying its D1 migrations (#2214), so there is a
 * guaranteed window where this code runs against a database without the
 * table. "Does this table exist" has a definite answer; "was that failure a
 * missing table" is a guess about an error message, and a failure classifier
 * narrowed round after round cannot be sharpened into correctness.
 *
 * **A PRESENT is cached for the life of the isolate.** A table does not
 * un-exist, so the steady-state cost is one read per isolate.
 *
 * **An ABSENT or an UNKNOWN is cached for the life of one PASS** (#2213 r28
 * `4016565774`). Neither used to be cached at all, on the reasoning that
 * caching an absence would leave this isolate ignoring the quarantine after
 * the migration landed, until it happened to recycle. That reasoning is right
 * about an isolate-lifetime cache and it bought an unbounded one instead:
 * during the guaranteed deploy-before-migration window (#2214) EVERY terminal
 * event re-probed, and a normal close-out can reach the helper twice — once in
 * its own handler and again through the deferred `LoanStatusChanged` cleanup.
 * A backfill with enough close-outs then spends the Worker's subrequest
 * allowance on identical `sqlite_master` reads and aborts before advancing the
 * cursor, which is the rollout freeze this guard exists to prevent.
 *
 * A pass is the right scope because it bounds both errors: at most one probe
 * per pass however many close-outs it carries, and at most one pass of
 * ignoring a migration that has just landed.
 *
 * `beginPass()` both OPENS that scope and clears it, and the opening half is
 * load-bearing: a caller that never calls it never caches a negative at all,
 * and so keeps the pre-r28 behaviour exactly. Written the other way round —
 * caching by default, `beginPass()` merely clearing — a lane that forgot the
 * call would latch `absent` for the life of its isolate and go on ignoring
 * the quarantine long after the migration landed, which is the failure the
 * no-caching rule was protecting against in the first place. Forgetting is
 * now a missed optimisation rather than a stale answer.
 */
export interface QuarantineAvailabilityProbe {
  (db: QuarantineProbeDb): Promise<QuarantineAvailability>;
  /** Forget a cached `absent`/`unknown`; a cached `present` survives. */
  beginPass(): void;
}

export function createQuarantineAvailability(): QuarantineAvailabilityProbe {
  let seen = false;
  let passOpen = false;
  let thisPass: QuarantineAvailability | null = null;
  const probe = async (db: QuarantineProbeDb): Promise<QuarantineAvailability> => {
    if (seen) return 'present';
    if (thisPass !== null) return thisPass;
    try {
      const row = await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${QUARANTINE_TABLE}'`,
        )
        .first<{ name: string }>();
      if (row) {
        seen = true;
        return 'present';
      }
      if (passOpen) thisPass = 'absent';
      return 'absent';
    } catch {
      // STILL DOES NOT THROW. Its callers are a reminder sweep and a close-out
      // batch, and making either fail because the QUESTION failed would turn a
      // database hiccup into a stalled chain cursor or a dropped sweep. What
      // changed in r13 is that the answer is no longer a confident "absent":
      // the caller is told the question failed and decides for itself.
      if (passOpen) thisPass = 'unknown';
      return 'unknown';
    }
  };
  probe.beginPass = () => {
    passOpen = true;
    thisPass = null;
  };
  return probe as QuarantineAvailabilityProbe;
}
