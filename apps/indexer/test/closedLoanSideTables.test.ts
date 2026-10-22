/**
 * Side tables of a CLOSED loan (#2190 round 2).
 *
 * Two tables hold rows that represent a LIVE ACTION on a loan, and the app
 * publishes both with an action attached: `prepay_listings` (a Seaport
 * collateral sale) and `swap_to_repay_intents` (a committed swap, which
 * `handleLoanById` serves with a cancel affordance). Neither may outlive the
 * loan.
 *
 * Review found the reconciliation pass leaving the first behind, and then —
 * after that was fixed table-by-table — the second. The fix was to stop
 * enumerating tables at the call sites. One place names them
 * (`_closedLoanSideTableStatements`); the event handlers run that list
 * through `_clearClosedLoanSideTables`, and the repair folds the same
 * statements into its own transaction. These cases are the reason the
 * close/not-a-close distinction cannot quietly collapse, in either
 * direction:
 *
 *  - a close must clear BOTH, so a new close-out handler that clears only
 *    the listing fails here;
 *  - an event that ends a LISTING or an INTENT without closing the loan must
 *    clear only its own table, so folding the helper into those call sites
 *    fails here too. That direction matters as much: a borrower who cancels
 *    a collateral listing has not cancelled their swap commitment, and
 *    silently tearing it down would be the platform disposing of a position
 *    the user still holds.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  _closedLoanSideTableStatements,
  _loanSideTableStatements,
  _verifiedHolderStatements,
  processLoanLogs,
  QUARANTINE_MAINTENANCE_D1_QUERIES,
  RECONCILE_BUDGET_OWN_INVOCATION,
  RECONCILE_BUDGET_SHARED_TICK,
} from '../src/chainIndexer';
import { reconcileAfterScan } from '../src/loanReconcile';
import { withdrawOrphanLoan } from '../src/loanOrphans';
import {
  notificationInsertStatement,
  planReconciledNotifications,
} from '../src/notifications';
import {
  discloseQuarantineReleases,
  QUARANTINE_STALE_SECONDS,
} from '../src/loanQuarantine';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000d1a90' as never;
/** None of the branches below read the chain; a throwing stub turns an
 *  unexpected RPC into a loud failure rather than a silent one. */
const stubClient = {
  readContract: async () => {
    throw new Error('unexpected RPC in a side-table scan');
  },
} as never;

function seedActiveLoan(h: SqliteD1, loanId: number) {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, 'active', '0xlend', '0xborrow', '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '1', '2', '0xlend', '0xborrow',
         500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, loanId);
}

function seedListing(h: SqliteD1, loanId: number) {
  h.db
    .prepare(
      `INSERT INTO prepay_listings
         (chain_id, loan_id, order_hash, ask_price, conduit, lister,
          posted_at, updated_at, grace_period_end, block_number, tx_hash,
          log_index)
       VALUES (?, ?, '0xhash', '1000', '0xconduit', '0xborrow',
          0, 0, 0, 1, '0xtx', 0)`,
    )
    .run(CHAIN, loanId);
}

function seedIntent(h: SqliteD1, loanId: number) {
  h.db
    .prepare(
      `INSERT INTO swap_to_repay_intents
         (chain_id, loan_id, order_hash, committed_by, maker_amount,
          taker_amount, deadline, committed_at, committed_tx_hash)
       VALUES (?, ?, '0xorder', '0xborrow', '10', '20', 999, 0, '0xtx')`,
    )
    .run(CHAIN, loanId);
}

const hasListing = (h: SqliteD1, loanId: number) =>
  h.db
    .prepare('SELECT 1 FROM prepay_listings WHERE chain_id = ? AND loan_id = ?')
    .get(CHAIN, loanId) !== undefined;

const hasIntent = (h: SqliteD1, loanId: number) =>
  h.db
    .prepare(
      'SELECT 1 FROM swap_to_repay_intents WHERE chain_id = ? AND loan_id = ?',
    )
    .get(CHAIN, loanId) !== undefined;

const log = (eventName: string, loanId: number, extra: Record<string, unknown> = {}) => ({
  eventName,
  args: {
    loanId: BigInt(loanId),
    liquidator: '0x00000000000000000000000000000000000000ee',
    proceeds: 0n,
    ...extra,
  },
  blockNumber: 100n,
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: 0,
});

