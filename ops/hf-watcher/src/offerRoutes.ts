/**
 * T-041 Phase 1+2 — REST handlers for the offer-book indexer.
 *
 * The offer book is genuinely public data — every row is rederivable
 * by re-scanning Diamond logs from any node — so these endpoints use
 * an open CORS policy (`Access-Control-Allow-Origin: *`) rather than
 * the frontend-origin-locked policy used for `/thresholds` etc. The
 * frontend treats this worker as a CACHE: on a 5xx / network error,
 * the browser falls back to its own `lib/logIndex.ts` scan. Every
 * offer row carries a "verify on-chain" affordance that reads
 * `getOfferDetails` directly so a stale or compromised cache can't
 * mislead a user into accepting an offer that no longer matches the
 * on-chain state.
 *
 * Routes:
 *   GET /offers/stats               — aggregate counts (active +
 *                                      lifetime); homepage hero card.
 *   GET /offers/active?...          — paginated active offer list.
 *   GET /offers/:id                 — single offer by id.
 *   GET /offers/by-creator/:addr    — wallet's offers regardless of
 *                                      status; "my offers" view.
 *
 * Pagination: cursor-based on `(offer_id DESC)` so the newest offers
 * surface first. `?limit=50&before=<offer_id>` returns the next page.
 * The offer book is small enough (a few hundred to a few thousand
 * rows) that a simple LIMIT/OFFSET would also work, but cursor pages
 * gracefully handle the case where rows are inserted between requests.
 */

import type { Env } from './env';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** Open CORS for offer reads — see module-level comment. */
function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=10',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

/**
 * Map a raw D1 row to the JSON shape the frontend consumes. Mirrors
 * `LibVaipakam.Offer` field names so a viem-decoded on-chain offer
 * and a worker-cached offer interchange transparently in the
 * frontend's offer-card rendering.
 */
interface OfferRow {
  chain_id: number;
  offer_id: number;
  status: string;
  creator: string;
  offer_type: number;
  lending_asset: string;
  collateral_asset: string;
  asset_type: number;
  collateral_asset_type: number;
  principal_liquidity: number;
  collateral_liquidity: number;
  token_id: string;
  collateral_token_id: string;
  quantity: string;
  collateral_quantity: string;
  amount: string;
  amount_max: string;
  amount_filled: string;
  interest_rate_bps: number;
  interest_rate_bps_max: number;
  collateral_amount: string;
  duration_days: number;
  position_token_id: string;
  prepay_asset: string;
  use_full_term_interest: number;
  creator_fallback_consent: number;
  allows_partial_repay: number;
  first_seen_block: number;
  first_seen_at: number;
  updated_at: number;
}

