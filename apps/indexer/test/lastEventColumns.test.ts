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

describe('a figure read back at its event\'s block names the block, not the event (#3921 B2, Codex r2)', () => {
  it('the obligation handover records the end-of-block read', async () => {
    // The term is read at the event's block, which returns the END of that
    // block: a later transaction in it may already show. So the row names the
    // read at that block, not the handover's own log.
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 11);
    const client = {
      readContract: async () => ({
        collateralAmount: 350n,
        collateralTokenId: 0n,
        interestRateBps: 720n,
        durationDays: 14n,
        startTime: 50_000n,
      }),
    };
    await processLoanLogs(
      [
        log(
          'LoanObligationTransferred',
          { loanId: 11n, newBorrower: '0x00000000000000000000000000000000000000be', newBorrowerTokenId: 9n },
          600n,
          3,
          1,
        ),
      ] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[600n, 1_700_000_000]]),
      client as never,
      DIAMOND,
    );
    expect(lastEvent(h, 'loans', 'loan_id', 11)).toEqual([600, null, null]);
    // The new obligor's participation row is the handover's own record.
    const p = h.db
      .prepare(
        `SELECT last_event_block, last_event_tx_index, last_event_log_index FROM loan_participants
          WHERE loan_id = 11 AND wallet = '0x00000000000000000000000000000000000000be'`,
      )
      .get() as object;
    expect(Object.values(p)).toEqual([600, 1, 3]);
  });
});

describe('the loan side tables name their last event (#3921 B2)', () => {
  const row = (h: SqliteD1, table: string, loanId: number) =>
    Object.values(
      h.db
        .prepare(
          `SELECT last_event_block, last_event_tx_index, last_event_log_index FROM ${table}
            WHERE chain_id = ? AND loan_id = ?`,
        )
        .get(CHAIN, loanId) as object,
    );

  it('a swap-to-repay commit names the commit', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 20);
    await run(h, [
      log(
        'SwapToRepayIntentCommitted',
        {
          loanId: 20n,
          orderHash: `0x${'cd'.repeat(32)}`,
          committedBy: '0x00000000000000000000000000000000000000c1',
          makerAmount: 5n,
          takerAmount: 6n,
          deadline: 9_999n,
        },
        700n,
        6,
        2,
      ),
    ]);
    expect(row(h, 'swap_to_repay_intents', 20)).toEqual([700, 2, 6]);
  });

  function seedListing(h: SqliteD1, loanId: number) {
    h.db
      .prepare(
        `INSERT INTO prepay_listings (chain_id, loan_id, order_hash, ask_price, conduit, lister,
           posted_at, updated_at, grace_period_end, block_number, tx_hash, log_index)
         VALUES (?, ?, '0xo', '1', '0xc', '0xl', 1, 1, 1, 1, '0xt', 0)`,
      )
      .run(CHAIN, loanId);
  }
  const partialRepay = (h: SqliteD1, loanId: number, client: unknown) =>
    processLoanLogs(
      [log('PartialRepaid', { loanId: BigInt(loanId), newPrincipal: 50n }, 800n, 4, 1)] as never,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[800n, 1_700_000_000]]),
      client as never,
      DIAMOND,
    );

  it('a listing\'s grace end read at the event\'s block names that block', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 21);
    seedListing(h, 21);
    await partialRepay(h, 21, { readContract: async () => ({ graceEnd: 123n }) });
    expect(row(h, 'prepay_listings', 21)).toEqual([800, null, null]);
  });

  it('a grace end the pinned read could not give is from an unnamed block, so the row says unknown', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 22);
    seedListing(h, 22);
    h.db.prepare('UPDATE prepay_listings SET last_event_block = 5 WHERE loan_id = 22').run();
    // The pinned read fails, the head read answers: its block is not named.
    const client = {
      readContract: async (q: { blockNumber?: bigint }) => {
        if (q.blockNumber !== undefined) throw new Error('no history');
        return { graceEnd: 456n };
      },
    };
    await partialRepay(h, 22, client);
    const g = h.db.prepare('SELECT grace_period_end FROM prepay_listings WHERE loan_id = 22').get() as {
      grace_period_end: number;
    };
    expect(g.grace_period_end).toBe(456);
    expect(row(h, 'prepay_listings', 22)).toEqual([null, null, null]);
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
