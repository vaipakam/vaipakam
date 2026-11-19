/**
 * #3744 — offer escrow held for an offer's position token.
 *
 * An open offer's escrow follows the holder of the offer's position token.
 * When a step someone else triggered (a match, a fill, an expired cleanup)
 * returns escrow to a holder who cannot be paid right then, the contract keeps
 * the amount in the creator's vault, held for the token
 * (`OfferEscrowReturned` with `held` true), until the token's holder collects
 * it into their own vault (`collectOfferRefund`, which emits
 * `OfferRefundCollected`).
 *
 * `GET /offers/held-refunds/:address?chainId=` lists the (position token,
 * asset, token id) lines the event log shows as still held for a wallet:
 * those whose return named the wallet as holder, and those whose token the
 * wallet holds now by the indexer's record. Each line carries the figure the
 * log adds up to (held returns less collections) and says it is that, a log
 * figure: the contract's `getOfferRefundHeld` is the amount, and only the
 * token's holder of record may collect. The app reads both live before it
 * offers the step, and never shows this figure as the collectable amount.
 *
 * What this cannot see, stated rather than implied: a held line for a token
 * that moved after its offer's token was retired (a retired token can still
 * move as a receipt, while the indexer records a retired token's holder as
 * nobody), unless the return itself named the wallet. The live read is what
 * settles who may collect.
 */
import type { Env } from './env';
import { jsonResponse } from './offerRoutes';
import { chainNotServed, requestedChainId } from './servedChain';
import { redactedError } from '@vaipakam/lib/errorDescription';

/** The most event rows one request reads. Held returns are rare; a wallet
 *  past this is reported as `truncated`, never as complete. */
export const HELD_REFUND_SCAN_CAP = 2000;

/** One held line, as the event log adds it up. */
export interface HeldRefundLine {
  positionToken: string;
  asset: string;
  tokenId: string;
  /** Held returns less collections, from the event log. Not the amount: the
   *  contract's `getOfferRefundHeld` is. */
  indexedRemaining: string;
  /** The offers whose returns were held for this token, newest last. */
  offerIds: number[];
  /** The asset's kind on the offer it came from (0 ERC-20, 1 ERC-721,
   *  2 ERC-1155), or null when the offer row is not indexed. */
  assetKind: number | null;
}

interface EventRow {
  kind: string;
  args_json: string;
  offer_id: number | null;
}

interface OfferAssetRow {
  offer_id: number;
  lending_asset: string;
  asset_type: number;
  collateral_asset: string;
  collateral_asset_type: number;
}

/** Fold the returned and collected events into the lines still held. Pure,
 *  so the arithmetic is tested without a database. */
export function foldHeldRefunds(
  rows: readonly EventRow[],
  offers: ReadonlyMap<number, OfferAssetRow>,
): HeldRefundLine[] {
  const lines = new Map<string, { line: HeldRefundLine; held: bigint; collected: bigint }>();
  const keyOf = (t: string, a: string, id: string) => `${t}|${a}|${id}`;
  for (const r of rows) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(r.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const token = typeof args.positionToken === 'string' ? args.positionToken : null;
    const asset = typeof args.asset === 'string' ? args.asset.toLowerCase() : null;
    const tokenId = typeof args.tokenId === 'string' ? args.tokenId : '0';
    const amountRaw = typeof args.amount === 'string' ? args.amount : null;
    if (!token || !asset || amountRaw === null || !/^\d+$/.test(amountRaw) || !/^\d+$/.test(token)) continue;
    const amount = BigInt(amountRaw);
    const key = keyOf(token, asset, tokenId);
    let entry = lines.get(key);
    if (!entry) {
      entry = {
        line: { positionToken: token, asset, tokenId, indexedRemaining: '0', offerIds: [], assetKind: null },
        held: 0n,
        collected: 0n,
      };
      lines.set(key, entry);
    }
    if (r.kind === 'OfferEscrowReturned') {
      if (args.held !== true) continue;
      entry.held += amount;
      if (r.offer_id !== null && !entry.line.offerIds.includes(r.offer_id)) {
        entry.line.offerIds.push(r.offer_id);
        const o = offers.get(r.offer_id);
        if (o && entry.line.assetKind === null) {
          if (o.lending_asset.toLowerCase() === asset) entry.line.assetKind = Number(o.asset_type);
          else if (o.collateral_asset.toLowerCase() === asset) entry.line.assetKind = Number(o.collateral_asset_type);
        }
      }
    } else if (r.kind === 'OfferRefundCollected') {
      entry.collected += amount;
    }
  }
  const out: HeldRefundLine[] = [];
  for (const { line, held, collected } of lines.values()) {
    if (held <= collected) continue;
    out.push({ ...line, indexedRemaining: (held - collected).toString() });
  }
  return out;
}

export async function handleOfferHeldRefunds(req: Request, env: Env, addrRaw: string): Promise<Response> {
  const url = new URL(req.url);
  const chainId = requestedChainId(url);
  const addr = addrRaw.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return jsonResponse({ error: 'bad-address' }, 400);
  const notServed = chainNotServed(env, chainId);
  if (notServed) return notServed;
  try {
    const events = await env.DB.prepare(
      `SELECT kind, args_json, offer_id FROM activity_events
        WHERE chain_id = ?
          AND kind IN ('OfferEscrowReturned', 'OfferRefundCollected')
          AND (
            actor = ?
            OR json_extract(args_json, '$.positionToken') IN (
              SELECT position_token_id FROM offers
               WHERE chain_id = ? AND creator_current_owner = ? AND position_token_id <> '0'
            )
          )
        ORDER BY block_number ASC, log_index ASC
        LIMIT ?`,
    )
      .bind(chainId, addr, chainId, addr, HELD_REFUND_SCAN_CAP + 1)
      .all<EventRow>();
    const rows = events.results ?? [];
    const truncated = rows.length > HELD_REFUND_SCAN_CAP;
    const kept = truncated ? rows.slice(0, HELD_REFUND_SCAN_CAP) : rows;
    const offerIds = [...new Set(kept.map((r) => r.offer_id).filter((id): id is number => id !== null))];
    const offers = new Map<number, OfferAssetRow>();
    if (offerIds.length > 0) {
      const found = await env.DB.prepare(
        `SELECT offer_id, lending_asset, asset_type, collateral_asset, collateral_asset_type
           FROM offers
          WHERE chain_id = ? AND offer_id IN (SELECT value FROM json_each(?))`,
      )
        .bind(chainId, JSON.stringify(offerIds))
        .all<OfferAssetRow>();
      for (const o of found.results ?? []) offers.set(Number(o.offer_id), o);
    }
    return jsonResponse({
      chainId,
      address: addr,
      lines: foldHeldRefunds(kept, offers),
      truncated,
      basis:
        'event-log figures; the contract getOfferRefundHeld is the amount and its holder of record may collect',
    });
  } catch (err) {
    console.error('[offerHeldRefunds] failed', redactedError(err));
    return jsonResponse({ error: 'held-refunds-failed' }, 500);
  }
}