function toJson(row: OfferRow): Record<string, unknown> {
  return {
    chainId: row.chain_id,
    offerId: row.offer_id,
    status: row.status,
    creator: row.creator,
    offerType: row.offer_type,
    lendingAsset: row.lending_asset,
    collateralAsset: row.collateral_asset,
    assetType: row.asset_type,
    collateralAssetType: row.collateral_asset_type,
    principalLiquidity: row.principal_liquidity,
    collateralLiquidity: row.collateral_liquidity,
    tokenId: row.token_id,
    collateralTokenId: row.collateral_token_id,
    quantity: row.quantity,
    collateralQuantity: row.collateral_quantity,
    amount: row.amount,
    amountMax: row.amount_max,
    amountFilled: row.amount_filled,
    interestRateBps: row.interest_rate_bps,
    interestRateBpsMax: row.interest_rate_bps_max,
    collateralAmount: row.collateral_amount,
    durationDays: row.duration_days,
    positionTokenId: row.position_token_id,
    prepayAsset: row.prepay_asset,
    useFullTermInterest: row.use_full_term_interest === 1,
    creatorFallbackConsent: row.creator_fallback_consent === 1,
    allowsPartialRepay: row.allows_partial_repay === 1,
    firstSeenBlock: row.first_seen_block,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /offers/stats?chainId=8453 (default 8453)
 * Returns counts per status + indexer cursor info.
 * Used by the homepage hero card and by the offer-book preloader to
 * decide whether to pull a fresh page or trust the cached payload.
 */
export async function handleOffersStats(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  try {
    const counts = await env.DB.prepare(
      `SELECT status, COUNT(*) as n FROM offers WHERE chain_id = ? GROUP BY status`,
    )
      .bind(chainId)
      .all<{ status: string; n: number }>();
    // Note: chainIndexer.ts writes the cursor with `kind = 'diamond'`
    // (it scans the diamond's full event surface — offers + loans).
    // The earlier 'offers' literal was a stale split that never
    // matched, so this lookup returned null and the frontend showed
    // a permanent amber "indexer disconnected" badge.
    const cursor = await env.DB.prepare(
      `SELECT last_block, updated_at FROM indexer_cursor
       WHERE chain_id = ? AND kind = 'diamond'`,
    )
      .bind(chainId)
      .first<{ last_block: number; updated_at: number }>();
    const tally: Record<string, number> = {
      active: 0,
      accepted: 0,
      cancelled: 0,
      expired: 0,
    };
    for (const row of counts.results ?? []) {
      tally[row.status] = row.n;
    }
    return jsonResponse({
      chainId,
      active: tally.active,
      accepted: tally.accepted,
      cancelled: tally.cancelled,
      expired: tally.expired,
      total: tally.active + tally.accepted + tally.cancelled + tally.expired,
      indexer: cursor
        ? { lastBlock: cursor.last_block, updatedAt: cursor.updated_at }
        : null,
    });
  } catch (err) {
    console.error('[offerRoutes] stats failed', err);
    return jsonResponse({ error: 'stats-failed' }, 500);
  }
}

/**
 * GET /offers/active?chainId=8453&limit=50&before=<offer_id>
 * Returns the page of active offers. Newest-first.
 */
export async function handleOffersActive(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  try {
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND status = 'active' AND offer_id < ?
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, before, limit)
      : env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND status = 'active'
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, limit);
    const rows = await stmt.all<OfferRow>();
    const offers = (rows.results ?? []).map(toJson);
    const next =
      offers.length === limit && offers.length > 0
        ? (offers[offers.length - 1] as { offerId: number }).offerId
        : null;
    return jsonResponse({ chainId, offers, nextBefore: next });
  } catch (err) {
    console.error('[offerRoutes] active failed', err);
    return jsonResponse({ error: 'active-failed' }, 500);
  }
}

/**
 * GET /offers/:id?chainId=8453
 * Returns a single offer regardless of status. 404 when unknown.
 */
export async function handleOfferById(
  req: Request,
  env: Env,
  offerIdRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const offerId = Number.parseInt(offerIdRaw, 10);
  if (!Number.isFinite(offerId) || offerId < 0) {
    return jsonResponse({ error: 'bad-offer-id' }, 400);
  }
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM offers WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(chainId, offerId)
      .first<OfferRow>();
    if (!row) return jsonResponse({ error: 'not-found' }, 404);
    return jsonResponse(toJson(row));
  } catch (err) {
    console.error('[offerRoutes] byId failed', err);
    return jsonResponse({ error: 'byId-failed' }, 500);
  }
}

/**
 * GET /offers/by-creator/:addr?chainId=8453&limit=50&before=<offer_id>
 * Returns every offer the wallet created, regardless of status.
 * Powers the wallet-menu "My Offers" view.
 */
export async function handleOffersByCreator(
  req: Request,
  env: Env,
  addrRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  try {
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND creator = ? AND offer_id < ?
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, addr, before, limit)
      : env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND creator = ?
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, addr, limit);
    const rows = await stmt.all<OfferRow>();
    const offers = (rows.results ?? []).map(toJson);
    const next =
      offers.length === limit && offers.length > 0
        ? (offers[offers.length - 1] as { offerId: number }).offerId
        : null;
    return jsonResponse({ chainId, creator: addr, offers, nextBefore: next });
  } catch (err) {
    console.error('[offerRoutes] byCreator failed', err);
    return jsonResponse({ error: 'byCreator-failed' }, 500);
  }
}

/**
 * Preflight echo for /offers/* — returns the open CORS shape so the
 * browser doesn't get rejected when posting from a non-allow-list
 * origin. Offer reads have no auth, so blanket allow is safe.
 */
export function handleOffersPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function parseChainId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_PAGE_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(n, MAX_PAGE_LIMIT);
}

function parseBefore(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
