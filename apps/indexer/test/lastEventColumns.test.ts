/**
 * #3921 B2 — the offer and loan rows name the event that last changed them,
 * driven through the real handlers against the real migrated schema.
 * (`lastEventGuard.test.ts` holds every write site to the rule; this file
 * shows the rule's outcome on the rows.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { markBorrowerFillsUnread, processLoanLogs, settleLoanRow } from '../src/chainIndexer';
import { readPosition } from '../src/lastEvent';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000d1a90' as never;

function seedLoan(h: SqliteD1, loanId: number, status = 'active') {
  h.db
    .prepare(
      `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
         principal, collateral_amount, asset_type, collateral_asset_type,
         lending_asset, collateral_asset, duration_days, token_id,
         collateral_token_id, lender_token_id, borrower_token_id,
         lender_current_owner, borrower_current_owner, interest_rate_bps,
         start_time, start_block, start_at, updated_at)
       VALUES (?, ?, 1, ?, '0xlend', '0xborrow', '100', '200', 0, 0,
         '0xasset', '0xcoll', 30, '0', '0', '1', '2', '0xlend', '0xborrow',
         500, 1000, 0, 1000, 0)`,
    )
    .run(CHAIN, loanId, status);
}

const lastEvent = (h: SqliteD1, table: 'loans' | 'offers', key: string, id: number) =>
  Object.values(
    h.db
      .prepare(
        `SELECT last_event_block, last_event_tx_index, last_event_log_index
           FROM ${table} WHERE chain_id = ? AND ${key} = ?`,
      )
      .get(CHAIN, id) as object,
  );

const log = (
  eventName: string,
  args: Record<string, unknown>,
  block: bigint,
  logIndex: number,
  transactionIndex?: number,
) => ({
  eventName,
  args,
  blockNumber: block,
  transactionHash: `0x${'ab'.repeat(32)}`,
  ...(transactionIndex === undefined ? {} : { transactionIndex }),
  logIndex,
});

const run = (h: SqliteD1, logs: ReturnType<typeof log>[]) =>
  processLoanLogs(
    logs as never,
    { DB: h.d1 } as unknown as Env,
    CHAIN,
    new Map(logs.map((l) => [l.blockNumber, 1_700_000_000])),
    {} as never,
    DIAMOND,
  );

describe('a loan row names its last event (#3921 B2)', () => {
  it('records the event a handler applied, by block, transaction and log', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 7);
    expect(lastEvent(h, 'loans', 'loan_id', 7)).toEqual([null, null, null]); // written before: unknown
    await run(h, [log('PartialRepaid', { loanId: 7n, newPrincipal: 60n }, 100n, 7, 3)]);
    expect(lastEvent(h, 'loans', 'loan_id', 7)).toEqual([100, 3, 7]);
    await run(h, [log('CollateralAdded', { loanId: 7n, newCollateralAmount: 250n }, 101n, 2, 1)]);
    expect(lastEvent(h, 'loans', 'loan_id', 7)).toEqual([101, 1, 2]);
  });

  it('names the LATER event when a handler applied an earlier one last', async () => {
    // The status edge is deferred to after the block's other handlers, so it
    // is written last although its log comes first. The row still names the
    // collateral top-up, which came later on chain.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 8);
    await run(h, [
      log('LoanStatusChanged', { loanId: 8n, from: 0, to: 2 }, 200n, 4, 1),
      log('CollateralAdded', { loanId: 8n, newCollateralAmount: 300n }, 200n, 9, 2),
    ]);
    const row = h.db.prepare('SELECT status, collateral_amount FROM loans WHERE loan_id = 8').get();
    expect(row).toEqual({ status: 'defaulted', collateral_amount: '300' });
    expect(lastEvent(h, 'loans', 'loan_id', 8)).toEqual([200, 2, 9]);
  });

  it('says so when the transaction position was not in hand', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 9);
    await run(h, [log('PartialRepaid', { loanId: 9n, newPrincipal: 10n }, 300n, 5)]);
    expect(lastEvent(h, 'loans', 'loan_id', 9)).toEqual([300, null, 5]);
  });

  it('a row set from a read names the block read at, with no event position', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 10, 'repaid');
    await run(h, [log('PartialRepaid', { loanId: 10n, newPrincipal: 0n }, 400n, 1, 0)]);
    // The settlement heal reads the status at the settled block.
    expect(await settleLoanRow({ DB: h.d1 } as unknown as Env, CHAIN, 10, null, null, readPosition(450n))).toBe(true);
    expect(lastEvent(h, 'loans', 'loan_id', 10)).toEqual([450, null, null]);
    // A replayed older event does not move it back.
    await run(h, [log('PartialRepaid', { loanId: 10n, newPrincipal: 0n }, 400n, 1, 0)]);
    expect(lastEvent(h, 'loans', 'loan_id', 10)).toEqual([450, null, null]);
  });
});

describe('an offer row names its last event (#3921 B2)', () => {
  it('the match mark records the match that consumed each offer', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    for (const id of [1, 2, 3]) {
      h.db
        .prepare(
          `INSERT INTO offers (chain_id, offer_id, status, creator, offer_type, lending_asset,
             collateral_asset, asset_type, collateral_asset_type, principal_liquidity,
             collateral_liquidity, amount, interest_rate_bps, collateral_amount, duration_days,
             first_seen_block, first_seen_at, updated_at, collateral_amount_filled)
           VALUES (?, ?, 'active', '0xc', 1, '0xa', '0xb', 0, 0, 0, 0, '1', 1, '1', 1, 1, 1, 1, '0')`,
        )
        .run(CHAIN, id);
    }
    await markBorrowerFillsUnread({ DB: h.d1 } as unknown as Env, CHAIN, [
      [1, { block: 500, txIndex: 1, logIndex: 4 }],
      [2, { block: 500, txIndex: 2, logIndex: 8 }],
      [3, { block: 500, txIndex: 1, logIndex: 4 }],
    ]);
    expect(lastEvent(h, 'offers', 'offer_id', 1)).toEqual([500, 1, 4]);
    expect(lastEvent(h, 'offers', 'offer_id', 2)).toEqual([500, 2, 8]);
    expect(lastEvent(h, 'offers', 'offer_id', 3)).toEqual([500, 1, 4]);
    const unread = h.db.prepare('SELECT COUNT(*) AS n FROM offers WHERE collateral_amount_filled IS NULL').get() as { n: number };
    expect(unread.n).toBe(3);
  });
});
