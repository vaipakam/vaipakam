/**
 * #2195 (ledger half) — a repaired loan's ending, as the Activity feed serves
 * it.
 *
 * The reconciliation repair (#2101) closes a loan whose terminal event the
 * indexer missed for good. `activity_events` is an index of LOGS — every row
 * claims a log at a (block, log_index) position — and a repaired terminal
 * has no log, so the ledger cannot carry it without inventing one. The
 * repair instead records what it OBSERVED on the loan row (migration 0066):
 * the terminal status the chain showed and the settled block the read was
 * pinned to. This module serves that record as its own entry type, merged
 * into the feed's order.
 *
 * What an entry says, and what it declines to say:
 *  - It says the chain showed the loan in `observedStatus` BY `observedBlock`
 *    (whose chain time is `observedAt`, null when not read).
 *  - It does NOT say when the loan ended, nor which event ended it: neither
 *    was seen. It carries no event name, no transaction and no actor.
 *
 * FEED POSITION. An entry sits at `observedBlock` with a log index of
 * `REPAIR_OBSERVATION_LOG_INDEX_BASE + loanId`. No real log index reaches the
 * base, so at its block an entry sorts after every event, and the loan id
 * keeps two repairs observed at the same block distinct — the feed's
 * `before=<block>:<logIndex>` cursor is strict, so a shared position would
 * drop every entry after the first at a page boundary.
 */
import { DERIVED_LOG_INDEX } from './notifications';

/** Real log indices never reach this; see the module header. */
export const REPAIR_OBSERVATION_LOG_INDEX_BASE = DERIVED_LOG_INDEX;

export interface RepairObservationRow {
  chain_id: number;
  loan_id: number;
  repair_observed_status: string;
  repair_observed_block: number;
  repair_observed_at: number | null;
}

/** The feed position of an entry, comparable with an event's
 *  `(block_number, log_index)`. */
export function repairObservationPosition(row: RepairObservationRow): { block: number; logIndex: number } {
  return { block: row.repair_observed_block, logIndex: REPAIR_OBSERVATION_LOG_INDEX_BASE + row.loan_id };
}

export function repairObservationToJson(row: RepairObservationRow): Record<string, unknown> {
  const pos = repairObservationPosition(row);
  return {
    chainId: row.chain_id,
    loanId: row.loan_id,
    // What the reconciliation read showed, and the block it was pinned to:
    // the loan had ended BY then. Not the ending's block or time.
    observedStatus: row.repair_observed_status,
    observedBlock: row.repair_observed_block,
    observedAt: row.repair_observed_at ?? null,
    // Where the entry sits in the feed, on the same scale as an event's
    // `blockNumber` / `logIndex`, and what a `before` cursor names.
    feedLogIndex: pos.logIndex,
    provenance: 'reconciliation',
  };
}

/**
 * The newest `limit` entries strictly before `before`, for one chain and
 * optionally one loan — the observation half of a feed page.
 *
 * One static statement (so `sqlSchemaGuard` can check it against the
 * schema), with absent filters bound as NULL. At the cursor's own block only
 * entries whose loan id puts them below the cursor's index qualify; an event
 * cursor (index below the base) binds a loan bound of 0 and so admits none
 * there. The ORDER BY matches `idx_loans_chain_repair_observed`, so the walk
 * stops at the limit.
 */
export function repairObservationsPage(
  db: D1Database,
  chainId: number,
  opts: { loanId?: number; before?: { block: number; logIndex: number } },
  limit: number,
): D1PreparedStatement {
  const beforeBlock = opts.before?.block ?? null;
  const loanBound =
    opts.before && opts.before.logIndex > REPAIR_OBSERVATION_LOG_INDEX_BASE
      ? opts.before.logIndex - REPAIR_OBSERVATION_LOG_INDEX_BASE
      : 0;
  return db
    .prepare(
      `SELECT chain_id, loan_id, repair_observed_status, repair_observed_block, repair_observed_at
         FROM loans
        WHERE chain_id = ?1 AND repair_observed_block IS NOT NULL
          AND (?2 IS NULL OR loan_id = ?2)
          AND (?3 IS NULL OR repair_observed_block < ?3 OR (repair_observed_block = ?3 AND loan_id < ?4))
        ORDER BY repair_observed_block DESC, loan_id DESC
        LIMIT ?5`,
    )
    .bind(chainId, opts.loanId ?? null, beforeBlock, loanBound, limit);
}