const run = (h: SqliteD1, logs: ReturnType<typeof log>[]) =>
  processLoanLogs(
    logs,
    { DB: h.d1 } as unknown as Env,
    CHAIN,
    new Map([[100n, 500]]),
    stubClient,
    DIAMOND,
  );

describe('a close clears every side table', () => {
  // One case per close-out shape that reaches the helper by a different
  // route: a specific handler, and the deferred `LoanStatusChanged` safety
  // net that fills a gap after the log loop.
  for (const eventName of ['HFLiquidationTriggered', 'LiquidationDiscounted']) {
    it(`${eventName} clears the listing AND the intent`, async () => {
      const h = createSqliteD1(ALL_MIGRATIONS);
      seedActiveLoan(h, 7);
      seedListing(h, 7);
      seedIntent(h, 7);
      await run(h, [log(eventName, 7)]);
      expect(hasListing(h, 7)).toBe(false);
      expect(hasIntent(h, 7)).toBe(false);
    });
  }

  it('the LoanStatusChanged safety net clears both too', async () => {
    // The deferred edge is applied after the log loop and was the one place
    // a repair-shaped close already existed on the event path.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 11);
    seedListing(h, 11);
    seedIntent(h, 11);
    await run(h, [log('LoanStatusChanged', 11, { from: 0, to: 2 })]);
    expect(hasListing(h, 11)).toBe(false);
    expect(hasIntent(h, 11)).toBe(false);
  });

  it('leaves another loan’s side tables alone', async () => {
    // The cleanup is keyed by loan, and a close is not a licence to tidy
    // the table.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 7);
    seedActiveLoan(h, 8);
    seedListing(h, 8);
    seedIntent(h, 8);
    await run(h, [log('HFLiquidationTriggered', 7)]);
    expect(hasListing(h, 8)).toBe(true);
    expect(hasIntent(h, 8)).toBe(true);
  });
});

describe('ending a listing or an intent is NOT a close', () => {
  it('PrepayListingCanceled clears the listing and leaves the intent', async () => {
    // The loan stays Active. A borrower who withdrew a collateral sale has
    // not withdrawn their swap commitment.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 9);
    seedListing(h, 9);
    seedIntent(h, 9);
    await run(h, [log('PrepayListingCanceled', 9)]);
    expect(hasListing(h, 9)).toBe(false);
    expect(hasIntent(h, 9)).toBe(true);
  });

  it('SwapToRepayIntentCancelled clears the intent and leaves the listing', async () => {
    // The mirror image, and the one that keeps the helper from being
    // dropped into every intent handler for symmetry.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 10);
    seedListing(h, 10);
    seedIntent(h, 10);
    await run(h, [log('SwapToRepayIntentCancelled', 10)]);
    expect(hasIntent(h, 10)).toBe(false);
    expect(hasListing(h, 10)).toBe(true);
  });
});

/**
 * The repair pass's budget, which is a property of the INVOCATION rather than
 * of the pass — so it is the caller's to set, and the numbers are asserted
 * here rather than left in a comment.
 *
 * Since #2221's ceiling split the pass is sized on the meter it actually
 * presses on: D1 statements. Its chain reads (`1 + maxRows * 3` at worst —
 * the count, a `getLoanDetails` per row, and two `ownerOf` reads for a
 * repaired row) are external requests, and the old sums that added them to
 * D1 calls against one 50 are retired with the single meter.
 */
describe('reconcile budget', () => {
  it('costs the shared legacy invocation the minimum that still turns', () => {
    const worst = 1 + (RECONCILE_BUDGET_SHARED_TICK.maxRows ?? 0) * 3;
    expect(worst).toBeLessThanOrEqual(4);
    // And it still turns: a budget of zero rows would make the rotation a
    // no-op that only ever asks the chain for a total.
    expect(RECONCILE_BUDGET_SHARED_TICK.minRows).toBeGreaterThanOrEqual(1);
  });

  it('holds the DO invocation to one row, sized on the query meter it presses on', () => {
    // The measured reason (see `RECONCILE_BUDGET_OWN_INVOCATION`): alarms exit
    // around 36 of 50 D1 statements, and a repaired row costs about nine more.
    // Raising this is a decision to re-read that figure first, and it should
    // fail here until someone has.
    expect(RECONCILE_BUDGET_OWN_INVOCATION.maxRows).toBe(1);
    // Quarantine maintenance is D1 only, and asks the shared probe ONCE per
    // pass however many lanes read it (#2221): 1 probe + 2 release + 4 stale
    // report + 1 repair write.
    expect(QUARANTINE_MAINTENANCE_D1_QUERIES).toBe(8);
  });

  it('never lets the shared-tick budget exceed the own-invocation one', () => {
    // The relationship, not just the values: if someone raises the tight one
    // to match the roomy one, the constants have stopped meaning what their
    // names say and the legacy path is the one that pays.
    expect(RECONCILE_BUDGET_SHARED_TICK.maxRows ?? 0).toBeLessThanOrEqual(
      RECONCILE_BUDGET_OWN_INVOCATION.maxRows ?? 0,
    );
  });
});

