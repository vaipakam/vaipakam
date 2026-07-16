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
