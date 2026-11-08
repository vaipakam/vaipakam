/**
 * #3205 — whether a position-bound flow can still complete.
 *
 * A position NFT's transfer never blocks. Instead every protocol flow bound
 * to a position completes only if that position's token has not moved (any
 * transfer, even away and back) since the flow opened. The chain has no view
 * yet that answers "moved since opened" (#3323), so the indexer derives it
 * from the position-NFT `Transfer` events it already scans:
 *
 *  - {@link recordPositionMove} keeps, per loan side, the LAST move as
 *    (block, log index) in `position_side_moves`. A mint (`from` = 0x0) is not
 *    a move; a burn is.
 *  - each flow row carries the (block, log index) it opened at — a collateral
 *    listing the point it was last posted or updated, since the current
 *    holder's update re-arms it;
 *  - {@link movedSinceOpened} compares the two. THIS is the rule, and the only
 *    place it is written: the routes call it, never their own comparison.
 *
 * Flows and the side they bind: borrower — collateral (prepay) listing,
 * offset offer, swap-to-repay intent, refinance request; lender — the loan
 * sale listing.
 *
 * The verdict is three-valued and never rounds an unknown: `null` means the
 * indexer cannot tell (the flow's opening point is not recorded), and a
 * reader must say so rather than read it as "not moved".
 */
import type { Env } from './env';
import { chunkD1InList } from '@vaipakam/lib/d1Binds';

export type PositionSide = 'lender' | 'borrower';

