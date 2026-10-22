/**
 * #2636 r4 — the operator's view of `loan_orphans`: every withdrawal not yet
 * marked reviewed, named on every pass by the stale-quarantine report, whose
 * one batch these statements ride. Its own module so the quarantine (which
 * reports) and the move (which releases a quarantine marker) do not import
 * each other.
 */
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
/** How many unreviewed withdrawals the stale report describes one by one;
 *  the rest are counted. */
export const UNREVIEWED_ORPHAN_REPORT_LIMIT = 20;

/**
 * The stale report's view of `loan_orphans` (#2636 r4): the count of
 * unreviewed withdrawals on the chain, and the oldest of them. Two
 * statements, handed to the stale report so they ride its one batch and cost
 * it no subrequest of their own.
 */
export function unreviewedOrphanStatements(db: D1Database, chainId: number): D1PreparedStatement[] {
  return [
    db
      .prepare(`SELECT COUNT(*) AS n FROM loan_orphans WHERE chain_id = ? AND reviewed_at IS NULL`)
      .bind(chainId),
    db
      .prepare(
        `SELECT move_id, diamond, loan_id, from_status, observed_block, withdrawn_at
           FROM loan_orphans
          WHERE chain_id = ? AND reviewed_at IS NULL
          ORDER BY withdrawn_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(chainId, UNREVIEWED_ORPHAN_REPORT_LIMIT),
  ];
}

/**
 * Name the unreviewed withdrawals, from the two results above. Silent when
 * there are none. Each entry carries the command that marks it reviewed,
 * guarded on its `move_id` so it cannot touch another entry.
 */
export function reportUnreviewedOrphans(
  chainId: number,
  countResult: { results?: unknown[] } | undefined,
  pageResult: { results?: unknown[] } | undefined,
  nowSec: number,
): void {
  const n = Number((countResult?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  if (n === 0) return;
  const rows = (pageResult?.results ?? []) as Array<{
    move_id: string;
    diamond: string;
    loan_id: number;
    from_status: string;
    observed_block: number;
    withdrawn_at: number;
  }>;
  const described = rows
    .map(
      (r) =>
        `loan ${r.loan_id} (was ${r.from_status}; no loan at block ${r.observed_block} ` +
        `on Diamond ${r.diamond}; withdrawn ${Math.floor((nowSec - r.withdrawn_at) / 3600)}h ago; ` +
        `mark reviewed: UPDATE loan_orphans SET reviewed_at = <unix seconds> ` +
        `WHERE move_id = '${r.move_id}' AND reviewed_at IS NULL)`,
    )
    .join('; ');
  const more = n > rows.length ? `, and ${n - rows.length} more not listed` : '';
  console.warn(
    `[loanOrphans] chain ${chainId}: ${n} loan record(s) the chain had no loan for ` +
      `were withdrawn from publication and are not yet reviewed: ${described}${more}. ` +
      `Each is kept whole in loan_orphans; if the existence test was wrong, ` +
      `migration 0065 describes how to put one back.`,
  );
}
