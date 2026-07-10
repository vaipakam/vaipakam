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

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

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
 * claimed (LoanSettled event flipped them).
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
         WHERE chain_id = ? AND status IN ('repaid', 'defaulted', 'liquidated')
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
        ? { lastBlock: cursor.last_block, updatedAt: cursor.updated_at }
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
    if (!Number.isInteger(n) || n < 1 || n > 365) return 'bad';
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