/**
 * The repair path, end to end against a real database.
 *
 * The unit cases for the pass run against a fake, which cannot catch a
 * mis-wired `closedLoanSideTableStatements` — the seam that carries the
 * scan's table list into the repair's transaction. This drives
 * `reconcileAfterScan` itself.
 */
describe('a repair records the holder the chain named, and only that one', () => {
  // The unsafe half of the deleted three-answer classifier was inferring a
  // BURN from a failed read; removing it took the safe half with it
  // (#2190 r7 `4008463632`). These two cases are the asymmetry that replaced
  // it, and they are what stops either half coming back on its own: an
  // address is recorded, and an absence is NOT — whatever the absence means.
  const owners = (h: SqliteD1, loanId: number) =>
    h.db
      .prepare(
        'SELECT lender_current_owner AS l, borrower_current_owner AS b FROM loans WHERE loan_id = ?',
      )
      .get(loanId) as { l: string; b: string };

  it('writes a side the chain answered for', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 40);
    await h.d1.batch(
      _verifiedHolderStatements({ DB: h.d1 } as unknown as Env, CHAIN, 40, {
        lender: '0xnewlender',
        borrower: '0xnewborrower',
      }, 1_700_000_000),
    );
    expect(owners(h, 40)).toEqual({ l: '0xnewlender', b: '0xnewborrower' });
  });

  it('leaves a side it got NO answer for exactly as it was', async () => {
    // `null` is a token that no longer exists AND a call that did not
    // complete — indistinguishable, which is why the classifier went. Zeroing
    // this column on a transient failure would hide a claim that is still
    // somebody's, which is the harm the removal exists to prevent.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 41);
    const stmts = _verifiedHolderStatements(
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      41,
      { lender: null, borrower: '0xnewborrower' },
      1_700_000_000,
    );
    // One statement, not two with a null bound into the first.
    expect(stmts).toHaveLength(1);
    await h.d1.batch(stmts);
    expect(owners(h, 41)).toEqual({ l: '0xlend', b: '0xnewborrower' });
  });

  it('writes nothing at all when neither side answered', () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 42);
    expect(
      _verifiedHolderStatements({ DB: h.d1 } as unknown as Env, CHAIN, 42, {
        lender: null,
        borrower: null,
      }, 1_700_000_000),
    ).toEqual([]);
  });
});

