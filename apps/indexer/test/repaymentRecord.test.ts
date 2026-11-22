/**
 * #3778 — the repayment record, derived against the REAL migrated schema
 * (design `RepaymentRecordDesign.md` §6): every closing route, timing read
 * from time, a takeover counted for the one who closed it, the sale vehicle
 * left out, an empty address answered with the statements, and no combined
 * number anywhere.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { CURSOR_KIND } from '../src/chainIndexer';
import {
  RECORD_STATEMENTS,
  RECORD_VERSION,
  handleRepaymentRecord,
} from '../src/repaymentRecord';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const ME = '0x' + 'a1'.repeat(20);
const OTHER = '0x' + 'b2'.repeat(20);
const PAYER = '0x' + 'c3'.repeat(20);
const LENDER = '0x' + 'd4'.repeat(20);
const USDC = '0x' + 'ee'.repeat(20);
const T0 = 1_800_000_000;
const DAY = 86_400;

type Row = Record<string, unknown>;

function db() {
  const h = createSqliteD1(MIGRATIONS);
  const insert = (table: string, row: Row) => {
    const cols = Object.keys(row);
    h.db
      .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...(Object.values(row) as (string | number | null)[]));
  };
  insert('indexer_cursor', { chain_id: CHAIN, kind: CURSOR_KIND, last_block: 9_999, updated_at: T0 + 100 * DAY });
  insert('indexer_deployment', { chain_id: CHAIN, diamond: '0x' + '01'.repeat(20), deploy_block: 1, adopted_at: T0 });

  let block = 10;
  /** One loan, held by `holders` in turn (wallet, from time). */
  const loan = (
    id: number,
    opts: {
      status?: string;
      assetType?: number;
      saleVehicle?: number;
      holders?: [string, number][];
      due?: number;
      /** The opening event's parties; two different addresses by default, null = unknown. */
      opening?: [string, string] | null;
    } = {},
  ) => {
    const holders = opts.holders ?? [[ME, T0]];
    insert('loans', {
      chain_id: CHAIN,
      loan_id: id,
      offer_id: id,
      status: opts.status ?? 'repaid',
      lender: LENDER,
      borrower: holders[0][0],
      borrower_current_owner: holders[holders.length - 1][0],
      principal: '1000',
      collateral_amount: '2',
      asset_type: opts.assetType ?? 0,
      lending_asset: USDC,
      start_block: 1,
      start_at: T0,
      updated_at: T0,
      is_sale_vehicle: opts.saleVehicle ?? 0,
      init_lender: opts.opening === null ? null : (opts.opening?.[0] ?? LENDER),
      init_borrower: opts.opening === null ? null : (opts.opening?.[1] ?? holders[0][0]),
    });
    for (const [wallet, fromAt] of holders) {
      insert('loan_participants', { chain_id: CHAIN, loan_id: id, wallet, role: 'borrower', from_at: fromAt });
    }
    event(id, 'LoanInitiatedDetails', T0, { loanId: String(id), details: { dueTimestamp: String(opts.due ?? T0 + 30 * DAY) } });
  };
  /**
   * One event on a loan, in its own transaction unless `tx` is given. The
   * companion interest statements are stored as the indexer stores them,
   * with no loan_id (`activityRefsPolicy.json` notScoped): only the payload
   * names the loan.
   */
  const UNSCOPED = new Set(['LoanInterestPaid', 'LoanInterestUndelivered', 'LoanInitiatedDetails']);
  const event = (loanId: number, kind: string, at: number | null, args: Row = {}, tx?: string) => {
    block++;
    insert('activity_events', {
      chain_id: CHAIN,
      block_number: block,
      log_index: 0,
      tx_hash: tx ?? `0x${block.toString(16).padStart(64, '0')}`,
      kind,
      loan_id: UNSCOPED.has(kind) ? null : loanId,
      args_json: JSON.stringify({ loanId: String(loanId), ...args }),
      block_at: at,
    });
  };
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const read = async (address = ME) => {
    const res = await handleRepaymentRecord(new Request(`https://x/repayment-record/${address}?chainId=${CHAIN}`), env, address);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, any>;
  };
  return { h, loan, event, read, env };
}

const repaid = (lateFeePaid = '0', extra: Row = {}) => ({ repayer: ME, lateFeePaid, newStatus: 1, ...extra });

