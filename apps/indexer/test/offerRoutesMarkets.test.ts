/**
 * GET /offers/markets — signed-book union (Codex #1145 round-4 P2).
 *
 * Market discovery must include markets whose ONLY liquidity is gasless
 * signed orders: the desk fetches the signed book only AFTER a market is
 * selected, so a market absent from /offers/markets is unreachable and
 * its signed depth undiscoverable. The handler UNIONs active, unexpired
 * `signed_offers` rows (the same freshness predicate GET /signed-offers
 * applies) into the on-chain `offers` aggregate; a market present in
 * both sources merges — counts sum, best rates MIN/MAX across both.
 *
 * The behaviour under test IS the SQL (UNION ALL + re-aggregate), so
 * these run against a real in-memory SQLite database: the REAL migration
 * 0033 DDL for `signed_offers`, plus a minimal projection of the
 * `offers` columns the markets query touches (the full table accretes
 * across many migrations; only the queried columns matter here).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handleOffersMarkets } from '../src/offerRoutes';
import type { Env } from '../src/env';
import { createSqliteD1, type SqliteD1 } from './helpers/sqliteD1';

const MIGRATION_0033 = readFileSync(
  new URL('../migrations/0033_signed_offer_book.sql', import.meta.url),
  'utf8',
);

/** Minimal `offers` projection — exactly the columns handleOffersMarkets
 *  reads (scoping predicates + per-side count/rate aggregates). */
const OFFERS_DDL = `
CREATE TABLE offers (
  chain_id              INTEGER NOT NULL,
  offer_id              INTEGER NOT NULL,
  status                TEXT    NOT NULL,
  offer_type            INTEGER NOT NULL,
  lending_asset         TEXT    NOT NULL,
  collateral_asset      TEXT    NOT NULL,
  duration_days         INTEGER NOT NULL,
  asset_type            INTEGER NOT NULL DEFAULT 0,
  collateral_asset_type INTEGER NOT NULL DEFAULT 0,
  interest_rate_bps     INTEGER NOT NULL,
  interest_rate_bps_max INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL DEFAULT 0,
  is_stub               INTEGER NOT NULL DEFAULT 0,
  is_sale_vehicle       INTEGER NOT NULL DEFAULT 0,
  is_offset_vehicle     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, offer_id)
);`;

const CHAIN_ID = 84532;
const L1 = '0x1111111111111111111111111111111111111111';
const L2 = '0x2222222222222222222222222222222222222222';
const C1 = '0xcccccccccccccccccccccccccccccccccccccccc';

let nextOfferId = 1;

