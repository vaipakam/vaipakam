/**
 * T-041 Phase B — REST handlers for the loans + activity-event
 * indexer. Open CORS, same policy as `/offers/*` (every row is
 * rederivable on-chain; no auth-relevant data).
 *
 * Routes:
 *   GET /loans/active                 — paginated active-loan list.
 *   GET /loans/:id                    — single loan by id.
 *   GET /loans/by-lender/:addr        — wallet's loans as lender.
 *   GET /loans/by-borrower/:addr      — wallet's loans as borrower.
 *   GET /activity                     — unified event ledger; filters
 *                                        on chainId / actor / loanId /
 *                                        offerId / kind.
 */

import { type Env, getChainConfigs } from './env';
import { EXPECTED_SCAN_CADENCE_SEC } from './chainIngestDO';
import {
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  foldRateCandles,
  type CandleFillRow,
} from './rateCandles';

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=10',
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      // Spread LAST so a route can override the default Cache-Control
      // (the candle endpoint serves max-age=60 per the §7 spec).
      ...extraHeaders,
    },
  });
}

/**
 * #749 — whether THIS worker actually INDEXES `chainId`. Gated on
 * `getChainConfigs(env)` membership, NOT just `getDeployment`: the scanner only
 * runs for a chain that has BOTH a deployment artifact AND an RPC secret bound
 * (so a deployed-but-disabled chain, an RPC/Secrets-Store outage, or a stray
 * local 31337 artifact is correctly excluded — Codex #768). A chain this worker
 * doesn't index returns a `chain-not-configured` 503 (not a cacheable empty 200,
 * which the frontend's indexer-first → on-chain-fallback wrapper would cache as
 * "no loans" and never fall back from). `env` here is the RESOLVED env (the
 * route dispatcher calls `resolveEnv` at the boundary), so the RPC bindings are
 * populated. These routes are otherwise PURE D1 — the authoritative
 * live-ownership read is the FRONTEND's on-chain fallback
 * (`MetricsFacet.getUserPositionLoans` via the user's own RPC), so the indexer
 * never spends operator RPC quota here; it just serves the projection, which the
 * ERC721 Transfer / LoanSold / LoanSaleCompleted / LoanObligationTransferred /
 * claim-burn handlers in chainIndexer.ts keep authoritative.
 */
function chainConfigured(env: Env, chainId: number): boolean {
  try {
    return getChainConfigs(env).some((c) => c.id === chainId);
  } catch {
    return false;
  }
}

interface LoanRow {
  chain_id: number;
  loan_id: number;
  offer_id: number;
  status: string;
  lender: string;
  borrower: string;
  principal: string;
  collateral_amount: string;
  asset_type: number;
  collateral_asset_type: number;
  lending_asset: string;
  collateral_asset: string;
  duration_days: number;
  token_id: string;
  collateral_token_id: string;
  lender_token_id: string;
  borrower_token_id: string;
  lender_current_owner: string | null;
  borrower_current_owner: string | null;
  interest_rate_bps: number;
  start_time: number;
  allows_partial_repay: number;
  // 0029 — lender-sale vehicle marker: the temp bookkeeping loan a
  // lender-sale offer initiates (never a fresh market fill). Exposed so
  // tape consumers can drop these rows client-side even when an older
  // worker ignored the excludeSaleVehicles=1 param (Codex #1134 round-5).
  is_sale_vehicle: number;
  start_block: number;
  start_at: number;
  terminal_block: number | null;
  terminal_at: number | null;
  updated_at: number;
}

function loanToJson(row: LoanRow): Record<string, unknown> {
  return {
    chainId: row.chain_id,
    loanId: row.loan_id,
    offerId: row.offer_id,
    status: row.status,
    lender: row.lender,
    borrower: row.borrower,
    principal: row.principal,
    collateralAmount: row.collateral_amount,
    assetType: row.asset_type,
    collateralAssetType: row.collateral_asset_type,
    lendingAsset: row.lending_asset,
    collateralAsset: row.collateral_asset,
    durationDays: row.duration_days,
    tokenId: row.token_id,
    collateralTokenId: row.collateral_token_id,
    lenderTokenId: row.lender_token_id,
    borrowerTokenId: row.borrower_token_id,
    lenderCurrentOwner: row.lender_current_owner,
    borrowerCurrentOwner: row.borrower_current_owner,
    interestRateBps: row.interest_rate_bps,
    startTime: row.start_time,
    allowsPartialRepay: row.allows_partial_repay === 1,
    isSaleVehicle: row.is_sale_vehicle === 1,
    startBlock: row.start_block,
    startAt: row.start_at,
    terminalBlock: row.terminal_block,
    terminalAt: row.terminal_at,
    updatedAt: row.updated_at,
  };
}

interface ActivityRow {
  chain_id: number;
  block_number: number;
  log_index: number;
  tx_hash: string;
  kind: string;
  loan_id: number | null;
  offer_id: number | null;
  actor: string | null;
  args_json: string;
  block_at: number;
}

function activityToJson(row: ActivityRow): Record<string, unknown> {
  let args: unknown = null;
  try {
    args = JSON.parse(row.args_json);
  } catch {
    // Stored row had bad JSON — surface raw text rather than 500.
    args = row.args_json;
  }
  return {
    chainId: row.chain_id,
    blockNumber: row.block_number,
    logIndex: row.log_index,
    txHash: row.tx_hash,
    kind: row.kind,
    loanId: row.loan_id,
    offerId: row.offer_id,
    actor: row.actor,
    args,
    blockAt: row.block_at,
  };
}

/** GET /loans/active?chainId=8453&limit=50&before=<loan_id> */
export async function handleLoansActive(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  try {
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ? AND status = 'active' AND loan_id < ?
           ORDER BY loan_id DESC LIMIT ?`,
        ).bind(chainId, before, limit)
      : env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ? AND status = 'active'
           ORDER BY loan_id DESC LIMIT ?`,
        ).bind(chainId, limit);
    const rows = await stmt.all<LoanRow>();
    const loans = (rows.results ?? []).map(loanToJson);
    const next =
      loans.length === limit && loans.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] active failed', err);
    return jsonResponse({ error: 'active-failed' }, 500);
  }
}

/** GET /loans/:id?chainId=8453 — returns the loan row plus, if a
 *  prepay listing is live for that loan, a nested `prepayListing`
 *  object with the order_hash / ask_price / conduit / lister /
 *  grace_period_end the connected app needs to render the "your
 *  loan has a live listing" banner + cancel CTA. */
