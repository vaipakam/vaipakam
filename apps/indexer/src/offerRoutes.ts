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

import { type Env, getChainConfigs } from './env';
import { EXPECTED_SCAN_CADENCE_SEC } from './chainIngestDO';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** Open CORS for offer reads — see module-level comment. */
function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=10',
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function chainConfigured(env: Env, chainId: number): boolean {
  try {
    return getChainConfigs(env).some((c) => c.id === chainId);
  } catch {
    return false;
  }
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
  // 0014 — surfaced from on-chain Offer for the MyOffers cooldown +
  // GTT chip (#241), Range-Orders fill-mode badge (#125), and the
  // expiry indicator (#195). Defaults: 0 / 0 / 0 — pre-#164 / GTC
  // / Partial. `created_at` is the on-chain stamp from
  // Offer.createdAt, NOT first_seen_at: the latter is the indexer's
  // ingestion clock, which drifts on restart / backfill / cron lag
  // and would push the UI's cancel-cooldown gate past the
  // contract-side window. See #246 round-2.
  created_at: number;
  expires_at: number;
  fill_mode: number;
  // 0029 — lender-sale vehicle marker (borrower-style offer linked to
  // an existing loan). Exposed so book consumers can drop these rows:
  // they are bookkeeping, never quotable market liquidity.
  is_sale_vehicle: number;
  // 0031 — Preclose Option-3 offset-vehicle marker (lender-style offer
  // pinned to an existing loan via offsetOfferToLoanId). Same
  // bookkeeping-not-liquidity rationale as is_sale_vehicle, on the
  // other side of the book (Codex #1134 round-5 P2).
  is_offset_vehicle: number;
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
    creatorRiskAndTermsConsent: row.creator_fallback_consent === 1,
    allowsPartialRepay: row.allows_partial_repay === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    fillMode: row.fill_mode,
    isSaleVehicle: row.is_sale_vehicle === 1,
    isOffsetVehicle: row.is_offset_vehicle === 1,
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
      // T-086 Round-8 §19.7e + Codex round-20 P2 — Scenario A
      // parallel-sale terminal. Without this bucket the public
      // `total` (used by dashboard / lifetime-metrics widgets) would
      // silently undercount every sold-before-acceptance offer.
      consumed_by_sale: 0,
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
      consumedBySale: tally.consumed_by_sale,
      total:
        tally.active +
        tally.accepted +
        tally.cancelled +
        tally.expired +
        tally.consumed_by_sale,
      // Deploy provenance (version-metadata binding): every deploy —
      // Workers Builds auto-deploys and manual wrangler alike — mints a
      // new version id, so "is the merged code live?" is answerable
      // from this route alone. null in local dev (binding absent).
      // `versionCreatedAt` is when the VERSION was created (Cloudflare's
      // documented semantics) — a rollback re-points to an existing
      // version, so this is NOT necessarily when it reached production
      // (Codex #1252 r1).
      deploy: env.CF_VERSION_METADATA
        ? {
            versionId: env.CF_VERSION_METADATA.id,
            versionTag: env.CF_VERSION_METADATA.tag ?? null,
            versionCreatedAt: env.CF_VERSION_METADATA.timestamp ?? null,
          }
        : null,
      indexer: cursor
        ? {
            lastBlock: cursor.last_block,
            updatedAt: cursor.updated_at,
            // RPC read-diet PR 0 — the ingest mode's expected per-chain scan
            // cadence, so the no-WS fallback probe can size its rail-health
            // staleness window (design §4.1.1) instead of hard-coding one.
            // null = legacy inline scan / unknown → clients keep the polling
            // posture (fail-safe).
            scanCadenceSec:
              env.CHAIN_INGEST_VIA_DO === 'true'
                ? EXPECTED_SCAN_CADENCE_SEC
                : null,
          }
        : null,
    });
  } catch (err) {
    console.error('[offerRoutes] stats failed', err);
    return jsonResponse({ error: 'stats-failed' }, 500);
  }
}


