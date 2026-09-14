/**
 * RECONCILING INDEXED LOAN STATUS AGAINST THE CHAIN (#2101 part B).
 *
 * The indexer learns a loan is over by seeing its terminal event. An event
 * missed while the Worker was down, rate-limited, or past its catch-up
 * window is missed PERMANENTLY — catching the cursor up restores the
 * cursor, not the rows. `bookCatchUp`'s `MAX_CATCHUP_BLOCKS` fail-open is
 * the right call for liveness and precisely why a repair pass has to exist
 * beside it.
 *
 * Measured on Base Sepolia on 2026-09-14: the chain reported 6 active
 * loans, `/loans/stats` 7, and `/loans/active` 9 rows. The three extra
 * rows were loans 8 (`Defaulted`, untouched since 2026-07-04), 13 and 14
 * (both `Repaid`). A ghost active loan is not a miscount — it is a
 * position the platform tells the world is still open.
 *
 * THE WRITE DIRECTION IS SAFE BY CONSTRUCTION, and that is what makes this
 * sweep acceptable on a fund-state surface at all. It only ever acts when
 * the chain reports a state MORE ADVANCED than the index:
 *
 *   - A node that is BEHIND answers with the old status (`Active`), which
 *     matches the row, so nothing is written. Staleness cannot manufacture
 *     a repair; it can only miss one, and the next rotation retries.
 *   - A node that is AHEAD is the whole point.
 *   - There is no path from here that marks a genuinely active loan
 *     terminal, because a terminal answer is never the stale one.
 *
 * That asymmetry is why this needs none of the block-pinning
 * `writeConfirm.mjs` needs for the live drives (#2107): there, a stale read
 * was indistinguishable from a failed write, and here it is inert.
 *
 * WHAT IT CANNOT RECOVER. The chain's `LoanStatus` has no `Liquidated`
 * member — an HF-liquidated loan reads `Defaulted(2)` — so a row repaired
 * from the chain may read `defaulted` where the event path would have
 * written `liquidated`. Less specific, never wrong, and far better than
 * `active`; stated here rather than discovered later. It also cannot say
 * WHY an event was missed.
 */

/**
 * The chain's `LoanStatus` → the row status the indexer stores.
 *
 * DELIBERATELY the same shape and the same omissions as
 * `LOAN_STATUS_TO_INDEXER_TERMINAL` in `chainIndexer.ts`: `Active(0)` and
 * `FallbackPending(4)` are absent because neither is terminal, and an
 * unknown future member falls through to `undefined` so a guessed status
 * is never written. Kept as its own copy rather than imported because
 * importing would pull the whole scan module — and the duplication is
 * pinned by a test that reads the two and requires them to agree.
 */
export const CHAIN_STATUS_TO_ROW_STATUS: Record<number, string> = {
  1: 'repaid',
  2: 'defaulted',
  3: 'settled',
  5: 'internal_matched',
};

/** A row this sweep is allowed to change, and the only one. */
const REPAIRABLE_FROM = 'active';

/**
 * The status to write, or `null` for "leave it alone".
 *
 * Everything this sweep is not allowed to do lives here, so the rule is
 * one function rather than a condition spread through the query and the
 * loop:
 *
 *  - a row that is not `active` is never touched, even if the chain
 *    disagrees — the event path owns terminal→terminal corrections, and a
 *    sweep that reopened that question could overwrite the more specific
 *    `liquidated` with the chain's `defaulted`;
 *  - `Active` and `FallbackPending` write nothing, so a loan still running
 *    can never be terminalized from here;
 *  - an unrecognised member writes nothing rather than guessing.
 */
export function decideRepair(indexedStatus: string, chainStatus: number): string | null {
  if (indexedStatus !== REPAIRABLE_FROM) return null;
  return CHAIN_STATUS_TO_ROW_STATUS[chainStatus] ?? null;
}

export interface ReconcileRow {
  loan_id: number;
  status: string;
}

export interface ReconcileReport {
  chainId: number;
  /** `getActiveLoansCount()` — the chain's own answer. */
  chainActive: number;
  /** Rows the index believes active. */
  indexedActive: number;
  /** True when the two agree; the sweep still examines rows. */
  agreed: boolean;
  examined: number[];
  repaired: { loanId: number; from: string; to: string }[];
  /** Loan ids whose chain read failed this tick. Retried next rotation. */
  unread: number[];
  /** Where the rotation pointer was left. */
  nextPointer: number;
}