export async function handleLoanById(
  req: Request,
  env: Env,
  loanIdRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const loanId = Number.parseInt(loanIdRaw, 10);
  if (!Number.isFinite(loanId) || loanId < 0) {
    return jsonResponse({ error: 'bad-loan-id' }, 400);
  }
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM loans WHERE chain_id = ? AND loan_id = ?`,
    )
      .bind(chainId, loanId)
      .first<LoanRow>();
    if (!row) return jsonResponse({ error: 'not-found' }, 404);
    const listing = await env.DB.prepare(
      `SELECT order_hash, ask_price, conduit, lister,
              posted_at, updated_at, grace_period_end,
              conduit_key, salt, executor,
              end_ask_price, auction_end_time, auction_mode
       FROM prepay_listings
       WHERE chain_id = ? AND loan_id = ?`,
    )
      .bind(chainId, loanId)
      .first<{
        order_hash: string;
        ask_price: string;
        conduit: string;
        lister: string;
        posted_at: number;
        updated_at: number;
        grace_period_end: number;
        conduit_key: string | null;
        salt: string | null;
        executor: string | null;
        end_ask_price: string | null;
        auction_end_time: number | null;
        auction_mode: number | null;
      }>();
    const payload: Record<string, unknown> = loanToJson(row);
    if (listing) {
      // T-086 Round-5 Block C (#309 Mode B) — surface conduit_key /
      // salt / executor / auction_mode / end_ask_price /
      // auction_end_time to the dapp. The Offers panel + the
      // match-offer rotation need these to reconstruct the
      // canonical order shape + decide which mode's update path
      // to call. `conduit_key` / `salt` / `executor` were added in
      // migration 0016 (Block A) but not previously surfaced over
      // the API; `auction_mode` / `end_ask_price` /
      // `auction_end_time` came with migration 0018 (Block B).
      payload.prepayListing = {
        orderHash: listing.order_hash,
        askPrice: listing.ask_price,
        conduit: listing.conduit,
        lister: listing.lister,
        postedAt: listing.posted_at,
        updatedAt: listing.updated_at,
        gracePeriodEnd: listing.grace_period_end,
        conduitKey: listing.conduit_key,
        salt: listing.salt,
        executor: listing.executor,
        endAskPrice: listing.end_ask_price,
        auctionEndTime: listing.auction_end_time,
        auctionMode: listing.auction_mode,
      };
    }
    // T-090 v1.1 (#389) Sub 2 (#417) — surface the live intent
    // commit (if any) so the dapp can render the pending-intent
    // CTA + cancel button from this single endpoint. Mirrors the
    // prepay-listing surface above; null when no commit is live.
    // Codex round-1 PR #421 P2 — without this read surface the
    // table is write-only and the dapp has no path to learn an
    // intent commit landed.
    const intent = await env.DB.prepare(
      `SELECT order_hash, committed_by, maker_amount, taker_amount,
              deadline, committed_at, committed_tx_hash
       FROM swap_to_repay_intents
       WHERE chain_id = ? AND loan_id = ?`,
    )
      .bind(chainId, loanId)
      .first<{
        order_hash: string;
        committed_by: string;
        maker_amount: string;
        taker_amount: string;
        deadline: number;
        committed_at: number;
        committed_tx_hash: string;
      }>();
    if (intent) {
      payload.swapToRepayIntent = {
        orderHash: intent.order_hash,
        committedBy: intent.committed_by,
        makerAmount: intent.maker_amount,
        takerAmount: intent.taker_amount,
        deadline: intent.deadline,
        committedAt: intent.committed_at,
        committedTxHash: intent.committed_tx_hash,
      };
    }
    return jsonResponse(payload);
  } catch (err) {
    console.error('[loanRoutes] byId failed', err);
    return jsonResponse({ error: 'byId-failed' }, 500);
  }
}

/**
 * GET /loans/by-lender/:addr OR /loans/by-borrower/:addr
 *
 * Returns loans where the wallet *currently* holds the corresponding
 * position NFT. Live-ownership filter — NOT a SQL match on the
 * historical `lender` / `borrower` columns from LoanInitiated.
 *
 * #749 — answered as PURE D1 from the indexer-maintained `lender_current_owner`
 * / `borrower_current_owner` column with a SQL `LIMIT` — zero operator RPC (the
 * indexer's whole purpose). The old path pulled EVERY loan (no SQL LIMIT) and
 * fanned out one `ownerOf` read PER LOAN, so an unauthenticated caller could
 * amplify RPC load with the GLOBAL loan count and, past the Worker subrequest
 * cap, silently under-returned.
 *
 * The projection is kept AUTHORITATIVE by the chainIndexer.ts handlers — the
 * ERC721 `Transfer` handler (incl. burns → `0x0` so claimed positions drop out),
 * `LoanSold` / `LoanObligationTransferred` (position token-id migration), and
 * the `LoanInitiated` seed-from-`offers.creator_current_owner` (pre-accept
 * offer-NFT transfer). The FRONTEND layers an on-chain
 * `MetricsFacet.getUserPositionLoans` verify (the USER's RPC, not the operator's)
 * over this for the indexer-cursor-lag window.
 */
export async function handleLoansByParticipant(
  req: Request,
  env: Env,
  addrRaw: string,
  side: 'lender' | 'borrower',
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  // Fail closed when this chain isn't indexed here, so the frontend's
  // indexer-first → on-chain-fallback wrapper actually falls back (#749).
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  // Column is selected from the validated `side` enum — a hardcoded literal,
  // never caller input, so this is not a dynamic-SQL injection surface.
  const ownerCol =
    side === 'lender' ? 'lender_current_owner' : 'borrower_current_owner';
  try {
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ? AND ${ownerCol} = ? AND loan_id < ?
           ORDER BY loan_id DESC
           LIMIT ?`,
        ).bind(chainId, addr, before, limit)
      : env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ? AND ${ownerCol} = ?
           ORDER BY loan_id DESC
           LIMIT ?`,
        ).bind(chainId, addr, limit);
    const rows = (await stmt.all<LoanRow>()).results ?? [];
    const loans = rows.map(loanToJson);
    const next =
      rows.length === limit && rows.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, side, address: addr, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] byParticipant failed', err);
    return jsonResponse({ error: 'byParticipant-failed' }, 500);
  }
}

/**
 * GET /loans/by-current-holder/:addr?chainId=8453&limit=50&before=<loan_id>
 *
 * Returns loans where `addr` is the CURRENT holder of either the
 * lender- or borrower-position NFT. Same semantic surface as
 * /loans/by-lender + /loans/by-borrower UNIONED, but answered via a
 * pure D1 lookup on the `lender_current_owner` / `borrower_current_owner`
 * columns maintained by chainIndexer.ts's ERC721 Transfer handler.
 *
 * Zero RPC cost per request — `getUserPositionLoans` on the Diamond is
 * the on-chain authoritative fallback for the rare case where the
 * indexer's cursor hasn't caught up to the latest Transfer.
 *
 * Each loan appears at most ONCE in the response even if `addr` holds
 * both the lender and borrower NFT — downstream can compare against
 * `lender_current_owner` / `borrower_current_owner` to infer role(s).
 */
export async function handleLoansByCurrentHolder(
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
          `SELECT * FROM loans
           WHERE chain_id = ?
             AND (lender_current_owner = ? OR borrower_current_owner = ?)
             AND loan_id < ?
           ORDER BY loan_id DESC
           LIMIT ?`,
        ).bind(chainId, addr, addr, before, limit)
      : env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ?
             AND (lender_current_owner = ? OR borrower_current_owner = ?)
           ORDER BY loan_id DESC
           LIMIT ?`,
        ).bind(chainId, addr, addr, limit);
    const rows = (await stmt.all<LoanRow>()).results ?? [];
    const loans = rows.map(loanToJson);
    const next =
      rows.length === limit && rows.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, address: addr, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] byCurrentHolder failed', err);
    return jsonResponse({ error: 'byCurrentHolder-failed' }, 500);
  }
}

/** GET /activity?chainId=8453&actor=0x...&loanId=N&offerId=N&kind=...&limit=50&before=<block:logIndex>
 *
 *  Cursor format: composite "block:logIndex" (e.g. `12345:6`) so a
 *  cron-deferred block on the boundary doesn't drop rows. When omitted,
 *  page starts at the head of the ledger. */
