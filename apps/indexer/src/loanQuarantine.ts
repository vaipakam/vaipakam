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
 * Tell the operator about rows that have been quarantined too long.
 *
 * The quarantine is silent by design in the ordinary case: a read fails, the
 * row is held back for a lap, the next lap settles it, nobody needs to know.
 * What must NOT be silent is a row that stays — that is a position the
 * platform is still publishing as open while the chain says otherwise, or
 * cannot say at all, and no amount of retrying will resolve it.
 */
export async function reportStaleQuarantine(
  db: D1Database,
  chainId: number,
  nowSec: number,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT loan_id, reason, first_seen_at FROM loan_reconcile_quarantine
        WHERE chain_id = ? AND first_seen_at <= ?
        ORDER BY first_seen_at ASC LIMIT 20`,
    )
    .bind(chainId, nowSec - QUARANTINE_STALE_SECONDS)
    .all<{ loan_id: number; reason: string; first_seen_at: number }>();
  const stale = rows.results ?? [];
  if (stale.length === 0) return;
  console.warn(
    `[loanQuarantine] chain ${chainId}: ${stale.length} loan(s) unsettled for ` +
      `over ${QUARANTINE_STALE_SECONDS / 3600}h and withheld from reminders — ` +
      stale
        .map(
          (r) =>
            `loan ${r.loan_id} (${r.reason}, since ${new Date(r.first_seen_at * 1000).toISOString()})`,
        )
        .join('; ') +
      `. An orphan needs a person; the others mean a source or a build that ` +
      `has not recovered.`,
  );
}
