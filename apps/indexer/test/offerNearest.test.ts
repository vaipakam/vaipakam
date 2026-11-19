/**
 * #3623 — `/offers/:id/nearest` serves, for an open token-for-token offer,
 * the other side's open offers on its pair, closest rate range first, and
 * says why it serves nothing for an offer it cannot rank.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleIntentNearest, handleOfferNearest } from '../src/offerRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const LEND = '0x' + 'a1'.repeat(20);
const COLL = '0x' + 'b1'.repeat(20);
const OTHER = '0x' + 'c1'.repeat(20);

interface Seed {
  id: number;
  type: 0 | 1;
  creator?: string;
  rate: number;
  rateMax?: number;
  days?: number;
  status?: string;
  expiresAt?: number;
  lending?: string;
  assetType?: number;
  sale?: number;
}

function setup(seeds: Seed[]) {
  const h = createSqliteD1(ALL_MIGRATIONS);
  for (const s of seeds) {
    h.db
      .prepare(
        `INSERT INTO offers (chain_id, offer_id, status, creator, offer_type, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, amount, interest_rate_bps, interest_rate_bps_max, collateral_amount,
           duration_days, expires_at, is_sale_vehicle, first_seen_block, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '1000', ?, ?, '150', ?, ?, ?, 1, 1, 1)`,
      )
      .run(
        CHAIN,
        s.id,
        s.status ?? 'active',
        s.creator ?? '0x' + s.id.toString(16).padStart(40, '0'),
        s.type,
        s.assetType ?? 0,
        s.lending ?? LEND,
        COLL,
        s.rate,
        s.rateMax ?? s.rate,
        s.days ?? 30,
        s.expiresAt ?? 0,
        s.sale ?? 0,
      );
  }
  return { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
}

async function nearest(env: Env, id: number, limit?: number) {
  const q = limit === undefined ? '' : `&limit=${limit}`;
  const res = await handleOfferNearest(new Request(`https://x/offers/${id}/nearest?chainId=${CHAIN}${q}`), env, String(id));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('/offers/:id/nearest (#3623)', () => {
  it('ranks the other side by rate gap, then term distance, and counts them all', async () => {
    const env = setup([
      { id: 1, type: 0, rate: 600 }, // my lender offer at 6%
      { id: 2, type: 1, rate: 400, rateMax: 500 }, // 1% below
      { id: 3, type: 1, rate: 550, rateMax: 650 }, // meets, other term
      { id: 4, type: 1, rate: 580, rateMax: 620, days: 30 }, // meets, same term
      { id: 5, type: 0, rate: 600 }, // same side
      { id: 6, type: 1, rate: 600, lending: OTHER }, // other pair
      { id: 7, type: 1, rate: 600, status: 'cancelled' },
      { id: 8, type: 1, rate: 600, expiresAt: 1 },
      { id: 9, type: 1, rate: 600, assetType: 1 },
      { id: 10, type: 1, rate: 600, sale: 1 },
      { id: 11, type: 1, rate: 600, creator: '0x' + (1).toString(16).padStart(40, '0') }, // my own wallet
    ]);
    await env.DB.prepare(`UPDATE offers SET duration_days = 45 WHERE offer_id = 3`).run();
    const { status, body } = await nearest(env, 1);
    expect(status).toBe(200);
    expect(body.eligible).toBe(true);
    const c = body.candidates as { offerId: number; rateGapBps: number }[];
    expect(c.map((x) => x.offerId)).toEqual([4, 3, 2]);
    expect(c.map((x) => x.rateGapBps)).toEqual([0, 0, 100]);
    expect(body.oppositeOpen).toBe(3);
  });

  it('serves at most the limit, and the count still says how many stand behind', async () => {
    const env = setup([{ id: 1, type: 1, rate: 500 }, ...[2, 3, 4].map((id): Seed => ({ id, type: 0, rate: 500 + id }))]);
    const { body } = await nearest(env, 1, 2);
    expect((body.candidates as unknown[]).length).toBe(2);
    expect(body.oppositeOpen).toBe(3);
  });

  it('states an empty other side as an empty list, not an error', async () => {
    const env = setup([{ id: 1, type: 0, rate: 600 }]);
    const { body } = await nearest(env, 1);
    expect(body).toMatchObject({ eligible: true, candidates: [], oppositeOpen: 0 });
  });

  it('refuses to rank an offer that is not open, expired, not token-for-token or bound to a loan', async () => {
    const env = setup([
      { id: 1, type: 0, rate: 600, status: 'accepted' },
      { id: 2, type: 0, rate: 600, expiresAt: 1 },
      { id: 3, type: 0, rate: 600, assetType: 1 },
      { id: 4, type: 1, rate: 600, sale: 1 },
    ]);
    expect((await nearest(env, 1)).body).toMatchObject({ eligible: false, reason: 'not-open' });
    expect((await nearest(env, 2)).body).toMatchObject({ eligible: false, reason: 'expired' });
    expect((await nearest(env, 3)).body).toMatchObject({ eligible: false, reason: 'not-erc20' });
    expect((await nearest(env, 4)).body).toMatchObject({ eligible: false, reason: 'loan-bound' });
    expect((await nearest(env, 99)).status).toBe(404);
  });
});

describe('/intents/nearest (#3660)', () => {
  const OWNER = '0x' + 'd1'.repeat(20);
  async function forSlot(env: Env, minRate: number, maxDays: number, extra = '') {
    const q = `chainId=${CHAIN}&owner=${OWNER}&lending=${LEND.toUpperCase().replace('0X', '0x')}&collateral=${COLL}&minRateBps=${minRate}&maxDurationDays=${maxDays}${extra}`;
    const res = await handleIntentNearest(new Request(`https://x/intents/nearest?${q}`), env);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('ranks borrow requests by how far their rate sits below the lowest rate, then by term past the longest', async () => {
    const env = setup([
      { id: 2, type: 1, rate: 400, rateMax: 450 }, // 0.5% below a 5% floor
      { id: 3, type: 1, rate: 500, rateMax: 700, days: 60 }, // meets, term 30 days past
      { id: 4, type: 1, rate: 300, rateMax: 900, days: 10 }, // meets, term within
      { id: 5, type: 1, rate: 800, days: 30 }, // meets, term within
      { id: 6, type: 0, rate: 600 }, // a lender offer
      { id: 7, type: 1, rate: 600, creator: OWNER }, // the slot's own wallet
      { id: 8, type: 1, rate: 600, sale: 1 }, // loan-bound
    ]);
    const { status, body } = await forSlot(env, 500, 30);
    expect(status).toBe(200);
    const c = body.candidates as { offerId: number; rateGapBps: number }[];
    expect(c.map((x) => x.offerId)).toEqual([5, 4, 3, 2]);
    expect(c.map((x) => x.rateGapBps)).toEqual([0, 0, 0, 50]);
    expect(body.oppositeOpen).toBe(4);
  });

  it('refuses a malformed address or term', async () => {
    const env = setup([]);
    const bad = await handleIntentNearest(new Request(`https://x/intents/nearest?chainId=${CHAIN}&owner=0x1&lending=${LEND}&collateral=${COLL}&minRateBps=1&maxDurationDays=1`), env);
    expect(bad.status).toBe(400);
    expect((await forSlot(env, -1, 30)).status).toBe(400);
  });
});