/**
 * GET /offers/markets?chainId=8453
 *
 * Rate Desk (#1129) — market discovery. Returns every DISTINCT
 * (lendingAsset, collateralAsset, durationDays) triple that has live
 * ERC-20/ERC-20 offers, with per-side live counts and best headline rates.
 * The desk's pair chips + tenor emphasis derive from THIS endpoint — never
 * from walking the paginated /offers/active feed, whose page cap would
 * silently drop markets (ProRateTerminalDesign.md §8, Codex #1128 round-4).
 *
 * Since Rate Desk phase 3 (#1131) the discovery set UNIONs the GASLESS
 * signed-offer book (Codex #1145 round-4 P2): a maker posting the FIRST
 * liquidity for a market as a signed order would otherwise never surface
 * in the desk's market picker — the signed book is only fetched AFTER a
 * market is selected, so signed-only depth in a market absent from this
 * list is undiscoverable. Active signed_offers rows (same freshness
 * predicate GET /signed-offers applies: status='active', GTC or unexpired
 * expires_at, plus an unlapsed signature deadline) group into the same
 * market triples; a market present in BOTH sources merges — counts sum
 * and best rates MIN/MAX across both — so activity ordering reflects the
 * whole book. Response shape is unchanged.
 *
 * Expired GTT rows are excluded (expiry is lazily enforced on-chain, so a
 * lapsed offer's row can still read status='active' — advertising a market
 * whose only rows are expired would point the desk at liquidity that cannot
 * be accepted and then render an empty book).
 *
 * ERC-20-only by construction (asset_type = 0 AND collateral_asset_type = 0):
 * NFT/1155 legs carry token identity and must not merge into a fungible
 * market row. Unhealed STUB rows are excluded too (is_stub = 0, Codex #1134
 * round-6 P2): when the inline getOfferDetails read fails, processOfferLogs
 * inserts a placeholder row with '0x' assets, asset_type 0 and
 * duration_days 0 — which wears the ERC-20 shape and would otherwise
 * aggregate into a fake ('0x','0x',0) market that the desk could advertise
 * and auto-select. (/offers/active market-scoped reads don't need the
 * predicate: any valid market filter — a 40-hex address or a 1..4385
 * durationDays — can never match a stub's placeholder values.)
 * Sale-vehicle offers are excluded — they are bookkeeping, not
 * quotable markets — and so are Preclose Option-3 OFFSET vehicles
 * (lender-style rows pinned to an existing loan; Codex #1134 round-5 P2 —
 * a market whose only row is an offset vehicle would get advertised and
 * auto-selected, then render an empty book). Rates are small integers
 * (bps), safe to aggregate in SQL.
 *
 * bestAskBps = MIN(lender interest_rate_bps)      — lender floor (offer_type 0)
 * bestBidBps = MAX(borrower interest_rate_bps_max) — borrower ceiling (offer_type 1)
 */
export async function handleOffersMarkets(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  try {
    const now = Math.floor(Date.now() / 1000);
    // Two per-source aggregates UNION ALL'd, then re-aggregated: SUM
    // merges the counts and MIN/MAX merge the headline rates (SQLite
    // aggregates ignore NULLs, so a side present in only one source
    // keeps that source's rate). The signed leg reuses GET
    // /signed-offers' exact freshness predicate — status='active', GTC
    // or live expires_at, no-deadline or live deadline — so discovery
    // can never advertise a market whose only signed rows are already
    // unservable. asset_type predicates on the signed leg are
    // ingest-guaranteed today (the POST route rejects non-ERC-20 legs,
    // v0.5 shape) but stated anyway for parity with the offers leg if a
    // later book version lifts that gate.
    const rows = await env.DB.prepare(
      `SELECT lending_asset, collateral_asset, duration_days,
              SUM(lender_offers) AS lender_offers,
              SUM(borrower_offers) AS borrower_offers,
              MIN(best_ask_bps) AS best_ask_bps,
              MAX(best_bid_bps) AS best_bid_bps
         FROM (
           SELECT lending_asset, collateral_asset, duration_days,
                  SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END) AS lender_offers,
                  SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END) AS borrower_offers,
                  MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END) AS best_ask_bps,
                  MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END) AS best_bid_bps
              FROM offers
             WHERE chain_id = ? AND status = 'active'
               AND asset_type = 0 AND collateral_asset_type = 0
               AND is_stub = 0
               AND is_sale_vehicle = 0
               AND is_offset_vehicle = 0
               AND (expires_at = 0 OR expires_at > ?)
             GROUP BY lending_asset, collateral_asset, duration_days
           UNION ALL
           SELECT lending_asset, collateral_asset, duration_days,
                  SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END) AS lender_offers,
                  SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END) AS borrower_offers,
                  MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END) AS best_ask_bps,
                  MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END) AS best_bid_bps
              FROM signed_offers
             WHERE chain_id = ? AND status = 'active'
               AND asset_type = 0 AND collateral_asset_type = 0
               AND (expires_at = 0 OR expires_at > ?)
               AND (deadline = 0 OR deadline > ?)
             GROUP BY lending_asset, collateral_asset, duration_days
         )
        GROUP BY lending_asset, collateral_asset, duration_days
        ORDER BY (lender_offers + borrower_offers) DESC`,
    )
      .bind(chainId, now, chainId, now, now)
      .all<{
        lending_asset: string;
        collateral_asset: string;
        duration_days: number;
        lender_offers: number;
        borrower_offers: number;
        best_ask_bps: number | null;
        best_bid_bps: number | null;
      }>();
    const markets = (rows.results ?? []).map((r) => ({
      lendingAsset: r.lending_asset,
      collateralAsset: r.collateral_asset,
      durationDays: r.duration_days,
      lenderOffers: r.lender_offers,
      borrowerOffers: r.borrower_offers,
      bestAskBps: r.best_ask_bps,
      bestBidBps: r.best_bid_bps,
    }));
    return jsonResponse({ chainId, markets });
  } catch (err) {
    console.error('[offerRoutes] markets failed', err);
    return jsonResponse({ error: 'markets-failed' }, 500);
  }
}

