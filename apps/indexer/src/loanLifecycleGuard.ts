/**
 * The off-chain check on every loan-status change (#2337).
 *
 * WHAT IT CHECKS. The platform allows a loan's status to move only along a
 * fixed diagram (docs/FunctionalSpecs/ProjectDetailsREADME.md §6, "The status
 * diagram"), and every move is announced by the one event the contracts emit
 * from the transition itself, `LoanStatusChanged(loanId, from, to)`. This
 * module reads those announcements, plus each loan's `LoanInitiated`, and
 * records any announcement that disagrees with the diagram:
 *
 *  - `edge` — the move (from → to) is not in the diagram, including a status
 *    number the diagram does not know;
 *  - `continuity` — the move does not start from the status this indexer last
 *    saw announced for that loan, so a change happened that was never
 *    announced, or was announced out of order;
 *  - `reinitiated` — a loan this indexer is already tracking is announced as
 *    initiated again.
 *
 * The contracts reject every move outside the diagram, so a recorded
 * violation means a contract defect or an indexer that has drifted from the
 * contracts. Either needs an operator at once, which is why the count is on
 * `GET /health/ingest` and the scheduled ingest probe pages on it.
 *
 * WHAT IT CANNOT CHECK, stated rather than implied. A loan first seen part-way
 * through its life (its initiation predates this indexer's records) has no
 * earlier announcement to compare its first one with, so that first move is
 * checked against the diagram only; from the second on it is checked fully.
 * The health answer reports how many tracked loans were seen from initiation.
 * The temporary record a lender sale uses internally announces nothing by
 * design, so it is never tracked.
 *
 * SEPARATE FROM THE PROJECTION. The `loans` table is a projection that heals
 * itself (the deferred safety-net edges, the reconciliation pass); this check
 * must not, because healing is exactly what would hide the drift it exists to
 * report. It keeps its own two tables and writes nothing else.
 *
 * REPLAY-SAFE. Each tracked loan carries the log position of the announcement
 * that set its status, and a log at or before that position is skipped, so a
 * scan replayed after a crash neither re-applies nor re-judges a move.
 * Violations are keyed by the log itself (INSERT OR IGNORE), and a block's
 * state and violation writes land in one batch.
 */
import { chunkD1InList } from '@vaipakam/lib/d1Binds';

/** The contracts' `LoanStatus` enum, append-only, so the numbers are stable. */
export const LOAN_STATUS = {
  Active: 0,
  Repaid: 1,
  Defaulted: 2,
  Settled: 3,
  FallbackPending: 4,
  InternalMatched: 5,
} as const;

const S = LOAN_STATUS;

/**
 * The status diagram: for each status, the statuses a loan may move to next.
 * Settled is final. This is the INTENDED diagram from the functional spec, not
 * a copy read off the contracts — if the two ever differ, the check reports
 * it, which is the point.
 */
export const ALLOWED_LOAN_STATUS_EDGES: ReadonlyMap<number, ReadonlySet<number>> = new Map<number, ReadonlySet<number>>([
  [S.Active, new Set([S.Repaid, S.Defaulted, S.FallbackPending, S.InternalMatched])],
  [S.FallbackPending, new Set([S.Active, S.Repaid, S.Defaulted, S.InternalMatched])],
  [S.Repaid, new Set([S.Settled])],
  [S.Defaulted, new Set([S.Settled])],
  [S.InternalMatched, new Set([S.Settled])],
  [S.Settled, new Set<number>()],
]);

export function isAllowedLoanStatusEdge(from: number, to: number): boolean {
  return ALLOWED_LOAN_STATUS_EDGES.get(from)?.has(to) ?? false;
}

export type LifecycleReason = 'edge' | 'continuity' | 'reinitiated';

/** One announcement, reduced to what the check reads. */
export type LifecycleObservation =
  | { kind: 'initiated'; loanId: number; blockNumber: number; logIndex: number; txHash: string }
  | { kind: 'status'; loanId: number; blockNumber: number; logIndex: number; txHash: string; from: number; to: number };

/** What the check knows about one loan. */
export interface TrackedLoan {
  status: number;
  fromInitiation: boolean;
  lastBlock: number;
  lastLogIndex: number;
}

export interface LifecycleJudgement {
  next: TrackedLoan;
  /** Empty when the announcement agrees with the diagram. */
  reasons: LifecycleReason[];
  /** The status last seen, or null when the loan was not yet tracked. */
  expected: number | null;
}

/** True when `obs` sits strictly after the position `prev` was set at. */
function isAfter(prev: TrackedLoan, obs: LifecycleObservation): boolean {
  return obs.blockNumber > prev.lastBlock || (obs.blockNumber === prev.lastBlock && obs.logIndex > prev.lastLogIndex);
}

/**
 * Judge one announcement against what is known of its loan. Pure.
 *
 * Returns null when the announcement sits at or before the position the
 * loan's record was set at: it has already been applied (a replayed scan),
 * and judging it again would count one move twice.
 */
