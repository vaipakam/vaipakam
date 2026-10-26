/**
 * #2757 — `/offers/by-current-holder` returns the same set as its on-chain
 * counterpart, `MetricsFacet.getUserPositionOffers`: the OPEN offers whose
 * position NFT the wallet holds. The contract drops an offer from that view
 * once it stops being an offer (accepted, cancelled, filled into a sale); the
 * route used to return every status and leave each caller to filter.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { handleOffersByCurrentHolder } from '../src/offerRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const HOLDER = '0x' + '11'.repeat(20);

describe('/offers/by-current-holder serves open offers only (#2757)', () => {
  it('drops an offer the holder no longer holds as an offer, expired or not', async () => {
    const h = createSqliteD1(ALL_MIGRATIONS);
    const seed = (offerId: number, status: string, expiresAt = 0) =>
      h.db
        .prepare(
          `INSERT INTO offers (chain_id, offer_id, status, creator, creator_current_owner, offer_type, asset_type,
             collateral_asset_type, lending_asset, collateral_asset, amount, interest_rate_bps, collateral_amount,
             duration_days, expires_at, first_seen_block, first_seen_at, updated_at)
           VALUES (?, ?, ?, '0xc0', ?, 1, 0, 0, '0xa1', '0xb1', '1000', 500, '150', 30, ?, 1, 1, 1)`,
        )
        .run(CHAIN, offerId, status, HOLDER, expiresAt);
    seed(1, 'active');
    seed(2, 'accepted');
    seed(3, 'cancelled');
    seed(4, 'consumed_by_sale');
    seed(5, 'active', 1); // expired, never cancelled: still an offer on chain

    const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
    const res = await handleOffersByCurrentHolder(
      new Request(`https://x/offers/by-current-holder/${HOLDER}?chainId=${CHAIN}`),
      env,
      HOLDER,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { offers: { offerId: number }[] };
    expect(body.offers.map((o) => o.offerId)).toEqual([5, 1]);
  });
});
