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
import { PLACED_IN_TENOR_SQL } from '../src/marketPlacement';
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
  unplaced: number;
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
       start_time, start_block, start_at, updated_at,
       init_rate_bps, init_duration_days, init_principal,
       init_terms_unbacked, init_principal_unbacked)
     VALUES (?, ?, 1, 'active', '0xl', '0xb', '1000', '200', 0, 0, ?, ?,
       ?, '0', '0', '1', '2', '0xl', '0xb', ?, 0, 0, ?, 0,
       ?, ?, '1000', ?, 0)`,
  );
  // A seeded fill carries a BACKED initiation snapshot unless `termsUnbacked`
  // is set, in which case the candle route must count it and draw nothing.
  const seed = (loanId: number, startAt: number, rateBps: number, termsUnbacked = 0) =>
    insert.run(CHAIN_ID, loanId, LEND, COLL, DAYS, rateBps, startAt, rateBps, DAYS, termsUnbacked);
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
  it('keeps the newest fills, drops the partial boundary bucket, and flags truncation', async () => {
    const h = makeHarness();
    // CAP + 1 fills: loans 1–2 sit in the FIRST 1h bucket, the rest in
    // later buckets. The scan keeps the newest CAP rows, dropping only
    // loan 1 — which cuts MID-bucket: the oldest retained bucket holds
    // loan 2 but not loan 1, so its open/fills would lie. The route
    // must drop that boundary bucket entirely (Codex #1269 r3 P3).
    h.db.exec('BEGIN');
    h.seed(1, 1_000, 111);
    h.seed(2, 1_001, 222);
    for (let i = 3; i <= CAP + 1; i++) h.seed(i, 3_600 + i, 500);
    h.db.exec('COMMIT');
    const body = await h.call();
    expect(body.truncated).toBe(true);
    // Bucket t=0 (the cut-through boundary) is GONE, not partial.
    expect(body.buckets[0].t).toBe(3_600);
    const totalFills = body.buckets.reduce((n, b) => n + b.fills, 0);
    expect(totalFills).toBe(CAP - 1); // CAP kept minus the boundary bucket's lone fill
    // Buckets stay ascending by t (the fold's output contract).
    const ts = body.buckets.map((b) => b.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('a single-bucket truncated series keeps its (partial) candle instead of blanking (Codex r4)', async () => {
    // CAP+1 fills inside ONE 1h bucket: dropping the boundary bucket
    // here would return `buckets: []` and the chart would claim "no
    // fills in range" about the market's busiest hour. The partial
    // candle stays, disclosed by `truncated`.
    const h = makeHarness();
    h.db.exec('BEGIN');
    for (let i = 1; i <= CAP + 1; i++) h.seed(i, 1_000 + (i % 2_000), 500);
    h.db.exec('COMMIT');
    const body = await h.call();
    expect(body.truncated).toBe(true);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0].fills).toBe(CAP); // newest CAP kept, one dropped
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

  it('places only confirmed fills and counts the rest pair-wide as unplaced (#1142)', async () => {
    const h = makeHarness();
    h.seed(1, 0, 400);
    h.seed(2, 100, 9_999, 1); // same pair and tenor, agreed terms NOT confirmed
    h.seed(3, 7_200, 9_999, 1);
    const body = await h.call();
    expect(body.truncated).toBe(false);
    expect(body.buckets.map((b) => [b.t, b.open, b.close, b.fills])).toEqual([[0, 400, 400, 1]]);
    expect(body.unplaced).toBe(2);
  });

  it('files a fill by its agreed tenor, never the live one, and counts an unconfirmed loan whatever tenor it names', async () => {
    const h = makeHarness();
    h.seed(1, 0, 400);
    // Agreed at another tenor: not this market's fill, and not unplaced.
    h.db
      .prepare('UPDATE loans SET init_duration_days = ? WHERE loan_id = 1')
      .run(DAYS + 30);
    h.seed(2, 10, 500, 1);
    h.db
      .prepare('UPDATE loans SET init_duration_days = ? WHERE loan_id = 2')
      .run(DAYS + 30);
    const body = await h.call();
    expect(body.buckets).toEqual([]);
    expect(body.unplaced).toBe(1);
  });

  it('range-scans the placed fills through the placement index', () => {
    const h = makeHarness();
    const plan = h.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT loan_id FROM loans
         WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
           AND ${PLACED_IN_TENOR_SQL} AND is_sale_vehicle = 0
           AND asset_type = 0 AND collateral_asset_type = 0 AND start_at >= ?
         ORDER BY start_at DESC, loan_id DESC LIMIT ?`,
      )
      .all(CHAIN_ID, LEND, COLL, DAYS, 0, 10) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(' | ')).toContain('idx_loans_placed_tenor_start_at');
  });
});