export async function handleActivity(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const actor = url.searchParams.get('actor');
  const loanIdRaw = url.searchParams.get('loanId');
  const offerIdRaw = url.searchParams.get('offerId');
  const kind = url.searchParams.get('kind');
  const beforeRaw = url.searchParams.get('before');

  const where: string[] = ['chain_id = ?'];
  const binds: (string | number)[] = [chainId];
  if (actor) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(actor)) {
      return jsonResponse({ error: 'bad-actor' }, 400);
    }
    where.push('actor = ?');
    binds.push(actor.toLowerCase());
  }
  if (loanIdRaw) {
    const n = Number.parseInt(loanIdRaw, 10);
    if (!Number.isFinite(n) || n < 0) return jsonResponse({ error: 'bad-loanId' }, 400);
    where.push('loan_id = ?');
    binds.push(n);
  }
  if (offerIdRaw) {
    const n = Number.parseInt(offerIdRaw, 10);
    if (!Number.isFinite(n) || n < 0) return jsonResponse({ error: 'bad-offerId' }, 400);
    where.push('offer_id = ?');
    binds.push(n);
  }
  if (kind) {
    if (!/^[A-Za-z]+$/.test(kind)) return jsonResponse({ error: 'bad-kind' }, 400);
    where.push('kind = ?');
    binds.push(kind);
  }
  if (beforeRaw) {
    const m = beforeRaw.match(/^(\d+):(\d+)$/);
    if (!m) return jsonResponse({ error: 'bad-before' }, 400);
    where.push('(block_number, log_index) < (?, ?)');
    binds.push(Number.parseInt(m[1], 10), Number.parseInt(m[2], 10));
  }
  try {
    const sql = `SELECT * FROM activity_events
                 WHERE ${where.join(' AND ')}
                 ORDER BY block_number DESC, log_index DESC
                 LIMIT ?`;
    binds.push(limit);
    const rows = await env.DB.prepare(sql).bind(...binds).all<ActivityRow>();
    const events = (rows.results ?? []).map(activityToJson);
    const last = rows.results && rows.results.length === limit ? rows.results[rows.results.length - 1] : null;
    const nextBefore = last ? `${last.block_number}:${last.log_index}` : null;
    return jsonResponse({ chainId, events, nextBefore });
  } catch (err) {
    console.error('[loanRoutes] activity failed', err);
    return jsonResponse({ error: 'activity-failed' }, 500);
  }
}

/**
 * GET /claimables/:addr?chainId=8453
 *
 * Returns the wallet's open claim opportunities — loans where this
 * wallet *currently* holds the position NFT for the side in question
 * AND the matching `*FundsClaimed` event has NOT yet fired for that
 * (loanId, claimant) pair. Two filters compose:
 *
 *   1. **Live-ownership filter** (chain) — multicall ownerOf for both
 *      lenderTokenId and borrowerTokenId on every terminal-status
 *      loan; keep loans where the wallet owns either NFT. Captures
 *      secondary-market NFT buyers correctly.
 *   2. **Already-claimed filter** (D1) — exclude loans where the
 *      matching `*FundsClaimed` activity event has already fired
 *      with this wallet as claimant.
 *
 * 'settled' loans are skipped — that status means BOTH sides already
 * claimed (LoanSettled event flipped them). 'internal_matched' IS
 * included (#1234): it is terminal AND claimable — apps/defi's
 * ClaimCenter verifies it status-agnostically (live getLoanDetails +
 * getClaimable) and labels it "Internally Matched"; omitting it here
 * hid internally-matched claims from the defi claim surface's indexer
 * candidate layer.
 */
export async function handleClaimables(
  req: Request,
  env: Env,
  addrRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  // Fail closed when this chain isn't indexed here so the frontend falls back.
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    // #749 — PURE D1: the wallet's OWN terminal loans, filtered on the
    // indexer-maintained `*_current_owner` columns (kept authoritative by the
    // chainIndexer.ts Transfer/burn + LoanSold + LoanObligationTransferred +
    // accept-seed handlers). A claim BURNS the position NFT → its
    // `*_current_owner` is set to `0x0`, which never equals a real wallet, so a
    // claimed side automatically drops out (the already-claimed activity filter
    // below is then belt-and-suspenders). Zero operator RPC; the FRONTEND layers
    // the on-chain `getUserPositionLoans` verify via the user's own RPC.
    const rows = (
      await env.DB.prepare(
        `SELECT * FROM loans
         WHERE chain_id = ?
           AND status IN ('repaid', 'defaulted', 'liquidated', 'internal_matched')
           AND (lender_current_owner = ? OR borrower_current_owner = ?)
         ORDER BY loan_id DESC`,
      )
        .bind(chainId, addr, addr)
        .all<LoanRow>()
    ).results ?? [];
    if (rows.length === 0) {
      return jsonResponse({ chainId, address: addr, asLender: [], asBorrower: [] });
    }
    // Pre-fetch already-claimed loan IDs so we can dedup in memory
    // without N round trips. One query per side. (Belt-and-suspenders: a claimed
    // position NFT is burned, so its `*_current_owner` is already `0x0`.)
    const claimedLender = new Set<number>();
    const claimedBorrower = new Set<number>();
    const lenderClaims = (
      await env.DB.prepare(
        `SELECT DISTINCT loan_id FROM activity_events
         WHERE chain_id = ? AND kind = 'LenderFundsClaimed' AND actor = ?`,
      )
        .bind(chainId, addr)
        .all<{ loan_id: number }>()
    ).results ?? [];
    for (const r of lenderClaims) claimedLender.add(r.loan_id);
    const borrowerClaims = (
      await env.DB.prepare(
        `SELECT DISTINCT loan_id FROM activity_events
         WHERE chain_id = ? AND kind = 'BorrowerFundsClaimed' AND actor = ?`,
      )
        .bind(chainId, addr)
        .all<{ loan_id: number }>()
    ).results ?? [];
    for (const r of borrowerClaims) claimedBorrower.add(r.loan_id);
    // Split by which side's current-owner is `addr` (a wallet can hold BOTH NFTs
    // of one loan), then drop sides already claimed.
    const asLender: LoanRow[] = [];
    const asBorrower: LoanRow[] = [];
    for (const row of rows) {
      if (row.lender_current_owner === addr && !claimedLender.has(row.loan_id)) {
        asLender.push(row);
      }
      if (
        row.borrower_current_owner === addr &&
        !claimedBorrower.has(row.loan_id)
      ) {
        asBorrower.push(row);
      }
    }
    return jsonResponse({
      chainId,
      address: addr,
      asLender: asLender.map(loanToJson),
      asBorrower: asBorrower.map(loanToJson),
    });
  } catch (err) {
    console.error('[loanRoutes] claimables failed', err);
    return jsonResponse({ error: 'claimables-failed' }, 500);
  }
}

/**
 * GET /claim-candidates/:addr?chainId=8453 — RPC read-diet PR C
 * (Alpha02RpcReadDietDesign §4.2.3).
 *
 * A LEAN, prioritized claim-candidate HINT for the connected app —
 * additive by contract: the client may use it to ADD candidates its
 * own discovery missed and to order verification, but must never let
 * it SUPPRESS a chain-enumerated candidate (a fresh position-NFT
 * transfer can be absent from D1 until ingest safe-finalizes, and the
 * spec keeps the current holder's claim discoverable from chain).
 *
 * Deliberately separate from GET /claimables/:addr — that shape is a
 * typed apps/defi contract ({asLender, asBorrower} of full rows);
 * this one returns a flat (loanId, role, status) list ordered by
 * most-recently-touched first (verification priority). No
 * already-claimed activity filter here: a claim burns the position
 * NFT so `*_current_owner` flips to 0x0 and the side drops out; a
 * rare false positive costs the client one probe that getClaimable
 * (the actual authority) rejects.
 *
 * Bounded (Codex #1232 r2): a wallet holding a pathological number of
 * terminal position NFTs would otherwise turn one public GET into an
 * unbounded D1 read AND an unbounded client-side probe fan-out. The
 * response carries the most-recently-touched CLAIM_CANDIDATES_CAP
 * loan rows and is truncation-honest (`truncated: true`) — an omitted
 * tail id is simply unhinted, which the additive contract already
 * tolerates.
 */
const CLAIM_CANDIDATES_CAP = 200;

