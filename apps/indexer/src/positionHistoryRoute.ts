/**
 * #3021 — GET /positions/:tokenId?chainId= : what a position token id stood
 * for, read from the indexer's own record.
 *
 * The NFT verifier answers "live / retired / never minted" from the chain
 * (`highestTokenId`, `ownerOf`). For a retired token the chain says nothing
 * more, so the verifier asks this route for the history: the offer or loan
 * the token belonged to, which side, the final status and the terms, and
 * when the token was retired.
 *
 * What it reads:
 *  - `position_tokens` (0115) maps the id to its offer and loan. It keeps
 *    every id a row has held, so a token a sale or a handover replaced still
 *    resolves to its loan, which `loans.lender_token_id` alone cannot do.
 *  - The loan or offer row for the terms. A loan record wins over an offer
 *    record: an offer's token becomes the loan's token at accept.
 *  - `activity_events` for the `PositionRetired` event (block, tx, time).
 *
 * What it states and what it withholds (CLAUDE.md "funds and lifecycle
 * state get stated, never implied"):
 *  - `record: null` when the index has no entry for the token. That is not a
 *    claim the token never existed; the chain verdict stands on its own.
 *  - The agreed principal, rate and duration only where the ledger backs
 *    them (the `init_*_unbacked` flags, 0056 / 0058, the same rule as
 *    `/loans/:id`); otherwise null, never the live terms in their place.
 *  - The collateral amount is the last one recorded on the loan, labelled so.
 *  - `reason` names why the token retired only where the record shows it:
 *    the loan side moved to a new token (a sale, takeover or handover), the
 *    offer was cancelled, or the loan closed. Otherwise null, and the app
 *    keeps its default wording.
 */

import { type Env } from './env';
import { chainNotServed, requestedChainId } from './servedChain';

/** A uint256 written in decimal, no sign, no leading zeros beyond "0". */
const TOKEN_ID_RE = /^(0|[1-9]\d{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;

/** Loan statuses after which the position is closed. */
const CLOSED_LOAN_STATUSES = new Set([
  'repaid',
  'defaulted',
  'liquidated',
  'settled',
  'internal_matched',
]);

type Side = 'lender' | 'borrower';

interface LedgerRow {
  offer_id: number | null;
  loan_id: number | null;
  side: Side | null;
}

interface LoanHistoryRow {
  loan_id: number;
  offer_id: number;
  status: string;
  lender_token_id: string;
  borrower_token_id: string;
  init_principal: string | null;
  init_principal_unbacked?: number;
  init_rate_bps: number | null;
  init_duration_days: number | null;
  init_terms_unbacked?: number;
  collateral_amount: string;
  lending_asset: string;
  collateral_asset: string;
  asset_type: number;
  collateral_asset_type: number;
  token_id: string;
  collateral_token_id: string;
  start_at: number;
  terminal_block: number | null;
  terminal_at: number | null;
  terminal_at_verified?: number;
}

interface OfferHistoryRow {
  offer_id: number;
  status: string;
  offer_type: number;
  amount: string;
  amount_max: string;
  interest_rate_bps: number;
  interest_rate_bps_max: number;
  collateral_amount: string;
  duration_days: number;
  lending_asset: string;
  collateral_asset: string;
  asset_type: number;
  collateral_asset_type: number;
}

interface RetiredRow {
  block_number: number;
  log_index: number;
  tx_hash: string;
  block_at: number;
}

export type RetirementReason = 'position-moved' | 'offer-cancelled' | 'loan-closed';

export interface PositionHistory {
  chainId: number;
  tokenId: string;
  record: LoanRecord | OfferRecord | null;
  retirement: {
    blockNumber: number;
    logIndex: number;
    txHash: string;
    at: number;
  } | null;
  reason: RetirementReason | null;
}

export interface LoanRecord {
  kind: 'loan';
  loanId: number;
  /** The offer the token was minted for, when it began as an offer token. */
  fromOfferId: number | null;
  side: Side;
  status: string;
  /** False when the side has since moved to a newer token. */
  isCurrentToken: boolean;
  /** As agreed at initiation; each field null unless the ledger backs it. */
  agreed: {
    principal: string | null;
    interestRateBps: number | null;
    durationDays: number | null;
  };
  /** The last collateral amount recorded on the loan, not the amount at start. */
  lastCollateralAmount: string;
  lendingAsset: string;
  collateralAsset: string;
  assetType: number;
  collateralAssetType: number;
  lentTokenId: string;
  collateralTokenId: string;
  startAt: number;
  /** Null while open, and for a settlement whose time is not verified. */
  closedAt: number | null;
}

export interface OfferRecord {
  kind: 'offer';
  offerId: number;
  side: Side;
  status: string;
  amount: string;
  /** Null for a single-amount offer. */
  amountMax: string | null;
  interestRateBps: number;
  /** Null for a single-rate offer. */
  interestRateBpsMax: number | null;
  collateralAmount: string;
  durationDays: number;
  lendingAsset: string;
  collateralAsset: string;
  assetType: number;
  collateralAssetType: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=30',
    },
  });
}

