/**
 * Migration 0056 (#2461) — `init_principal` keeps only what the chain's
 * `LoanInitiated` substantiates. 0032's fallback copied the mutable
 * principal into rows the ledger could not back; those become NULL (the
 * documented "unknown"), while rows the ledger confirms are untouched.
 * Runs on the real migrated schema up to 0055, then applies 0056 to seeded
 * rows exactly as wrangler would.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';

const DIR = new URL('../migrations/', import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const TARGET = '0056_init_principal_unverified_to_null.sql';
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
  return { ...h, loan, initiated, init };
}

describe('0056 — init_principal substantiated by the LoanInitiated ledger', () => {
  it('keeps a value the ledger confirms, even after the live principal moved', () => {
    const h = harness();
    h.loan(1, '0', '1000'); // internally matched: live 0, initiated 1000
    h.initiated(1, '1000');
    h.db.exec(MIGRATION);
    expect(h.init(1)).toBe('1000');
  });

  it('withdraws a fallback copy the ledger does not back', () => {
    const h = harness();
    h.loan(2, '400', '400'); // 0032 fallback copied the partly repaid remainder
    h.db.exec(MIGRATION);
    expect(h.init(2)).toBeNull();
  });

  it('withdraws a value that disagrees with the ledger', () => {
    const h = harness();
    h.loan(3, '400', '400');
    h.initiated(3, '1000');
    h.db.exec(MIGRATION);
    expect(h.init(3)).toBeNull();
  });

  it('leaves NULL alone and is idempotent', () => {
    const h = harness();
    h.loan(4, '5', null);
    h.loan(5, '0', '7');
    h.initiated(5, '7');
    h.db.exec(MIGRATION);
    h.db.exec(MIGRATION);
    expect(h.init(4)).toBeNull();
    expect(h.init(5)).toBe('7');
  });

  it('matches only this chain and this loan', () => {
    const h = harness();
    h.loan(6, '9', '9');
    h.initiated(7, '9'); // another loan's event with the same amount
    h.db.exec(MIGRATION);
    expect(h.init(6)).toBeNull();
  });
});
