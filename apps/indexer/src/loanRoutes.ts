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

import { type Env } from './env';
import {
  graceSecondsFromBuckets,
  loanDeadlines,
  pauseInForceAt,
} from '@vaipakam/lib/loanClock';
import { readLoanClockSnapshot, type LoanClockSnapshotRead } from '@vaipakam/lib/loanClockSnapshot';
import { redactedError } from '@vaipakam/lib/errorDescription';
import { chainNotServed, parseChainId, requestedChainId } from './servedChain';
import { EXPECTED_SCAN_CADENCE_SEC } from './chainIngestDO';
import {
  type RepairObservationRow,
  repairObservationPosition,
  repairObservationsPage,
  repairObservationToJson,
} from './repairObservations';
import {
  CANDLE_INTERVALS,
  CANDLE_RANGES,
  foldRateCandles,
  type CandleFillRow,
} from './rateCandles';
import {
  PLACED_IN_TENOR_SQL,
  PLACEMENT_RULE,
  placedTenorOf,
  readUnplacedCount,
  unplacedOnPairStatement,
} from './marketPlacement';

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

interface LoanRow {
  chain_id: number;
  loan_id: number;
  offer_id: number;
  status: string;
  lender: string;
  borrower: string;
  principal: string;
  // 0032 — the principal the loan was INITIATED with, stamped once at
  // every LoanInitiated insert path and never touched by a mutation
  // handler (partial repay, swap-to-repay, internal match all rewrite
  // `principal`). NULL only for a row a pre-0032 worker wrote and the
  // backfill could not reach.
  init_principal: string | null;
  // 0056 — 1 when `init_principal` is a 0032 fallback copy the
  // `LoanInitiated` ledger does not back. The candles still read the value
  // (a frozen best figure); the app is never told it as history.
  // Absent (undefined) on a database 0056 has not reached.
  init_principal_unbacked?: number;
  // 0058 — the initiation terms (0032) and whether the ledger backs them.
  init_rate_bps: number | null;
  init_duration_days: number | null;
  // Absent (undefined) on a database 0058 has not reached.
  init_terms_unbacked?: number;
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
  // 0060 — 1 when a settled row's `terminal_at` is the chain's time for its
  // settlement block. Absent on a database 0060 has not reached.
  terminal_at_verified?: number;
  updated_at: number;
}

/**
 * The loan clock a response's loans are dated by (#2808): the chain's
 * snapshotted grace schedule and pause log, and the moment the deadlines are
 * computed at. One per response, so every loan in it is dated at the same
 * instant from the same snapshot.
 */
interface LoanClockView {
  read: LoanClockSnapshotRead;
  nowSec: bigint;
}

async function loanClockView(env: Env, chainId: number): Promise<LoanClockView> {
  return {
    read: await readLoanClockSnapshot(env.DB, chainId),
    nowSec: BigInt(Math.floor(Date.now() / 1000)),
  };
}

/**
 * An ACTIVE loan's deadlines, on the D2 loan clock (#668 / #935): the due
 * date and grace end moved by the protocol's paused time since the loan's
 * start — the figures `LoanFacet.getLoanDeadlines` returns, never
 * `startTime + durationDays` (that is `originalMaturity`, the due date the
 * loan was announced with, and after a pause it is early).
 *
 * Served as `{ available: false, reason }` when the chain's grace schedule or
 * pause log is not known to this indexer: a date that might be early is not
 * served as current. `pauseInForce` says the protocol is paused at `asOf`;
 * while it is, the credit grows with the clock, so the dates keep moving and
 * the time LEFT to them is what stays fixed. Omitted for a loan that is not
 * Active: its deadlines no longer govern anything.
 */
function deadlinesJson(row: LoanRow, clock: LoanClockView): Record<string, unknown> | undefined {
  if (row.status !== 'active') return undefined;
  if (!clock.read.known) return { available: false, reason: clock.read.reason };
  // An unhealed stub has no real clock yet (start_time 0).
  if (row.start_time <= 0) return { available: false, reason: 'loan-not-indexed' };
  const { graceBuckets, pauseLog } = clock.read.snapshot;
  const durationDays = BigInt(row.duration_days);
  const d = loanDeadlines(
    { startTime: BigInt(row.start_time), durationDays },
    graceSecondsFromBuckets(graceBuckets, durationDays),
    pauseLog,
    clock.nowSec,
  );
  return {
    available: true,
    originalMaturity: Number(d.originalMaturity),
    pauseCredit: Number(d.pauseCredit),
    maturity: Number(d.maturity),
    graceEnd: Number(d.graceEnd),
    pauseInForce: pauseInForceAt(pauseLog, clock.nowSec),
    asOf: Number(clock.nowSec),
  };
}

