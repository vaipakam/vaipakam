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
 * THE WRITE DIRECTION IS ONE-WAY, AND THAT IS NOT SUFFICIENT ON ITS OWN.
 * It acts only when the chain reports a state more advanced than the
 * index, so a node that is BEHIND answers `Active`, matches the row, and
 * writes nothing.
 *
 * An earlier revision stopped there and called that "safe by
 * construction". Review showed the argument inverts (#2190 round 1). The
 * write is IRREVERSIBLE from this pass's point of view: it only ever
 * selects LIVE rows, so a row it has terminalized is never examined
 * again. Read `latest` and a reorg can remove the terminal afterwards,
 * leaving the row terminal in the index and active on the chain with
 * nothing that would ever look at it — the very permanence that makes a
 * stale read harmless in one direction makes a WRONG read unrecoverable
 * in the other.
 *
 * So every read pins to the SAFE head the scan already resolved, which is
 * what `chainIndexer` and the backing snapshot have always done for
 * exactly this reason, and the pass runs only when that scan has caught
 * up to it.
 *
 * A REPAIRED ROW IS A WHOLE ROW, NOT A STATUS. The row a terminal event
 * writes carries the loan's money as well as its state, and a repair that
 * moved only the status would leave a shape no event-written row has ever
 * had (#2190 round 1). So the same block-pinned `getLoanDetails` the status
 * comes from also supplies `principal` and `collateralAmount`, and both are
 * written with it — no extra subrequest, since the read is already being
 * made.
 *
 * That is deliberately wider than the finding, which named the
 * `internal_matched` case: a match decrements both figures, so a match-
 * repaired row would otherwise advertise principal outstanding on a closed
 * loan. But the same is true of every mutation the index can miss the event
 * for — partial repay, partial swap-repay, a liquidation swap, a partial
 * withdrawal, a collateral top-up, a written-off fallback shortfall — and
 * an index stale enough to have missed a terminal has no claim to be fresh
 * about the numbers. Nothing is lost by taking the chain's figures: no
 * terminal transition in the contracts zeroes either field, so the chain
 * holds the outstanding-at-close amounts the event path preserves, and
 * where it holds a lower figure that IS the economic truth the index
 * missed.
 *
 * A REPAIRED ROW ALSO CLEARS THE LOAN'S SIDE TABLES, and this pass keeps
 * NO LIST OF WHICH ONES. Review found the same gap twice running: round 1,
 * that a repaired close left a live prepay listing behind; round 2, that it
 * left a live swap-to-repay intent behind, which `handleLoanById` goes on
 * publishing with a cancel action attached. Adding the second table the way
 * the first was added would have left a third to be found the same way.
 *
 * So the cleanup is one named concept owned by the scan —
 * `_clearClosedLoanSideTables`, the same one every terminal handler calls —
 * and it is handed in through the context. A table added there reaches the
 * repair with no change on this side, which is the property that stops this
 * particular finding recurring.
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

/**
 * Row statuses this pass may change — the LIVE ones.
 *
 * `fallback_pending` belongs here and its absence was a defect (#2190
 * round 1). The rest of the indexer treats it as live and transitions it
 * straight to terminal: the `InternalMatchExecuted` handler and the
 * terminal helper both guard on `status IN ('active', 'fallback_pending')`.
 *
 * It also broke the COUNT GATE, which is worse than the missed repair and
 * was not in the finding. `MetricsFacet.getActiveLoansCount` is documented
 * as "loans currently in Active **or FallbackPending** status", so
 * counting only `active` on our side compares two different sets: one
 * `fallback_pending` row makes the counts differ permanently, which pins
 * the gate open, spends the larger budget every pass, and never examines
 * the row responsible for the difference.
 */
const REPAIRABLE_FROM = new Set(['active', 'fallback_pending']);

/**
 * The status to write, or `null` for "leave it alone".
 *
 * Everything this sweep is not allowed to do lives here, so the rule is
 * one function rather than a condition spread through the query and the
 * loop:
 *
 *  - a row that is not LIVE is never touched, even if the chain
 *    disagrees — the event path owns terminal→terminal corrections, and a
 *    sweep that reopened that question could overwrite the more specific
 *    `liquidated` with the chain's `defaulted`;
 *  - `Active` and `FallbackPending` write nothing, so a loan still running
 *    can never be terminalized from here;
 *  - an unrecognised member writes nothing rather than guessing.
 */
export function decideRepair(indexedStatus: string, chainStatus: number): string | null {
  if (!REPAIRABLE_FROM.has(indexedStatus)) return null;
  // No "is this actually a change?" guard. I wrote one and a probe
  // showed it unreachable: every value in the map is terminal, so `to`
  // can never equal a live status, and the map is pinned to the scan's
  // copy by a test. An unreachable defensive branch is the shape this
  // repo has spent review rounds deleting — it cannot be exercised, so
  // it cannot be trusted, and it invites a reader to believe a case is
  // handled that never arises.
  //
  // A live row the chain also calls live simply gets `null` from the
  // lookup: `Active(0)` and `FallbackPending(4)` are both absent.
  return CHAIN_STATUS_TO_ROW_STATUS[chainStatus] ?? null;
}

/** The live statuses, for a caller building the SQL. Exported so the
 *  selector and the compare-and-set cannot drift from `decideRepair`. */
export const LIVE_ROW_STATUSES = [...REPAIRABLE_FROM];

export interface ReconcileRow {
  loan_id: number;
  status: string;
}

/**
 * One block-pinned `getLoanDetails` post-image, reduced to what a repair
 * writes. The amounts are carried as decimal STRINGS because that is how
 * `loans.principal` / `loans.collateral_amount` are stored — these are
 * uint256 and do not survive a round trip through a JS number.
 */
export interface ChainLoanRead {
  status: number;
  principal: string;
  collateralAmount: string;
}

/** What a repair writes: the status it decided plus the money the same
 *  read reported. Kept as one value so a caller cannot write half of it. */
export interface LoanRepair {
  status: string;
  principal: string;
  collateralAmount: string;
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
  /** Loan ids whose repair the compare-and-set declined because another
   *  writer had already terminalized the row. Not a failure — the other
   *  write is the better-informed one — but not a repair either. */
  superseded: number[];
  /** Loan ids repaired whose side-table cleanup then FAILED.
   *
   *  Reported rather than thrown. The status write has already landed and
   *  the row is no longer live, so the rotation will never select it again
   *  — aborting here would lose the pointer write and still leave the rows
   *  behind. An operator reading this list is looking at a closed loan the
   *  app may still advertise a collateral listing or a live swap-to-repay
   *  intent for, which is exactly the class of ghost this pass exists to
   *  remove, so it is named rather than implied. */
  sideTablesNotCleared: number[];
  /** Where the rotation pointer was left. */
  nextPointer: number;
}

export interface ReconcileDeps {
  /** Rows the index believes active, from `after` onward, at most `limit`. */
  activeRowsAfter(chainId: number, after: number, limit: number): Promise<ReconcileRow[]>;
  countIndexedActive(chainId: number): Promise<number>;
  /** `MetricsFacet.getActiveLoansCount()`. One subrequest. */
  readChainActiveCount(chainId: number): Promise<number>;
  /** `getLoanDetails(id)`, reduced. ONE subrequest, and it carries the
   *  money as well as the status precisely so a repair needs no second. */
  readChainLoan(chainId: number, loanId: number): Promise<ChainLoanRead>;
  /** Returns whether the row actually changed — a compare-and-set that
   *  matched nothing is not a repair, and must not be reported as one. */
  writeRepair(chainId: number, loanId: number, repair: LoanRepair): Promise<boolean>;
  /** Drop every side-table row representing a live action on a loan this
   *  pass just closed. The scan's own helper, handed in — see the module
   *  header for why this is one concept rather than a list of tables. */
  clearClosedLoanSideTables(chainId: number, loanId: number): Promise<void>;
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
    superseded: [],
    sideTablesNotCleared: [],
    nextPointer: rows.length > 0 ? rows[rows.length - 1].loan_id : 0,
  };

  for (const row of rows) {
    report.examined.push(row.loan_id);
    let onchain: ChainLoanRead;
    try {
      onchain = await deps.readChainLoan(chainId, row.loan_id);
    } catch {
      // A read that did not happen is not evidence about the loan. The
      // row is left exactly as it is and the rotation returns to it.
      report.unread.push(row.loan_id);
      continue;
    }
    const from = row.status;
    const to = decideRepair(from, onchain.status);
    if (to === null) continue;
    // The amounts come from the SAME read as the status, so they are the
    // same block's post-image and cannot describe a different moment than
    // the status they are written beside.
    const changed = await deps.writeRepair(chainId, row.loan_id, {
      status: to,
      principal: onchain.principal,
      collateralAmount: onchain.collateralAmount,
    });
    // REPORTED ONLY IF THE ROW CHANGED. The compare-and-set exists
    // because the scan may terminalize this row from its own event
    // first; when it does, the CAS matches nothing and the stored status
    // is the scan's more specific one. Announcing `active->defaulted`
    // there would make the operational record false in precisely the
    // race the guard was added to handle (#2190 round 1).
    if (!changed) {
      report.superseded.push(row.loan_id);
      continue;
    }
    // `from` is captured BEFORE the write, not re-read after it. Reading
    // it afterwards happens to work against D1, which does not touch the
    // row object — and silently reports `from` equal to `to` against any
    // implementation that does. A report of what changed must not depend
    // on the storage layer declining to mutate its input.
    report.repaired.push({ loanId: row.loan_id, from, to });
    // Only after a repair that ACTUALLY landed. A superseded row was
    // terminalized by a handler that runs this same cleanup itself, and a
    // row this pass did not close has no business losing a live listing or
    // a committed intent.
    try {
      await deps.clearClosedLoanSideTables(chainId, row.loan_id);
    } catch {
      report.sideTablesNotCleared.push(row.loan_id);
    }
  }

  await deps.writePointer(chainId, report.nextPointer);
  return report;
}

