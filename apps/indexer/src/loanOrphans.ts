/**
 * #2197 — withdrawing a `loans` row the chain has no loan for.
 *
 * ONE owner for the move, because two lanes prove a row is an orphan: the
 * reconciliation pass, which existence-checks the live rows (`active`,
 * `fallback_pending`), and the settlement heal, which reads every
 * terminal-unsettled row (`repaid`, `defaulted`, `liquidated`,
 * `internal_matched`) at the settled head anyway. Both find the same thing —
 * `getLoanDetails` answering the zero struct (id 0) at a settled block — and
 * both must make the same move, so the move lives here and neither carries
 * its own copy.
 *
 * WHAT MOVES. Everything the platform publishes about the loan: the `loans`
 * row, its ledger entries (`activity_events`), its participation history
 * (`loan_participants`) and its inbox notifications — each archived whole
 * into `loan_orphans` and deleted, so no surface (the loan pages, a wallet's
 * history and Activity filter, the bell) goes on presenting a position the
 * chain never had (#2636 r2). Its side tables are cleared too; they are
 * commitments to act, not records, and are not kept. Migration 0065 says how
 * an operator puts a move back.
 *
 * ONE TRANSACTION, ONE COMPARE-AND-SET. The move is a single D1 batch. Its
 * first statement archives the loan row only if the row still equals, column
 * for column, the copy read below, and stamps the archive row with a fresh
 * `move_id`; every later statement acts only if THAT archive row exists. So a
 * writer that changed anything about the loan row between the read and the
 * batch leaves the whole move a no-op: nothing archived, nothing deleted.
 * Whole-row equality rather than `updated_at` (#2636 r2): writers stamp whole
 * seconds, so two writes in one second share a stamp. A related row is
 * kept by the same check (#2636 r3): the archive insert also requires each
 * related table to hold exactly the rows that were read for the loan, by
 * rowid, so one that arrives in between aborts the move too, and the next lap
 * reads it and tries again. Those rows are written once and never edited, so
 * the same set is the same content.
 *
 * DEDUPE STATE GOES TOO, unkept. `notify_state` and `pre_grace_notify_state`
 * remember which alert a wallet last got for a position. A reorganised-away
 * loan's id can be issued again to a real loan, which would otherwise inherit
 * the phantom's alert history and miss its first warning (#2636 r3).
 *
 * THE OPERATOR'S RECORD IS `loan_orphans` ITSELF (#2636 r4). Every entry
 * stays unreviewed (`reviewed_at` NULL) until a person marks it reviewed, and
 * the stale report names the unreviewed ones on every pass
 * (`loanOrphanReport.ts`, folded into that
 * report's one batch). The table is archived and restored, so the finding
 * survives a restore with it. The id's reconciliation quarantine marker is
 * RELEASED after a landed move rather than kept: that marker withholds
 * reminders from whatever loan bears the id, and once the published row is
 * gone the only loan it could withhold them from is a real one issued the
 * same id later.
 *
 * The side tables are the ones `_closedLoanSideTableStatements` clears on a
 * close-out (`prepay_listings`, `swap_to_repay_intents`), written out here
 * with the guard rather than shared, because the close-out's are
 * unconditional. `test/closedLoanSideTables.test.ts` pins the two lists to
 * the same tables.
 *
 *
 * Every statement but the archive insert is a literal, so the #1149
 * SQL-vs-schema guard checks it against the migrated schema. The archive
 * insert's guard is built from the loan row's own column names (refused
 * unless each is a plain identifier) and is exercised against the real
 * schema in `test/closedLoanSideTables.test.ts`.
 */

import { affords, plus, type Cost, type TickBudget } from './subrequestBudget';
import { discloseQuarantineReleases, quarantineReleaseStatement } from './loanQuarantine';

/** What one move costs the invocation: three batches (the snapshot, the
 *  move, the marker release after it), all of them D1 — no chain read — and
 *  every statement in them a D1 query. Callers check `orphanMoveAffordable`
 *  before starting a move, so it never runs into the ceiling half done. */
export const ORPHAN_MOVE_COST: Cost = { external: 0, d1Queries: 4 + 9 + 1 };

/**
 * Whether a move may START: its whole cost, and still what the caller must
 * do after it (`reserve`). The one rule every lane that withdraws an orphan
 * applies (#2636 r4).
 */
export function orphanMoveAffordable(budget: TickBudget, reserve: Cost): boolean {
  return affords(budget, plus(ORPHAN_MOVE_COST, reserve));
}

/** A column name SQLite handed back, accepted only as a plain identifier. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Move `loanId` on `chainId` out of publication into `loan_orphans`, if its
 * row still carries status `from`. Returns whether the move landed: false
 * when the row is gone, no longer `from`, or it or any row about it changed
 * in between (the whole batch is then a no-op, and the caller's next lap
 * decides again).
 *
 * The caller must already have PROVEN the loan nonexistent at
 * `observedBlock` (a successful read answering the zero struct at a settled
 * block). A read that failed proves nothing and must never reach here.
 */