function loanToJson(row: LoanRow, clock: LoanClockView): Record<string, unknown> {
  const deadlines = deadlinesJson(row, clock);
  return {
    chainId: row.chain_id,
    loanId: row.loan_id,
    offerId: row.offer_id,
    status: row.status,
    lender: row.lender,
    borrower: row.borrower,
    principal: row.principal,
    // #2453 — what was lent/borrowed, as opposed to `principal`, which is
    // what is still outstanding (zero once internal matching cleared it).
    // null = not recorded for this row, or recorded but not backed by the
    // chain's initiation event (0056); the app says so rather than guess.
    //
    // #2478 r2 (P1) — BACKED is the explicit 0 and nothing else. HTTP is not
    // behind the schema gate, so a Worker published before its migration
    // reads rows WITHOUT the flag column; testing `=== 1` would serve every
    // unverified snapshot as history in that window. An absent flag is
    // "not known to be backed", which is withheld like a flagged one.
    initPrincipal: row.init_principal_unbacked === 0 ? (row.init_principal ?? null) : null,
    // #2467 — the rate and duration the loan EXECUTED at, as opposed to the
    // live `interestRateBps` / `durationDays`, which `LoanExtended` rewrites.
    // Null unless the ledger backs both (0058) — never the live terms.
    // Backed only on the explicit 0, for the reason above.
    initRateBps: row.init_terms_unbacked === 0 ? (row.init_rate_bps ?? null) : null,
    initDurationDays: row.init_terms_unbacked === 0 ? (row.init_duration_days ?? null) : null,
    // #1142 — the tenor MARKET the loan is a fill of, by the one placement
    // rule the candles and the market-scoped `/loans/recent` select on
    // (marketPlacement.ts), so a client re-checking a scoped page compares
    // the key the server used. null = placed in no market: the agreed terms
    // are not confirmed, so any tenor would be a guess.
    marketDurationDays: placedTenorOf(row),
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
    // #2476 r15 — a SETTLED row's time is served only when verified (0060):
    // an unverified one may be a previous Worker's scan clock, and stating
    // when the indexer noticed a settlement as when it happened is the claim
    // this withholds. Other terminal statuses are served as stored.
    terminalAt: row.status === 'settled' && row.terminal_at_verified !== 1 ? null : row.terminal_at,
    updatedAt: row.updated_at,
    ...(deadlines ? { deadlines } : {}),
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
  // 0055 (#2383) — the normalized value (activityValue.ts). NULL = not
  // established for this row; `undefined` = the column does not exist yet
  // (this build reading a database before 0055 — `SELECT *` keeps that
  // working). Both serve as null.
  asset?: string | null;
  asset_type?: number | null;
  amount?: string | null;
  amount_max?: string | null;
  token_id?: string | null;
  quantity?: string | null;
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
    // #2383 — what the row moved or offered. `amount`/`amountMax` are base
    // units of an ERC-20 `asset`; `tokenId` names an NFT. null = unknown,
    // and a client must show nothing rather than reconstruct it from args.
    asset: row.asset ?? null,
    assetType: row.asset_type ?? null,
    amount: row.amount ?? null,
    amountMax: row.amount_max ?? null,
    tokenId: row.token_id ?? null,
    // #2383 r1 — an ERC-1155's quantity (null for any other asset).
    quantity: row.quantity ?? null,
  };
}

/** GET /loans/active?chainId=8453&limit=50&before=<loan_id> */
export async function handleLoansActive(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
    const clock = await loanClockView(env, chainId);
    const loans = (rows.results ?? []).map((r) => loanToJson(r, clock));
    const next =
      loans.length === limit && loans.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] active failed', redactedError(err));
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
  const chainId = requestedChainId(url);
  const loanId = Number.parseInt(loanIdRaw, 10);
  if (!Number.isFinite(loanId) || loanId < 0) {
    return jsonResponse({ error: 'bad-loan-id' }, 400);
  }
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
    const payload: Record<string, unknown> = loanToJson(row, await loanClockView(env, chainId));
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
      // `makerAmount` is the auction lot (#2322) — the collateral the
      // debt needs, not the loan's whole collateral. The whole
      // collateral, the lot included, stays pledged in the borrower's
      // vault until the fill (#1566 slice 3), and that vault is the
      // order's maker (S3e).
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
    console.error('[loanRoutes] byId failed', redactedError(err));
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
  const chainId = requestedChainId(url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  // Fail closed when this chain isn't indexed here, so the frontend's
  // indexer-first → on-chain-fallback wrapper actually falls back (#749).
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
    const clock = await loanClockView(env, chainId);
    const loans = rows.map((r) => loanToJson(r, clock));
    const next =
      rows.length === limit && rows.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, side, address: addr, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] byParticipant failed', redactedError(err));
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
  const chainId = requestedChainId(url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const before = parseBefore(url.searchParams.get('before'));
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
    const clock = await loanClockView(env, chainId);
    const loans = rows.map((r) => loanToJson(r, clock));
    const next =
      rows.length === limit && rows.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, address: addr, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] byCurrentHolder failed', redactedError(err));
    return jsonResponse({ error: 'byCurrentHolder-failed' }, 500);
  }
}

/** Most event kinds one `/activity` request may filter on at once. */
const MAX_ACTIVITY_KINDS = 8;

/** GET /activity?chainId=8453&actor=0x...&loanId=N&offerId=N&kind=K[,K...]&limit=50&before=<block:logIndex>&repairObservations=1
 *
 *  Cursor format: composite "block:logIndex" (e.g. `12345:6`) so a
 *  cron-deferred block on the boundary doesn't drop rows. When omitted,
 *  page starts at the head of the ledger. */