export async function handleClaimCandidates(
  req: Request,
  env: Env,
  addrRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    const rows = (
      await env.DB.prepare(
        // `internal_matched` is terminal AND claimable in the connected
        // app (its proper-close group), so the hint must cover it
        // (Codex #1232 r1). NOT copied from /claimables' narrower
        // three-status filter — that route's parity gap is tracked
        // separately.
        `SELECT loan_id, status, lender_current_owner, borrower_current_owner,
                updated_at
         FROM loans
         WHERE chain_id = ?
           AND status IN ('repaid', 'defaulted', 'liquidated', 'internal_matched')
           AND (lender_current_owner = ? OR borrower_current_owner = ?)
         ORDER BY updated_at DESC, loan_id DESC
         LIMIT ?`,
      )
        .bind(chainId, addr, addr, CLAIM_CANDIDATES_CAP + 1)
        .all<{
          loan_id: number;
          status: string;
          lender_current_owner: string | null;
          borrower_current_owner: string | null;
          updated_at: number;
        }>()
    ).results ?? [];
    const truncated = rows.length > CLAIM_CANDIDATES_CAP;
    const kept = truncated ? rows.slice(0, CLAIM_CANDIDATES_CAP) : rows;
    const candidates: Array<{
      loanId: number;
      role: 'lender' | 'borrower';
      status: string;
      updatedAt: number;
    }> = [];
    for (const row of kept) {
      if (row.lender_current_owner === addr) {
        candidates.push({
          loanId: row.loan_id,
          role: 'lender',
          status: row.status,
          updatedAt: row.updated_at,
        });
      }
      if (row.borrower_current_owner === addr) {
        candidates.push({
          loanId: row.loan_id,
          role: 'borrower',
          status: row.status,
          updatedAt: row.updated_at,
        });
      }
    }
    return jsonResponse({ chainId, address: addr, candidates, truncated });
  } catch (err) {
    console.error('[loanRoutes] claim-candidates failed', err);
    return jsonResponse({ error: 'claim-candidates-failed' }, 500);
  }
}

/**
 * GET /loans/stats?chainId=8453
 *
 * Aggregate loan counters + USD-agnostic per-asset volume. Replaces
 * the Analytics page's per-loan `getLoanDetails` multicall storm
 * with one O(table-scan) D1 query. Mirrors `/offers/stats` shape so
 * the frontend has a consistent contract.
 *
 * Returned shape:
 *   {
 *     chainId,
 *     active, repaid, defaulted, liquidated, settled, total,  // counts
 *     erc20ActiveLoans, nftRentalsActive,
 *     volumeByAsset: { [lowercaseAddr]: principalSumDecimal },
 *     averageInterestRateBps: number | null,
 *     indexer: { lastBlock, updatedAt } | null,
 *   }
 *
 * USD pricing is NOT done here — the frontend pulls oracle prices
 * via `getAssetPrice` and multiplies. This endpoint stays
 * deterministic and fast (no oracle dep).
 */
export async function handleLoansStats(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  try {
    // Counts per status.
    const counts = await env.DB.prepare(
      `SELECT status, COUNT(*) as n FROM loans WHERE chain_id = ? GROUP BY status`,
    )
      .bind(chainId)
      .all<{ status: string; n: number }>();
    const tally: Record<string, number> = {
      active: 0,
      repaid: 0,
      defaulted: 0,
      liquidated: 0,
      settled: 0,
    };
    for (const row of counts.results ?? []) {
      tally[row.status] = row.n;
    }
    // Asset-type breakdown for the active set (ERC-20 vs NFT rental).
    const assetTypeBreakdown = await env.DB.prepare(
      `SELECT asset_type, COUNT(*) as n
       FROM loans
       WHERE chain_id = ? AND status = 'active'
       GROUP BY asset_type`,
    )
      .bind(chainId)
      .all<{ asset_type: number; n: number }>();
    let erc20ActiveLoans = 0;
    let nftRentalsActive = 0;
    for (const row of assetTypeBreakdown.results ?? []) {
      // 0 = ERC-20, others = NFT-side variants. Matches the frontend
      // `AssetType.ERC20 = 0` enum convention.
      if (row.asset_type === 0) erc20ActiveLoans += row.n;
      else nftRentalsActive += row.n;
    }
    // Per-asset principal volume across ALL statuses (lifetime
    // protocol throughput). D1's SQLite stores `principal` as TEXT
    // (decimal string) since 18-decimal ERC-20 amounts overflow
    // 64-bit integer arithmetic — `SUM(CAST(principal AS INTEGER))`
    // would silently cap at 2^63-1 once a single loan's principal
    // crossed ~9.2e18 (just above 9.2 ETH-in-wei). So aggregate
    // client-side with BigInt instead. Bounded scan: rows are
    // already chain-scoped, and the loans table is on the order of
    // thousands at most for the foreseeable future. If that grows
    // past memory pressure we can add a precomputed
    // `volume_by_asset` materialised view.
    const volumeRows = await env.DB.prepare(
      `SELECT lending_asset, principal, interest_rate_bps
       FROM loans WHERE chain_id = ?`,
    )
      .bind(chainId)
      .all<{ lending_asset: string; principal: string; interest_rate_bps: number }>();
    const volumeByAsset: Record<string, bigint> = {};
    const loansByAsset: Record<string, number> = {};
    let aprSum = 0;
    let aprCount = 0;
    for (const row of volumeRows.results ?? []) {
      // Drop rows with unset / malformed `lending_asset` (legacy
      // testnet bookkeeping wrote `0x` for some NFT-rental loans
      // before the indexer normalised the column). Keeps the per-
      // asset breakdown clean without affecting the count tallies
      // computed above.
      if (!row.lending_asset || !row.lending_asset.startsWith('0x') || row.lending_asset.length < 42) {
        continue;
      }
      const key = row.lending_asset.toLowerCase();
      try {
        const p = BigInt(row.principal || '0');
        volumeByAsset[key] = (volumeByAsset[key] ?? 0n) + p;
        loansByAsset[key] = (loansByAsset[key] ?? 0) + 1;
      } catch {
        // Malformed principal (shouldn't happen with the indexer's
        // BigInt-safe writer, but guard anyway). Skip the row.
      }
      if (typeof row.interest_rate_bps === 'number') {
        aprSum += row.interest_rate_bps;
        aprCount += 1;
      }
    }
    const volumeByAssetSerialized: Record<string, string> = {};
    for (const [k, v] of Object.entries(volumeByAsset)) {
      volumeByAssetSerialized[k] = v.toString();
    }
    const averageInterestRateBps = aprCount > 0 ? aprSum / aprCount : null;
    const cursor = await env.DB.prepare(
      `SELECT last_block, updated_at FROM indexer_cursor
       WHERE chain_id = ? AND kind = 'diamond'`,
    )
      .bind(chainId)
      .first<{ last_block: number; updated_at: number }>();
    return jsonResponse({
      chainId,
      active: tally.active,
      repaid: tally.repaid,
      defaulted: tally.defaulted,
      liquidated: tally.liquidated,
      settled: tally.settled,
      total:
        tally.active + tally.repaid + tally.defaulted + tally.liquidated + tally.settled,
      erc20ActiveLoans,
      nftRentalsActive,
      volumeByAsset: volumeByAssetSerialized,
      loansByAsset,
      averageInterestRateBps,
      indexer: cursor
        ? {
            lastBlock: cursor.last_block,
            updatedAt: cursor.updated_at,
            // RPC read-diet PR 0 — mirrors /offers/stats: the ingest mode's
            // expected per-chain scan cadence (null = legacy/unknown →
            // clients keep the polling posture).
            scanCadenceSec:
              env.CHAIN_INGEST_VIA_DO === 'true'
                ? EXPECTED_SCAN_CADENCE_SEC
                : null,
          }
        : null,
    });
  } catch (err) {
    console.error('[loanRoutes] stats failed', err);
    return jsonResponse({ error: 'stats-failed' }, 500);
  }
}

