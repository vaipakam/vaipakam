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
 * deleted only by the rowid that was archived, so one that arrives after the
 * read is left alone rather than deleted unkept.
 *
 * The side tables are the ones `_closedLoanSideTableStatements` clears on a
 * close-out (`prepay_listings`, `swap_to_repay_intents`), written out here
 * with the guard rather than shared, because the close-out's are
 * unconditional. `test/closedLoanSideTables.test.ts` pins the two lists to
 * the same tables.
 *
 * The quarantine marker (`loan_reconcile_quarantine`) is never touched here:
 * where the reconciliation pass set one it is the operator's standing record
 * that a row was withdrawn.
 *
 * Every statement but the archive insert is a literal, so the #1149
 * SQL-vs-schema guard checks it against the migrated schema. The archive
 * insert's guard is built from the loan row's own column names (refused
 * unless each is a plain identifier) and is exercised against the real
 * schema in `test/closedLoanSideTables.test.ts`.
 */

/** A column name SQLite handed back, accepted only as a plain identifier. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Move `loanId` on `chainId` out of publication into `loan_orphans`, if its
 * row still carries status `from`. Returns whether the move landed: false
 * when the row is gone, no longer `from`, or changed by another writer in
 * between (the whole batch is then a no-op, and the caller's next lap
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
  // a statement without naming every column. One batch, so one snapshot.
  const [loanRes, activityRes, participantRes, notificationRes] = await db.batch([
    db.prepare(`SELECT * FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ?`).bind(chainId, loanId, from),
    db
      .prepare(`SELECT rowid AS orphan_rowid, * FROM activity_events WHERE chain_id = ? AND loan_id = ?`)
      .bind(chainId, loanId),
    db
      .prepare(`SELECT rowid AS orphan_rowid, * FROM loan_participants WHERE chain_id = ? AND loan_id = ?`)
      .bind(chainId, loanId),
    db
      .prepare(`SELECT rowid AS orphan_rowid, * FROM notifications WHERE chain_id = ? AND loan_id = ?`)
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
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO loan_orphans
           (move_id, chain_id, diamond, loan_id, from_status, observed_block, withdrawn_at, row_json, related_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM loans WHERE ${sameRow})`,
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
      ),
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
            AND rowid IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, rowids(related.activity_events), moveId),
    db
      .prepare(
        `DELETE FROM loan_participants WHERE chain_id = ? AND loan_id = ?
            AND rowid IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, rowids(related.loan_participants), moveId),
    db
      .prepare(
        `DELETE FROM notifications WHERE chain_id = ? AND loan_id = ?
            AND rowid IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, rowids(related.notifications), moveId),
    db
      .prepare(
        `DELETE FROM loans WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loan_orphans WHERE move_id = ?)`,
      )
      .bind(chainId, loanId, moveId),
  ]);
  return (results[6]?.meta?.changes ?? 0) > 0;
}