export function judgeObservation(prev: TrackedLoan | null, obs: LifecycleObservation): LifecycleJudgement | null {
  if (prev && !isAfter(prev, obs)) return null;
  const at = { lastBlock: obs.blockNumber, lastLogIndex: obs.logIndex };
  if (obs.kind === 'initiated') {
    return {
      next: { status: S.Active, fromInitiation: true, ...at },
      reasons: prev ? ['reinitiated'] : [],
      expected: prev ? prev.status : null,
    };
  }
  const reasons: LifecycleReason[] = [];
  if (!isAllowedLoanStatusEdge(obs.from, obs.to)) reasons.push('edge');
  if (prev && obs.from !== prev.status) reasons.push('continuity');
  return {
    next: { status: obs.to, fromInitiation: prev?.fromInitiation ?? false, ...at },
    reasons,
    expected: prev ? prev.status : null,
  };
}

/** The decoded-log fields this module reads. */
export interface LifecycleLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

/** The announcements in `logs`, in chain order. */
export function lifecycleObservations(logs: readonly LifecycleLog[]): LifecycleObservation[] {
  const out: LifecycleObservation[] = [];
  for (const log of logs) {
    const base = {
      loanId: Number(log.args.loanId as bigint),
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex,
      txHash: log.transactionHash.toLowerCase(),
    };
    if (log.eventName === 'LoanInitiated') {
      out.push({ kind: 'initiated', ...base });
    } else if (log.eventName === 'LoanStatusChanged') {
      out.push({
        kind: 'status',
        ...base,
        from: Number(log.args.from as number | bigint),
        to: Number(log.args.to as number | bigint),
      });
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** The narrow D1 surface the writer uses. */
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}
export interface LifecycleDb {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

/**
 * Apply one scan's announcements: judge each in chain order against the
 * loan's record, then write every record change and every violation in ONE
 * batch, so a crash leaves either all of it or none of it.
 */
export async function recordLoanLifecycle(
  db: LifecycleDb,
  chainId: number,
  logs: readonly LifecycleLog[],
  blockTimes: ReadonlyMap<bigint, number>,
): Promise<{ applied: number; violations: number }> {
  const observations = lifecycleObservations(logs);
  if (observations.length === 0) return { applied: 0, violations: 0 };

  const loanIds = [...new Set(observations.map((o) => o.loanId))];
  const tracked = new Map<number, TrackedLoan>();
  for (const chunk of chunkD1InList(loanIds, { before: [chainId] })) {
    const rows =
      (
        await db
          .prepare(
            `SELECT loan_id, status, from_initiation, last_block, last_log_index
               FROM loan_lifecycle_state WHERE chain_id = ? AND loan_id IN (${chunk.placeholders})`,
          )
          .bind(...chunk.binds)
          .all<{ loan_id: number; status: number; from_initiation: number; last_block: number; last_log_index: number }>()
      ).results ?? [];
    for (const r of rows) {
      tracked.set(r.loan_id, {
        status: r.status,
        fromInitiation: r.from_initiation !== 0,
        lastBlock: r.last_block,
        lastLogIndex: r.last_log_index,
      });
    }
  }

  const writes: D1Statement[] = [];
  const changed = new Set<number>();
  let applied = 0;
  let violations = 0;
  for (const obs of observations) {
    const judged = judgeObservation(tracked.get(obs.loanId) ?? null, obs);
    if (!judged) continue;
    applied++;
    tracked.set(obs.loanId, judged.next);
    changed.add(obs.loanId);
    if (judged.reasons.length === 0) continue;
    violations++;
    // Chain time, like every time the scan writes (#2757): the block's time
    // is read before any handler runs, so a missing one is a caller defect.
    const blockTime = blockTimes.get(BigInt(obs.blockNumber));
    if (blockTime === undefined) throw new Error(`recordLoanLifecycle: no chain time for block ${obs.blockNumber}`);
    writes.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO loan_lifecycle_violation
             (chain_id, tx_hash, log_index, loan_id, block_number, event,
              from_status, to_status, expected_status, reasons, block_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          chainId,
          obs.txHash,
          obs.logIndex,
          obs.loanId,
          obs.blockNumber,
          obs.kind === 'initiated' ? 'LoanInitiated' : 'LoanStatusChanged',
          obs.kind === 'status' ? obs.from : null,
          obs.kind === 'status' ? obs.to : null,
          judged.expected,
          judged.reasons.join(','),
          blockTime,
        ),
    );
  }
  for (const loanId of changed) {
    const t = tracked.get(loanId)!;
    writes.push(
      db
        .prepare(
          `INSERT INTO loan_lifecycle_state
             (chain_id, loan_id, status, from_initiation, last_block, last_log_index)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (chain_id, loan_id) DO UPDATE SET
             status = excluded.status,
             from_initiation = excluded.from_initiation,
             last_block = excluded.last_block,
             last_log_index = excluded.last_log_index`,
        )
        .bind(chainId, loanId, t.status, t.fromInitiation ? 1 : 0, t.lastBlock, t.lastLogIndex),
    );
  }
  if (writes.length > 0) await db.batch(writes);
  return { applied, violations };
}

// ──────────────────────────────────────────────────────────────────
// The health read.
// ──────────────────────────────────────────────────────────────────

/** How many violations each chain lists by name; the count is always whole. */
export const LIFECYCLE_LIST_LIMIT = 50;

export const LIFECYCLE_BASIS =
  'loan-status announcements this indexer has seen that disagree with the status diagram; ' +
  'a loan first seen part-way through its life has its first announcement checked against the diagram only';

export interface LifecycleViolation {
  txHash: string;
  logIndex: number;
  loanId: number;
  blockNumber: number;
  event: string;
  from: number | null;
  to: number | null;
  expected: number | null;
  reasons: string[];
  /** The chain time of the block that carried the announcement. */
  blockTime: number;
}

export interface ChainLifecycleHealth {
  chainId: number;
  /** Loans this indexer is tracking. */
  trackedLoans: number;
  /** Of those, the ones seen from their initiation (fully checked). */
  trackedFromInitiation: number;
  /** Every violation recorded for this chain. */
  violations: number;
  /** The oldest ones, at most LIFECYCLE_LIST_LIMIT, in chain order. */
  listed: LifecycleViolation[];
  /** True when `violations` is more than `listed` names. */
  truncated: boolean;
}

export interface LifecycleHealth {
  basis: string;
  listLimit: number;
  chains: ChainLifecycleHealth[];
}

/** The narrow D1 surface the read uses. */
interface D1Read {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T = unknown>(): Promise<{ results?: T[] }> };
  };
}