/**
 * GET /loans/recent?chainId=8453&limit=50&before=<loan_id>
 *     [&lendingAsset=0x..&collateralAsset=0x..&durationDays=30&excludeSaleVehicles=1]
 *
 * Cross-status recent feed: most recent N loans regardless of state
 * (active / repaid / defaulted / liquidated / settled). Mirrors
 * `/offers/recent` — same indexer-first replacement for the per-loan
 * multicall the Analytics page used to do via `useLogIndex` ID
 * discovery + `getLoanDetails` multicall.
 */
export async function handleLoansRecent(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  // Rate Desk (#1129) — optional market scoping (lendingAsset /
  // collateralAsset / durationDays). Without it this is a GLOBAL newest-first
  // page capped at 200 rows, which cannot honestly serve a per-market tape —
  // a market whose fills are older than the first page would render falsely
  // empty. The filters ride `idx_loans_market` (migration 0029).
  // `excludeSaleVehicles=1` additionally drops lender-sale temp bookkeeping
  // loans (not market fills); opt-in so existing consumers of the unfiltered
  // feed keep their exact behaviour.
  const market = parseMarketFilter(url);
  if (market === 'bad') {
    return jsonResponse({ error: 'bad-market-filter' }, 400);
  }
  const excludeSaleVehicles = url.searchParams.get('excludeSaleVehicles') === '1';
  try {
    const conds: string[] = ['chain_id = ?'];
    const binds: (number | string)[] = [chainId];
    if (before) {
      conds.push('loan_id < ?');
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
    if (excludeSaleVehicles) {
      conds.push('is_sale_vehicle = 0');
    }
    const stmt = env.DB.prepare(
      `SELECT * FROM loans
       WHERE ${conds.join(' AND ')}
       ORDER BY loan_id DESC LIMIT ?`,
    ).bind(...binds, limit);
    const rows = await stmt.all<LoanRow>();
    const loans = (rows.results ?? []).map(loanToJson);
    const next =
      loans.length === limit && loans.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] recent failed', err);
    return jsonResponse({ error: 'recent-failed' }, 500);
  }
}

/**
 * GET /loans/timeseries?chainId=8453&range=30d
 *
 * Per-day buckets of ERC-20 loan principal + earned interest grouped
 * by lending_asset. Drives the Analytics "TVL Over Time" + "Daily
 * Loan Volume" charts. Frontend prices the per-asset BigInt volumes
 * to USD client-side using the oracle (`getAssetPrice`) over the
 * unique-asset set, same pattern as `useAssetBreakdown`. Server
 * stays deterministic + price-feed-free.
 *
 * Range:
 *   '24h' | '7d' | '30d' | '90d' | 'All'
 *
 * '24h' returns hourly buckets; the longer ranges return daily
 * buckets keyed at midnight-UTC of the day a loan started. 'All'
 * caps at 365 days back to match the existing frontend semantics
 * (the previous chain-derived flow used the same 365-day ceiling).
 *
 * Returned shape:
 *   {
 *     chainId,
 *     range,
 *     buckets: [
 *       {
 *         t: <unix-seconds at bucket start>,
 *         principalByAsset: { [lowercaseAddr]: decimal-string },
 *         interestByAsset:  { [lowercaseAddr]: decimal-string }
 *       },
 *       …
 *     ]
 *   }
 *
 * Interest is `principal × interest_rate_bps / 10_000` summed at the
 * bucket level — matches the lifetime-interest approximation the
 * frontend's chart used pre-refactor.
 */
export async function handleLoansTimeseries(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const rangeRaw = (url.searchParams.get('range') || '30d').trim();
  // 'All' uses the same 365-day cap as the frontend's previous
  // implementation; not strictly "all-time" but matches expectations
  // and keeps the result set bounded so a popular protocol can't
  // accidentally ship a 50 MB response.
  const RANGE_DAYS: Record<string, number> = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
    All: 365,
  };
  const days = RANGE_DAYS[rangeRaw] ?? 30;
  const bucketSec = rangeRaw === '24h' ? 3600 : 86400;
  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - days * 86400;
  try {
    // Pull only the columns the bucketing needs. ERC-20-only filter
    // (`asset_type = 0`) matches the frontend's exclusion of NFT
    // rentals from USD time-series — those have no oracle price.
    const rows = await env.DB.prepare(
      `SELECT start_at, lending_asset, principal, interest_rate_bps
       FROM loans
       WHERE chain_id = ? AND asset_type = 0 AND start_at >= ?
       ORDER BY start_at ASC`,
    )
      .bind(chainId, fromSec)
      .all<{
        start_at: number;
        lending_asset: string;
        principal: string;
        interest_rate_bps: number;
      }>();

    // Bucket by day (or hour for 24h). Per-asset BigInt
    // accumulators avoid the 2^53 floating-point ceiling that would
    // otherwise eat the low-end digits of 18-decimal token sums.
    const principalByBucket = new Map<number, Map<string, bigint>>();
    const interestByBucket = new Map<number, Map<string, bigint>>();
    for (const row of rows.results ?? []) {
      if (
        !row.lending_asset ||
        !row.lending_asset.startsWith('0x') ||
        row.lending_asset.length < 42
      ) {
        continue;
      }
      const t = Math.floor(row.start_at / bucketSec) * bucketSec;
      const asset = row.lending_asset.toLowerCase();
      let principal: bigint;
      try {
        principal = BigInt(row.principal || '0');
      } catch {
        continue;
      }
      // Lifetime interest approximation matches the pre-refactor
      // frontend behaviour: principal × rate-bps / 10_000. Real-time
      // accrual / partial-repay refinements live further down the
      // chart pipeline; the bucket sum is a "potential interest at
      // origination" lens, deliberately simple.
      const interest = (principal * BigInt(row.interest_rate_bps || 0)) / 10_000n;

      let pBucket = principalByBucket.get(t);
      if (!pBucket) {
        pBucket = new Map();
        principalByBucket.set(t, pBucket);
      }
      pBucket.set(asset, (pBucket.get(asset) ?? 0n) + principal);

      let iBucket = interestByBucket.get(t);
      if (!iBucket) {
        iBucket = new Map();
        interestByBucket.set(t, iBucket);
      }
      iBucket.set(asset, (iBucket.get(asset) ?? 0n) + interest);
    }

    const buckets = Array.from(principalByBucket.keys())
      .sort((a, b) => a - b)
      .map((t) => {
        const principalByAsset: Record<string, string> = {};
        const interestByAsset: Record<string, string> = {};
        for (const [k, v] of principalByBucket.get(t) ?? new Map()) {
          principalByAsset[k] = v.toString();
        }
        for (const [k, v] of interestByBucket.get(t) ?? new Map()) {
          interestByAsset[k] = v.toString();
        }
        return { t, principalByAsset, interestByAsset };
      });

    return jsonResponse({ chainId, range: rangeRaw, buckets });
  } catch (err) {
    console.error('[loanRoutes] timeseries failed', err);
    return jsonResponse({ error: 'timeseries-failed' }, 500);
  }
}

