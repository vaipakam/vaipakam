/**
 * HF-liquidation terminal-status projection (#1293).
 *
 * `HFLiquidationTriggered` (full + split terminal) and `LiquidationDiscounted`
 * terminalize a loan Active→Defaulted on-chain via
 * `EncumbranceMutateFacet.terminalize` and emit ONLY their own event — no
 * `LoanDefaulted` companion. Before this fix the indexer had no branch for
 * them, so an HF-liquidated loan was stranded `active` in D1 forever. These
 * tests drive `processLoanLogs` directly (the HF branch flips status off the
 * event alone — no RPC) and assert the projection + its idempotency.
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
// The HF branches never call the client; a stub that throws surfaces any
// unexpected RPC use as a loud test failure.
const stubClient = {
  readContract: async () => {
    throw new Error('unexpected RPC in an HF-only scan');
  },
} as never;

function seedLoan(h: SqliteD1, loanId: number, status: string) {
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
         500, 0, 0, 0, 0)`,
    )
    .run(CHAIN, loanId, status);
}

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

const hfLog = (
  eventName: string,
  loanId: number,
  block = 100,
  logIndex = 0,
) => ({
  eventName,
  args: {
    loanId: BigInt(loanId),
    liquidator: '0x00000000000000000000000000000000000000ee',
    proceeds: 0n,
  },
  blockNumber: BigInt(block),
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex,
});

const statusOf = (h: SqliteD1, loanId: number) =>
  (
    h.db
      .prepare('SELECT status FROM loans WHERE chain_id = ? AND loan_id = ?')
      .get(CHAIN, loanId) as { status: string }
  ).status;

describe('processLoanLogs — HF-liquidation status projection (#1293)', () => {
  const run = (h: SqliteD1, logs: ReturnType<typeof hfLog>[]) =>
    processLoanLogs(
      logs,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500]]),
      stubClient,
      DIAMOND,
    );

  it('flips an active loan to defaulted on HFLiquidationTriggered', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 7);
    const res = await run(h, [hfLog('HFLiquidationTriggered', 7)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 7)).toBe('defaulted');
  });

  it('flips an active loan to defaulted on LiquidationDiscounted', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 8);
    const res = await run(h, [hfLog('LiquidationDiscounted', 8)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 8)).toBe('defaulted');
  });

  it('is idempotent on re-scan (guarded on status = active)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 9);
    await run(h, [hfLog('HFLiquidationTriggered', 9)]);
    const res2 = await run(h, [hfLog('HFLiquidationTriggered', 9)]);
    expect(res2.statusUpdates).toBe(0); // already terminal — no-op
    expect(statusOf(h, 9)).toBe('defaulted');
  });
});

/**
 * #1782 — `LoanStatusChanged`, emitted by `LibLifecycle.transition` for EVERY
 * status edge, is the general safety net behind the specific handlers above.
 * These assert exactly what the handler claims: it flips a stranded row to the
 * terminal status the chain reports, skips the non-terminal edges rather than
 * overwriting a status with a guess, promotes a rescued `fallback_pending` row,
 * and leaves an ALREADY-terminal row alone (Repaid→Settled belongs to the claim
 * handlers, which know whether both sides have claimed).
 *
 * Enum slots are append-only and stable: Active=0, Repaid=1, Defaulted=2,
 * Settled=3, FallbackPending=4, InternalMatched=5.
 */
const statusChangedLog = (
  loanId: number,
  from: number,
  to: number,
  block = 100,
  logIndex = 0,
) => ({
  eventName: 'LoanStatusChanged',
  args: { loanId: BigInt(loanId), from, to },
  blockNumber: BigInt(block),
  transactionHash: `0x${'cd'.repeat(32)}`,
  logIndex,
});

describe('processLoanLogs — LoanStatusChanged safety net (#1782)', () => {
  const run = (h: SqliteD1, logs: ReturnType<typeof statusChangedLog>[]) =>
    processLoanLogs(
      logs,
      { DB: h.d1 } as unknown as Env,
      CHAIN,
      new Map([[100n, 500]]),
      stubClient,
      DIAMOND,
    );

  it.each([
    ['Repaid', 1, 'repaid'],
    ['Defaulted', 2, 'defaulted'],
    ['Settled', 3, 'settled'],
    ['InternalMatched', 5, 'internal_matched'],
  ])('flips an active loan on a terminal edge to %s', async (_n, to, want) => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 20);
    const res = await run(h, [statusChangedLog(20, 0, to as number)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 20)).toBe(want);
  });

  it.each([
    ['Active (a FallbackPending cure)', 0],
    ['FallbackPending', 4],
  ])('does NOT overwrite status on a non-terminal edge to %s', async (_n, to) => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 21);
    const res = await run(h, [statusChangedLog(21, 1, to as number)]);
    expect(res.statusUpdates).toBe(0);
    expect(statusOf(h, 21)).toBe('active');
  });

  it('maps an unknown future enum value to no status write', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 22);
    const res = await run(h, [statusChangedLog(22, 0, 99)]);
    expect(res.statusUpdates).toBe(0);
    expect(statusOf(h, 22)).toBe('active');
  });

  it('promotes a rescued fallback_pending row', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 23, 'fallback_pending');
    const res = await run(h, [statusChangedLog(23, 4, 1)]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 23)).toBe('repaid');
  });

  it('leaves an ALREADY-terminal row alone (Repaid -> Settled)', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedLoan(h, 24, 'repaid');
    const res = await run(h, [statusChangedLog(24, 1, 3)]);
    expect(res.statusUpdates).toBe(0);
    expect(statusOf(h, 24)).toBe('repaid'); // the claim handlers own this edge
  });

  // The skip cases above cannot discriminate on their own: "nothing happened"
  // is also what you get with no handler at all. This one pairs a skipped edge
  // with a flipped one in the SAME scan, so exactly-one update proves the
  // handler ran AND chose correctly.
  it('skips the non-terminal edge while flipping the terminal one in one scan', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 26); // gets a FallbackPending edge — must stay active
    seedActiveLoan(h, 27); // gets a Repaid edge — must flip
    const res = await run(h, [
      statusChangedLog(26, 0, 4, 100, 0),
      statusChangedLog(27, 0, 1, 100, 1),
    ]);
    expect(res.statusUpdates).toBe(1);
    expect(statusOf(h, 26)).toBe('active');
    expect(statusOf(h, 27)).toBe('repaid');
  });

  it('is idempotent on re-scan', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    seedActiveLoan(h, 25);
    await run(h, [statusChangedLog(25, 0, 1)]);
    const res2 = await run(h, [statusChangedLog(25, 0, 1)]);
    expect(res2.statusUpdates).toBe(0);
    expect(statusOf(h, 25)).toBe('repaid');
  });
});