/**
 * Read the check's state in ONE statement, so the counts and the listed rows
 * come from one snapshot. Returns null only while the tables do not exist yet
 * (the window before migration 0080 is applied); any other failure throws, so
 * a failed read is never reported as "no violations".
 */
export async function readLifecycleHealth(db: D1Read): Promise<LifecycleHealth | null> {
  type Row = {
    row_kind: 'tracked' | 'count' | 'listed';
    chain_id: number;
    n: number | null;
    m: number | null;
    tx_hash: string | null;
    log_index: number | null;
    loan_id: number | null;
    block_number: number | null;
    event: string | null;
    from_status: number | null;
    to_status: number | null;
    expected_status: number | null;
    reasons: string | null;
    block_time: number | null;
  };
  const sql = `
    SELECT 'tracked' AS row_kind, chain_id, COUNT(*) AS n, SUM(from_initiation) AS m,
           NULL AS tx_hash, NULL AS log_index, NULL AS loan_id, NULL AS block_number, NULL AS event,
           NULL AS from_status, NULL AS to_status, NULL AS expected_status, NULL AS reasons, NULL AS block_time
      FROM loan_lifecycle_state GROUP BY chain_id
    UNION ALL
    SELECT 'count', chain_id, COUNT(*), NULL,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
      FROM loan_lifecycle_violation GROUP BY chain_id
    UNION ALL
    SELECT 'listed', chain_id, NULL, NULL,
           tx_hash, log_index, loan_id, block_number, event,
           from_status, to_status, expected_status, reasons, block_time
      FROM (SELECT v.*, ROW_NUMBER() OVER (PARTITION BY chain_id ORDER BY block_number, log_index) AS rn
              FROM loan_lifecycle_violation v)
     WHERE rn <= ?`;
  let rows: Row[];
  try {
    rows = (await db.prepare(sql).bind(LIFECYCLE_LIST_LIMIT).all<Row>()).results ?? [];
  } catch (err) {
    if (/no such table/i.test((err as Error).message ?? '')) return null;
    throw err;
  }
  const byChain = new Map<number, ChainLifecycleHealth>();
  const chain = (id: number) => {
    let c = byChain.get(id);
    if (!c) {
      c = { chainId: id, trackedLoans: 0, trackedFromInitiation: 0, violations: 0, listed: [], truncated: false };
      byChain.set(id, c);
    }
    return c;
  };
  for (const r of rows) {
    const c = chain(r.chain_id);
    if (r.row_kind === 'tracked') {
      c.trackedLoans = r.n ?? 0;
      c.trackedFromInitiation = r.m ?? 0;
    } else if (r.row_kind === 'count') {
      c.violations = r.n ?? 0;
    } else {
      c.listed.push({
        txHash: r.tx_hash ?? '',
        logIndex: r.log_index ?? 0,
        loanId: r.loan_id ?? 0,
        blockNumber: r.block_number ?? 0,
        event: r.event ?? '',
        from: r.from_status,
        to: r.to_status,
        expected: r.expected_status,
        reasons: (r.reasons ?? '').split(',').filter(Boolean),
        blockTime: r.block_time ?? 0,
      });
    }
  }
  const chains = [...byChain.values()].sort((a, b) => a.chainId - b.chainId);
  for (const c of chains) {
    c.listed.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    c.truncated = c.violations > c.listed.length;
  }
  return { basis: LIFECYCLE_BASIS, listLimit: LIFECYCLE_LIST_LIMIT, chains };
}