export async function handleActivity(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
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
    // One kind, or a comma-separated list of them read as ONE stream in feed
    // order (#1209: a past seller's loans are those any seller-claim event
    // names, under one cursor rather than one per kind).
    const kinds = kind.split(',');
    if (kinds.length > MAX_ACTIVITY_KINDS || kinds.some((k) => !/^[A-Za-z]+$/.test(k))) {
      return jsonResponse({ error: 'bad-kind' }, 400);
    }
    where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    binds.push(...kinds);
  }
  let before: { block: number; logIndex: number } | undefined;
  if (beforeRaw) {
    const m = beforeRaw.match(/^(\d+):(\d+)$/);
    if (!m) return jsonResponse({ error: 'bad-before' }, 400);
    before = { block: Number.parseInt(m[1], 10), logIndex: Number.parseInt(m[2], 10) };
    where.push('(block_number, log_index) < (?, ?)');
    binds.push(before.block, before.logIndex);
  }
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    const sql = `SELECT * FROM activity_events
                 WHERE ${where.join(' AND ')}
                 ORDER BY block_number DESC, log_index DESC
                 LIMIT ?`;
    binds.push(limit);
    const rows = await env.DB.prepare(sql).bind(...binds).all<ActivityRow>();
    // #2195 — repaired loans' endings, merged into the same order (see
    // `repairObservations.ts`). They carry no actor, offer or event kind, so
    // a page filtered on any of those has none. Each half is read to the
    // page's limit, so the page's top `limit` of the union is exact.
    //
    // OPT-IN (`repairObservations=1`): merged entries take page slots, and a
    // reader that does not render them would otherwise see fewer events per
    // page with nothing to show for it. A request without the flag gets
    // exactly the events-only page it always got, and no such field.
    //
    // `repairObservations: null` means NOT KNOWN, never "none": a database
    // that predates migration 0066 (this build serving before the deploy
    // applies it) or a failed read. The page is then the events alone, as
    // before this field existed, and says so rather than implying a repaired
    // loan's history is complete.
    const wantObservations = url.searchParams.get('repairObservations') === '1';
    let observations: RepairObservationRow[] | null = [];
    if (wantObservations && !actor && !offerIdRaw && !kind) {
      try {
        const loanId = loanIdRaw ? Number.parseInt(loanIdRaw, 10) : undefined;
        const r = await repairObservationsPage(env.DB, chainId, { loanId, before }, limit).all<RepairObservationRow>();
        observations = r.results ?? [];
      } catch (err) {
        console.warn('[loanRoutes] activity: repaired-loan endings not read; served as unknown', redactedError(err));
        observations = null;
      }
    }
    type Item =
      | { at: { block: number; logIndex: number }; event: ActivityRow }
      | { at: { block: number; logIndex: number }; observation: RepairObservationRow };
    const merged: Item[] = [
      ...(rows.results ?? []).map((r) => ({ at: { block: r.block_number, logIndex: r.log_index }, event: r })),
      ...(observations ?? []).map((o) => ({ at: repairObservationPosition(o), observation: o })),
    ]
      .sort((a, b) => b.at.block - a.at.block || b.at.logIndex - a.at.logIndex)
      .slice(0, limit);
    const events = merged.flatMap((m) => ('event' in m ? [activityToJson(m.event)] : []));
    const repairObservations =
      observations === null
        ? null
        : merged.flatMap((m) => ('observation' in m ? [repairObservationToJson(m.observation)] : []));
    const last = merged.length === limit ? merged[merged.length - 1] : null;
    const nextBefore = last ? `${last.at.block}:${last.at.logIndex}` : null;
    return jsonResponse(
      wantObservations ? { chainId, events, repairObservations, nextBefore } : { chainId, events, nextBefore },
    );
  } catch (err) {
    console.error('[loanRoutes] activity failed', redactedError(err));
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
 * included (#1234): it is terminal AND claimable — apps/app's
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
  const chainId = requestedChainId(url);
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  // Fail closed when this chain isn't indexed here so the frontend falls back.
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    // #749 — PURE D1: the wallet's OWN terminal loans, filtered on the
    // indexer-maintained `*_current_owner` columns (kept authoritative by the
    // chainIndexer.ts Transfer/burn + LoanSold + LoanObligationTransferred +
    // accept-seed handlers). A claim BURNS the position NFT → its
    // `*_current_owner` is set to `0x0`, which never equals a real wallet, so a
    // claimed side automatically drops out (the already-claimed activity filter
    // below is then belt-and-suspenders). Zero operator RPC; the FRONTEND layers
    // the on-chain `getUserPositionLoans` verify via the user's own RPC.
    // #1247 PAG-011-adjacent (PAG-007) — the one row route that had no
    // LIMIT: cap at the CLAIM_CANDIDATES_CAP most-recently-TERMINAL
    // loans and say so (`truncated`), matching /claim-candidates.
    // Recency is `terminal_at` (Codex #1269 r3: `updated_at` also
    // moves on later position-NFT transfers and counterparty claim
    // burns, which would let stale loans jump the window), COALESCEd
    // to `updated_at` only for legacy rows; loan_id tie-breaks. The
    // OR-of-owners predicate is split into one query PER SIDE so each
    // rides its `idx_loans_*_current_owner` index — the r2 single
    // query planned as an idx_loans_chain_status walk of EVERY
    // terminal loan on the chain (Codex r3 EQP); split, the work is
    // bounded by the wallet's own rows. Each side fetches CAP+1 and
    // the union's true top-CAP is re-derived in JS (any row in the
    // union's top-CAP is necessarily in its own side's top-CAP, so
    // the merge loses nothing). `truncated` is additive — the typed
    // no current consumer reads it (the client was removed in #988 —
    // see the note on this endpoint further down), and the Claim Center
    // layers an on-chain verify over this discovery anyway.
    // Each side also excludes rows whose claim ALREADY fired (r4): a
    // claim burns the position NFT so the owner projection normally
    // evicts the row, but if that projection lags, claimed rows would
    // consume window slots and push older UNclaimed candidates out of
    // the clipped view. The exclusion must happen before LIMIT — the
    // JS claimed-set filter below stays as belt-and-suspenders and for
    // the cross-side split (a both-sides holder's row can be claimed
    // on one side only). The NOT EXISTS probes idx_activity_chain_loan
    // per examined row, all of which are the wallet's own.
    const sideRows = (
      col: 'lender_current_owner' | 'borrower_current_owner',
      claimKind: 'LenderFundsClaimed' | 'BorrowerFundsClaimed',
    ) =>
      env.DB.prepare(
        `SELECT * FROM loans
         WHERE chain_id = ? AND ${col} = ?
           AND status IN ('repaid', 'defaulted', 'liquidated', 'internal_matched')
           AND NOT EXISTS (
             SELECT 1 FROM activity_events e
              WHERE e.chain_id = loans.chain_id AND e.loan_id = loans.loan_id
                AND e.kind = '${claimKind}' AND e.actor = ?
           )
         ORDER BY (terminal_at IS NULL) ASC, terminal_at DESC, loan_id DESC
         LIMIT ?`,
      )
        .bind(chainId, addr, addr, CLAIM_CANDIDATES_CAP + 1)
        .all<LoanRow>();
    const [lenderSide, borrowerSide] = await Promise.all([
      sideRows('lender_current_owner', 'LenderFundsClaimed'),
      sideRows('borrower_current_owner', 'BorrowerFundsClaimed'),
    ]);
    // Dedup (one wallet can hold BOTH position NFTs of a loan), then
    // re-sort the union by the same recency key and clip.
    const byId = new Map<number, LoanRow>();
    for (const r of [
      ...(lenderSide.results ?? []),
      ...(borrowerSide.results ?? []),
    ]) {
      byId.set(r.loan_id, r);
    }
    // A ROW WITH NO TERMINAL TIME IS OF UNKNOWN AGE, AND RANKS AS UNKNOWN —
    // never as `updated_at`, which is when this service last WROTE the row
    // (#2190 r8 `4008583615`). `2ca88cc7f` stopped the reconciliation repair
    // fabricating a terminal time, and the fallback here quietly restored
    // the same claim through a different column: a repair bumps
    // `updated_at` to now, so a loan that ended in July sorted to the top of
    // a CAPPED list and pushed genuinely recent claims out of it. Fixing the
    // column I was writing and not the claim the reader makes is what let
    // this survive the first fix.
    //
    // (Since #2476 a settled row's time can also be NULL when its block read
    // failed or its provenance could not be confirmed — again a time that is
    // genuinely unknown, which is the class this ordering demotes.)
    //
    // NULL here means a REPAIRED row and nothing else: `terminal_at` has
    // existed since migration 0005 created this table (never added later, so
    // there are no pre-column rows), and every production terminal writer
    // stamps it in the same UPDATE as the status — `flipLoanStatus`, both
    // settle paths, the deferred `LoanStatusChanged` edges. No backfill
    // migration sets a terminal status without it either. So this ordering
    // demotes exactly the rows whose age is genuinely unknown, and nothing
    // else.
    //
    // Unknown-age rows therefore sort AFTER every row with a real terminal
    // time, rather than above them. They are not hidden — nothing else
    // competes for the cap when a wallet's claimables are all of unknown age
    // — but an unknown may not displace something known to be recent. Must
    // stay in step with the SQL's `ORDER BY` above, which does the same.
    const merged = [...byId.values()].sort((a, b) => {
      if ((a.terminal_at == null) !== (b.terminal_at == null)) {
        return a.terminal_at == null ? 1 : -1;
      }
      return (b.terminal_at ?? 0) - (a.terminal_at ?? 0) || b.loan_id - a.loan_id;
    });
    const truncated = merged.length > CLAIM_CANDIDATES_CAP;
    const rows = truncated ? merged.slice(0, CLAIM_CANDIDATES_CAP) : merged;
    if (rows.length === 0) {
      return jsonResponse({
        chainId,
        address: addr,
        asLender: [],
        asBorrower: [],
        truncated,
      });
    }
    // Pre-fetch already-claimed loan IDs so we can dedup in memory
    // without N round trips. One query per side. (Belt-and-suspenders: a claimed
    // position NFT is burned, so its `*_current_owner` is already `0x0`.)
    // #1247 PAG-007 (Codex #1269 r1+r2) — the claimed sets are only
    // ever consulted for the ≤CAP kept rows, so the lookups are EXACT:
    // scoped to the kept loan ids via `json_each` over ONE bound JSON
    // array (a flat IN(id, id, …) of up to 200 ids would exceed D1's
    // 100-bound-parameter cap, and an id-floor predicate is porous
    // when the kept window is sparse — an old kept id would re-open
    // the wallet's whole later claim history).
    const keptIdsJson = JSON.stringify(rows.map((r) => r.loan_id));
    const claimedLender = new Set<number>();
    const claimedBorrower = new Set<number>();
    const lenderClaims = (
      await env.DB.prepare(
        `SELECT DISTINCT loan_id FROM activity_events
         WHERE chain_id = ? AND kind = 'LenderFundsClaimed' AND actor = ?
           AND loan_id IN (SELECT value FROM json_each(?))`,
      )
        .bind(chainId, addr, keptIdsJson)
        .all<{ loan_id: number }>()
    ).results ?? [];
    for (const r of lenderClaims) claimedLender.add(r.loan_id);
    const borrowerClaims = (
      await env.DB.prepare(
        `SELECT DISTINCT loan_id FROM activity_events
         WHERE chain_id = ? AND kind = 'BorrowerFundsClaimed' AND actor = ?
           AND loan_id IN (SELECT value FROM json_each(?))`,
      )
        .bind(chainId, addr, keptIdsJson)
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
    const clock = await loanClockView(env, chainId);
    return jsonResponse({
      chainId,
      address: addr,
      asLender: asLender.map((r) => loanToJson(r, clock)),
      asBorrower: asBorrower.map((r) => loanToJson(r, clock)),
      truncated,
    });
  } catch (err) {
    console.error('[loanRoutes] claimables failed', redactedError(err));
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
 * typed {asLender, asBorrower} response of full rows. Note it has no
 * current consumer: the client was removed in #988 (claimables are
 * on-chain-authoritative now) and `apps/app` uses this hint plus
 * on-chain verification instead, so do not treat that endpoint as a
 * compatibility constraint on the app;
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

/** #1247 PAG-009 — the executed-rate candle route's per-request scan
 *  ceiling (newest fills first; the fold drops the oldest candles
 *  when hit and the response says `truncated`). */
const CANDLE_SCAN_CAP = 10_000;

/** #1023 — /loans/by-participant `fields=ids` response ceiling. Ids
 *  are ~8 bytes each so 5,000 is a small payload, and a wallet with
 *  more DISTINCT loan participations than this is far outside any
 *  realistic feed consumer; `truncated` reports honestly beyond it. */
const PARTICIPANT_IDS_CAP = 5_000;

export async function handleClaimCandidates(
  req: Request,
  env: Env,
  addrRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
    console.error('[loanRoutes] claim-candidates failed', redactedError(err));
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
/** Statuses this endpoint publishes under their own name. Anything else
 *  lands in `other`, so the published buckets always sum to `total`. */
const KNOWN_LOAN_STATUSES = new Set([
  'active',
  'repaid',
  'defaulted',
  'liquidated',
  'settled',
  'fallback_pending',
  'internal_matched',
]);

export async function handleLoansStats(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    // ONE SNAPSHOT (#2080). Every figure in this response — the status
    // counts, the asset split, the volume rows AND the ingest cursor it
    // cites as provenance — comes from one D1 batch, which D1 runs as a
    // single transaction. They used to be four separate reads, so an
    // ingest committing between them returned pre-ingest counters under a
    // post-ingest cursor: "current through block N" beside counts that did
    // not include block N. The batch makes the response consistent by
    // construction rather than by read order, and keeps the counters
    // consistent with each other too (the asset split cannot outrun
    // `active`).
    const [counts, assetTypeBreakdown, volumeRows, cursorRows] = await env.DB.batch([
      // Counts per status.
      env.DB.prepare(
        // SALE VEHICLES ARE NOT BORROWER POSITIONS (#2069 review round 8).
        // Selling a lender position emits a temporary bookkeeping loan,
        // which migration 0029 flags precisely so it stays out of anything
        // a person reads — and `getLoans`, the activity feed and the
        // claimables query all already filter it. This one did not, so
        // every secondary sale raised the count as though a new loan had
        // originated. Invisible while this was an internal aggregate;
        // not once the public dashboard prints it as the deployment's
        // loan total. (`loans` carries no `is_offset_vehicle` column —
        // that flag exists on `offers` only.)
        `SELECT status, COUNT(*) as n FROM loans
          WHERE chain_id = ? AND is_sale_vehicle = 0
          GROUP BY status`,
      )
        .bind(chainId),
      // Asset-type breakdown for the active set (ERC-20 vs NFT rental).
      env.DB.prepare(
        // Same exclusion as the status counters above. Without it the
         // ERC-20 / NFT active subtotals could EXCEED the `active` count
         // beside them while a sale vehicle is open — two figures on one
         // card disagreeing, which is worse than either being wrong alone.
        // EXCLUDE ROWS WITH NO ASSET METADATA — which is NOT the same set
        // as `is_stub = 1`.
        //
        // Two different paths set that flag. Fallback B (no
        // `LoanInitiatedDetails`, canonical read-back failed) inserts
        // `asset_type = 0` regardless of what the loan is, so counting
        // those published every such NFT rental as an active ERC-20 loan.
        // The companion-event path ALSO sets `is_stub = 1`, but only
        // because the two position token IDs are missing — it writes the
        // REAL `assetType` from the event. Keying on the flag therefore
        // dropped correctly classified loans from both subtotals while
        // healing was merely delayed, which is its own inaccuracy.
        //
        // `lending_asset` is the discriminator: fallback B writes the
        // literal `'0x'` placeholder, the companion path writes the actual
        // address. So this asks the question that matters — do we know
        // what this loan is? — rather than a flag that answers a
        // different one.
        //
        // TWO SENTINELS, not one (round 61 P2). `'0x'` is what fallback B
        // writes today; rows predating it carry the COLUMN DEFAULT,
        // `0x0000…0000` (migrations/0005:52), and migration 0009 marks
        // those as stubs without normalising the value. Excluding only
        // `'0x'` let such a row through with its default `asset_type = 0`
        // and published it as an ERC-20 loan — a false classification, not
        // a gap. Worse, it was a SILENT one: the subtotals then reconcile
        // against `active`, so the unclassified remainder reads zero and
        // the transparency page's contradiction notice never fires. A
        // misfiled row that makes the arithmetic look right is exactly what
        // that notice exists to expose.
        //
        // The `active` count above still includes both kinds, so the
        // subtotals may sum to less than `active` while metadata-less rows
        // await healing. That direction is the honest one: undercounting a
        // type is an admitted gap, misfiling it is a false statement.
        `SELECT asset_type, COUNT(*) as n
         FROM loans
         WHERE chain_id = ? AND is_sale_vehicle = 0
           AND lending_asset NOT IN ('0x', '0x0000000000000000000000000000000000000000')
           AND status = 'active'
         GROUP BY asset_type`,
      )
        .bind(chainId),
      env.DB.prepare(
        // And again for lifetime volume and average APR: a secondary sale
        // is not an origination, so counting its bookkeeping row inflates
        // volume and drags the rate average toward a number nobody agreed
        // to. Every aggregate in this handler now excludes vehicles —
        // the previous commit fixed one query and left these two, which
        // is the third time this exact omission has been found.
        `SELECT lending_asset, principal, interest_rate_bps
         FROM loans WHERE chain_id = ? AND is_sale_vehicle = 0`,
      )
        .bind(chainId),
      env.DB.prepare(
        `SELECT last_block, updated_at FROM indexer_cursor
         WHERE chain_id = ? AND kind = 'diamond'`,
      )
        .bind(chainId),
    ]);
    const cursor = (cursorRows.results?.[0] ?? null) as {
      last_block: number;
      updated_at: number;
    } | null;
    const tally: Record<string, number> = {
      active: 0,
      repaid: 0,
      defaulted: 0,
      liquidated: 0,
      settled: 0,
      // Normal lifecycle states, seeded so they are always present in
      // the response rather than appearing only once one exists.
      fallback_pending: 0,
      internal_matched: 0,
    };
    for (const row of (counts.results ?? []) as { status: string; n: number }[]) {
      tally[row.status] = row.n;
    }
    let erc20ActiveLoans = 0;
    let nftRentalsActive = 0;
    for (const row of (assetTypeBreakdown.results ?? []) as { asset_type: number; n: number }[]) {
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
    const volumeByAsset: Record<string, bigint> = {};
    const loansByAsset: Record<string, number> = {};
    let aprSum = 0;
    let aprCount = 0;
    for (const row of (volumeRows.results ?? []) as { lending_asset: string; principal: string; interest_rate_bps: number }[]) {
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
    return jsonResponse({
      chainId,
      active: tally.active,
      repaid: tally.repaid,
      defaulted: tally.defaulted,
      liquidated: tally.liquidated,
      settled: tally.settled,
      // NAMED so `total` reconciles — see the offers endpoint. The loans
      // table also holds `fallback_pending` and the terminal
      // `internal_matched`, both normal lifecycle states, and `other`
      // absorbs anything added later.
      fallbackPending: tally.fallback_pending ?? 0,
      internalMatched: tally.internal_matched ?? 0,
      other: Object.entries(tally)
        .filter(([k]) => !KNOWN_LOAN_STATUSES.has(k))
        .reduce((a, [, n]) => a + n, 0),
      // EVERY PERSISTED STATUS, not the five named above. The GROUP BY
      // returns whatever statuses exist, and this table also holds
      // `fallback_pending` and the terminal `internal_matched` — so
      // adding only the named five reported a total lower than the
      // number of loan rows whenever either existed, with neither
      // population represented anywhere else in the response.
      //
      // That was survivable while this was an internal aggregate. It is
      // not now that the public transparency dashboard presents this
      // figure to readers as the deployment's total loan count: a total
      // that silently omits a category is exactly the kind of number
      // that page exists so nobody has to take on trust.
      total: Object.values(tally).reduce((a, b) => a + b, 0),
      erc20ActiveLoans,
      nftRentalsActive,
      volumeByAsset: volumeByAssetSerialized,
      loansByAsset,
      averageInterestRateBps,
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
            // RPC read-diet PR 0 — mirrors /offers/stats: the ingest mode's
            // expected per-chain scan cadence (null = legacy/unknown →
            // clients keep the polling posture).
            scanCadenceSec: env.doIngestEnabled ? EXPECTED_SCAN_CADENCE_SEC : null,
          }
        : null,
    });
  } catch (err) {
    console.error('[loanRoutes] stats failed', redactedError(err));
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
  const chainId = requestedChainId(url);
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
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
      // #1142 — scope by the one placement rule the candles use
      // (marketPlacement.ts): the AGREED tenor, and only when the agreed
      // terms are confirmed. `LoanExtended` rewrites the live
      // `duration_days`, which moved an extended 30d fill into the 60d tape;
      // an unconfirmed snapshot names a tenor that may be a guess. Rides
      // 0071's partial index.
      conds.push(PLACED_IN_TENOR_SQL);
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
    // #1142 — a tape scoped to one (pair, tenor) market also states how many
    // loans on the pair no tenor holds (all time, capped), read in the same
    // batch, so an empty tape never reads as "no loans agreed" while the
    // pair has loans whose tenor is unknown (Codex #2689 r5).
    const marketScoped =
      market.lendingAsset !== null &&
      market.collateralAsset !== null &&
      market.durationDays !== null;
    let rows: D1Result<LoanRow>;
    let unplaced: ReturnType<typeof readUnplacedCount> | null = null;
    if (marketScoped) {
      const [tapeRows, unplacedRows] = await env.DB.batch([
        stmt,
        unplacedOnPairStatement(
          env.DB,
          chainId,
          market.lendingAsset!,
          market.collateralAsset!,
          0,
        ),
      ]);
      rows = tapeRows as D1Result<LoanRow>;
      unplaced = readUnplacedCount(unplacedRows as D1Result<{ n: number }>);
    } else {
      rows = await stmt.all<LoanRow>();
    }
    const clock = await loanClockView(env, chainId);
    const loans = (rows.results ?? []).map((r) => loanToJson(r, clock));
    const next =
      loans.length === limit && loans.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    // The scope this page was actually read under, so a reader can verify
    // the filters were applied — an empty page included, which has no row
    // to check (#1142, Codex #2689 r5). `placement` names the rule that
    // chose the tenor; null when no tenor was asked for. `unplaced` is null
    // unless the page is scoped to one full market.
    const scope = {
      lendingAsset: market.lendingAsset,
      collateralAsset: market.collateralAsset,
      durationDays: market.durationDays,
      placement: market.durationDays !== null ? PLACEMENT_RULE : null,
      excludeSaleVehicles,
    };
    return jsonResponse({ chainId, loans, nextBefore: next, scope, unplaced });
  } catch (err) {
    console.error('[loanRoutes] recent failed', redactedError(err));
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
  const chainId = requestedChainId(url);
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
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
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
    console.error('[loanRoutes] timeseries failed', redactedError(err));
    return jsonResponse({ error: 'timeseries-failed' }, 500);
  }
}

/**
 * Rate Desk phase 2 (#1130) — GET /loans/rate-candles
 *   ?chainId=8453&lendingAsset=0x..&collateralAsset=0x..&durationDays=30
 *   &interval=1h|4h|1d&range=7d|30d|90d|all
 *
 * → { chainId, buckets: [{ t, open, high, low, close, fills, principalTotal,
 *                           unrecordedPrincipalFills }],
 *     unplaced: { count, capped }, truncated }
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
 *   - Metadata-less stub rows — fallback-B inserts carry `'0x'`;
 *     rows predating that carry the column default `0x0000…0000`. Both
 *     are "we do not know what this loan is" and both are excluded from
 *     the typed subtotals (round 61 P2).
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
 * 0032 §2).
 *
 * PLACEMENT (#1142, Codex #2689 r2–r3): the market is chosen by the one rule
 * in marketPlacement.ts. A loan is a fill of this tenor only when its agreed
 * terms are confirmed by the ledger (`init_terms_unbacked = 0`, 0058), so
 * every rate drawn is a backed one. The rule used to COALESCE to the live
 * columns, which plotted, and filed under a tenor, terms nobody could back. A
 * loan on this pair whose terms are not confirmed is in no tenor market: the
 * response counts those in range as `unplaced` (pair-wide, every tenor), and
 * the desk says so, rather than drawing a guess or dropping them silently.
 * The count is read in the same batch as the candles (one snapshot) and stops
 * at `UNPLACED_COUNT_CAP`; past it, `capped: true` says "more than".
 * A drawn fill whose PRINCIPAL is not confirmed (`init_principal_unbacked`,
 * 0056) is counted in its bucket's `unrecordedPrincipalFills` and left out of
 * `principalTotal`.
 * `start_at` needs no snapshot — it is written once at insert and no
 * handler updates it (LoanExtended/partial repay reset `start_time`, a
 * different column).
 *
 * Aggregation split (§7): SQL selects the market's rows in the range ordered
 * by (start_at, loan_id); ALL folding — OHLC, fills, principal — happens in
 * JS (`foldRateCandles`). Rationale in rateCandles.ts: principal MUST be
 * BigInt-folded (the /loans/stats pattern), and SQLite has no first/last
 * aggregate for open/close, so one ordered select + one JS pass is the
 * simplest correct shape. Rides `idx_loans_placed_tenor_start_at` (0071).
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
  const chainId = requestedChainId(url);
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
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    const conds = [
      'chain_id = ?',
      'lending_asset = ?',
      'collateral_asset = ?',
      // The one placement rule (see PLACEMENT above): the agreed tenor,
      // and only when the agreed terms are confirmed.
      PLACED_IN_TENOR_SQL,
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
    const since =
      rangeDays === null ? null : Math.floor(Date.now() / 1000) - rangeDays * 86400;
    if (since !== null) {
      conds.push('start_at >= ?');
      binds.push(since);
    }
    // The INIT snapshot and its provenance flags; never the live values.
    // #1247 PAG-009 — bounded scan: `range=all` has no start bound, so
    // a long-lived busy market would otherwise make this an unbounded
    // D1 read per request. Scan the NEWEST CANDLE_SCAN_CAP fills
    // (DESC + reverse for the fold's ascending order) and say so —
    // a truncated series drops the OLDEST candles, never recent ones.
    // The candle read and the unplaced count (the loans on this pair in
    // range that no tenor market holds, marketPlacement.ts) run in ONE
    // batch, so both describe the same snapshot: a loan whose flag clears
    // between two separate reads would otherwise be counted by both or by
    // neither. `range=all` counts from the epoch.
    const [rows, unplacedRows] = await env.DB.batch([
      env.DB.prepare(
        `SELECT loan_id, start_at, init_rate_bps,
                init_principal, init_principal_unbacked
         FROM loans
         WHERE ${conds.join(' AND ')}
         ORDER BY start_at DESC, loan_id DESC
         LIMIT ?`,
      ).bind(...binds, CANDLE_SCAN_CAP + 1),
      unplacedOnPairStatement(
        env.DB,
        chainId,
        market.lendingAsset,
        market.collateralAsset,
        since ?? 0,
      ),
    ]);
    const fills = (rows.results ?? []) as CandleFillRow[];
    const truncated = fills.length > CANDLE_SCAN_CAP;
    const scanned = (truncated ? fills.slice(0, CANDLE_SCAN_CAP) : fills)
      .slice()
      .reverse();
    const folded = foldRateCandles(scanned, intervalSec);
    // Codex #1269 r3 (P3) — the scan slice can cut MID-bucket, so the
    // oldest retained bucket may hold only part of its fills; a candle
    // with a wrong open/fills/principal is worse than no candle. Drop
    // the boundary bucket whenever the scan clipped — "the oldest
    // candles are not drawn" then covers it exactly. EXCEPT when it is
    // the ONLY bucket (r4: 10k+ fills inside one interval): an empty
    // series would render as "no fills in range", an active lie about
    // the market's busiest hour — keep the partial candle, and the
    // `truncated` disclosure covers its approximation.
    const buckets =
      truncated && folded.length > 1 ? folded.slice(1) : folded;
    const unplaced = readUnplacedCount(unplacedRows as D1Result<{ n: number }>);
    return jsonResponse({ chainId, buckets, unplaced, truncated }, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (err) {
    console.error('[loanRoutes] rate-candles failed', redactedError(err));
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
  const chainId = requestedChainId(url);
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
  // #1023 — `scope=all` serves the ALL-history consumer the table was
  // built for (Activity's participation filter needs every loan the
  // wallet ever touched, any asset shape, sale vehicles included —
  // their actor-null events belong in the wallet's feed too). The
  // default stays the desk-scoped view the History tab renders.
  const scopeRaw = url.searchParams.get('scope');
  if (scopeRaw !== null && scopeRaw !== 'desk' && scopeRaw !== 'all') {
    return jsonResponse({ error: 'bad-scope' }, 400);
  }
  const scope = scopeRaw ?? 'desk';
  // #1023 (Codex #1287 r1) — `fields=ids` returns the wallet's raw
  // participation loan-id set in ONE bounded response, no loans join,
  // no hydration, no cursor walk: `{ chainId, wallet, loanIds,
  // truncated }`. Built for Activity's participation filter, which
  // only consumes ids — and the NEW response shape doubles as the
  // deploy-skew guard: an older worker ignores the param and answers
  // the loans shape, which the client rejects (no `loanIds` array)
  // instead of silently treating a desk-scoped page as all-history.
  const fieldsRaw = url.searchParams.get('fields');
  if (fieldsRaw !== null && fieldsRaw !== 'ids') {
    return jsonResponse({ error: 'bad-fields' }, 400);
  }
  if (fieldsRaw === 'ids' && scope !== 'all') {
    // ids mode exists for the all-history consumer; a desk-scoped ids
    // read would need the loans join anyway — refuse rather than
    // silently serve a different scope than requested.
    return jsonResponse({ error: 'ids-requires-scope-all' }, 400);
  }
  // Fail closed when this chain isn't indexed here, so the frontend's
  // indexer-first → on-chain-fallback wrapper actually falls back (#749) —
  // same posture as the sibling wallet routes.
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    if (fieldsRaw === 'ids') {
      // Ids-only mode — index-served DISTINCT over the wallet's own
      // participation rows, deterministic newest-id-first, bounded at
      // PARTICIPANT_IDS_CAP with the standard cap+1 truncation probe.
      const idRows = (
        await env.DB.prepare(
          `SELECT DISTINCT loan_id FROM loan_participants
           WHERE chain_id = ? AND wallet = ?
           ORDER BY loan_id DESC
           LIMIT ?`,
        )
          .bind(chainId, wallet, PARTICIPANT_IDS_CAP + 1)
          .all<{ loan_id: number }>()
      ).results ?? [];
      const idsTruncated = idRows.length > PARTICIPANT_IDS_CAP;
      const loanIds = (
        idsTruncated ? idRows.slice(0, PARTICIPANT_IDS_CAP) : idRows
      ).map((r) => r.loan_id);
      return jsonResponse({ chainId, wallet, loanIds, truncated: idsTruncated });
    }
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
    const conds = ['p.chain_id = ?', 'p.wallet = ?'];
    if (scope === 'desk') {
      conds.push(
        'l.asset_type = 0',
        'l.collateral_asset_type = 0',
        'l.is_sale_vehicle = 0',
        "l.lending_asset LIKE '0x%' AND length(l.lending_asset) = 42",
        "l.collateral_asset LIKE '0x%' AND length(l.collateral_asset) = 42",
        'l.duration_days >= 1',
      );
    }
    // scope=all keeps NO market-shape predicates — including the
    // stub-shape guard: a stub row's loan_id is real, and the
    // all-history consumer (the Activity loan-id filter) only reads
    // ids, so hiding a not-yet-healed row would drop real feed events.
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
    const clock = await loanClockView(env, chainId);
    const loans = results.map((row) => ({
      ...loanToJson(row, clock),
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
    console.error('[loanRoutes] by-participant failed', redactedError(err));
    return jsonResponse({ error: 'by-participant-failed' }, 500);
  }
}

export function handleLoansPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      // Read-only: the one POST under /loans/* (#335's prepay match
      // source) was retired in #2757.
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
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

// ─── Notification center (#1213 / E-11) ──────────────────────────────

interface NotificationRow {
  id: number;
  kind: string;
  loan_id: number | null;
  offer_id: number | null;
  event_kind: string | null;
  data_json: string | null;
  created_at: number;
  block_number: number | null;
  log_index: number | null;
}

function notificationToJson(row: NotificationRow) {
  let data: unknown = null;
  if (row.data_json) {
    try {
      data = JSON.parse(row.data_json);
    } catch {
      data = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    loanId: row.loan_id,
    offerId: row.offer_id,
    eventKind: row.event_kind,
    data,
    createdAt: row.created_at,
    // Chain-order key — the client tracks read/unread as a per-wallet
    // last-seen cursor, which must be the SAME (block, logIndex) key the
    // feed orders + paginates by; `createdAt` alone can't order (Codex
    // #1292 r5).
    blockNumber: row.block_number,
    logIndex: row.log_index,
  };
}

/**
 * GET /notifications/:addr?chainId=8453&limit&before
 *
 * The wallet's in-app inbox (#1213 / E-11): per-recipient lifecycle
 * rows the ingest materialized (see notifications.ts), newest-first.
 * Pure D1, open CORS — every row is derived from public on-chain events
 * (same privacy model as /claimables and /activity). The chain stays
 * authoritative: rows deep-link to Loan Details / the Claim Center and
 * re-verify there.
 *
 * Read/unread state is CLIENT-side (a per-wallet last-seen cursor in the
 * frontend), NOT a server column — so there is no unauthenticated
 * mutation to grief (Codex #1292 r1) and no per-wallet mutable state to
 * cache-poison. The response is therefore served `no-store`: it is a
 * per-wallet surface whose freshness (a just-materialized row) drives
 * the bell badge, so a shared/edge cache must never replay a stale page.
 *
 * Ordered newest-first by CHAIN ORDER (block, log_index, id), NOT by
 * `created_at` — that column is the block timestamp but falls back to
 * wall-clock on a mid-catch-up read failure, which would sort a
 * historical row as newest (Codex #1292 r4). `id` is the unique
 * tiebreaker: a single log can fan out multiple rows for one recipient
 * (an `InternalMatchExecuted` leg fan-out shares block+log_index), so a
 * `block:log`-only cursor could skip the rest of that group (Codex #1292
 * r6). Cursor `before` = `"<blockNumber>:<logIndex>:<id>"`.
 */
export async function handleNotifications(
  req: Request,
  env: Env,
  addrRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return jsonResponse({ error: 'bad-address' }, 400);
  }
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  const limit = parseLimit(url.searchParams.get('limit'));
  const beforeRaw = url.searchParams.get('before');

  const where: string[] = ['chain_id = ?', 'recipient = ?'];
  const binds: (string | number)[] = [chainId, addr];
  if (beforeRaw) {
    const m = beforeRaw.match(/^(\d+):(\d+):(\d+)$/);
    if (!m) return jsonResponse({ error: 'bad-before' }, 400);
    // (block_number, log_index, id) < (?, ?, ?) — the UNIQUE chain-order
    // keyset (id tiebreaks a same-log fan-out so no row is skipped).
    where.push(
      '(block_number < ? OR (block_number = ? AND (log_index < ? OR (log_index = ? AND id < ?))))',
    );
    const blk = Number.parseInt(m[1], 10);
    const li = Number.parseInt(m[2], 10);
    binds.push(blk, blk, li, li, Number.parseInt(m[3], 10));
  }
  try {
    const rows = await env.DB.prepare(
      `SELECT id, kind, loan_id, offer_id, event_kind, data_json,
              created_at, block_number, log_index
         FROM notifications
        WHERE ${where.join(' AND ')}
        ORDER BY block_number DESC, log_index DESC, id DESC
        LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<NotificationRow>();
    const results = rows.results ?? [];
    const notifications = results.map(notificationToJson);
    const last = results.length === limit ? results[results.length - 1] : null;
    const nextBefore = last
      ? `${last.block_number}:${last.log_index}:${last.id}`
      : null;
    return jsonResponse(
      { chainId, address: addr, notifications, nextBefore },
      200,
      { 'Cache-Control': 'no-store' },
    );
  } catch (err) {
    console.error('[loanRoutes] notifications failed', redactedError(err));
    return jsonResponse({ error: 'notifications-failed' }, 500);
  }
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
