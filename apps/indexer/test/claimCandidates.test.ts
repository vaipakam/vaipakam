/**
 * RPC read-diet PR C — GET /claim-candidates/:address, pinned.
 * The route is an ADDITIVE hint (design §4.2.3): the connected app may
 * union these candidates into its own discovery and use the ordering,
 * but a wrong row here can only cost one client probe — so the pins
 * are about shape, filtering, and ordering, not about authority.
 */
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleClaimCandidates } from '../src/loanRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

/** Trimmed loans DDL — only the columns the route touches (the full
 *  table accretes across many migrations; the SQL under test names
 *  its columns explicitly). */
const LOANS_DDL = `CREATE TABLE loans (
  chain_id INTEGER NOT NULL,
  loan_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  lender_current_owner TEXT,
  borrower_current_owner TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, loan_id)
)`;

const ME = '0x00000000000000000000000000000000000000aa';
const OTHER = '0x00000000000000000000000000000000000000bb';
const BURNED = '0x0000000000000000000000000000000000000000';

function makeHarness() {
  const { db, d1 } = createSqliteD1([LOANS_DDL]);
  const env = { DB: d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const seed = (
    loanId: number,
    status: string,
    lenderOwner: string | null,
    borrowerOwner: string | null,
    updatedAt: number,
  ) =>
    db
      .prepare(`INSERT INTO loans VALUES (84532, ?, ?, ?, ?, ?)`)
      .run(loanId, status, lenderOwner, borrowerOwner, updatedAt);
  const call = async (addr = ME, chainId = 84532) => {
    const res = await handleClaimCandidates(
      new Request(`https://idx/claim-candidates/${addr}?chainId=${chainId}`),
      env,
      addr,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { seed, call };
}

describe('GET /claim-candidates/:address', () => {
  it('returns one flat entry per HELD side, most recently touched first', async () => {
    const h = makeHarness();
    h.seed(1, 'repaid', ME, OTHER, 100);
    h.seed(2, 'defaulted', OTHER, ME, 300);
    h.seed(3, 'liquidated', ME, ME, 200); // wallet holds BOTH sides
    const { status, body } = await h.call();
    expect(status).toBe(200);
    expect(body.candidates).toEqual([
      { loanId: 2, role: 'borrower', status: 'defaulted', updatedAt: 300 },
      { loanId: 3, role: 'lender', status: 'liquidated', updatedAt: 200 },
      { loanId: 3, role: 'borrower', status: 'liquidated', updatedAt: 200 },
      { loanId: 1, role: 'lender', status: 'repaid', updatedAt: 100 },
    ]);
  });

  it('excludes non-terminal statuses and claimed (burned → 0x0) sides', async () => {
    const h = makeHarness();
    h.seed(1, 'active', ME, ME, 100); // not terminal
    h.seed(2, 'settled', ME, ME, 100); // both sides consumed
    h.seed(3, 'repaid', BURNED, ME, 100); // lender side claimed
    const { body } = await h.call();
    expect(body.candidates).toEqual([
      { loanId: 3, role: 'borrower', status: 'repaid', updatedAt: 100 },
    ]);
  });

  it('rejects a malformed address and an unconfigured chain', async () => {
    const h = makeHarness();
    expect((await h.call('0xnope')).status).toBe(400);
    expect((await h.call(ME, 424242)).status).toBe(503);
  });

  it('returns an empty list for a wallet with no terminal holdings', async () => {
    const h = makeHarness();
    h.seed(1, 'repaid', OTHER, OTHER, 100);
    const { status, body } = await h.call();
    expect(status).toBe(200);
    expect(body.candidates).toEqual([]);
  });
});