export function handlePositionsPreflight(): Response {
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

/** The token id in canonical decimal form, or null when it is not a uint256. */
export function parseTokenId(raw: string): string | null {
  if (!TOKEN_ID_RE.test(raw)) return null;
  const v = BigInt(raw);
  return v > UINT256_MAX ? null : v.toString();
}

function loanRecord(row: LoanHistoryRow, ledger: LedgerRow, tokenId: string): LoanRecord {
  const side: Side =
    ledger.side ?? (row.borrower_token_id === tokenId ? 'borrower' : 'lender');
  const currentToken = side === 'lender' ? row.lender_token_id : row.borrower_token_id;
  return {
    kind: 'loan',
    loanId: row.loan_id,
    fromOfferId: ledger.offer_id,
    side,
    status: row.status,
    isCurrentToken: currentToken === tokenId,
    // BACKED is the explicit 0 and nothing else (#2478 r2): an absent flag
    // reads as not known to be backed.
    agreed: {
      principal: row.init_principal_unbacked === 0 ? (row.init_principal ?? null) : null,
      interestRateBps: row.init_terms_unbacked === 0 ? (row.init_rate_bps ?? null) : null,
      durationDays: row.init_terms_unbacked === 0 ? (row.init_duration_days ?? null) : null,
    },
    lastCollateralAmount: row.collateral_amount,
    lendingAsset: row.lending_asset,
    collateralAsset: row.collateral_asset,
    assetType: row.asset_type,
    collateralAssetType: row.collateral_asset_type,
    lentTokenId: row.token_id,
    collateralTokenId: row.collateral_token_id,
    startAt: row.start_at,
    // The `/loans/:id` rule (#2476 r15): an unverified settlement time may be
    // a scan clock, so it is withheld rather than stated as when it happened.
    closedAt: !CLOSED_LOAN_STATUSES.has(row.status)
      ? null
      : row.status === 'settled' && row.terminal_at_verified !== 1
        ? null
        : (row.terminal_at ?? null),
  };
}

function offerRecord(row: OfferHistoryRow, ledger: LedgerRow): OfferRecord | null {
  const side: Side | null =
    ledger.side ?? (row.offer_type === 0 ? 'lender' : row.offer_type === 1 ? 'borrower' : null);
  if (side === null) return null;
  return {
    kind: 'offer',
    offerId: row.offer_id,
    side,
    status: row.status,
    amount: row.amount,
    amountMax: row.amount_max && row.amount_max !== '0' ? row.amount_max : null,
    interestRateBps: row.interest_rate_bps,
    interestRateBpsMax: row.interest_rate_bps_max > 0 ? row.interest_rate_bps_max : null,
    collateralAmount: row.collateral_amount,
    durationDays: row.duration_days,
    lendingAsset: row.lending_asset,
    collateralAsset: row.collateral_asset,
    assetType: row.asset_type,
    collateralAssetType: row.collateral_asset_type,
  };
}

/**
 * Why the token retired, only where the record shows it. Precedence: a moved
 * loan side first (the token was replaced while the loan went on), then a
 * closed loan, then a cancelled offer that never became a loan.
 */
export function retirementReason(
  record: LoanRecord | OfferRecord | null,
): RetirementReason | null {
  if (record === null) return null;
  if (record.kind === 'loan') {
    if (!record.isCurrentToken) return 'position-moved';
    if (CLOSED_LOAN_STATUSES.has(record.status)) return 'loan-closed';
    return null;
  }
  return record.status === 'cancelled' ? 'offer-cancelled' : null;
}

/** The indexer's record for one position token on one chain. */
export async function readPositionHistory(
  env: Env,
  chainId: number,
  tokenId: string,
): Promise<PositionHistory> {
  const [ledger, retired] = await Promise.all([
    env.DB.prepare(
      `SELECT offer_id, loan_id, side FROM position_tokens
        WHERE chain_id = ? AND token_id = ?`,
    )
      .bind(chainId, tokenId)
      .first<LedgerRow>(),
    env.DB.prepare(
      `SELECT block_number, log_index, tx_hash, block_at FROM activity_events
        WHERE chain_id = ? AND kind = 'PositionRetired'
          AND json_extract(args_json, '$.tokenId') = ?
        ORDER BY block_number DESC, log_index DESC
        LIMIT 1`,
    )
      .bind(chainId, tokenId)
      .first<RetiredRow>(),
  ]);

  let record: LoanRecord | OfferRecord | null = null;
  if (ledger?.loan_id != null) {
    const loan = await env.DB.prepare(
      `SELECT loan_id, offer_id, status, lender_token_id, borrower_token_id,
              init_principal, init_principal_unbacked, init_rate_bps,
              init_duration_days, init_terms_unbacked, collateral_amount,
              lending_asset, collateral_asset, asset_type, collateral_asset_type,
              token_id, collateral_token_id, start_at, terminal_block,
              terminal_at, terminal_at_verified
         FROM loans WHERE chain_id = ? AND loan_id = ?`,
    )
      .bind(chainId, ledger.loan_id)
      .first<LoanHistoryRow>();
    if (loan) record = loanRecord(loan, ledger, tokenId);
  }
  if (record === null && ledger?.offer_id != null) {
    const offer = await env.DB.prepare(
      `SELECT offer_id, status, offer_type, amount, amount_max,
              interest_rate_bps, interest_rate_bps_max, collateral_amount,
              duration_days, lending_asset, collateral_asset, asset_type,
              collateral_asset_type
         FROM offers WHERE chain_id = ? AND offer_id = ?`,
    )
      .bind(chainId, ledger.offer_id)
      .first<OfferHistoryRow>();
    if (offer) record = offerRecord(offer, ledger);
  }

  return {
    chainId,
    tokenId,
    record,
    retirement: retired
      ? {
          blockNumber: retired.block_number,
          logIndex: retired.log_index,
          txHash: retired.tx_hash,
          at: retired.block_at,
        }
      : null,
    reason: retired ? retirementReason(record) : null,
  };
}

export async function handlePositionHistory(
  req: Request,
  env: Env,
  tokenIdRaw: string,
): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const tokenId = parseTokenId(tokenIdRaw);
  if (tokenId === null) return json({ error: 'bad-token-id' }, 400);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    return json(await readPositionHistory(env, chainId, tokenId));
  } catch {
    return json({ error: 'internal' }, 500);
  }
}
