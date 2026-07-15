/**
 * GET /loans/rate-candles — the ROUTE-level scan cap (#1247 PAG-009).
 *
 * `range=all` has no lower time bound, so before the cap this was the
 * indexer's one per-request unbounded loans read. The route now scans
 * the NEWEST `CANDLE_SCAN_CAP` (10,000) fills — `ORDER BY start_at
 * DESC, loan_id DESC LIMIT cap+1`, then reversed back to ascending for
 * the fold — and reports `truncated` when older fills were dropped.
 * The behaviour under test IS the SQL ordering + slice + reverse, so
 * this runs against the real migrated schema (the fold itself is pinned
 * separately in rateCandles.test.ts).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleLoansRateCandles } from '../src/loanRoutes';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort() // wrangler applies in filename order
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN_ID = 84532;
const LEND = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COLL = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DAYS = 30;
/** Mirrors CANDLE_SCAN_CAP in loanRoutes.ts. */
const CAP = 10_000;

interface CandlesBody {
  chainId: number;
  buckets: Array<{ t: number; open: number; close: number; fills: number }>;
  truncated: boolean;
}

function makeHarness() {
  const h: SqliteD1 = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const insert = h.db.prepare(
    `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
       principal, collateral_amount, asset_type, collateral_asset_type,
       lending_asset, collateral_asset, duration_days, token_id,
       collateral_token_id, lender_token_id, borrower_token_id,
       lender_current_owner, borrower_current_owner, interest_rate_bps,
       start_time, start_block, start_at, updated_at)
     VALUES (?, ?, 1, 'active', '0xl', '0xb', '1000', '200', 0, 0, ?, ?,
       ?, '0', '0', '1', '2', '0xl', '0xb', ?, 0, 0, ?, 0)`,
  );
  const seed = (loanId: number, startAt: number, rateBps: number) =>
    insert.run(CHAIN_ID, loanId, LEND, COLL, DAYS, rateBps, startAt);
  const call = async (): Promise<CandlesBody> => {
    const res = await handleLoansRateCandles(
      new Request(
        `https://idx/loans/rate-candles?chainId=${CHAIN_ID}` +
          `&lendingAsset=${LEND}&collateralAsset=${COLL}&durationDays=${DAYS}` +
          `&interval=1h&range=all`,
      ),
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as CandlesBody;
  };
  return { ...h, seed, call };
}

describe('GET /loans/rate-candles — scan cap (#1247 PAG-009)', () => {
  it('keeps the newest 10,000 fills, drops the oldest, and flags truncation', async () => {
    const h = makeHarness();
    // CAP + 1 fills, one second apart, all inside a few 1h buckets.
    // Loan 1 (the chronologically OLDEST) carries a distinctive rate:
    // if the cap kept it, the first bucket's `open` would be 111.
    h.db.exec('BEGIN');
    h.seed(1, 1_000, 111);
    h.seed(2, 1_001, 222);
    for (let i = 3; i <= CAP + 1; i++) h.seed(i, 1_000 + i, 500);
    h.db.exec('COMMIT');
    const body = await h.call();
    expect(body.truncated).toBe(true);
    const totalFills = body.buckets.reduce((n, b) => n + b.fills, 0);
    expect(totalFills).toBe(CAP); // exactly the cap, one fill dropped
    // The dropped fill is the OLDEST: the earliest bucket now opens at
    // loan 2's rate, proving the DESC-scan + reverse kept recency and
    // restored ascending order for the fold.
    expect(body.buckets[0].open).toBe(222);
    // Buckets stay ascending by t (the fold's output contract).
    const ts = body.buckets.map((b) => b.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('reports truncated: false and untouched ascending buckets under the cap', async () => {
    const h = makeHarness();
    h.seed(1, 0, 400);
    h.seed(2, 7_200, 600); // separate 1h bucket
    const body = await h.call();
    expect(body.truncated).toBe(false);
    expect(body.buckets.map((b) => [b.t, b.open])).toEqual([
      [0, 400],
      [7_200, 600],
    ]);
  });
});
