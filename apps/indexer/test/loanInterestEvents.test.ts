/**
 * #3755 / #3768 — the indexer keeps every LoanInterestPaid and
 * LoanInterestUndelivered statement per loan, once per log, and the figure
 * read from them is payments less take-backs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { processLoanLogs } from '../src/chainIndexer';
import { interestPaidByLoan, type LoanInterestRow } from '../src/loanInterest';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000d1a90' as never;
const ASSET = '0x00000000000000000000000000000000000000Aa';
const stubClient = {
  readContract: async () => {
    throw new Error('unexpected RPC');
  },
} as never;

const log = (eventName: string, block: bigint, logIndex: number, loanId: bigint, gross: bigint) => ({
  eventName,
  blockNumber: block,
  logIndex,
  transactionHash: `0x${'ab'.repeat(32)}`,
  args: { loanId, asset: ASSET, gross },
});

describe('loan interest statements', () => {
  it('stores each statement once and reads payments less take-backs', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const env = { DB: h.d1 } as unknown as Env;
    const times = new Map<bigint, number>([
      [10n, 1_000],
      [11n, 1_100],
    ]);
    const big = 2n ** 70n;
    const logs = [
      log('LoanInterestPaid', 10n, 0, 4n, big),
      log('LoanInterestUndelivered', 10n, 1, 4n, 5n),
      log('LoanInterestPaid', 11n, 0, 4n, 5n),
      log('LoanInterestPaid', 11n, 1, 9n, 7n),
    ];
    await processLoanLogs(logs as never, env, CHAIN, times, stubClient, DIAMOND);
    // A re-read of the same range adds nothing.
    await processLoanLogs(logs as never, env, CHAIN, times, stubClient, DIAMOND);

    const rows = h.db
      .prepare('SELECT loan_id, kind, asset, gross, block_at FROM loan_interest_events WHERE chain_id = ? ORDER BY block_number, log_index')
      .all(CHAIN) as unknown as (LoanInterestRow & { asset: string })[];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ loan_id: 4, kind: 'paid', asset: ASSET.toLowerCase(), gross: big.toString(), block_at: 1_000 });
    expect(rows[1]).toMatchObject({ kind: 'undelivered', gross: '5' });

    const paid = interestPaidByLoan(rows, 1_100);
    expect(paid.get(4)).toBe(big);
    expect(paid.get(9)).toBe(7n);
    expect(interestPaidByLoan(rows, 1_000).get(4)).toBe(big - 5n);
  });

  it('refuses a statement whose block time is not in hand', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const env = { DB: h.d1 } as unknown as Env;
    await expect(
      processLoanLogs([log('LoanInterestPaid', 12n, 0, 1n, 1n)] as never, env, CHAIN, new Map(), stubClient, DIAMOND),
    ).rejects.toThrow();
    const n = (h.db.prepare('SELECT COUNT(*) AS n FROM loan_interest_events').get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