/**
 * GET /offers/active?chainId=8453&limit=50&before=<offer_id>
 *     [&lendingAsset=0x..&collateralAsset=0x..&durationDays=30]
 *     [&excludeExpired=1&excludeSaleVehicles=1&excludeOffsetVehicles=1]
 * Returns the page of active offers. Newest-first.
 *
 * Rate Desk (#1129) — the optional market params scope the page to one
 * (pair, tenor) market server-side (riding `idx_offers_market`, migration
 * 0029). Without them this is a GLOBAL newest-first page capped at 200 rows,
 * which cannot honestly serve a per-market book fallback — a market whose
 * offers are older than the first page would render as missing liquidity.
 *
 * `excludeExpired=1` drops lazily-expired GTT rows (expiry is enforced
 * lazily on-chain, so a lapsed offer's row can still read status='active');
 * `excludeSaleVehicles=1` drops lender-sale bookkeeping offers;
 * `excludeOffsetVehicles=1` drops Preclose Option-3 offset bookkeeping
 * offers (Codex #1134 round-5 P2) — all opt-in flags (round-3 convention),
 * mirroring /loans/recent's excludeSaleVehicles, so existing consumers of
 * the unfiltered feed keep byte-identical behaviour. The desk's fallback
 * book passes all three so non-book rows can't eat its bounded page-walk
 * budget.
 */