/**
 * Rate Desk phase 2 (#1130) — GET /loans/rate-candles
 *   ?chainId=8453&lendingAsset=0x..&collateralAsset=0x..&durationDays=30
 *   &interval=1h|4h|1d&range=7d|30d|90d|all
 *
 * → { chainId, buckets: [{ t, open, high, low, close, fills, principalTotal }] }
 *
 * Executed-rate OHLC series for ONE market (ProRateTerminalDesign.md §7). All
 * three market params are REQUIRED — a candle series is per-market by
 * definition; there is no "global candles" fallback. `interval`/`range`
 * default to 1h/30d when omitted and 400 on anything outside the enums.
 *
 * Row scope — executed MARKET FILLS only:
 *   - `is_sale_vehicle = 0`: the temp bookkeeping loan a lender-sale vehicle
 *     initiates is a secondary sale, never a fresh rate print (§7).
 *   - `asset_type = 0 AND collateral_asset_type = 0`: ERC-20 both legs. The
 *     desk's markets are ERC-20/ERC-20 pairs; NFT-legged loans are a
 *     different product surface (rentals) and their rate isn't comparable.
 *   - Metadata-less stub rows (fallback-B inserts, lending_asset = '0x')
 *     can never match the market equality filter, so no explicit `is_stub`
 *     predicate is needed — and MUST NOT be added: a companion-path row with
 *     is_stub = 1 only lacks its position token ids (see the LoanInitiated
 *     insert paths in chainIndexer.ts); its market/rate/principal columns are
 *     real and its fill belongs on the chart.
 *
 * IMMUTABLE FILL TERMS (Codex #1139 round-5 P2): a candle is a record of
 * EXECUTED fills, but the loans row is a mutable projection — PartialRepaid /
 * swap-partial / internal-match rewrite `principal`, and LoanExtended
 * rewrites `interest_rate_bps` + `duration_days` in place. Reading those
 * live would retroactively shrink executed volume and teleport an extended
 * 30d fill into the 60d market at its original start_at. So BOTH the tenor
 * scope AND the selected rate/principal read the init_* snapshot columns
 * (stamped at every LoanInitiated insert path, never mutated — migration
 * 0032 §2), COALESCEd to the mutable column only for rows written by a
 * pre-snapshot worker in the migration→deploy window (the 0032 backfill
 * fills everything that exists at apply time). The COALESCE tenor
 * expression is spelled IDENTICALLY to the 0032 expression index so the
 * planner can match it textually; correctness doesn't depend on the index.
 * `start_at` needs no snapshot — it is written once at insert and no
 * handler updates it (LoanExtended/partial repay reset `start_time`, a
 * different column).
 *
 * Aggregation split (§7): SQL selects the market's rows in the range ordered
 * by (start_at, loan_id); ALL folding — OHLC, fills, principal — happens in
 * JS (`foldRateCandles`). Rationale in rateCandles.ts: principal MUST be
 * BigInt-folded (the /loans/stats pattern), and SQLite has no first/last
 * aggregate for open/close, so one ordered select + one JS pass is the
 * simplest correct shape. Rides `idx_loans_market_start_at` (migration 0032).
 *
 * Buckets: only where fills >= 1 (no empty/interpolated buckets — §5.3),
 * ascending by t. `range=all` = no lower time bound.
 * `Cache-Control: max-age=60` per the spec (candles are heavier to compute
 * and change at fill cadence, not block cadence).
 */