/**
 * Build the live dependencies from the SCAN'S OWN CONTEXT and run a pass.
 *
 * WHERE THIS RUNS IS THE FIX (#2190 round 1). An earlier revision ran
 * this as its own cron pass with its own client, its own identity check
 * and its own `latest` reads, and review returned five P1s that were one
 * mistake said five ways: a repair that writes loan rows from OUTSIDE the
 * ingest path does none of what the ingest path does. Both ingest paths
 * already funnel through `runChainIndexerForChain` — the DO calls it, and
 * the legacy cron reaches it through the round-robin — so running there
 * settles four of them structurally rather than by adding a guard each:
 *
 *  - the scan has already resolved a SAFE head, so reads pin to it and
 *    cost nothing extra. This is the one that mattered: an unpinned
 *    `latest` read can return a terminal a reorg then removes, and
 *    because this pass only ever selects `active` rows, the row it wrote
 *    is never looked at again — terminal in the index and active on the
 *    chain, permanently. "A stale read can only miss a repair" was the
 *    claim, and irreversibility is exactly what makes it false;
 *  - it runs after that window's events are processed, so it cannot
 *    terminalize a row ahead of an event still to be applied;
 *  - it is inside the DO's call, so the DO's broadcast covers the write;
 *  - the scan has already asserted chain identity before any of this.
 *
 * CAUGHT UP OR NOT AT ALL. The caller runs this only when the scan
 * reached the safe head (`scannedTo === headBlock`). While a backfill is
 * still walking forward there are processed-but-later events between the
 * cursor and the head, and repairing from head state would jump the
 * queue — which is the ordering hazard, not a refinement of it.
 */
