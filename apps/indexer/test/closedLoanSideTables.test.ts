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
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  _closedLoanSideTableStatements,
  _verifiedHolderStatements,
  processLoanLogs,
  RECONCILE_BUDGET_OWN_INVOCATION,
  RECONCILE_BUDGET_SHARED_TICK,
} from '../src/chainIndexer';
import { reconcileAfterScan } from '../src/loanReconcile';
import {
  notificationInsertStatement,
  planReconciledNotifications,
} from '../src/notifications';
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
 * The repair pass's subrequest budget, which is a property of the INVOCATION
 * rather than of the pass — so it is the caller's to set, and the numbers
 * are asserted here rather than left in a comment.
 *
 * Free-tier Workers cap at 50 subrequests per invocation. On the DO path —
 * which `CHAIN_INGEST_VIA_DO: "true"` makes the deployed one — the scan runs
 * inside the Durable Object's own invocation, so the ~12 headroom beside its
 * own ~38 is the repair's to use.
 *
 * The legacy inline path is NOT a tighter version of the same sum, and these
 * cases must not be read as asserting that it fits. That invocation carries
 * the scan (~38), the backing snapshot (~4) and the OpenSea republish sweep
 * (up to 35 — 5 rows x 7 calls each), which is ~77 against a cap of 50
 * before this pass exists at all (#2194). The tight budget is the minimum
 * non-zero cost on a path that is already over, not a fit.
 *
 * The pass spends `1 + maxRows` at worst: one `getActiveLoansCount` plus one
 * `getLoanDetails` per row examined. That is the number these cases pin.
 */
describe('reconcile budget', () => {
  it('costs the shared legacy invocation the minimum that still turns', () => {
    // Deliberately NOT phrased as "fits" — see the header: that invocation
    // is already over the cap without this pass. What is asserted is that
    // the pass takes the least it can while still doing anything.
    const worst = 1 + (RECONCILE_BUDGET_SHARED_TICK.maxRows ?? 0) * 3;
    expect(worst).toBeLessThanOrEqual(4);
    // And it still turns: a budget of zero rows would make the rotation a
    // no-op that only ever asks the chain for a total.
    expect(RECONCILE_BUDGET_SHARED_TICK.minRows).toBeGreaterThanOrEqual(1);
  });

  it('fits the DO invocation, holder verification included', () => {
    // Three subrequests per row in the worst case, not one: the chain read
    // that decides the repair, plus the two `ownerOf` reads that decide who
    // the notice goes to. The 5→3 trim exists for this sum (#2190 r5).
    const worst = 1 + (RECONCILE_BUDGET_OWN_INVOCATION.maxRows ?? 0) * 3;
    expect(worst).toBeLessThanOrEqual(12);
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

  const runRepair = (h: SqliteD1) =>
    reconcileAfterScan(
      {
        db: h.d1 as never,
        chainId: CHAIN,
        diamond: DIAMOND,
        head: 100n,
        readContract: readTerminal as never,
        metricsAbi: [],
        loanAbi: [],
        closedLoanSideTableStatements: (loanId) =>
          _closedLoanSideTableStatements({ DB: h.d1 } as unknown as Env, CHAIN, loanId),
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
});