export interface ReconcileDeps {
  /** Rows the index believes active, from `after` onward, at most `limit`. */
  activeRowsAfter(chainId: number, after: number, limit: number): Promise<ReconcileRow[]>;
  countIndexedActive(chainId: number): Promise<number>;
  /** `MetricsFacet.getActiveLoansCount()`. One subrequest. */
  readChainActiveCount(chainId: number): Promise<number>;
  /** `getLoanDetails(id).status`. One subrequest per call. */
  readChainStatus(chainId: number, loanId: number): Promise<number>;
  writeStatus(chainId: number, loanId: number, status: string): Promise<void>;
  readPointer(chainId: number): Promise<number>;
  writePointer(chainId: number, value: number): Promise<void>;
}

export interface ReconcileOptions {
  /**
   * Rows to examine when the counts DISAGREE.
   *
   * Bounded because the tick's budget is: free-tier Workers cap at 50
   * subrequests per invocation and `chainIndexer` reserves ~38 for a
   * single-chain backfill, so the headroom on the legacy inline path is
   * single-digit. A sweep that read every active row — nine on one chain
   * the day this was written — would recreate the dropped-event condition
   * the round-robin exists to prevent.
   */
  maxRows?: number;
  /**
   * Rows to examine when the counts AGREE, and this is not decoration.
   *
   * Two errors cancel: one missed terminal plus one missed `LoanInitiated`
   * leaves the counts equal while both rows are wrong. A gate that only
   * fires on a mismatch is one that can be silently satisfied, so the
   * rotation keeps turning at a slower rate and every row is eventually
   * read whether or not the totals ever disagreed.
   */
  minRows?: number;
}

/**
 * One chain's reconciliation pass. Returns what it did; writes nothing
 * else and logs nothing, so the caller owns reporting.
 */
export async function reconcileChainLoans(
  chainId: number,
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const maxRows = Math.max(1, opts.maxRows ?? 5);
  const minRows = Math.max(1, Math.min(opts.minRows ?? 1, maxRows));

  const [chainActive, indexedActive] = await Promise.all([
    deps.readChainActiveCount(chainId),
    deps.countIndexedActive(chainId),
  ]);
  const agreed = chainActive === indexedActive;
  const budget = agreed ? minRows : maxRows;

  const pointer = await deps.readPointer(chainId);
  let rows = await deps.activeRowsAfter(chainId, pointer, budget);
  // The rotation WRAPS rather than stopping at the end, or the tail of the
  // table would be swept once and the head never again.
  if (rows.length === 0 && pointer > 0) {
    rows = await deps.activeRowsAfter(chainId, 0, budget);
  }

  const report: ReconcileReport = {
    chainId,
    chainActive,
    indexedActive,
    agreed,
    examined: [],
    repaired: [],
    unread: [],
    nextPointer: rows.length > 0 ? rows[rows.length - 1].loan_id : 0,
  };

  for (const row of rows) {
    report.examined.push(row.loan_id);
    let chainStatus: number;
    try {
      chainStatus = await deps.readChainStatus(chainId, row.loan_id);
    } catch {
      // A read that did not happen is not evidence about the loan. The
      // row is left exactly as it is and the rotation returns to it.
      report.unread.push(row.loan_id);
      continue;
    }
    const from = row.status;
    const to = decideRepair(from, chainStatus);
    if (to === null) continue;
    await deps.writeStatus(chainId, row.loan_id, to);
    // `from` is captured BEFORE the write, not re-read after it. Reading
    // it afterwards happens to work against D1, which does not touch the
    // row object — and silently reports `from` equal to `to` against any
    // implementation that does. A report of what changed must not depend
    // on the storage layer declining to mutate its input.
    report.repaired.push({ loanId: row.loan_id, from, to });
  }

  await deps.writePointer(chainId, report.nextPointer);
  return report;
}