function insertOffer(
  h: SqliteD1,
  o: {
    offerType: 0 | 1;
    lendingAsset: string;
    durationDays: number;
    rateBps: number;
    rateBpsMax?: number;
  },
): void {
  h.db
    .prepare(
      `INSERT INTO offers
         (chain_id, offer_id, status, offer_type, lending_asset,
          collateral_asset, duration_days, interest_rate_bps,
          interest_rate_bps_max)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      CHAIN_ID,
      nextOfferId++,
      o.offerType,
      o.lendingAsset,
      C1,
      o.durationDays,
      o.rateBps,
      o.rateBpsMax ?? o.rateBps,
    );
}

function insertSigned(
  h: SqliteD1,
  s: {
    orderHash: string;
    offerType: 0 | 1;
    lendingAsset: string;
    durationDays: number;
    rateBps: number;
    rateBpsMax?: number;
    chainId?: number;
    status?: string;
    expiresAt?: number;
    deadline?: number;
  },
): void {
  h.db
    .prepare(
      `INSERT INTO signed_offers
         (chain_id, order_hash, signer, order_json, signature,
          offer_type, lending_asset, collateral_asset, duration_days,
          asset_type, collateral_asset_type,
          interest_rate_bps, interest_rate_bps_max,
          amount, amount_max, collateral_amount, collateral_amount_max,
          fill_mode, expires_at, deadline, nonce,
          status, filled_amount, created_at, updated_at)
       VALUES (?, ?, '0xsigner', '{}', '0xsig', ?, ?, ?, ?, 0, 0, ?, ?,
               '100', '100', '10', '10', 0, ?, ?, '1', ?, '0', 1000, 1000)`,
    )
    .run(
      s.chainId ?? CHAIN_ID,
      s.orderHash,
      s.offerType,
      s.lendingAsset,
      C1,
      s.durationDays,
      s.rateBps,
      s.rateBpsMax ?? s.rateBps,
      s.expiresAt ?? 0,
      s.deadline ?? 0,
      s.status ?? 'active',
    );
}

interface MarketJson {
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number;
  lenderOffers: number;
  borrowerOffers: number;
  bestAskBps: number | null;
  bestBidBps: number | null;
}

async function getMarketsBody(
  h: SqliteD1,
): Promise<{ markets: MarketJson[]; truncated: boolean }> {
  const env = { DB: h.d1 } as unknown as Env;
  const res = await handleOffersMarkets(
    new Request(`http://indexer.test/offers/markets?chainId=${CHAIN_ID}`),
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { markets: MarketJson[]; truncated: boolean };
}

async function getMarkets(h: SqliteD1): Promise<MarketJson[]> {
  return (await getMarketsBody(h)).markets;
}

function freshDb(): SqliteD1 {
  return createSqliteD1([OFFERS_DDL, MIGRATION_0033]);
}

describe('GET /offers/markets — signed-book union (Codex #1145 r4)', () => {
  it('a signed-only market appears in discovery (same response shape)', async () => {
    const h = freshDb();
    insertSigned(h, {
      orderHash: 'signed-1',
      offerType: 0,
      lendingAsset: L1,
      durationDays: 7,
      rateBps: 450,
    });
    // Same market on ANOTHER chain must not leak into this chain's list.
    insertSigned(h, {
      orderHash: 'signed-other-chain',
      offerType: 1,
      lendingAsset: L1,
      durationDays: 7,
      rateBps: 0,
      rateBpsMax: 999,
      chainId: 1,
    });
    const markets = await getMarkets(h);
    expect(markets).toEqual([
      {
        lendingAsset: L1,
        collateralAsset: C1,
        durationDays: 7,
        lenderOffers: 1,
        borrowerOffers: 0,
        bestAskBps: 450,
        bestBidBps: null,
      },
    ]);
  });

  it('a market present in both sources merges counts and best rates', async () => {
    const h = freshDb();
    // On-chain: 2 lender asks (500, 600) + 1 borrower bid (max 300).
    insertOffer(h, { offerType: 0, lendingAsset: L1, durationDays: 30, rateBps: 500 });
    insertOffer(h, { offerType: 0, lendingAsset: L1, durationDays: 30, rateBps: 600 });
    insertOffer(h, { offerType: 1, lendingAsset: L1, durationDays: 30, rateBps: 0, rateBpsMax: 300 });
    // Signed: 1 lender ask (450 — beats on-chain) + 2 borrower bids
    // (max 700 — beats on-chain — and 350).
    insertSigned(h, { orderHash: 's-ask', offerType: 0, lendingAsset: L1, durationDays: 30, rateBps: 450 });
    insertSigned(h, { orderHash: 's-bid-1', offerType: 1, lendingAsset: L1, durationDays: 30, rateBps: 0, rateBpsMax: 700 });
    insertSigned(h, { orderHash: 's-bid-2', offerType: 1, lendingAsset: L1, durationDays: 30, rateBps: 0, rateBpsMax: 350 });
    const markets = await getMarkets(h);
    expect(markets).toEqual([
      {
        lendingAsset: L1,
        collateralAsset: C1,
        durationDays: 30,
        lenderOffers: 3,
        borrowerOffers: 3,
        bestAskBps: 450,
        bestBidBps: 700,
      },
    ]);
  });

  it('unservable signed rows create no market (terminal / expired / lapsed deadline)', async () => {
    const h = freshDb();
    const now = Math.floor(Date.now() / 1000);
    insertSigned(h, { orderHash: 's-filled', offerType: 0, lendingAsset: L1, durationDays: 7, rateBps: 100, status: 'filled' });
    insertSigned(h, { orderHash: 's-expired', offerType: 0, lendingAsset: L1, durationDays: 7, rateBps: 100, expiresAt: now - 60 });
    insertSigned(h, { orderHash: 's-deadline', offerType: 0, lendingAsset: L1, durationDays: 7, rateBps: 100, deadline: now - 60 });
    expect(await getMarkets(h)).toEqual([]);
  });

  it('activity ordering reflects the merged totals across both sources', async () => {
    const h = freshDb();
    // Market A (L1, 30d): 1 on-chain offer only.
    insertOffer(h, { offerType: 0, lendingAsset: L1, durationDays: 30, rateBps: 500 });
    // Market B (L2, 7d): 3 signed rows — more total activity than A.
    insertSigned(h, { orderHash: 'b-1', offerType: 0, lendingAsset: L2, durationDays: 7, rateBps: 400 });
    insertSigned(h, { orderHash: 'b-2', offerType: 0, lendingAsset: L2, durationDays: 7, rateBps: 410 });
    insertSigned(h, { orderHash: 'b-3', offerType: 1, lendingAsset: L2, durationDays: 7, rateBps: 0, rateBpsMax: 350 });
    const markets = await getMarkets(h);
    expect(markets.map((m) => m.lendingAsset)).toEqual([L2, L1]);
    expect(markets[0]).toMatchObject({ lenderOffers: 2, borrowerOffers: 1 });
  });

  // #1247 PAG-010 — the distinct-market space is maker-spammable, so
  // discovery serves at most MARKETS_CAP (200) markets, DEEPEST first,
  // with `truncated` saying the tail was dropped.
  it('caps discovery at the 200 deepest markets and flags truncation', async () => {
    const h = freshDb();
    // 201 one-offer markets (distinct tenors) + one two-offer market
    // that MUST survive the cut regardless of how ties fall.
    for (let d = 1; d <= 201; d++) {
      insertOffer(h, { offerType: 0, lendingAsset: L1, durationDays: d, rateBps: 500 });
    }
    insertOffer(h, { offerType: 0, lendingAsset: L2, durationDays: 7, rateBps: 400 });
    insertOffer(h, { offerType: 1, lendingAsset: L2, durationDays: 7, rateBps: 0, rateBpsMax: 300 });
    const body = await getMarketsBody(h);
    expect(body.truncated).toBe(true);
    expect(body.markets).toHaveLength(200);
    // Deepest-first: the two-offer market heads the list.
    expect(body.markets[0]).toMatchObject({
      lendingAsset: L2,
      durationDays: 7,
      lenderOffers: 1,
      borrowerOffers: 1,
    });
  });

  it('reports truncated: false when discovery fits the cap', async () => {
    const h = freshDb();
    insertOffer(h, { offerType: 0, lendingAsset: L1, durationDays: 30, rateBps: 500 });
    const body = await getMarketsBody(h);
    expect(body.truncated).toBe(false);
    expect(body.markets).toHaveLength(1);
  });

  it('an on-chain-only market is untouched by the union (pre-#1145 shape preserved)', async () => {
    const h = freshDb();
    insertOffer(h, { offerType: 0, lendingAsset: L1, durationDays: 30, rateBps: 500 });
    insertOffer(h, { offerType: 1, lendingAsset: L1, durationDays: 30, rateBps: 0, rateBpsMax: 320 });
    const markets = await getMarkets(h);
    expect(markets).toEqual([
      {
        lendingAsset: L1,
        collateralAsset: C1,
        durationDays: 30,
        lenderOffers: 1,
        borrowerOffers: 1,
        bestAskBps: 500,
        bestBidBps: 320,
      },
    ]);
  });
});