describe('how each loan closed', () => {
  it('classifies every closing route once', async () => {
    const { loan, event, read } = db();
    loan(1); event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());                      // on time
    loan(2); event(2, 'LoanRepaid', T0 + 31 * DAY, repaid('5'));                   // late fee
    loan(3); event(3, 'LoanPreclosedDirect', T0 + 5 * DAY, { borrower: ME });     // preclose
    loan(4); event(4, 'OffsetCompleted', T0 + 5 * DAY, { originalLoanId: '4' });  // offset
    loan(5); event(5, 'SwapToRepayExecuted', T0 + 6 * DAY);                        // own sale
    loan(6); event(6, 'PrepayCollateralSaleSettled', T0 + 6 * DAY);
    loan(7); event(7, 'LoanRefinanced', T0 + 7 * DAY, { oldLoanId: '7' });        // refinance
    loan(8, { status: 'defaulted' }); event(8, 'HFLiquidationTriggered', T0 + 8 * DAY);
    loan(9, { status: 'defaulted' }); event(9, 'LoanDefaulted', T0 + 40 * DAY, { newStatus: 2 });
    loan(10, { status: 'internal_matched' }); event(10, 'LoanStatusChanged', T0 + 9 * DAY, { from: 0, to: 5 });
    loan(11, { status: 'active' });
    const r = await read();
    expect(r.loans).toEqual({
      closed: 10,
      repaidOnTime: 3,
      repaidAfterDue: 1,
      repaidBySale: 2,
      refinanced: 1,
      liquidated: 2,
      defaulted: 1,
      unclassified: 0,
      openNow: 1,
      openedByThisAddress: 10,
      takenOverLater: 0,
    });
  });

  it('counts a refinanced loan once, as refinanced, not also as repaid', async () => {
    const { loan, event, read } = db();
    loan(1);
    event(1, 'LoanRefinanced', T0 + 3 * DAY, { oldLoanId: '1' });
    const r = await read();
    expect(r.loans.refinanced).toBe(1);
    expect(r.loans.closed).toBe(1);
  });

  it('reads timing from time: no late fee after the due date is unclassified, never on time', async () => {
    const { loan, event, read } = db();
    // Paid down to a remainder too small to carry a late fee, then repaid
    // after the original due date: without the chain's own due moment the
    // record does not guess.
    loan(1); event(1, 'LoanRepaid', T0 + 35 * DAY, repaid('0'));
    // The chain's stated late-fee start (`lateFeeFrom`) decides when present:
    // after the original due date but inside a due date moved by a pause.
    loan(2); event(2, 'LoanRepaid', T0 + 35 * DAY, repaid('0', { lateFeeFrom: String(T0 + 36 * DAY) }));
    loan(3); event(3, 'LoanRepaid', T0 + 37 * DAY, repaid('0', { lateFeeFrom: String(T0 + 36 * DAY) }));
    const r = await read();
    expect(r.loans).toMatchObject({ unclassified: 1, repaidOnTime: 1, repaidAfterDue: 1 });
  });

  it('a part repayment does not close a loan', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'active' });
    event(1, 'LoanRepaid', T0 + 2 * DAY, { ...repaid(), newStatus: 0, outstandingPrincipal: '500' });
    const r = await read();
    expect(r.loans).toMatchObject({ closed: 0, openNow: 1 });
  });

  it('a loan cured out of the fallback and then repaid is repaid', async () => {
    const { loan, event, read } = db();
    loan(1);
    event(1, 'LiquidationFallback', T0 + 8 * DAY);
    event(1, 'LoanRepaid', T0 + 9 * DAY, repaid());
    expect((await read()).loans).toMatchObject({ repaidOnTime: 1, liquidated: 0 });
  });

  it('tells the default fallback from the HF fallback by the default event in its transaction', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'defaulted' });
    event(1, 'LiquidationFallback', T0 + 40 * DAY, {}, '0xtx1');
    event(1, 'LoanFallbackPending', T0 + 40 * DAY, {}, '0xtx1');
    event(1, 'LoanDefaulted', T0 + 50 * DAY, { newStatus: 2 });
    loan(2, { status: 'defaulted' });
    event(2, 'LiquidationFallback', T0 + 8 * DAY);
    event(2, 'LoanDefaulted', T0 + 20 * DAY, { newStatus: 2 }); // the later claim
    expect((await read()).loans).toMatchObject({ defaulted: 1, liquidated: 1 });
  });

  it('counts a closed loan with no classifying event as unclassified', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'settled' });
    event(1, 'LoanInterestPaid', T0 + DAY, { asset: USDC, gross: '1' });
    const r = await read();
    expect(r.loans).toMatchObject({ closed: 1, unclassified: 1 });
  });
});