export async function handleLoansRateCandles(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const market = parseMarketFilter(url);
  if (market === 'bad') {
    return jsonResponse({ error: 'bad-market-filter' }, 400);
  }
  if (
    !market.lendingAsset ||
    !market.collateralAsset ||
    market.durationDays === null
  ) {
    return jsonResponse({ error: 'market-filter-required' }, 400);
  }
  // Own-property lookups only: a raw query key like `interval=toString`
  // must read as undefined (→ 400), never an inherited Object.prototype
  // member (Codex #1139 round-1 P3). The enum objects are null-prototype
  // too (rateCandles.ts) — belt and suspenders on a public query surface.
  const intervalRaw = url.searchParams.get('interval') ?? '1h';
  const intervalSec = Object.hasOwn(CANDLE_INTERVALS, intervalRaw)
    ? CANDLE_INTERVALS[intervalRaw]
    : undefined;
  if (intervalSec === undefined) {
    return jsonResponse({ error: 'bad-interval' }, 400);
  }
  const rangeRaw = url.searchParams.get('range') ?? '30d';
  const rangeDays = Object.hasOwn(CANDLE_RANGES, rangeRaw)
    ? CANDLE_RANGES[rangeRaw]
    : undefined;
  if (rangeDays === undefined) {
    return jsonResponse({ error: 'bad-range' }, 400);
  }
  // Fail closed when this chain isn't indexed here (Codex #1139 round-1
  // P2): an unindexed chain would otherwise query D1 anyway and serve a
  // CACHEABLE 200 with empty/stale buckets, which the chart renders as
  // an honest zero-fill market. Same #749 posture as the participant /
  // current-holder routes — a 503 keeps the frontend's tri-state on
  // "unavailable", never a false empty.
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    const conds = [
      'chain_id = ?',
      'lending_asset = ?',
      'collateral_asset = ?',
      // Tenor scope on the INIT duration (see the immutable-fill-terms
      // header note) — an extended loan's fill stays in the market it
      // executed in. Expression spelled exactly like the 0032 index.
      'COALESCE(init_duration_days, duration_days) = ?',
      'is_sale_vehicle = 0',
      'asset_type = 0',
      'collateral_asset_type = 0',
    ];
    const binds: (number | string)[] = [
      chainId,
      market.lendingAsset,
      market.collateralAsset,
      market.durationDays,
    ];
    if (rangeDays !== null) {
      conds.push('start_at >= ?');
      binds.push(Math.floor(Date.now() / 1000) - rangeDays * 86400);
    }
    // Aliased so CandleFillRow / foldRateCandles stay shape-agnostic: the
    // fill's terms are the INIT snapshot, never the mutated live values.
    const rows = await env.DB.prepare(
      `SELECT loan_id, start_at,
              COALESCE(init_rate_bps, interest_rate_bps) AS interest_rate_bps,
              COALESCE(init_principal, principal) AS principal
       FROM loans
       WHERE ${conds.join(' AND ')}
       ORDER BY start_at ASC, loan_id ASC`,
    )
      .bind(...binds)
      .all<CandleFillRow>();
    const buckets = foldRateCandles(rows.results ?? [], intervalSec);
    return jsonResponse({ chainId, buckets }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (err) {
    console.error('[loanRoutes] rate-candles failed', err);
    return jsonResponse({ error: 'rate-candles-failed' }, 500);
  }
}

/**
 * Rate Desk phase 2 (#1130) — GET /loans/by-participant
 *   ?chainId=8453&wallet=0x..&limit=50&before=<participatedAt>_<loanId>
 *
 * → { chainId, wallet, loans: [{ ...loanToJson, participatedAt,
 *     roles: ['lender'|'borrower'] }], nextBefore }
 *
 * HISTORICAL-participant view backing the desk's History tab
 * (ProRateTerminalDesign.md §3 History row): every loan — ANY status — where
 * the wallet has a persisted `loan_participants` row (seeded at LoanInitiated
 * from the current-owner projection, appended on every position-NFT
 * transfer / token-id migration, never deleted). This is deliberately NOT
 * derivable from the immutable loans.lender/borrower columns (they miss
 * pre-accept offer-NFT buyers and later transferees) nor from the
 * `*_current_owner` projection (burned-on-claim positions drop out — the
 * exact "lender whose loan was repaid+claimed disappears" gap
 * Activity.tsx:72-74 documents).
 *
 * `roles` aggregates the wallet's participation roles on that loan (a wallet
 * can be both sides, e.g. it bought the counterparty NFT).
 *
 * Ordering + pagination (Codex #1139 round-3): newest PARTICIPATION first —
 * MAX(from_at) over the wallet's rows on the loan, DESC, loan_id DESC as
 * the stable tiebreak. Loan-id-only ordering buried a recent transfer into
 * an older loan id behind older participation in newer ids. The cursor is
 * composite to match: `before=<participatedAt>_<loanId>`, strict
 * lexicographic less-than; `nextBefore` is returned in the same encoding.
 */
export async function handleLoansByHistoricalParticipant(
  req: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId')) ?? 8453;
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseParticipationCursor(url.searchParams.get('before'));
  const walletRaw = url.searchParams.get('wallet');
  if (!walletRaw) {
    return jsonResponse({ error: 'wallet-required' }, 400);
  }
  const wallet = walletRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  // Fail closed when this chain isn't indexed here, so the frontend's
  // indexer-first → on-chain-fallback wrapper actually falls back (#749) —
  // same posture as the sibling wallet routes.
  if (!chainConfigured(env, chainId)) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    // Desk scoping lives in the ROUTE, not the table (Codex #1139 round-3):
    // `loan_participants` deliberately stays append-EVERYTHING — every
    // LoanInitiated / position transfer, any asset shape — so a future
    // all-history consumer can reuse it unfiltered. The desk's History tab
    // is an ERC-20/ERC-20, non-sale-vehicle surface (the same scope the
    // tape and candle routes apply); without these three predicates
    // NFT-leg loans and internal sale vehicles would present as desk
    // history.
    // Stub-shape guard (Codex #1139 round-4): the LoanInitiated
    // fallback-B insert writes placeholder market fields —
    // lending_asset / collateral_asset = '0x', duration_days = 0 —
    // until `refreshStubLoans` heals the row (and forever, if the heal
    // keeps failing). Such a row would otherwise pass the ERC-20 scope
    // (asset_type 0 is the placeholder too) and render a fake desk-
    // history entry. Guard on the SHAPE (real 42-char 0x addresses +
    // a real ≥1-day term) rather than a blanket `is_stub = 0`: the
    // companion-event insert path can land `is_stub = 1` with fully
    // real market fields while only its position-token ids await the
    // heal, and hiding those rows would drop genuine desk history.
    const conds = [
      'p.chain_id = ?',
      'p.wallet = ?',
      'l.asset_type = 0',
      'l.collateral_asset_type = 0',
      'l.is_sale_vehicle = 0',
      "l.lending_asset LIKE '0x%' AND length(l.lending_asset) = 42",
      "l.collateral_asset LIKE '0x%' AND length(l.collateral_asset) = 42",
      'l.duration_days >= 1',
    ];
    const binds: (number | string)[] = [chainId, wallet];
    // The composite cursor compares against the per-loan MAX(from_at)
    // aggregate, so it must live in HAVING, not WHERE — OR-expanded
    // lexicographic (participated_at, loan_id) < (:t, :id).
    let having = '';
    if (before) {
      having = `HAVING MAX(p.from_at) < ?
                OR (MAX(p.from_at) = ? AND l.loan_id < ?)`;
      binds.push(before.participatedAt, before.participatedAt, before.loanId);
    }
    // One row per loan; GROUP_CONCAT folds the wallet's roles on it. The
    // participation index (chain_id, wallet, loan_id) serves the filter;
    // the newest-participation sort runs over just the wallet's own rows,
    // and the loans join is a PK lookup per row.
    const rows = await env.DB.prepare(
      `SELECT l.*, GROUP_CONCAT(DISTINCT p.role) AS participant_roles,
              MAX(p.from_at) AS participated_at
       FROM loan_participants p
       JOIN loans l ON l.chain_id = p.chain_id AND l.loan_id = p.loan_id
       WHERE ${conds.join(' AND ')}
       GROUP BY l.chain_id, l.loan_id
       ${having}
       ORDER BY participated_at DESC, l.loan_id DESC
       LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<LoanRow & { participant_roles: string; participated_at: number }>();
    const results = rows.results ?? [];
    const loans = results.map((row) => ({
      ...loanToJson(row),
      // When the wallet's newest participation on the loan was observed
      // (unix seconds) — the value the ordering + cursor run on.
      participatedAt: row.participated_at,
      // Sorted for a deterministic wire shape (GROUP_CONCAT order is
      // unspecified in SQLite).
      roles: (row.participant_roles ?? '').split(',').filter(Boolean).sort(),
    }));
    const last = results.length > 0 ? results[results.length - 1] : null;
    const next =
      last !== null && results.length === limit
        ? `${last.participated_at}_${last.loan_id}`
        : null;
    return jsonResponse({ chainId, wallet, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] by-participant failed', err);
    return jsonResponse({ error: 'by-participant-failed' }, 500);
  }
}

export function handleLoansPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      // #335 — `POST /loans/:loanId/prepay-listing/match-source`
      // is the only POST entry under /loans/* today; allowed
      // alongside the existing GETs.
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** #335 — POST /loans/:loanId/prepay-listing/match-source
 *
 *  Records a breadcrumb mapping a successful Match-rotation tx to
 *  the OpenSea offer that triggered it. The on-chain
 *  `PrepayListingUpdated` event the rotation emits doesn't carry
 *  the originating offer ID (the rotation is just an order-shape
 *  update from the diamond's POV); the dapp posts the breadcrumb
 *  after the tx confirms so analytics queries can later
 *  distinguish "Match-from-OpenSea-offer rotation" from "manual
 *  repricing".
 *
 *  Body shape:
 *    {
 *      txHash: \`0x\${string}\`     // rotation tx hash
 *      orderHash: \`0x\${string}\`  // OpenSea offer's canonical hash
 *      bidder: \`0x\${string}\`     // OpenSea offer's Seaport offerer
 *      matchedAt: number          // Unix seconds, dapp clock
 *    }
 *
 *  **Best-effort analytics surface.** The breadcrumb is NOT a
 *  prerequisite for the Match flow. The rotation tx is already
 *  on-chain by the time the dapp POSTs here; if the POST fails
 *  (network blip, indexer down), the rotation is unaffected.
 *  Downstream analytics queries treat the absence of a breadcrumb
 *  as "matched via the manual repricing path" — the conservative
 *  interpretation.
 *
 *  **Spoofing window — INSERT OR REPLACE + overwrite warning.**
 *  The endpoint is unauthenticated; an attacker who observes a
 *  real rotation tx hash on chain can POST a bogus breadcrumb
 *  before (or after) the legitimate dapp does. Round-1 used
 *  INSERT OR IGNORE, which would let the first-arriving writer
 *  (potentially the attacker) win permanently — the legitimate
 *  dapp's retry would silently no-op. Round-2 (Codex P2 #343)
 *  switched to INSERT OR REPLACE so the legitimate dapp's retry
 *  can override a spoof, and emits an operator-visible warning
 *  whenever a row is overwritten with a DIFFERENT payload (so a
 *  sustained spoof attack would show up in the indexer logs as
 *  a tx_hash receiving multiple distinct (orderHash, bidder)
 *  writes).
 *
 *  Full prevention would need EIP-712 signed claims from the
 *  rotation tx's sender (the borrower) — v2 follow-up if
 *  production signal shows the spoofing window mattering in
 *  practice. For non-financial analytics metadata the
 *  best-effort + replace + warn shape is the right v1.1 trade-
 *  off.
 *
 *  **Multi-chain.** Loan IDs are scoped per chain. The
 *  breadcrumb table's primary key is `(chain_id, tx_hash)`; the
 *  endpoint accepts `chainId` from the query string (same
 *  convention as the GET routes). */
export async function handleLoanPrepayMatchSource(
  req: Request,
  env: Env,
  loanIdRaw: string,
): Promise<Response> {
  // #335 — per-IP rate-limit BEFORE the validation gates so a
  // scripted attacker spamming malformed payloads can't burn
  // through the D1 query budget on invalid-input branches. When
  // the binding isn't provisioned this is a no-op; the strict
  // hex validation + INSERT OR REPLACE conflict policy still
  // keep the endpoint defensible.
  if (env.OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT) {
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.OPENSEA_OFFERS_MATCH_SOURCE_RATELIMIT.limit({
      key: ip,
    });
    if (!success) {
      return jsonResponse({ error: 'rate-limited' }, 429);
    }
  }
  const loanId = Number.parseInt(loanIdRaw, 10);
  if (!Number.isFinite(loanId) || loanId < 0) {
    return jsonResponse({ error: 'bad-loan-id' }, 400);
  }
  const url = new URL(req.url);
  const chainId = parseChainId(url.searchParams.get('chainId'));
  if (chainId === null) {
    return jsonResponse({ error: 'bad-chain-id' }, 400);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid-json' }, 400);
  }
  if (body === null || typeof body !== 'object') {
    return jsonResponse({ error: 'invalid-body' }, 400);
  }
  const o = body as Record<string, unknown>;

  // Strict hex validation — the breadcrumb is keyed on tx_hash, so
  // a malformed payload would just sit in the table forever; reject
  // upfront so query-side joins stay clean.
  const HEX64 = /^0x[0-9a-fA-F]{64}$/;
  const HEX40 = /^0x[0-9a-fA-F]{40}$/;
  if (typeof o.txHash !== 'string' || !HEX64.test(o.txHash)) {
    return jsonResponse({ error: 'invalid-tx-hash' }, 400);
  }
  if (typeof o.orderHash !== 'string' || !HEX64.test(o.orderHash)) {
    return jsonResponse({ error: 'invalid-order-hash' }, 400);
  }
  if (typeof o.bidder !== 'string' || !HEX40.test(o.bidder)) {
    return jsonResponse({ error: 'invalid-bidder' }, 400);
  }
  if (
    typeof o.matchedAt !== 'number' ||
    !Number.isFinite(o.matchedAt) ||
    o.matchedAt <= 0
  ) {
    return jsonResponse({ error: 'invalid-matched-at' }, 400);
  }

  try {
    const txHash = o.txHash.toLowerCase();
    const orderHash = o.orderHash.toLowerCase();
    const bidder = o.bidder.toLowerCase();
    // Pre-check: if a row already exists for this (chain_id, tx_hash)
    // and the new payload differs from what's there, emit an
    // operator-visible warning so a sustained spoof attack shows
    // up in the indexer's logs. The legitimate dapp retry is
    // idempotent (same fields); only an attacker would post a
    // DIFFERENT (orderHash, bidder, loan_id).
    //
    // Codex round-3 P2 — loan_id MUST be part of this check.
    // INSERT OR REPLACE below also overwrites loan_id (it's a
    // non-PK column on the same composite key), so a spoofer
    // POSTing to a different /loans/<wrong-id>/... URL with the
    // same public (orderHash, bidder) silently moves the
    // breadcrumb onto a different loan and corrupts the
    // loan-history join. Comparing loan_id surfaces that case.
    const existing = await env.DB.prepare(
      `SELECT loan_id, order_hash, bidder, match_mode
       FROM prepay_listing_match_breadcrumbs
       WHERE chain_id = ? AND tx_hash = ?`,
    )
      .bind(chainId, txHash)
      .first<{
        loan_id: number;
        order_hash: string;
        bidder: string;
        match_mode: string;
      }>();
    if (
      existing !== null &&
      (existing.order_hash !== orderHash ||
        existing.bidder !== bidder ||
        existing.loan_id !== loanId)
    ) {
      console.warn(
        '[loanRoutes] match-source overwrite — possible spoof',
        {
          chainId,
          txHash,
          was: existing,
          now: { loanId, orderHash, bidder },
        },
      );
    }
    // T-086 Block D / Codex round-5 P2 on PR #346: the chainIndexer
    // event-source writes `match_mode = 'atomic'` for every
    // `PrepayListingMatched` event. A late or spoofed v1-style POST
    // to this route must NOT silently downgrade an existing
    // event-sourced atomic row to `v1-twostep` — that defeats the
    // durable match-mode signal migration 0020 added. The ON CONFLICT
    // clause below preserves an existing `atomic` match_mode while
    // still letting a legitimate dapp's v1-twostep retry override an
    // attacker's first-arrival v1-twostep spoof (the public-data
    // race-conditioner pattern is unchanged for v1 rows).
    //
    // We also log + warn when an attempted v1-twostep POST tries to
    // overwrite an atomic row so operators see the downgrade attempt.
    if (existing !== null && existing.match_mode === 'atomic') {
      console.warn(
        '[loanRoutes] match-source POST blocked — atomic breadcrumb preserved',
        {
          chainId,
          txHash,
          existing: { match_mode: existing.match_mode },
          attempted: { loanId, orderHash, bidder, match_mode: 'v1-twostep' },
        },
      );
    }
    await env.DB.prepare(
      `INSERT INTO prepay_listing_match_breadcrumbs
         (chain_id, tx_hash, loan_id, order_hash, bidder, matched_at, match_mode)
       VALUES (?, ?, ?, ?, ?, ?, 'v1-twostep')
       ON CONFLICT(chain_id, tx_hash) DO UPDATE SET
         loan_id = CASE WHEN prepay_listing_match_breadcrumbs.match_mode = 'atomic'
                        THEN prepay_listing_match_breadcrumbs.loan_id
                        ELSE excluded.loan_id END,
         order_hash = CASE WHEN prepay_listing_match_breadcrumbs.match_mode = 'atomic'
                           THEN prepay_listing_match_breadcrumbs.order_hash
                           ELSE excluded.order_hash END,
         bidder = CASE WHEN prepay_listing_match_breadcrumbs.match_mode = 'atomic'
                       THEN prepay_listing_match_breadcrumbs.bidder
                       ELSE excluded.bidder END,
         matched_at = CASE WHEN prepay_listing_match_breadcrumbs.match_mode = 'atomic'
                           THEN prepay_listing_match_breadcrumbs.matched_at
                           ELSE excluded.matched_at END,
         match_mode = CASE WHEN prepay_listing_match_breadcrumbs.match_mode = 'atomic'
                           THEN 'atomic'
                           ELSE excluded.match_mode END`,
    )
      .bind(
        chainId,
        txHash,
        loanId,
        orderHash,
        bidder,
        Math.floor(o.matchedAt),
      )
      .run();
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('[loanRoutes] match-source insert failed', err);
    return jsonResponse({ error: 'insert-failed' }, 500);
  }
}

/** Rate Desk (#1129) — optional (pair, tenor) market scoping shared by the
 *  desk-facing feeds. Addresses are stored lowercase at ingest, so params are
 *  lowercased before matching; malformed values are a 400, never a silent
 *  unfiltered fallback (an unfiltered "filtered" response would advertise the
 *  wrong market's rows as the requested one). */
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

/** Composite cursor for /loans/by-participant — `<participatedAt>_<loanId>`,
 *  matching that route's (newest-participation DESC, loan_id DESC) ordering
 *  (Codex #1139 round-3). A plain loan-id cursor cannot page that order: a
 *  recent transfer into an older loan id sorts to the top, and a
 *  loan-id-only `before` would skip or repeat it. Malformed values are
 *  treated as "no cursor" — first page — same lenient posture as
 *  parseBefore. */
function parseParticipationCursor(
  raw: string | null,
): { participatedAt: number; loanId: number } | null {
  if (!raw) return null;
  const m = /^(\d+)_(\d+)$/.exec(raw);
  if (!m) return null;
  const participatedAt = Number.parseInt(m[1], 10);
  const loanId = Number.parseInt(m[2], 10);
  return Number.isFinite(participatedAt) &&
    participatedAt >= 0 &&
    Number.isFinite(loanId) &&
    loanId > 0
    ? { participatedAt, loanId }
    : null;
}
