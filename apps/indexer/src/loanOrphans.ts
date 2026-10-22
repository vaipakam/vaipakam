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
 * THE MOVE is one D1 batch (one transaction): archive the row whole into
 * `loan_orphans` (migration 0065 says why whole, and how an operator puts it
 * back), clear the loan's side tables, then delete it from `loans`. Every
 * statement carries the SAME compare-and-set — the status the caller read
 * and the `updated_at` of the copy being kept — and the deletes from the
 * side tables and from `loans` run while the row still exists, so a writer
 * that touched the row between the read below and the batch turns every
 * statement into a no-op: nothing archived that was not deleted, nothing
 * deleted whose kept copy is stale, and no side-table row of a loan that
 * stays live disposed of (#2636 r1).
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
 * Every statement is a literal (no interpolation) so the #1149
 * SQL-vs-schema guard checks each against the migrated schema.
 */

/**
 * Move `loanId` on `chainId` out of `loans` into `loan_orphans`, if it still
 * carries status `from`. Returns whether the move landed: false when the row
 * is gone or no longer `from`, or another writer changed it in between (all
 * statements then no-ops, and the caller's next lap decides again).
 *
 * The caller must already have PROVEN the loan nonexistent at
 * `observedBlock` (a successful read answering the zero struct at a settled
 * block). A read that failed proves nothing and must never reach here.
 */
export async function withdrawOrphanLoan(
  db: D1Database,
  chainId: number,
  loanId: number,
  from: string,
  /** The settled block the existence read was pinned to: the evidence. */
  observedBlock: bigint,
  /** Wall clock of the move, seconds. When the platform acted. */
  nowSec: number,
): Promise<boolean> {
  // The row as it stands, to keep. Read first because D1 cannot serialise a
  // whole row inside a statement without naming every column.
  const row = await db
    .prepare(`SELECT * FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ?`)
    .bind(chainId, loanId, from)
    .first<Record<string, unknown> & { updated_at: number }>();
  if (!row) return false;
  const guard = [chainId, loanId, from, row.updated_at] as const;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO loan_orphans (chain_id, loan_id, from_status, observed_block, withdrawn_at, row_json)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ? AND updated_at = ?)`,
      )
      .bind(chainId, loanId, from, Number(observedBlock), nowSec, JSON.stringify(row), ...guard),
    db
      .prepare(
        `DELETE FROM prepay_listings WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ? AND updated_at = ?)`,
      )
      .bind(chainId, loanId, ...guard),
    db
      .prepare(
        `DELETE FROM swap_to_repay_intents WHERE chain_id = ? AND loan_id = ?
            AND EXISTS (SELECT 1 FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ? AND updated_at = ?)`,
      )
      .bind(chainId, loanId, ...guard),
    db
      .prepare(`DELETE FROM loans WHERE chain_id = ? AND loan_id = ? AND status = ? AND updated_at = ?`)
      .bind(...guard),
  ]);
  return (results[3]?.meta?.changes ?? 0) > 0;
}