describe('Codex #3906 round 1', () => {
  it('reads a preclose in the grace as after the due date when its breakdown states a late fee', async () => {
    const { loan, event, read } = db();
    loan(1);
    event(1, 'LoanSettlementBreakdown', T0 + 32 * DAY, { lateFee: '3' }, '0xpc1');
    event(1, 'LoanPreclosedDirect', T0 + 32 * DAY, { borrower: ME }, '0xpc1');
    // No late fee stated and past the opening due date: not guessed.
    loan(2);
    event(2, 'LoanSettlementBreakdown', T0 + 32 * DAY, { lateFee: '0' }, '0xpc2');
    event(2, 'LoanPreclosedDirect', T0 + 32 * DAY, { borrower: ME }, '0xpc2');
    // An offset states no late fee: after the opening due date it is unclassified.
    loan(3); event(3, 'OffsetCompleted', T0 + 31 * DAY, { originalLoanId: '3' });
    expect((await read()).loans).toMatchObject({ repaidAfterDue: 1, unclassified: 2, repaidOnTime: 0 });
  });

  it('a fallback cured by added collateral does not decide a later default', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'defaulted' });
    event(1, 'LiquidationFallback', T0 + 8 * DAY);          // the HF route's fallback
    event(1, 'LoanCuredFromFallback', T0 + 9 * DAY);
    event(1, 'LoanDefaulted', T0 + 40 * DAY, { newStatus: 2 });
    expect((await read()).loans).toMatchObject({ defaulted: 1, liquidated: 0 });
  });

  it('a period a collateral sale paid is not a period closed with no sale', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'active' });
    event(1, 'SwapToRepayPartialExecuted', T0 + 10 * DAY, {}, '0xs1');
    event(1, 'PeriodicInterestSettled', T0 + 10 * DAY, {}, '0xs1');
    event(1, 'LoanPartiallyLiquidated', T0 + 20 * DAY, {}, '0xs2');
    event(1, 'PeriodicInterestSettled', T0 + 20 * DAY, {}, '0xs2');
    event(1, 'PeriodicInterestSettled', T0 + 30 * DAY);
    expect((await read()).interestPeriods).toEqual({ closedWithoutSale: 1, paidBySale: 2, collectedBySale: 0 });
  });

  it('reads the interest statements by their payload, since they are stored with no loan', async () => {
    const { h, loan, event, read } = db();
    loan(1, { status: 'active' });
    event(1, 'LoanInterestPaid', T0 + DAY, { asset: USDC, gross: '12' });
    const stored = h.db.prepare(`SELECT loan_id FROM activity_events WHERE kind = 'LoanInterestPaid'`).get() as Row;
    expect(stored.loan_id).toBeNull();
    expect((await read()).interestPaid).toEqual([{ asset: USDC, total: '12' }]);
  });

  it('does not guess the holder when two acquisitions share one block time', async () => {
    const { loan, event, read } = db();
    loan(1, { holders: [[OTHER, T0], [ME, T0 + 5 * DAY], [PAYER, T0 + 5 * DAY]] });
    event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());
    event(1, 'LoanInterestPaid', T0 + 10 * DAY, { asset: USDC, gross: '7' });
    for (const who of [ME, PAYER]) {
      const r = await read(who);
      expect(r.loans.closed).toBe(0);
      expect(r.interestPaid).toEqual([]);
      expect(r.leftOut.holderUnresolved).toBe(1);
    }
    // An address outside the tie is simply not the holder.
    expect((await read(OTHER)).leftOut.holderUnresolved).toBe(0);
  });
});

