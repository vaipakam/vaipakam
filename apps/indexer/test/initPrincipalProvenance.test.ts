/**
 * Migration 0056 (#2461) — flags the `init_principal` values the chain's
 * `LoanInitiated` does not back, WITHOUT changing them: the rate candles keep
 * reading the frozen value, and the loan routes withhold a flagged one from
 * the app. Runs on the real migrated schema up to 0055, then applies 0056 to
 * seeded rows exactly as wrangler would.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleLoansByHistoricalParticipant } from '../src/loanRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const DIR = new URL('../migrations/', import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const TARGET = '0056_init_principal_unbacked.sql';
const BEFORE = FILES.filter((f) => f < TARGET).map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const MIGRATION = readFileSync(new URL(TARGET, DIR), 'utf8');

function harness() {
  const h = createSqliteD1(BEFORE);
  const loan = (loanId: number, principal: string, init: string | null) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at, init_principal)
         VALUES (84532, ?, 1, 'active', '0xa', '0xb', ?, '1', 0, 0, '0xc', '0xd',
           30, '0', '0', '1', '2', '0xa', '0xb', 500, 0, 0, 0, 0, ?)`,
      )
      .run(loanId, principal, init);
  const initiated = (loanId: number, principal: string, logIndex = 0) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
         VALUES (84532, ?, ?, '0x1', 'LoanInitiated', ?, ?, 0)`,
      )
      .run(loanId, logIndex, loanId, JSON.stringify({ loanId: String(loanId), principal }));
  const init = (loanId: number) =>
    (h.db.prepare(`SELECT init_principal AS v FROM loans WHERE loan_id = ?`).get(loanId) as { v: string | null }).v;
  const unbacked = (loanId: number) =>
    (h.db.prepare(`SELECT init_principal_unbacked AS v FROM loans WHERE loan_id = ?`).get(loanId) as { v: number }).v;
  return { ...h, loan, initiated, init, unbacked };
}

describe('0056 — init_principal flagged when the LoanInitiated ledger does not back it', () => {
  it('leaves a value the ledger confirms unflagged, even after the live principal moved', () => {
    const h = harness();
    h.loan(1, '0', '1000'); // internally matched: live 0, initiated 1000
    h.initiated(1, '1000');
    h.db.exec(MIGRATION);
    expect([h.init(1), h.unbacked(1)]).toEqual(['1000', 0]);
  });

  it('flags a fallback copy the ledger does not back, and keeps the frozen value for the candles', () => {
    const h = harness();
    h.loan(2, '400', '400'); // 0032 fallback copied the partly repaid remainder
    h.db.exec(MIGRATION);
    expect([h.init(2), h.unbacked(2)]).toEqual(['400', 1]);
    // Even after a later mutation, the candle figure stays frozen.
    h.db.prepare(`UPDATE loans SET principal = '0' WHERE loan_id = 2`).run();
    const c = h.db
      .prepare(`SELECT COALESCE(init_principal, principal) AS p FROM loans WHERE loan_id = 2`)
      .get() as { p: string };
    expect(c.p).toBe('400');
  });

  it('flags a value that disagrees with the ledger', () => {
    const h = harness();
    h.loan(3, '400', '400');
    h.initiated(3, '1000');
    h.db.exec(MIGRATION);
    expect(h.unbacked(3)).toBe(1);
  });

  it('leaves NULL unflagged and matches only this chain and this loan', () => {
    const h = harness();
    h.loan(4, '5', null);
    h.loan(6, '9', '9');
    h.initiated(7, '9'); // another loan's event with the same amount
    h.db.exec(MIGRATION);
    expect(h.unbacked(4)).toBe(0);
    expect(h.unbacked(6)).toBe(1);
  });

  it('a row written after the migration defaults to unflagged', () => {
    const h = harness();
    h.db.exec(MIGRATION);
    h.loan(8, '50', '50');
    expect(h.unbacked(8)).toBe(0);
  });

  it('the loan routes withhold a flagged value and serve a backed one', async () => {
    const h = harness();
    h.loan(1, '0', '1000');
    h.initiated(1, '1000');
    h.loan(2, '400', '400');
    h.db.exec(MIGRATION);
    for (const id of [1, 2]) {
      h.db
        .prepare(`INSERT INTO loan_participants (chain_id, loan_id, wallet, role, from_at) VALUES (84532, ?, '0x000000000000000000000000000000000000000a', 'lender', ?)`)
        .run(id, 100 + id);
    }
    const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    const res = await handleLoansByHistoricalParticipant(
      new Request('https://idx/loans/by-participant?chainId=84532&wallet=0x000000000000000000000000000000000000000a&scope=all'),
      env,
    );
    const body = (await res.json()) as { loans: Array<{ loanId: number; initPrincipal: string | null }> };
    const byId = new Map(body.loans.map((l) => [l.loanId, l.initPrincipal]));
    expect(byId.get(1)).toBe('1000');
    expect(byId.get(2)).toBeNull();
  });
});
