/**
 * Migration 0058 + `reverifyInitTerms` (#2467) — the initiation rate and
 * duration are served only when the chain's own `LoanInitiatedDetails`
 * backs both; the stored values are never changed (the candles keep them).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { reverifyInitTerms } from '../src/chainIndexer';
import { handleLoansByHistoricalParticipant } from '../src/loanRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const DIR = new URL('../migrations/', import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const TARGET = '0058_init_terms_unbacked.sql';
const BEFORE = FILES.filter((f) => f < TARGET).map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const MIGRATION = readFileSync(new URL(TARGET, DIR), 'utf8');
const ME = '0x000000000000000000000000000000000000000a';

function harness() {
  const h = createSqliteD1(BEFORE);
  const loan = (id: number, live: [number, number], init: [number | null, number | null]) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at, init_rate_bps, init_duration_days)
         VALUES (84532, ?, 1, 'active', ?, '0xb', '100', '1', 0, 0, '0xc', '0xd',
           ?, '0', '0', '1', '2', ?, '0xb', ?, 0, 0, 0, 0, ?, ?)`,
      )
      .run(id, ME, live[1], ME, live[0], init[0], init[1]);
  const details = (id: number, rate: number, days: number) =>
    h.db
      .prepare(
        `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, args_json, block_at)
         VALUES (84532, ?, 1, '0x1', 'LoanInitiatedDetails', NULL, ?, 0)`,
      )
      .run(id, JSON.stringify({ loanId: String(id), details: { interestRateBps: String(rate), durationDays: String(days) } }));
  const flag = (id: number) =>
    (h.db.prepare('SELECT init_terms_unbacked AS f, init_rate_bps AS r, init_duration_days AS d FROM loans WHERE loan_id = ?').get(id) as {
      f: number;
      r: number | null;
      d: number | null;
    });
  return { ...h, loan, details, flag };
}

describe('0058 — initiation terms backed by LoanInitiatedDetails', () => {
  it('backs a snapshot the ledger confirms, even after an extension moved the live terms', () => {
    const h = harness();
    h.loan(1, [900, 60], [500, 30]); // extended: live 9% / 60d, executed at 5% / 30d
    h.details(1, 500, 30);
    h.db.exec(MIGRATION);
    expect(h.flag(1)).toEqual({ f: 0, r: 500, d: 30 });
  });

  it('withholds — without changing — a copy of extended terms the ledger does not carry', () => {
    const h = harness();
    h.loan(2, [900, 60], [900, 60]); // 0032 fallback copied the extended terms
    h.details(2, 500, 30);
    h.loan(3, [500, 30], [500, 30]); // no ledger row at all
    h.db.exec(MIGRATION);
    expect(h.flag(2)).toEqual({ f: 1, r: 900, d: 60 });
    expect(h.flag(3).f).toBe(1);
  });

  it('needs BOTH values to match', () => {
    const h = harness();
    h.loan(4, [500, 60], [500, 60]);
    h.details(4, 500, 30); // rate matches, duration does not
    h.db.exec(MIGRATION);
    expect(h.flag(4).f).toBe(1);
  });

  it('reverifyInitTerms backs a later row once its details land, never an extended one', async () => {
    const h = harness();
    h.db.exec(MIGRATION);
    h.loan(5, [500, 30], [500, 30]); // written after the migration, default withheld
    h.loan(6, [900, 60], [900, 60]); // stamped from a post-extension read
    h.details(6, 500, 30);
    const env = { DB: h.d1 } as unknown as Env;
    expect([h.flag(5).f, h.flag(6).f]).toEqual([1, 1]);
    expect(await reverifyInitTerms(env, 84532)).toBe(0);
    h.details(5, 500, 30);
    expect(await reverifyInitTerms(env, 84532)).toBe(1);
    expect([h.flag(5).f, h.flag(6).f]).toEqual([0, 1]);
  });

  it('the loan routes serve backed terms and null — never the live terms — otherwise', async () => {
    const h = harness();
    h.loan(7, [900, 60], [500, 30]);
    h.details(7, 500, 30);
    h.loan(8, [900, 60], [900, 60]);
    h.db.exec(MIGRATION);
    for (const id of [7, 8]) {
      h.db.prepare(`INSERT INTO loan_participants (chain_id, loan_id, wallet, role, from_at) VALUES (84532, ?, ?, 'lender', ?)`).run(id, ME, 100 + id);
    }
    const res = await handleLoansByHistoricalParticipant(
      new Request(`https://idx/loans/by-participant?chainId=84532&wallet=${ME}&scope=all`),
      { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env,
    );
    const body = (await res.json()) as {
      loans: Array<{ loanId: number; interestRateBps: number; initRateBps: number | null; initDurationDays: number | null }>;
    };
    const byId = new Map(body.loans.map((l) => [l.loanId, l]));
    expect(byId.get(7)).toMatchObject({ interestRateBps: 900, initRateBps: 500, initDurationDays: 30 });
    expect(byId.get(8)).toMatchObject({ interestRateBps: 900, initRateBps: null, initDurationDays: null });
  });
});

describe('reverifyInitTerms — cost (#2478 r1)', () => {
  it('probes the details index per flagged loan rather than scanning the chain’s details rows', async () => {
    // A loan whose terms the ledger never carries stays flagged, so this runs
    // on every tick: the lookup must stay one index probe as the ledger grows.
    const h = harness();
    h.db.exec(MIGRATION);
    const seen: string[] = [];
    const d1 = h.d1 as { prepare(sql: string): unknown };
    const env = {
      DB: {
        prepare: (sql: string) => {
          seen.push(sql);
          return d1.prepare(sql);
        },
      },
    } as unknown as Env;
    await reverifyInitTerms(env, 84532);
    expect(seen).toHaveLength(1);
    const plan = (h.db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(84532) as { detail: string }[])
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(/USING INDEX idx_activity_initiated_details_loan/);
  });
});