describe('Codex #3906 round 2', () => {
  it('counts a daily rental paid in full as completed, from its last deduction', async () => {
    const { loan, event, read } = db();
    // The position is burned after the claim, so the current holder is gone:
    // the closing time from the deduction places it instead.
    loan(1, { assetType: 1, holders: [[ME, T0]] });
    event(1, 'AutoDailyDeducted', T0 + 29 * DAY, { dayFeeDeducted: '5' }, '0xd29');
    event(1, 'AutoDailyDeducted', T0 + 30 * DAY, { dayFeeDeducted: '5' }, '0xd30');
    event(1, 'LoanStatusChanged', T0 + 30 * DAY, { from: 0, to: 1 }, '0xd30');
    const r = await read();
    expect(r.rentals).toMatchObject({ closed: 1, completed: 1, unclassified: 0 });
  });

  it('does not credit a payment to the address that took the position in the same block', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'active', holders: [[ME, T0], [OTHER, T0 + 10 * DAY]] });
    event(1, 'LoanInterestPaid', T0 + 10 * DAY, { asset: USDC, gross: '7' });
    event(1, 'LoanInterestPaid', T0 + 12 * DAY, { asset: USDC, gross: '3' });
    const theirs = await read(OTHER);
    expect(theirs.interestPaid).toEqual([{ asset: USDC, total: '3' }]);
    expect(theirs.leftOut.holderUnresolved).toBe(1);
    const mine = await read();
    expect(mine.interestPaid).toEqual([]);
    expect(mine.leftOut.holderUnresolved).toBe(1);
  });

  it('reads each address\'s events through the per-loan and payload indexes', async () => {
    const { h } = db();
    const src = readFileSync(new URL('../src/repaymentRecord.ts', import.meta.url), 'utf8');
    for (const name of ['idx_activity_chain_loan', 'idx_activity_payload_loan', 'idx_loan_participants_wallet']) {
      expect(src).toContain(`INDEXED BY ${name}`);
      expect(h.db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)).toBeTruthy();
    }
  });
});

describe('who a loan counts for', () => {
  it('counts a taken-over loan for the address that closed it, as taken over', async () => {
    const { loan, event, read } = db();
    loan(1, { holders: [[OTHER, T0], [ME, T0 + 20 * DAY]] });
    event(1, 'LoanRepaid', T0 + 25 * DAY, repaid());
    const mine = await read();
    expect(mine.loans).toMatchObject({ closed: 1, repaidOnTime: 1, takenOverLater: 1, openedByThisAddress: 0 });
    const theirs = await read(OTHER);
    expect(theirs.loans.closed).toBe(0);
  });

  it('counts a loan paid by another address for the holder', async () => {
    const { loan, event, read } = db();
    loan(1);
    event(1, 'LoanRepaid', T0 + 10 * DAY, repaid('0', { repayer: PAYER }));
    expect((await read()).loans.repaidOnTime).toBe(1);
    expect((await read(PAYER)).loans.closed).toBe(0);
  });

  it("leaves out the vehicle loan a lender's sale creates", async () => {
    const { loan, event, read } = db();
    loan(1, { saleVehicle: 1 });
    event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());
    const r = await read();
    expect(r.loans.closed).toBe(0);
    expect(r.firstLoanAt).toBeNull();
  });
});

describe('periods, interest and rentals', () => {
  it('attributes periods and interest to the holder at the time', async () => {
    const { loan, event, read } = db();
    loan(1, { status: 'active', holders: [[OTHER, T0], [ME, T0 + 15 * DAY]] });
    event(1, 'PeriodicInterestSettled', T0 + 10 * DAY);       // other's
    event(1, 'LoanInterestPaid', T0 + 10 * DAY, { asset: USDC, gross: '40' });
    event(1, 'PeriodicInterestSettled', T0 + 20 * DAY);       // mine
    event(1, 'PeriodicInterestAutoLiquidated', T0 + 50 * DAY);
    event(1, 'LoanInterestPaid', T0 + 20 * DAY, { asset: USDC, gross: '100' });
    event(1, 'LoanInterestUndelivered', T0 + 21 * DAY, { asset: USDC, gross: '30' });
    const r = await read();
    expect(r.interestPeriods).toEqual({ closedWithoutSale: 1, paidBySale: 0, collectedBySale: 1 });
    expect(r.interestPaid).toEqual([{ asset: USDC, total: '70' }]);
    expect(r.loans.openNow).toBe(1);
    expect(r.firstLoanAt).toBe(T0 + 15 * DAY);
  });

  it('counts rentals apart from loans', async () => {
    const { loan, event, read } = db();
    loan(1, { assetType: 1 }); event(1, 'LoanRepaid', T0 + 5 * DAY, repaid());
    loan(2, { assetType: 2, status: 'defaulted' }); event(2, 'LoanDefaulted', T0 + 40 * DAY, { newStatus: 2 });
    loan(3, { assetType: 1, status: 'active' });
    const r = await read();
    expect(r.rentals).toEqual({ closed: 2, completed: 1, endedByDefault: 1, unclassified: 0, openNow: 1 });
    expect(r.loans.closed).toBe(0);
  });
});

