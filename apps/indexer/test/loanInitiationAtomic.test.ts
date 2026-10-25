/**
 * #2221 (Codex #2836 r6) — a `LoanInitiated` row and its initiation
 * participants are written together or not at all.
 *
 * A scan can now stop inside a block, and the next pass replays it. The
 * participant seeds may be written only by the pass that writes the row
 * (Codex #1139 round-5 P2: a replay would backdate a later holder), so a stop
 * between the row and its seeds used to leave a loan no replay could seed.
 * The row and the seeds now go in one batch, refused or committed whole.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import type { Env } from '../src/env';
import { processLoanLogs } from '../src/chainIndexer';
import { createSqliteD1 } from './helpers/sqliteD1';

const DIR = new URL('../migrations/', import.meta.url);
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8'));

const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000000d1' as const;
const LENDER = '0x000000000000000000000000000000000000000a';
const BORROWER = '0x000000000000000000000000000000000000000b';

/** A bare `LoanInitiated` with no companion and a client that cannot read the
 *  loan back: the stub path, whose seeds come from the event parties. */
const initiated = (loanId: number) => ({
  eventName: 'LoanInitiated',
  args: { loanId: BigInt(loanId), offerId: 1n, lender: LENDER, borrower: BORROWER, principal: 1000n, collateralAmount: 1500n },
  blockNumber: 100n,
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: 0,
});

const client = {
  readContract: vi.fn(async () => {
    throw new Error('no read in this fixture');
  }),
} as unknown as PublicClient;

function harness() {
  const h = createSqliteD1(migrations);
  let refuseNextBatch = false;
  const batch = h.d1.batch.bind(h.d1);
  const db = new Proxy(h.d1, {
    get(target, prop, receiver) {
      if (prop === 'batch') {
        return async (statements: unknown[]) => {
          if (refuseNextBatch) {
            refuseNextBatch = false;
            throw new Error('refused: the invocation has no allowance left for this batch');
          }
          return batch(statements as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const env = { DB: db } as unknown as Env;
  const run = (loanId: number) =>
    processLoanLogs([initiated(loanId)] as never, env, CHAIN, new Map([[100n, 1_700_000_000]]), client, DIAMOND);
  const loans = (loanId: number) =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM loans WHERE chain_id = ? AND loan_id = ?').get(CHAIN, loanId) as { n: number }).n;
  const participants = (loanId: number) =>
    h.db
      .prepare('SELECT wallet, role FROM loan_participants WHERE chain_id = ? AND loan_id = ? ORDER BY role')
      .all(CHAIN, loanId) as { wallet: string; role: string }[];
  return { h, run, loans, participants, refuse: () => (refuseNextBatch = true) };
}

describe('LoanInitiated writes its row and its participants as one unit', () => {
  it('a refused write leaves neither, and the replay writes both', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = harness();
    t.refuse();
    await expect(t.run(7)).rejects.toThrow(/refused/);
    expect(t.loans(7)).toBe(0);
    expect(t.participants(7)).toEqual([]);

    const r = await t.run(7);
    expect(r.newLoans).toBe(1);
    expect(t.loans(7)).toBe(1);
    expect(t.participants(7)).toEqual([
      { wallet: BORROWER, role: 'borrower' },
      { wallet: LENDER, role: 'lender' },
    ]);
  });

  it('a replay of a committed row seeds nobody (no backdated holder)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = harness();
    await t.run(8);
    // The pass that wrote the row seeded it; take the seeds away to see that
    // the replay does not write them again.
    t.h.db.prepare('DELETE FROM loan_participants WHERE chain_id = ? AND loan_id = ?').run(CHAIN, 8);
    const r = await t.run(8);
    expect(r.newLoans).toBe(0);
    expect(t.participants(8)).toEqual([]);
  });
});
