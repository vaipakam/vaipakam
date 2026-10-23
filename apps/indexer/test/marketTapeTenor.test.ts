/**
 * #1142 — the market-scoped tape (`/loans/recent` with a tenor) files a
 * loan under the tenor it EXECUTED in, the key the candles use, so an
 * extension cannot move a past fill into another market's tape. Every row
 * carries that key as `marketDurationDays`, beside (never instead of) the
 * backed `initDurationDays` and the live `durationDays`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleLoansRecent } from '../src/loanRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const DIR = new URL('../migrations/', import.meta.url);
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const LEND = '0x000000000000000000000000000000000000000c';
const COLL = '0x000000000000000000000000000000000000000d';

function harness() {
  const h = createSqliteD1(ALL);
  const loan = (id: number, live: [number, number], init: [number | null, number | null], backed: boolean) =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at, init_rate_bps, init_duration_days,
           init_terms_unbacked)
         VALUES (84532, ?, 1, 'active', '0xa', '0xb', '100', '1', 0, 0, ?, ?,
           ?, '0', '0', '1', '2', '0xa', '0xb', ?, 0, 0, ?, 0, ?, ?, ?)`,
      )
      .run(id, LEND, COLL, live[1], live[0], 1000 + id, init[0], init[1], backed ? 0 : 1);
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const tape = async (days: number) => {
    const res = await handleLoansRecent(
      new Request(
        `https://idx/loans/recent?chainId=84532&lendingAsset=${LEND}&collateralAsset=${COLL}&durationDays=${days}&excludeSaleVehicles=1`,
      ),
      env,
    );
    return ((await res.json()) as { loans: Array<Record<string, unknown>> }).loans;
  };
  return { ...h, loan, tape };
}

describe('market tape tenor (#1142)', () => {
  it('keeps an extended fill in the tenor it executed in', async () => {
    const h = harness();
    h.loan(1, [900, 60], [500, 30], true); // executed 5% / 30d, extended to 9% / 60d
    h.loan(2, [700, 60], [700, 60], true); // executed at 60d
    expect((await h.tape(30)).map((l) => l.loanId)).toEqual([1]);
    expect((await h.tape(60)).map((l) => l.loanId)).toEqual([2]);
    expect((await h.tape(30))[0]).toMatchObject({
      durationDays: 60,
      interestRateBps: 900,
      initDurationDays: 30,
      initRateBps: 500,
      marketDurationDays: 30,
    });
  });

  it('files an unbacked snapshot by its best figure but never serves it as the executed terms', async () => {
    const h = harness();
    h.loan(3, [900, 60], [800, 30], false);
    const rows = await h.tape(30);
    expect(rows.map((l) => l.loanId)).toEqual([3]);
    expect(rows[0]).toMatchObject({ marketDurationDays: 30, initDurationDays: null, initRateBps: null });
  });

  it('falls back to the live tenor for a row with no snapshot at all', async () => {
    const h = harness();
    h.loan(4, [500, 45], [null, null], false);
    const rows = await h.tape(45);
    expect(rows.map((l) => l.loanId)).toEqual([4]);
    expect(rows[0]).toMatchObject({ marketDurationDays: 45 });
  });

  it('pages the scoped tape through the tenor index, not a scan', () => {
    const h = harness();
    const plan = h.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM loans
         WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
           AND COALESCE(init_duration_days, duration_days) = ? AND is_sale_vehicle = 0
         ORDER BY loan_id DESC LIMIT ?`,
      )
      .all(84532, LEND, COLL, 30, 50) as Array<{ detail: string }>;
    const text = plan.map((r) => r.detail).join(' | ');
    expect(text).toContain('idx_loans_market_init_tenor_loan');
    expect(text).not.toContain('TEMP B-TREE');
  });
});