describe('what every answer says', () => {
  it('answers an address with no history with an empty record and the statements', async () => {
    const { read } = db();
    const r = await read('0x' + '99'.repeat(20));
    expect(r.version).toBe(RECORD_VERSION);
    expect(r.asOf).toEqual({ block: 9_999, indexedAt: T0 + 100 * DAY });
    expect(r.historyBegins).toEqual({ block: 1 });
    expect(r.loans.closed).toBe(0);
    expect(r.firstLoanAt).toBeNull();
    expect(r.statements).toEqual([...RECORD_STATEMENTS]);
    expect(r.feesPaid.stated).toBe(false);
    expect(r.excludes.length).toBeGreaterThan(0);
  });

  it('carries no combined number, rank or colour, and none of the words the design rules out', async () => {
    const { loan, event, read } = db();
    loan(1); event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());
    const { statements: _required, ...rest } = await read();
    const text = JSON.stringify(rest).toLowerCase();
    for (const word of ['score', 'credit', 'rating', 'trust', 'reputation', 'grade', 'worthiness', 'rank', 'colour', 'color']) {
      expect(text).not.toContain(word);
    }
    const src = readFileSync(new URL('../src/repaymentRecord.ts', import.meta.url), 'utf8');
    const strings = [...src.matchAll(/'([^'\n]*)'/g)].map((m) => m[1].toLowerCase()).join(' ');
    for (const word of ['credit', 'rating', 'reputation', 'worthiness']) expect(strings).not.toContain(word);
  });

  it('refuses a malformed address', async () => {
    const { env } = db();
    const res = await handleRepaymentRecord(new Request(`https://x/r?chainId=${CHAIN}`), env, '0x12');
    expect(res.status).toBe(400);
  });
});

describe('the counting rule for public figures (#3879)', () => {
  it('leaves out a loan whose opening event named this address on both sides, and counts it apart', async () => {
    const { loan, event, read } = db();
    loan(1); event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());
    loan(2, { opening: [ME, ME] }); event(2, 'LoanRepaid', T0 + 10 * DAY, repaid());
    event(2, 'LoanInterestPaid', T0 + 10 * DAY, { asset: USDC, gross: '9' });
    loan(3, { status: 'active', opening: [ME, ME] });
    const r = await read();
    expect(r.loans).toMatchObject({ closed: 1, repaidOnTime: 1, openNow: 0 });
    expect(r.interestPaid).toEqual([]);
    expect(r.leftOut).toEqual({ oneAddress: 2, openingPartiesUnknown: 0, holderUnresolved: 0 });
  });

  it('leaves out a loan whose opening parties are unknown, never assuming two', async () => {
    const { loan, event, read } = db();
    loan(1, { opening: null }); event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());
    const r = await read();
    expect(r.loans.closed).toBe(0);
    expect(r.leftOut).toEqual({ oneAddress: 0, openingPartiesUnknown: 1, holderUnresolved: 0 });
  });

  it('tests the opening parties only: a loan taken over by its lender stays counted', async () => {
    // Opened between two addresses; the lender later takes over the borrower
    // position and closes it. A later holder change moves a loan neither in
    // nor out, so the closing holder's record counts it.
    const { loan, event, read } = db();
    loan(1, { holders: [[ME, T0], [LENDER, T0 + DAY]] });
    event(1, 'LoanRepaid', T0 + 10 * DAY, repaid());
    const r = await read(LENDER);
    expect(r.loans).toMatchObject({ closed: 1, takenOverLater: 1 });
    expect(r.leftOut).toEqual({ oneAddress: 0, openingPartiesUnknown: 0, holderUnresolved: 0 });
  });
});
