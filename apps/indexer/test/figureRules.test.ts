/**
 * #3879 — the counting rule's two forms agree. The rate figures apply
 * rule 2 in SQL (`oneAddressLoanSql` / `partiesUnknownLoanSql` /
 * `leftOutOfRatesSql` / `ratesEligibleSql`); the repayment record (#3778)
 * applies it in code (`openingPartiesOf`) because its reads stay static
 * text. This test runs the SQL against the real migrated schema and holds
 * every loan row's answer equal to the code's, so the two cannot drift.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  leftOutOfRatesSql,
  oneAddressLoanSql,
  openingPartiesOf,
  partiesUnknownLoanSql,
  ratesEligibleSql,
} from '../src/figureRules';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const A = '0x' + '11'.repeat(20);
const B = '0x' + '22'.repeat(20);

/** Every shape the opening parties can take on a loan row. */
const CASES: Array<[string | null, string | null]> = [
  [A, B],
  [A, A],
  [null, B],
  [A, null],
  [null, null],
];

describe('the counting rule in SQL and in code (#3879)', () => {
  it('gives the same answer for every shape of opening parties', () => {
    const { db } = createSqliteD1(MIGRATIONS);
    CASES.forEach(([lender, borrower], i) => {
      db.prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, lender, borrower, principal, collateral_amount,
           start_block, start_at, updated_at, init_lender, init_borrower)
         VALUES (1, ?, ?, ?, ?, '1', '1', 1, 1, 1, ?, ?)`,
      ).run(i + 1, i + 1, A, B, lender, borrower);
    });
    const rows = db
      .prepare(
        `SELECT l.loan_id AS id, l.init_lender AS il, l.init_borrower AS ib,
                ${oneAddressLoanSql('l')} AS one,
                ${partiesUnknownLoanSql('l')} AS unknown,
                ${leftOutOfRatesSql('l')} AS leftOut,
                (${ratesEligibleSql('l')}) AS eligible
           FROM loans l ORDER BY l.loan_id`,
      )
      .all() as Array<{ id: number; il: string | null; ib: string | null; one: number; unknown: number; leftOut: number; eligible: number | null }>;
    expect(rows).toHaveLength(CASES.length);
    for (const r of rows) {
      const parties = openingPartiesOf(r.il, r.ib);
      expect(Boolean(r.one), `loan ${r.id} one`).toBe(parties === 'one');
      expect(Boolean(r.unknown), `loan ${r.id} unknown`).toBe(parties === 'unknown');
      expect(Boolean(r.leftOut), `loan ${r.id} leftOut`).toBe(parties !== 'two');
      // NULL-safe: the eligible terms are plain AND, so an unknown party
      // makes the whole term false (0), never NULL, for each case above.
      expect(Boolean(r.eligible), `loan ${r.id} eligible`).toBe(parties === 'two');
    }
    expect(rows.map((r) => openingPartiesOf(r.il, r.ib))).toEqual(['two', 'one', 'unknown', 'unknown', 'unknown']);
  });

  it('refuses an alias that is not a plain identifier', () => {
    for (const f of [oneAddressLoanSql, partiesUnknownLoanSql, leftOutOfRatesSql, ratesEligibleSql]) {
      expect(() => f('l; DROP TABLE loans')).toThrow('bad alias');
    }
  });
});
