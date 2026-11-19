/**
 * #3720 — the standing-offer candidates, against the REAL migrated schema:
 * exactly the pair and term, lowest rate first, open amount exact when asked,
 * the borrower's own and every loan-bound, expired or unread offer left out,
 * and a notice that the chain's check decides.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { STANDING_CANDIDATES_NOTICE, handleStandingCandidates, openAmount } from '../src/standingCandidates';
import type { Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const USDC = '0x' + 'aa'.repeat(20);
const WETH = '0x' + 'bb'.repeat(20);
const L = '0x' + '11'.repeat(20);
const ME = '0x' + '22'.repeat(20);
const NOW = Math.floor(Date.now() / 1000);

function seeded() {
  const h = createSqliteD1(MIGRATIONS);
  const offer = (id: number, extra: Record<string, string | number> = {}) => {
    const row: Record<string, string | number> = {
      chain_id: CHAIN, offer_id: id, status: 'active', creator: L, offer_type: 0,
      lending_asset: USDC, collateral_asset: WETH, asset_type: 0, collateral_asset_type: 0,
      amount: '1000', amount_max: '0', amount_filled: '0', interest_rate_bps: 500,
      collateral_amount: '2', duration_days: 30, first_seen_block: 1, first_seen_at: NOW,
      updated_at: NOW, created_at: NOW, expires_at: 0, ...extra,
    };
    const cols = Object.keys(row);
    h.db.prepare(`INSERT INTO offers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  offer(1, { interest_rate_bps: 600 });
  offer(2, { interest_rate_bps: 400 });
  offer(3, { interest_rate_bps: 300, amount_max: '3000', amount_filled: '1000' }); // open 2000
  offer(4, { interest_rate_bps: 100, creator: ME });                                // the borrower's own
  offer(5, { interest_rate_bps: 100, duration_days: 60 });                          // other term
  offer(6, { interest_rate_bps: 100, offer_type: 1 });                              // a request
  offer(7, { interest_rate_bps: 100, expires_at: NOW - 5 });
  offer(8, { interest_rate_bps: 100, is_stub: 1 });
  offer(9, { interest_rate_bps: 100, is_sale_vehicle: 1 });
  offer(10, { interest_rate_bps: 100, amount_filled: '1000' });                     // filled
  offer(11, { interest_rate_bps: 100, status: 'cancelled' });
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const get = async (q: string) => {
    const res = await handleStandingCandidates(
      new Request(`https://x/offers/standing-candidates?chainId=${CHAIN}&lendingAsset=${USDC}&collateralAsset=${WETH}&durationDays=30${q}`),
      env,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get };
}

describe('/offers/standing-candidates', () => {
  it('lists open lender offers on the pair and term, lowest rate first', async () => {
    const { get } = seeded();
    const { body } = await get(`&borrower=${ME}`);
    expect(body.candidates.map((c: any) => c.offerId)).toEqual([3, 2, 1]);
    expect(body.candidates[0]).toMatchObject({ rateBps: 300, openAmount: '2000', expiresAt: null });
    expect(body.notice).toBe(STANDING_CANDIDATES_NOTICE);
  });

  it("includes the caller's own offers only when no borrower is named", async () => {
    const { get } = seeded();
    const { body } = await get('');
    expect(body.candidates.map((c: any) => c.offerId)).toEqual([4, 3, 2, 1]);
  });

  it('keeps only an exact open amount when one is asked for', async () => {
    const { get } = seeded();
    const { body } = await get(`&borrower=${ME}&amount=1000`);
    expect(body.candidates.map((c: any) => c.offerId)).toEqual([2, 1]);
  });

  it('honours the limit and refuses malformed input', async () => {
    const { get } = seeded();
    expect((await get(`&borrower=${ME}&limit=1`)).body.candidates).toHaveLength(1);
    for (const q of ['&limit=0', '&limit=21', '&amount=-1', '&borrower=0x1']) {
      expect((await get(q)).status).toBe(400);
    }
  });

  it('never calls an offer the best on the book', () => {
    expect(STANDING_CANDIDATES_NOTICE).toMatch(/Not the best on the book/);
    expect(STANDING_CANDIDATES_NOTICE).not.toMatch(/\b(safe|approved)\b/i);
  });

  it('reads an open amount from the maximum, or the amount for an offer with no range', () => {
    expect(openAmount({ amount: '10', amount_max: '0', amount_filled: '4' })).toBe(6n);
    expect(openAmount({ amount: '10', amount_max: '30', amount_filled: '4' })).toBe(26n);
    expect(openAmount({ amount: '10', amount_max: '0', amount_filled: '40' })).toBe(0n);
    expect(openAmount({ amount: 'x', amount_max: '0', amount_filled: '0' })).toBeNull();
  });
});
