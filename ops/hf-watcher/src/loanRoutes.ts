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

import type { Env } from './env';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { getDeployment } from './deployments';
import { ERC721_OWNER_OF_ABI } from './diamondAbi';

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
 * Resolve a viem PublicClient + diamond Address for the given chain.
 * Returns null when the chain isn't currently configured (no RPC or
 * no deployment) so the caller can degrade to "use the immutable
 * lender/borrower from the loans row" without erroring out.
 */
function resolveChainClient(
  env: Env,
  chainId: number,
): { client: PublicClient; diamond: Address } | null {
  const rpcMap: Record<number, string | undefined> = {
    8453: env.RPC_BASE,
    1: env.RPC_ETH,
    42161: env.RPC_ARB,
    10: env.RPC_OP,
    1101: env.RPC_ZKEVM,
    56: env.RPC_BNB,
    84532: env.RPC_BASE_SEPOLIA,
    11155111: env.RPC_SEPOLIA,
    421614: env.RPC_ARB_SEPOLIA,
    11155420: env.RPC_OP_SEPOLIA,
    80002: env.RPC_POLYGON_AMOY,
    97: env.RPC_BNB_TESTNET,
  };
  const rpc = rpcMap[chainId];
  const dep = getDeployment(chainId);
  if (!rpc || !dep) return null;
  return {
    client: createPublicClient({ transport: http(rpc) }),
    diamond: dep.diamond as Address,
  };
}

/**
 * Multicall ownerOf(tokenId) for every token ID in `tokenIds`. Returns
 * a parallel array of lowercased owner addresses; entries for burned
 * or otherwise reverting tokens come back as `null` so the caller can
 * filter them out.
 *
 * NOT batched into a literal Multicall3 call here — viem's
 * `Promise.all` over many `readContract` calls collapses into batched
 * RPC requests automatically when the transport supports it. For
 * simplicity and to avoid the Multicall3 adapter import we keep this
 * as a parallel fan-out; on the operator's paid RPC tier this is one
 * round trip per call but the total wall-time is still ~one round-
 * trip-equivalent because the requests are issued concurrently.
 */
async function batchOwnerOf(
  client: PublicClient,
  diamond: Address,
  tokenIds: bigint[],
): Promise<(string | null)[]> {
  const results = await Promise.all(
    tokenIds.map(async (tokenId) => {
      try {
        const owner = (await client.readContract({
          address: diamond,
          abi: ERC721_OWNER_OF_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
        })) as string;
        return owner.toLowerCase();
      } catch {
        // Burned / nonexistent → no current holder.
        return null;
      }
    }),
  );
  return results;
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

/** GET /loans/:id?chainId=8453 */
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
    return jsonResponse(loanToJson(row));
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
 * historical `lender` / `borrower` columns from LoanInitiated. The
 * worker fans out a `ownerOf(tokenId)` multicall against the chain
 * for the relevant side's token ID per loan and filters in memory.
 *
 * Why live: NFT secondary trades transfer claim/repay rights to the
 * new holder, but `loans.lender` / `loans.borrower` reflect the
 * origination state and never change. Asking the chain at query
 * time means a wallet that *bought* a lender NFT secondary
 * surfaces correctly — and a wallet that *sold* its lender NFT
 * stops seeing the loan in their list. No re-org window.
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
  const tokenCol = side === 'lender' ? 'lender_token_id' : 'borrower_token_id';
  const chainCtx = resolveChainClient(env, chainId);
  if (!chainCtx) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    // 1. Pull every loan whose token IDs are bootstrapped (lender_token_id != '0').
    //    Walk newest-first so the first-page result is the most recent matches.
    const stmt = before
      ? env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ? AND ${tokenCol} != '0' AND loan_id < ?
           ORDER BY loan_id DESC`,
        ).bind(chainId, before)
      : env.DB.prepare(
          `SELECT * FROM loans
           WHERE chain_id = ? AND ${tokenCol} != '0'
           ORDER BY loan_id DESC`,
        ).bind(chainId);
    const rows = (await stmt.all<LoanRow>()).results ?? [];
    if (rows.length === 0) {
      return jsonResponse({ chainId, side, address: addr, loans: [], nextBefore: null });
    }
    // 2. Multicall ownerOf for the side's token id on every loan.
    const tokenIds = rows.map((r) =>
      BigInt(side === 'lender' ? r.lender_token_id : r.borrower_token_id),
    );
    const owners = await batchOwnerOf(chainCtx.client, chainCtx.diamond, tokenIds);
    // 3. Filter to loans where the owner == addr, then truncate to `limit`.
    const matched: LoanRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (owners[i] === addr) matched.push(rows[i]);
      if (matched.length >= limit) break;
    }
    const loans = matched.map(loanToJson);
    const next =
      matched.length === limit && matched.length > 0
        ? (loans[loans.length - 1] as { loanId: number }).loanId
        : null;
    return jsonResponse({ chainId, side, address: addr, loans, nextBefore: next });
  } catch (err) {
    console.error('[loanRoutes] byParticipant failed', err);
    return jsonResponse({ error: 'byParticipant-failed' }, 500);
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
  const chainCtx = resolveChainClient(env, chainId);
  if (!chainCtx) {
    return jsonResponse({ error: 'chain-not-configured' }, 503);
  }
  try {
    // Pull every terminal-status loan whose token IDs are
    // bootstrapped. We don't filter by lender/borrower address in SQL
    // because the on-chain owner may differ — the multicall below is
    // the authoritative filter.
    const rows = (
      await env.DB.prepare(
        `SELECT * FROM loans
         WHERE chain_id = ? AND status IN ('repaid', 'defaulted', 'liquidated')
           AND lender_token_id != '0' AND borrower_token_id != '0'
         ORDER BY loan_id DESC`,
      )
        .bind(chainId)
        .all<LoanRow>()
    ).results ?? [];
    if (rows.length === 0) {
      return jsonResponse({ chainId, address: addr, asLender: [], asBorrower: [] });
    }
    // Pull lender_token_id AND borrower_token_id ownerOf in one batch
    // — index 2*i is lender, 2*i+1 is borrower.
    const tokenIds: bigint[] = [];
    for (const r of rows) {
      tokenIds.push(BigInt(r.lender_token_id));
      tokenIds.push(BigInt(r.borrower_token_id));
    }
    const owners = await batchOwnerOf(chainCtx.client, chainCtx.diamond, tokenIds);
    // Pre-fetch already-claimed loan IDs so we can dedup in memory
    // without N round trips. One query per side.
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
    const asLender: LoanRow[] = [];
    const asBorrower: LoanRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lenderOwner = owners[i * 2];
      const borrowerOwner = owners[i * 2 + 1];
      if (lenderOwner === addr && !claimedLender.has(row.loan_id)) {
        asLender.push(row);
      }
      if (borrowerOwner === addr && !claimedBorrower.has(row.loan_id)) {
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

export function handleLoansPreflight(): Response {
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