export async function handleOffersActive(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  const market = parseMarketFilter(url);
  if (market === 'bad') {
    return jsonResponse({ error: 'bad-market-filter' }, 400);
  }
  const excludeExpired = url.searchParams.get('excludeExpired') === '1';
  const excludeSaleVehicles = url.searchParams.get('excludeSaleVehicles') === '1';
  const excludeOffsetVehicles =
    url.searchParams.get('excludeOffsetVehicles') === '1';
  try {
    const conds: string[] = [`chain_id = ?`, `status = 'active'`];
    const binds: (number | string)[] = [chainId];
    if (before) {
      conds.push('offer_id < ?');
      binds.push(before);
    }
    if (market.lendingAsset) {
      conds.push('lending_asset = ?');
      binds.push(market.lendingAsset);
    }
    if (market.collateralAsset) {
      conds.push('collateral_asset = ?');
      binds.push(market.collateralAsset);
    }
    if (market.durationDays !== null) {
      conds.push('duration_days = ?');
      binds.push(market.durationDays);
    }
    if (excludeExpired) {
      // Same predicate /offers/markets applies: 0 = GTC (never expires).
      conds.push('(expires_at = 0 OR expires_at > ?)');
      binds.push(Math.floor(Date.now() / 1000));
    }
    if (excludeSaleVehicles) {
      conds.push('is_sale_vehicle = 0');
    }
    if (excludeOffsetVehicles) {
      conds.push('is_offset_vehicle = 0');
    }
    const stmt = env.DB.prepare(
      `SELECT * FROM offers
       WHERE ${conds.join(' AND ')}
       ORDER BY offer_id DESC LIMIT ?`,
    ).bind(...binds, limit);
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
 * GET /offers/by-current-holder/:addr?chainId=8453&limit=50&before=<offer_id>
 *
 * Returns offers where `addr` CURRENTLY holds the creator-position NFT.
 * Pure D1 lookup on the `creator_current_owner` column maintained by
 * chainIndexer.ts's ERC721 Transfer handler. Covers secondary-market
 * recipients whose `creator` (LoanInitiated-time participant) wouldn't
 * match the connected wallet — unlike `/offers/by-creator/:addr` which
 * filters on the immutable `creator` column.
 *
 * Pairs with the on-chain authoritative fallback
 * `MetricsFacet.getUserPositionOffers(user)` for the rare case where
 * the indexer's cursor hasn't caught up to the latest Transfer.
 */
export async function handleOffersByCurrentHolder(
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
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND creator_current_owner = ? AND offer_id < ?
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, addr, before, limit)
      : env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND creator_current_owner = ?
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, addr, limit);
    const rows = await stmt.all<OfferRow>();
    const offers = (rows.results ?? []).map(toJson);
    const next =
      offers.length === limit && offers.length > 0
        ? (offers[offers.length - 1] as { offerId: number }).offerId
        : null;
    return jsonResponse({ chainId, address: addr, offers, nextBefore: next });
  } catch (err) {
    console.error('[offerRoutes] byCurrentHolder failed', err);
    return jsonResponse({ error: 'byCurrentHolder-failed' }, 500);
  }
}

/**
 * GET /offers/recent?chainId=8453&limit=50&before=<offer_id>
 *
 * Cross-status recent feed: returns the most recent N offers
 * regardless of state (active / accepted / cancelled / expired) so
 * the Analytics page can render a "Recent offer activity" list
 * without falling back to a chain log scan + multicall storm. Newest
 * first by offer_id (the on-chain create-counter, monotonic).
 *
 * The legacy frontend path (`useRecentOffers` via `useLogIndex` →
 * `getOffer` multicall) stays available as the no-indexer fallback;
 * this endpoint is the indexer-first happy path.
 */
export async function handleOffersRecent(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  try {
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ? AND offer_id < ?
           ORDER BY offer_id DESC LIMIT ?`,
        ).bind(chainId, before, limit)
      : env.DB.prepare(
          `SELECT * FROM offers
           WHERE chain_id = ?
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
    console.error('[offerRoutes] recent failed', err);
    return jsonResponse({ error: 'recent-failed' }, 500);
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

/** Rate Desk (#1129) — optional (pair, tenor) market scoping. Addresses are
 *  stored lowercase at ingest; malformed values are a 400, never a silent
 *  unfiltered fallback. Mirrors loanRoutes' helper (file-local per the
 *  existing parser convention in these route files). */
type MarketFilter = {
  lendingAsset: string | null;
  collateralAsset: string | null;
  durationDays: number | null;
};
function parseMarketFilter(url: URL): MarketFilter | 'bad' {
  const out: MarketFilter = { lendingAsset: null, collateralAsset: null, durationDays: null };
  for (const key of ['lendingAsset', 'collateralAsset'] as const) {
    const raw = url.searchParams.get(key);
    if (raw === null) continue;
    const addr = raw.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return 'bad';
    out[key] = addr;
  }
  const rawDays = url.searchParams.get('durationDays');
  if (rawDays !== null) {
    const n = Number(rawDays);
    // Upper bound is the contracts' hard governance ceiling:
    // `LibVaipakam.MAX_OFFER_DURATION_DAYS_CEIL = 4385` (LibVaipakam.sol:417)
    // — `ConfigFacet.setMaxOfferDurationDays` range-bounds every value to it,
    // so no offer/loan can ever carry a longer tenor. Anything above is
    // clearly malformed input, never a tenor the contracts could allow
    // (Codex #1134 round-5 P2 — the earlier 3650 under-shot the ceiling).
    if (!Number.isInteger(n) || n < 1 || n > 4385) return 'bad';
    out.durationDays = n;
  }
  return out;
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