/**
 * Build the live dependencies for one chain and run a pass.
 *
 * `maxRows` is PASSED IN, not derived from `env`. The tick's subrequest
 * headroom depends on which ingest path is running, and the resolved
 * `Env` does not carry `CHAIN_INGEST_DO` — `captureBackingSnapshot`
 * records that exact trap, where a cast to reach the flag always read
 * `undefined` and every DO-path row was stamped with the wrong cadence.
 * The scheduler is the only place both the flag and the binding are
 * visible, so it is the only place that can answer.
 */
export async function reconcileLoansForChain(
  env: { DB: D1Database },
  chain: { id: number; rpc: string; diamond: string },
  createClient: (rpc: string) => {
    getChainId(): Promise<number>;
    readContract(args: Record<string, unknown>): Promise<unknown>;
  },
  metricsAbi: unknown,
  loanAbi: unknown,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport | null> {
  const client = createClient(chain.rpc);

  // IDENTITY BEFORE TRUST. A secret pointed at the wrong network still
  // answers, and this pass WRITES terminal status from what it answers —
  // so a mis-pointed RPC would mark one chain's loans over using another
  // chain's state. `captureBackingSnapshot` refuses to store under the
  // same condition; refusing to write is more important here, because a
  // wrong reserve figure is a wrong number and a wrong terminal status is
  // a position the platform stops publishing.
  const observed = await client.getChainId();
  if (observed !== chain.id) {
    console.warn(
      `[loanReconcile] RPC for chain ${chain.id} reports ${observed}; not reconciling`,
    );
    return null;
  }

  const deps: ReconcileDeps = {
    async activeRowsAfter(chainId, after, limit) {
      const rows = await env.DB.prepare(
        `SELECT loan_id, status FROM loans
          WHERE chain_id = ? AND status = 'active' AND loan_id > ?
          ORDER BY loan_id ASC LIMIT ?`,
      )
        .bind(chainId, after, limit)
        .all<ReconcileRow>();
      return rows.results ?? [];
    },
    async countIndexedActive(chainId) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM loans WHERE chain_id = ? AND status = 'active'`,
      )
        .bind(chainId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async readChainActiveCount() {
      const n = await client.readContract({
        address: chain.diamond,
        abi: metricsAbi,
        functionName: 'getActiveLoansCount',
      });
      return Number(n as bigint);
    },
    async readChainStatus(_chainId, loanId) {
      const d = (await client.readContract({
        address: chain.diamond,
        abi: loanAbi,
        functionName: 'getLoanDetails',
        args: [BigInt(loanId)],
      })) as { status: number | bigint };
      return Number(d.status);
    },
    async writeStatus(chainId, loanId, status) {
      // COMPARE-AND-SET on `status = 'active'`, never an unconditional
      // UPDATE. The chain-ingest Durable Object is the serialized writer
      // for event-driven status, and this pass runs from the cron — two
      // writers on one column. Guarding the write means a terminal the DO
      // landed first simply wins, and this pass becomes a no-op rather
      // than overwriting the DO's more specific `liquidated` with the
      // chain enum's `defaulted`.
      await env.DB.prepare(
        `UPDATE loans SET status = ?, updated_at = ?
          WHERE chain_id = ? AND loan_id = ? AND status = 'active'`,
      )
        .bind(status, Math.floor(Date.now() / 1000), chainId, loanId)
        .run();
    },
    async readPointer(chainId) {
      const row = await env.DB.prepare(
        `SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`,
      )
        .bind(chainId, RECONCILE_CURSOR_KIND)
        .first<{ last_block: number }>();
      return row?.last_block ?? 0;
    },
    async writePointer(chainId, value) {
      await env.DB.prepare(
        `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain_id, kind) DO UPDATE SET last_block = ?, updated_at = ?`,
      )
        .bind(
          chainId,
          RECONCILE_CURSOR_KIND,
          value,
          Math.floor(Date.now() / 1000),
          value,
          Math.floor(Date.now() / 1000),
        )
        .run();
    },
  };

  return reconcileChainLoans(chain.id, deps, opts);
}

/** Rotation pointer row in `indexer_cursor`, per chain. `last_block` is
 *  repurposed as the last examined `loan_id` — the same repurposing the
 *  round-robin pointer already makes of that column. */
export const RECONCILE_CURSOR_KIND = 'loan_reconcile';
