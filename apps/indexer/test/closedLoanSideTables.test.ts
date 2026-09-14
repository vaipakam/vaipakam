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
 * enumerating tables at the call sites: `_clearClosedLoanSideTables` is the
 * one thing a CLOSE calls, and the repair path calls the same one. These
 * cases are the reason that distinction cannot quietly collapse, in either
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
import { processLoanLogs } from '../src/chainIndexer';
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