describe('reconcileAfterScan against a real database', () => {
  const readTerminal = async (args: Record<string, unknown>) => {
    if (args.functionName === 'getActiveLoansCount') return 0n;
    return {
      id: 21n,
      status: 1,
      principal: 0n,
      collateralAmount: 250n,
      lenderTokenId: 1n,
      borrowerTokenId: 2n,
    };
  };

  /** The clock the disclosure hook reads; one test moves it. */
  let discloseAt = 1_700_000_000;

  const runRepair = (h: SqliteD1) =>
    reconcileAfterScan(
      {
        db: h.d1 as never,
        chainId: CHAIN,
        diamond: DIAMOND,
        head: 100n,
        headAt: 1_699_999_000,
        canStartOrphanMove: () => true,
        readContract: readTerminal as never,
        metricsAbi: [],
        loanAbi: [],
        closedLoanSideTableStatements: (loanId) =>
          // `true`: the harness runs the REAL migrations, so the quarantine
          // table exists and its release belongs in this list. Omitting the
          // argument left it falsy and quietly dropped that statement, which
          // is how the repair path's quarantine release went untested here.
          _closedLoanSideTableStatements({ DB: h.d1 } as unknown as Env, CHAIN, loanId, true),
        // Wired exactly as production wires it, so the repair path's
        // disclosure is exercised here rather than only asserted structurally
        // (#2231 r9 `4036242408`). `discloseAt` lets one test push the clock
        // past the stale threshold; the rest keep the default and stay quiet.
        discloseSideTableBatch: (results) =>
          discloseQuarantineReleases(CHAIN, results, discloseAt, 'reconciled'),
        mutableColumns: (d: Record<string, unknown>) => ({
          assignments: ['principal = ?', 'collateral_amount = ?'],
          values: [String(d.principal), String(d.collateralAmount)],
        }),
        terminalHolderStatements: async (loanId, to) => {
          const rows = await planReconciledNotifications(
            h.d1 as never, CHAIN, [{ loanId, to }], 100, 1_700_000_000,
          );
          return rows.map((r) => notificationInsertStatement(h.d1 as never, r));
        },
      },
      { maxRows: 5, minRows: 1 },
    );

  it('ANNOUNCES a long-held quarantine marker the close-out batch released', async () => {
    // #2231 r9 `4036242408`. This batch deletes the marker, and it runs
    // before either disclosure path could observe it: the terminal sweep
    // finds nothing left, and the settle path never sees this loan again
    // because a terminal loan has left the set the rotation selects from.
    // So an unresolved finding about a reused id disappeared here, silently,
    // while two other release paths announced themselves.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 21);
    h.db
      .prepare(
        `INSERT INTO loan_reconcile_quarantine
           (chain_id, loan_id, reason, first_seen_at, last_seen_at)
         VALUES (?, ?, 'orphan', ?, ?)`,
      )
      .run(CHAIN, 21, 1_700_000_000, 1_700_000_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    discloseAt = 1_700_000_000 + QUARANTINE_STALE_SECONDS + 1;
    try {
      await runRepair(h);
    } finally {
      discloseAt = 1_700_000_000;
    }
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    warn.mockRestore();
    expect(said).toContain('loan 21');
    // The CLOSE-OUT wording, not the settle path's (#2231 r10 `4036448029`):
    // a terminal event proves the position currently bearing the id ended,
    // never that the released entry was about that position.
    // The RECONCILED wording (#2231 r11 `4036569613`): this path reached the
    // close-out list from a chain read, and the terminal event is precisely
    // what was missed — so claiming one arrived would misdescribe it.
    expect(said).toContain('found the loan already terminal');
    expect(said).toContain('no terminal event having arrived');
    expect(said).not.toContain('a terminal event for the id arrived');
    expect(said).not.toContain('soundest release');
    // And the marker really is gone — the disclosure is about a release that
    // happened, not a release that was contemplated.
    expect(
      h.db.prepare('SELECT COUNT(*) AS n FROM loan_reconcile_quarantine').get(),
    ).toMatchObject({ n: 0 });
  });

  it('closes the row and both side tables in one write', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 21);
    seedListing(h, 21);
    seedIntent(h, 21);
    const report = await runRepair(h);
    expect(report.repaired).toEqual([{ loanId: 21, from: 'active', to: 'repaid' }]);
    const row = h.db
      .prepare('SELECT status, principal, collateral_amount FROM loans WHERE loan_id = ?')
      .get(21) as { status: string; principal: string; collateral_amount: string };
    expect(row.status).toBe('repaid');
    // The explicit marker the repair's notice gates on (#2476 r12).
    expect(
      (h.db.prepare('SELECT terminal_by_repair AS m FROM loans WHERE loan_id = ?').get(21) as { m: number }).m,
    ).toBe(1);
    // #2195 — what the repair OBSERVED, in the same compare-and-set: the
    // status, the settled block the read was pinned to and that block's
    // time. The terminal block and time stay unknown.
    expect(
      h.db
        .prepare(
          `SELECT repair_observed_status AS s, repair_observed_block AS b, repair_observed_at AS t,
                  terminal_block AS tb, terminal_at AS ta FROM loans WHERE loan_id = ?`,
        )
        .get(21),
    ).toEqual({ s: 'repaid', b: 100, t: 1_699_999_000, tb: null, ta: null });
    // The money comes from the same read as the status.
    expect(row.principal).toBe('0');
    expect(row.collateral_amount).toBe('250');
    expect(hasListing(h, 21)).toBe(false);
    expect(hasIntent(h, 21)).toBe(false);
    // And the inbox rows rode the SAME transaction — written afterwards
    // they could be lost for good, since the repaired row leaves the live
    // set the rotation selects from (#2190 r4).
    const notif = h.db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE chain_id = ? AND loan_id = ?')
      .get(CHAIN, 21) as { n: number };
    expect(notif.n).toBe(2);
  });

  it('leaves a loan the chain still calls running completely untouched', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 22);
    seedListing(h, 22);
    seedIntent(h, 22);
    await reconcileAfterScan(
      {
        db: h.d1 as never,
        chainId: CHAIN,
        diamond: DIAMOND,
        head: 100n,
        headAt: 1_699_999_000,
        canStartOrphanMove: () => true,
        readContract: (async (args: Record<string, unknown>) =>
          args.functionName === 'getActiveLoansCount'
            ? 1n
            : {
                id: 22n,
                status: 0,
                principal: 100n,
                collateralAmount: 200n,
                lenderTokenId: 1n,
                borrowerTokenId: 2n,
              }) as never,
        metricsAbi: [],
        loanAbi: [],
        closedLoanSideTableStatements: (loanId) =>
          _closedLoanSideTableStatements({ DB: h.d1 } as unknown as Env, CHAIN, loanId),
        mutableColumns: (d: Record<string, unknown>) => ({
          assignments: ['principal = ?', 'collateral_amount = ?'],
          values: [String(d.principal), String(d.collateralAmount)],
        }),
        terminalHolderStatements: async () => [],
      },
      { maxRows: 5, minRows: 1 },
    );
    expect(hasListing(h, 22)).toBe(true);
    expect(hasIntent(h, 22)).toBe(true);
  });

  it('#2197 — withdraws a row the chain has no loan for: moved whole into loan_orphans, side tables cleared', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 23);
    seedListing(h, 23);
    seedIntent(h, 23);
    const before = h.db.prepare('SELECT * FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, 23);
    const report = await reconcileAfterScan(
      {
        db: h.d1 as never,
        chainId: CHAIN,
        diamond: DIAMOND,
        head: 100n,
        headAt: 1_699_999_000,
        canStartOrphanMove: () => true,
        // The zero struct: the chain has never heard of loan 23.
        readContract: (async (args: Record<string, unknown>) =>
          args.functionName === 'getActiveLoansCount'
            ? 0n
            : { id: 0n, status: 0, principal: 0n, collateralAmount: 0n, lenderTokenId: 0n, borrowerTokenId: 0n }) as never,
        metricsAbi: [],
        loanAbi: [],
        closedLoanSideTableStatements: (loanId) =>
          _closedLoanSideTableStatements({ DB: h.d1 } as unknown as Env, CHAIN, loanId, true),
        discloseSideTableBatch: () => {},
        mutableColumns: () => ({ assignments: [], values: [] }),
        terminalHolderStatements: async () => [],
      },
      { maxRows: 5, minRows: 1 },
    );
    expect(report.unresolvable).toEqual([23]);
    expect(report.withdrawn).toEqual([23]);
    // Gone from every surface that reads `loans`…
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loans WHERE loan_id = 23').get()).toEqual({ n: 0 });
    expect(hasListing(h, 23)).toBe(false);
    expect(hasIntent(h, 23)).toBe(false);
    // …and kept whole, with the evidence, for an operator's restore.
    const kept = h.db
      .prepare('SELECT chain_id, loan_id, from_status, observed_block, row_json FROM loan_orphans')
      .all() as { chain_id: number; loan_id: number; from_status: string; observed_block: number; row_json: string }[];
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ chain_id: CHAIN, loan_id: 23, from_status: 'active', observed_block: 100 });
    expect(JSON.parse(kept[0].row_json)).toEqual(before);
  });

  it('#2636 r4 — starts no move the invocation cannot finish: the row stays published and named', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 24);
    const report = await reconcileAfterScan(
      {
        db: h.d1 as never,
        chainId: CHAIN,
        diamond: DIAMOND,
        head: 100n,
        headAt: 1_699_999_000,
        canStartOrphanMove: () => false,
        readContract: (async (args: Record<string, unknown>) =>
          args.functionName === 'getActiveLoansCount'
            ? 0n
            : { id: 0n, status: 0, principal: 0n, collateralAmount: 0n, lenderTokenId: 0n, borrowerTokenId: 0n }) as never,
        metricsAbi: [],
        loanAbi: [],
        closedLoanSideTableStatements: (loanId) =>
          _closedLoanSideTableStatements({ DB: h.d1 } as unknown as Env, CHAIN, loanId, true),
        discloseSideTableBatch: () => {},
        mutableColumns: () => ({ assignments: [], values: [] }),
        terminalHolderStatements: async () => [],
      },
      { maxRows: 5, minRows: 1 },
    );
    expect(report.unresolvable).toEqual([24]);
    expect(report.withdrawn).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loans WHERE loan_id = 24').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_orphans').get()).toEqual({ n: 0 });
  });
});