export interface ScanReconcileContext {
  db: D1Database;
  chainId: number;
  diamond: string;
  /** The SAFE head the scan resolved. Every read pins to it. */
  head: bigint;
  readContract(args: Record<string, unknown>): Promise<unknown>;
  metricsAbi: unknown;
  loanAbi: unknown;
  /** The scan's own `_clearClosedLoanSideTables`, bound to this chain.
   *  Passed in rather than reimplemented: the cleanup every terminal
   *  handler performs and the cleanup a repair performs must be the same
   *  one, and importing it here would make the scan module and this one
   *  mutually dependent. */
  clearClosedLoanSideTables(loanId: number): Promise<void>;
}

export async function reconcileAfterScan(
  ctx: ScanReconcileContext,
  opts: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const now = () => Math.floor(Date.now() / 1000);
  const deps: ReconcileDeps = {
    async activeRowsAfter(chainId, after, limit) {
      const rows = await ctx.db
        .prepare(
          `SELECT loan_id, status FROM loans
            WHERE chain_id = ? AND status IN ('active', 'fallback_pending')
              AND loan_id > ?
            ORDER BY loan_id ASC LIMIT ?`,
        )
        .bind(chainId, after, limit)
        .all<ReconcileRow>();
      return rows.results ?? [];
    },
    async countIndexedActive(chainId) {
      const row = await ctx.db
        // BOTH live statuses, because the chain counter this is compared
        // against is documented as Active OR FallbackPending. Counting a
        // narrower set here makes the gate differ forever.
        .prepare(
          `SELECT COUNT(*) AS n FROM loans
            WHERE chain_id = ? AND status IN ('active', 'fallback_pending')`,
        )
        .bind(chainId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async readChainActiveCount() {
      const n = await ctx.readContract({
        address: ctx.diamond,
        abi: ctx.metricsAbi,
        functionName: 'getActiveLoansCount',
        blockNumber: ctx.head,
      });
      return Number(n as bigint);
    },
    async readChainLoan(_chainId, loanId) {
      const d = (await ctx.readContract({
        address: ctx.diamond,
        abi: ctx.loanAbi,
        functionName: 'getLoanDetails',
        args: [BigInt(loanId)],
        blockNumber: ctx.head,
      })) as { status: number | bigint; principal: bigint; collateralAmount: bigint };
      return {
        status: Number(d.status),
        // `String(...)`, never `Number(...)`: these are uint256 amounts and
        // the column is TEXT for that reason.
        principal: String(d.principal),
        collateralAmount: String(d.collateralAmount),
      };
    },
    async writeRepair(chainId, loanId, repair) {
      // The SAME columns the event path writes, not status alone.
      // `terminal_block` and `terminal_at` are part of what a terminal
      // row IS here, and `principal` / `collateral_amount` are what
      // `applyMatch` refreshes on the one terminal that moves them;
      // writing status without them would leave a repaired row in a shape
      // no event-written row has ever had, which nothing downstream is
      // built to read. The block recorded is the safe head the state was
      // read at — the repair cannot know the block the terminal actually
      // landed in, and recording the block it observed the state at is the
      // honest substitute.
      //
      // COMPARE-AND-SET on the LIVE set: if the scan just above
      // terminalized this row from its own event, that write is the more
      // specific one and wins, and this becomes a no-op.
      const r = await ctx.db
        .prepare(
          `UPDATE loans
              SET status = ?, principal = ?, collateral_amount = ?,
                  terminal_block = ?, terminal_at = ?, updated_at = ?
            WHERE chain_id = ? AND loan_id = ?
              AND status IN ('active', 'fallback_pending')`,
        )
        .bind(
          repair.status,
          repair.principal,
          repair.collateralAmount,
          Number(ctx.head),
          now(),
          now(),
          chainId,
          loanId,
        )
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },
    async clearClosedLoanSideTables(_chainId, loanId) {
      await ctx.clearClosedLoanSideTables(loanId);
    },
    async readPointer(chainId) {
      const row = await ctx.db
        .prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = ?`)
        .bind(chainId, RECONCILE_CURSOR_KIND)
        .first<{ last_block: number }>();
      return row?.last_block ?? 0;
    },
    async writePointer(chainId, value) {
      const t = now();
      await ctx.db
        .prepare(
          `INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chain_id, kind) DO UPDATE SET last_block = ?, updated_at = ?`,
        )
        .bind(chainId, RECONCILE_CURSOR_KIND, value, t, value, t)
        .run();
    },
  };
  return reconcileChainLoans(ctx.chainId, deps, opts);
}

/** Rotation pointer row in `indexer_cursor`, per chain. `last_block` is
 *  repurposed as the last examined `loan_id` — the same repurposing the
 *  round-robin pointer already makes of that column. */
export const RECONCILE_CURSOR_KIND = 'loan_reconcile';