export async function withdrawOrphanLoan(
  db: D1Database,
  chainId: number,
  /** The Diamond the existence read was made against. */
  diamond: string,
  loanId: number,
  from: string,
  /** The settled block the existence read was pinned to: the evidence. */
  observedBlock: bigint,
  /** Wall clock of the move, seconds. When the platform acted. */
  nowSec: number,
): Promise<boolean> {
  // What is kept, read first because D1 cannot serialise a whole row inside
  // a statement without naming every column. One batch, so one snapshot;
  // related rows in rowid order, the order the check below compares in.
  const [loanRes, activityRes, participantRes, notificationRes] = await db.batch([
    db.prepare(`SELECT * FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ?`).bind(chainId, loanId, from),
    db
      .prepare(`SELECT rowid AS orphan_rowid, * FROM activity_events WHERE chain_id = ? AND loan_id = ? ORDER BY rowid`)
      .bind(chainId, loanId),
    db
      .prepare(`SELECT rowid AS orphan_rowid, * FROM loan_participants WHERE chain_id = ? AND loan_id = ? ORDER BY rowid`)
      .bind(chainId, loanId),
    db
      .prepare(`SELECT rowid AS orphan_rowid, * FROM notifications WHERE chain_id = ? AND loan_id = ? ORDER BY rowid`)
      .bind(chainId, loanId),
  ]);
  const row = (loanRes?.results?.[0] ?? null) as Record<string, unknown> | null;
  if (!row) return false;
  const columns = Object.keys(row);
  if (columns.length === 0 || !columns.every((c) => PLAIN_IDENTIFIER.test(c))) {
    throw new Error(`loan ${loanId} on chain ${chainId}: unexpected column names; orphan move refused`);
  }
  const related = {
    activity_events: (activityRes?.results ?? []) as Array<{ orphan_rowid: number }>,
    loan_participants: (participantRes?.results ?? []) as Array<{ orphan_rowid: number }>,
    notifications: (notificationRes?.results ?? []) as Array<{ orphan_rowid: number }>,
  };
  const rowids = (rows: Array<{ orphan_rowid: number }>) => JSON.stringify(rows.map((r) => r.orphan_rowid));
  const moveId = crypto.randomUUID();
  // `IS`, not `=`, so a NULL column compares equal to a NULL it was read as.
  const sameRow = columns.map((c) => `"${c}" IS ?`).join(' AND ');
  // The archive row, and the gate for everything after it: the loan row is
  // unchanged, and each related table holds exactly the rows that were read.
  // `json(?)` normalises the bound list the way `json_group_array` writes.
  const archive = db
    .prepare(
      `INSERT INTO loan_orphans
         (move_id, chain_id, diamond, loan_id, from_status, observed_block, withdrawn_at, row_json, related_json)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM loans WHERE ${sameRow})
          AND (SELECT json_group_array(r) FROM (SELECT rowid AS r FROM activity_events
                WHERE chain_id = ? AND loan_id = ? ORDER BY rowid)) = json(?)
          AND (SELECT json_group_array(r) FROM (SELECT rowid AS r FROM loan_participants
                WHERE chain_id = ? AND loan_id = ? ORDER BY rowid)) = json(?)
          AND (SELECT json_group_array(r) FROM (SELECT rowid AS r FROM notifications
                WHERE chain_id = ? AND loan_id = ? ORDER BY rowid)) = json(?)`,
    )
    .bind(
      moveId,
      chainId,
      diamond.toLowerCase(),
      loanId,
      from,
      Number(observedBlock),
      nowSec,
      JSON.stringify(row),
      JSON.stringify(related),
      ...columns.map((c) => row[c] as never),
      chainId,
      loanId,
      rowids(related.activity_events),
      chainId,
      loanId,
      rowids(related.loan_participants),
      chainId,
      loanId,
      rowids(related.notifications),
    );
  const results = await db.batch([
    archive,
    db
      .prepare(
        `DELETE FROM prepay_listings WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM swap_to_repay_intents WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM activity_events WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM loan_participants WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM notifications WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM notify_state WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM pre_grace_notify_state WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
    db
      .prepare(
        `DELETE FROM loans WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
  ]);
  const moved = (results[8]?.meta?.changes ?? 0) > 0;
  if (moved) {
    // After the move, in its own batch: the release is the one path every
    // per-loan marker delete takes (`quarantineReleaseStatement`), and it
    // carries no move guard. Run only once the move has landed. If it fails,
    // the marker lingers on an id with no row, which the stale report names
    // ("no stored loan row") for a person to clear.
    try {
      const released = await db.batch([quarantineReleaseStatement(db, chainId, loanId)]);
      discloseQuarantineReleases(chainId, released, nowSec, 'examined');
    } catch (err) {
      console.warn(
        `[loanOrphans] chain ${chainId}: loan ${loanId} was withdrawn but its ` +
          `quarantine marker could not be released; the stale report will name it`,
        err,
      );
    }
  }
  return moved;
}

