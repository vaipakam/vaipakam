/**
 * #3623 / #3660 — the one ranking behind "why is this not matching?": the
 * open token-for-token offers on one side of a pair that sit closest to a
 * stated rate range and term. `/offers/:id/nearest` asks it for a posted
 * offer, `/intents/nearest` for an Auto-lend slot (a standing lend intent),
 * so both panels rank counterparties by the same rule.
 *
 * A candidate is open, unexpired, token-for-token, not bound to a loan (a
 * sale or offset vehicle) and not from the excluded wallet (the protocol
 * never matches a wallet with itself). The rate gap is 0 where the two
 * ranges meet, else how far apart they sit (a range whose max reads below
 * its min is taken as its min). The term ranks by distance from the stated
 * term, or, for a slot that lends up to a longest term, by how far a
 * request runs past it. Newest first on a tie.
 *
 * This is a CACHE ranking, never a verdict: the app reads each candidate
 * from the chain and asks the protocol's own preview before it names a gap.
 */
import type { Env } from './env';
import type { OfferRow } from './offerRoutes';

/** What the ranking is asked for. */
export interface NearestQuery {
  chainId: number;
  /** The candidates' side: 0 = lender offers, 1 = borrower requests. */
  side: 0 | 1;
  lendingAsset: string;
  collateralAsset: string;
  /** The wallet whose own offers are left out. */
  exclude: string;
  /** The stated rate range, in basis points. */
  rateMin: number;
  rateMax: number;
  durationDays: number;
  /** 'distance': closest term first. 'over': terms up to `durationDays`
   *  first, then by how far past it. */
  term: 'distance' | 'over';
  now: number;
  limit: number;
}

/** The closest candidates with their rate gap, and how many stand in all. */
export async function nearestOpposite(env: Env, q: NearestQuery): Promise<{ rows: (OfferRow & { rate_gap: number })[]; count: number }> {
  // The two statements carry the same filter, written out in each, and no
  // interpolated SQL (the term order is a bound flag), so the schema guard
  // prepares both against the migrated schema.
  const binds = [q.chainId, q.side, q.lendingAsset.toLowerCase(), q.collateralAsset.toLowerCase(), q.exclude, q.now];
  const byDistance = q.term === 'distance' ? 1 : 0;
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT *, MAX(0, interest_rate_bps - ?, ? - MAX(interest_rate_bps, interest_rate_bps_max)) AS rate_gap
         FROM offers
        WHERE chain_id = ? AND status = 'active' AND offer_type = ?
          AND lending_asset = ? AND collateral_asset = ?
          AND asset_type = 0 AND collateral_asset_type = 0
          AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
          AND lower(creator) <> lower(?)
          AND (expires_at = 0 OR expires_at > ?)
        ORDER BY rate_gap ASC,
                 CASE WHEN ? = 1 THEN ABS(duration_days - ?) ELSE MAX(0, duration_days - ?) END ASC,
                 offer_id DESC LIMIT ?`,
    )
      .bind(q.rateMax, q.rateMin, ...binds, byDistance, q.durationDays, q.durationDays, q.limit)
      .all<OfferRow & { rate_gap: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM offers
        WHERE chain_id = ? AND status = 'active' AND offer_type = ?
          AND lending_asset = ? AND collateral_asset = ?
          AND asset_type = 0 AND collateral_asset_type = 0
          AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
          AND lower(creator) <> lower(?)
          AND (expires_at = 0 OR expires_at > ?)`,
    )
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  const found = rows.results ?? [];
  return { rows: found, count: count?.n ?? found.length };
}