describe('withdrawOrphanLoan — one guarded move (#2636 r1)', () => {
  it('a writer that changes the row before the batch leaves EVERYTHING in place, even within the same second', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 61);
    seedListing(h, 61);
    seedIntent(h, 61);
    // The scan touches the row between the move's read batch and its write
    // batch, in the same second: `updated_at` unchanged, a value changed.
    let batches = 0;
    const raced = new Proxy(h.d1, {
      get(target, prop, recv) {
        if (prop === 'batch') {
          return async (stmts: unknown[]) => {
            if (batches++ === 1) {
              h.db.prepare(`UPDATE loans SET principal = '999' WHERE chain_id = ? AND loan_id = ?`).run(CHAIN, 61);
            }
            return (target as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(stmts);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    expect(await withdrawOrphanLoan(raced as never, CHAIN, DIAMOND, 61, 'active', 100n, 1)).toBe(false);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loans WHERE loan_id = 61').get()).toEqual({ n: 1 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_orphans').get()).toEqual({ n: 0 });
    expect(hasListing(h, 61)).toBe(true);
    expect(hasIntent(h, 61)).toBe(true);
  });

  it('clears every side table a close-out clears', () => {
    const tables = (src: string) =>
      [...src.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]).filter((t) => t !== 'loans').sort();
    const orphan = readFileSync(new URL('../src/loanOrphans.ts', import.meta.url), 'utf8');
    const indexer = readFileSync(new URL('../src/chainIndexer.ts', import.meta.url), 'utf8');
    const start = indexer.indexOf('export function _loanSideTableStatements(');
    const closeOut = indexer.slice(start, indexer.indexOf('\n}\n', start));
    expect(tables(closeOut).length).toBeGreaterThan(0);
    for (const t of tables(closeOut)) expect(tables(orphan)).toContain(t);
  });

  const seedRelated = (h: ReturnType<typeof createSqliteD1>, id: number) => {
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
         VALUES (?, ?, 0, '0xaa', 'LoanInitiated', ?, '{}', 1)`,
      )
      .run(CHAIN, id, id);
    h.db
      .prepare(`INSERT INTO loan_participants (chain_id, loan_id, wallet, role, from_at) VALUES (?, ?, '0xlend', 'lender', 1)`)
      .run(CHAIN, id);
    h.db
      .prepare(
        `INSERT INTO notifications (chain_id, recipient, kind, loan_id, created_at, dedup_key)
         VALUES (?, '0xborrow', 'loan_started', ?, 1, ?)`,
      )
      .run(CHAIN, id, `k${id}`);
  };
  const count = (h: ReturnType<typeof createSqliteD1>, t: string, id: number) =>
    (h.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE chain_id = ? AND loan_id = ?`).get(CHAIN, id) as { n: number }).n;
  /** Runs `between` once, between the move's read batch and its write batch. */
  const racing = (h: ReturnType<typeof createSqliteD1>, between: () => void) => {
    let batches = 0;
    return new Proxy(h.d1, {
      get(target, prop, recv) {
        if (prop === 'batch') {
          return async (stmts: unknown[]) => {
            if (batches++ === 1) between();
            return (target as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(stmts);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };

  it('moves every published row about the loan with it, kept whole, clears its alert memory and releases its marker', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 62);
    seedRelated(h, 62);
    h.db
      .prepare(
        `INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, created_at, updated_at)
         VALUES ('0xborrow', ?, 1.5, 1.2, 1.05, 1, 1)`,
      )
      .run(CHAIN);
    h.db.prepare(`INSERT INTO notify_state (wallet, chain_id, loan_id, last_band) VALUES ('0xborrow', ?, 62, 'alert')`).run(CHAIN);
    h.db.prepare(`INSERT INTO pre_grace_notify_state (wallet, chain_id, loan_id, last_sent_ts) VALUES ('0xborrow', ?, 62, 5)`).run(CHAIN);
    // Both ids carry a quarantine marker from an earlier pass.
    for (const id of [62, 63]) {
      h.db
        .prepare(
          `INSERT INTO loan_reconcile_quarantine (chain_id, loan_id, reason, first_seen_at, last_seen_at) VALUES (?, ?, 'orphan', 1, 1)`,
        )
        .run(CHAIN, id);
    }
    // An unrelated loan's rows stay.
    seedActiveLoan(h, 63);
    seedRelated(h, 63);
    h.db.prepare(`INSERT INTO notify_state (wallet, chain_id, loan_id, last_band) VALUES ('0xborrow', ?, 63, 'alert')`).run(CHAIN);
    expect(await withdrawOrphanLoan(h.d1 as never, CHAIN, DIAMOND, 62, 'active', 100n, 1)).toBe(true);
    for (const t of ['loans', 'activity_events', 'loan_participants', 'notifications', 'notify_state', 'pre_grace_notify_state']) {
      expect(count(h, t, 62)).toBe(0);
    }
    for (const t of ['loans', 'activity_events', 'loan_participants', 'notifications', 'notify_state']) {
      expect(count(h, t, 63)).toBe(1);
    }
    const kept = h.db.prepare('SELECT diamond, move_id, related_json FROM loan_orphans WHERE loan_id = 62').get() as {
      diamond: string;
      move_id: string;
      related_json: string;
    };
    expect(kept.diamond).toBe(String(DIAMOND).toLowerCase());
    const related = JSON.parse(kept.related_json);
    expect(related.activity_events).toHaveLength(1);
    expect(related.activity_events[0]).toMatchObject({ kind: 'LoanInitiated', tx_hash: '0xaa' });
    expect(related.loan_participants[0]).toMatchObject({ wallet: '0xlend', role: 'lender' });
    expect(related.notifications[0]).toMatchObject({ dedup_key: 'k62', recipient: '0xborrow' });
    // The operator's record is the archive entry, unreviewed (#2636 r4)…
    expect(h.db.prepare('SELECT reviewed_at FROM loan_orphans WHERE move_id = ?').get(kept.move_id)).toEqual({ reviewed_at: null });
    // …and the id's quarantine marker is RELEASED, so it cannot withhold
    // reminders from a real loan later issued the same id.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_reconcile_quarantine WHERE chain_id = ? AND loan_id = 62').get(CHAIN)).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_reconcile_quarantine WHERE chain_id = ? AND loan_id = 63').get(CHAIN)).toEqual({ n: 1 });
  });

  it('a related row that lands between the read and the move aborts it whole (#2636 r3)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 64);
    seedRelated(h, 64);
    const late = racing(h, () =>
      h.db
        .prepare(
          `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
           VALUES (?, 11, 0, '0xbb', 'LoanRepaid', 64, '{}', 2)`,
        )
        .run(CHAIN),
    );
    expect(await withdrawOrphanLoan(late as never, CHAIN, DIAMOND, 64, 'active', 100n, 1)).toBe(false);
    expect(count(h, 'loans', 64)).toBe(1);
    expect(count(h, 'activity_events', 64)).toBe(2);
    expect(count(h, 'loan_participants', 64)).toBe(1);
    expect(count(h, 'notifications', 64)).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_orphans').get()).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_reconcile_quarantine').get()).toEqual({ n: 0 });
    // The next attempt reads the new row and takes it along.
    expect(await withdrawOrphanLoan(h.d1 as never, CHAIN, DIAMOND, 64, 'active', 100n, 2)).toBe(true);
    expect(count(h, 'activity_events', 64)).toBe(0);
    const kept = h.db.prepare('SELECT related_json FROM loan_orphans WHERE loan_id = 64').get() as { related_json: string };
    expect(JSON.parse(kept.related_json).activity_events).toHaveLength(2);
  });

  it('a related row that disappears in between aborts it too', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 65);
    seedRelated(h, 65);
    const gone = racing(h, () =>
      h.db.prepare(`DELETE FROM notifications WHERE chain_id = ? AND loan_id = 65`).run(CHAIN),
    );
    expect(await withdrawOrphanLoan(gone as never, CHAIN, DIAMOND, 65, 'active', 100n, 1)).toBe(false);
    expect(count(h, 'loans', 65)).toBe(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM loan_orphans').get()).toEqual({ n: 0 });
  });
});