/** A point in the chain's log order. */
export interface LogPosition {
  block: number;
  logIndex: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * THE rule. `true` — the side's token moved after the flow opened, so the
 * flow can never complete. `false` — no move since. `null` — the flow's
 * opening point is not known, so the indexer cannot tell.
 */
export function movedSinceOpened(
  opened: LogPosition | null,
  lastMove: LogPosition | null,
): boolean | null {
  if (opened === null) return null;
  if (lastMove === null) return false;
  if (lastMove.block !== opened.block) return lastMove.block > opened.block;
  return lastMove.logIndex > opened.logIndex;
}

/** Build a {@link LogPosition} from nullable columns; null when either is. */
export function logPosition(
  block: number | null | undefined,
  logIndex: number | null | undefined,
): LogPosition | null {
  if (block === null || block === undefined) return null;
  if (logIndex === null || logIndex === undefined) return null;
  return { block: Number(block), logIndex: Number(logIndex) };
}

/**
 * Record a position-NFT `Transfer` as the latest move of whichever LIVE loan
 * side holds `tokenId`. A mint (`from` = 0x0) records nothing. A later move
 * replaces an earlier one; an older (replayed) one leaves the row alone, so
 * re-processing a block is idempotent.
 *
 * Call it BEFORE the Transfer handler re-points the holder: a burn writes the
 * zero holder, after which `liveSide` no longer matches the side it burned.
 *
 * @param liveSide The chain indexer's live-side predicate for a holder
 *        column, so a retired receipt moving on records nothing (the same
 *        predicate the holder updates use).
 * @returns the number of loan sides recorded.
 */
export async function recordPositionMove(
  env: Env,
  chainId: number,
  move: {
    tokenId: string;
    from: string;
    block: number;
    logIndex: number;
    txHash: string;
    movedAt: number;
  },
  liveSide: (column: 'lender_current_owner' | 'borrower_current_owner') => string,
): Promise<number> {
  if (move.tokenId === '0' || move.from.toLowerCase() === ZERO) return 0;
  const upsert = (side: PositionSide) => {
    const tokenCol = side === 'lender' ? 'lender_token_id' : 'borrower_token_id';
    const ownerCol = side === 'lender' ? 'lender_current_owner' : 'borrower_current_owner';
    return env.DB.prepare(
      `INSERT INTO position_side_moves
         (chain_id, loan_id, side, token_id, moved_block, moved_log_index, moved_tx_hash, moved_at)
       SELECT chain_id, loan_id, '${side}', ?, ?, ?, ?, ?
         FROM loans
        WHERE chain_id = ? AND ${tokenCol} = ? AND ${liveSide(ownerCol)}
       ON CONFLICT (chain_id, loan_id, side) DO UPDATE SET
         token_id = excluded.token_id,
         moved_block = excluded.moved_block,
         moved_log_index = excluded.moved_log_index,
         moved_tx_hash = excluded.moved_tx_hash,
         moved_at = excluded.moved_at
       WHERE excluded.moved_block > position_side_moves.moved_block
          OR (excluded.moved_block = position_side_moves.moved_block
              AND excluded.moved_log_index > position_side_moves.moved_log_index)`,
    ).bind(
      move.tokenId,
      move.block,
      move.logIndex,
      move.txHash.toLowerCase(),
      move.movedAt,
      chainId,
      move.tokenId,
    );
  };
  const res = await env.DB.batch([upsert('lender'), upsert('borrower')]);
  return res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

/** The latest move of each requested loan side, keyed `${loanId}:${side}`. */
export async function readLastMoves(
  env: Env,
  chainId: number,
  loanIds: readonly number[],
): Promise<Map<string, LogPosition>> {
  const out = new Map<string, LogPosition>();
  const ids = Array.from(new Set(loanIds.filter((n) => Number.isSafeInteger(n) && n > 0)));
  if (ids.length === 0) return out;
  const chunks = chunkD1InList(ids, { before: [chainId] });
  const parts = await env.DB.batch<{
    loan_id: number;
    side: PositionSide;
    moved_block: number;
    moved_log_index: number;
  }>(
    chunks.map((c) =>
      env.DB.prepare(
        `SELECT loan_id, side, moved_block, moved_log_index FROM position_side_moves
          WHERE chain_id = ? AND loan_id IN (${c.placeholders})`,
      ).bind(...c.binds),
    ),
  );
  for (const part of parts) {
    for (const r of part.results ?? []) {
      out.set(`${r.loan_id}:${r.side}`, { block: r.moved_block, logIndex: r.moved_log_index });
    }
  }
  return out;
}

/** Which position-bound flow an offer is, as the offer routes publish it. */
export type OfferFlowKind = 'loanSale' | 'offset' | 'refinance';

/** The JSON an offer route publishes for a position-bound offer. */
export interface PositionFlowJson {
  kind: OfferFlowKind;
  side: PositionSide;
  /** The loan the flow is bound to; null when its link was not seen. */
  loanId: number | null;
  /** See {@link movedSinceOpened}: null = cannot tell. */
  movedSinceOpened: boolean | null;
}

/** The columns of an offer row this module reads. */
export interface OfferFlowColumns {
  offer_id: number;
  is_sale_vehicle: number;
  is_offset_vehicle: number;
  refinance_target_loan_id?: number | null;
  vehicle_loan_id?: number | null;
  first_seen_block: number;
  created_log_index?: number | null;
}

/** The flow an offer row is bound to, or null for an offer bound to none
 *  (or one whose refinance target is not read yet, which the offer's own
 *  `refinanceTargetLoanId: null` already states as unknown). */
function offerBinding(
  row: OfferFlowColumns,
): { kind: OfferFlowKind; side: PositionSide; loanId: number | null } | null {
  if (row.is_sale_vehicle === 1) {
    return { kind: 'loanSale', side: 'lender', loanId: row.vehicle_loan_id ?? null };
  }
  if (row.is_offset_vehicle === 1) {
    return { kind: 'offset', side: 'borrower', loanId: row.vehicle_loan_id ?? null };
  }
  const target = row.refinance_target_loan_id;
  if (target !== null && target !== undefined && target > 0) {
    return { kind: 'refinance', side: 'borrower', loanId: target };
  }
  return null;
}

/**
 * The `positionFlow` field of each offer row, keyed by offer id: null for an
 * offer bound to no position, otherwise its kind, side, loan and verdict.
 */
export async function offerPositionFlows(
  env: Env,
  chainId: number,
  rows: readonly OfferFlowColumns[],
): Promise<Map<number, PositionFlowJson | null>> {
  const out = new Map<number, PositionFlowJson | null>();
  const bound = rows.map((r) => ({ row: r, b: offerBinding(r) }));
  const loanIds = bound.flatMap(({ b }) => (b?.loanId != null ? [b.loanId] : []));
  const moves = await readLastMoves(env, chainId, loanIds);
  for (const { row, b } of bound) {
    if (b === null) {
      out.set(row.offer_id, null);
      continue;
    }
    const opened = b.loanId === null ? null : logPosition(row.first_seen_block, row.created_log_index);
    out.set(row.offer_id, {
      kind: b.kind,
      side: b.side,
      loanId: b.loanId,
      movedSinceOpened:
        b.loanId === null ? null : movedSinceOpened(opened, moves.get(`${b.loanId}:${b.side}`) ?? null),
    });
  }
  return out;
}
