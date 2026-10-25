/**
 * The obligation handover re-originates the loan's term (#2808, Codex #2822
 * r3 P1).
 *
 * `PrecloseFacet`'s transfer of a borrower obligation keeps the loan Active
 * but resets its collateral, rate, duration and `startTime`. The loan routes
 * date an Active loan from the row's start and duration on the D2 loan clock,
 * so the `LoanObligationTransferred` handler must write the incoming term —
 * read from the chain at the event's block, since the event carries no start
 * time — or the routes serve the exiting borrower's due date as current.
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
const NEW_BORROWER = '0x00000000000000000000000000000000000000BE';

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
         500, 1000, 0, 1000, 0)`,
    )
    .run(CHAIN, loanId);
}

const transferLog = (loanId: number, block: bigint) => ({
  eventName: 'LoanObligationTransferred',
  args: {
    loanId: BigInt(loanId),
    originalBorrower: '0x000000000000000000000000000000000000b0b0',
    newBorrower: NEW_BORROWER,
    shortfallPaid: 0n,
    newBorrowerTokenId: 9n,
    newCollateralAmount: 350n,
    newInterestRateBps: 720n,
    newDurationDays: 14n,
    newDueTimestamp: 50_000n + 14n * 86_400n,
    newHealthFactor: 0n,
  },
  blockNumber: block,
  transactionHash: `0x${'cd'.repeat(32)}`,
  logIndex: 0,
});

const rowOf = (h: SqliteD1, loanId: number) =>
  h.db
    .prepare(
      `SELECT borrower, borrower_token_id, collateral_amount, collateral_token_id,
              interest_rate_bps, duration_days, start_time
         FROM loans WHERE chain_id = ? AND loan_id = ?`,
    )
    .get(CHAIN, loanId);

describe('LoanObligationTransferred writes the re-originated term (#2808)', () => {
  it('writes the incoming term, read at the event block', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 4);
    const reads: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      readContract: async (req: { functionName: string; blockNumber?: bigint }) => {
        reads.push(req);
        if (req.functionName !== 'getLoanDetails') throw new Error(`unexpected ${req.functionName}`);
        return {
          collateralAmount: 350n,
          collateralTokenId: 0n,
          interestRateBps: 720n,
          durationDays: 14n,
          startTime: 50_000n,
        };
      },
    } as never;

    await processLoanLogs(
      [transferLog(4, 120n)] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      // A wall-clock sentinel for the block: the term must not come from it.
      new Map([[120n, 99_999]]),
      client,
      DIAMOND,
      new Set([120n]),
    );

    expect(reads).toEqual([expect.objectContaining({ functionName: 'getLoanDetails', blockNumber: 120n })]);
    expect(rowOf(h, 4)).toEqual({
      borrower: NEW_BORROWER.toLowerCase(),
      borrower_token_id: '9',
      collateral_amount: '350',
      collateral_token_id: '0',
      interest_rate_bps: 720,
      duration_days: 14,
      start_time: 50_000,
    });
  });

  it('leaves the row untouched and fails the pass when the term cannot be read', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 5);
    const before = rowOf(h, 5);
    const client = {
      readContract: async () => {
        throw new Error('rpc down');
      },
    } as never;

    await expect(
      processLoanLogs(
        [transferLog(5, 121n)] as never,
        { DB: h.d1 } as unknown as Env,
        CHAIN,
        new Map([[121n, 60_000]]),
        client,
        DIAMOND,
      ),
    ).rejects.toThrow('rpc down');
    // No half-moved row: the borrower is not switched onto the old term.
    expect(rowOf(h, 5)).toEqual(before);
  });
});
