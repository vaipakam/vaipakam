/**
 * OFF-44 — the lender offers open for the pair the borrower picked, read
 * from the protocol's pair index through the wallet's connection. Each row
 * carries the offer as stored, its state, and (with a wallet) what accepting
 * it would do for this wallet, from `previewAccept`. A row whose reads fail
 * is kept with the failure stated, so a failed read never shrinks the list
 * into a confident "nothing here".
 */
import type { PublicClient } from 'viem';
import { type StoredOffer } from '../../shared/offers/acceptTerms';
import { borrowFit, notTakeable, rankForBorrower, type NotTakeable, type OfferFit } from '../../shared/offers/model';
import { readOffer, readOfferState, readPairLtvBps, readPairOfferIds, readPreview, type AcceptPreview, type OfferState } from '../../shared/offers/reads';
import { refusalFromError } from '../../shared/eligibility/refusal';

type Hex = `0x${string}`;

/** How many of the pair's open offers one read covers. */
export const MATCH_PAGE = 20;

export type Ltv = { kind: 'bps'; bps: bigint } | { kind: 'not-worked-out'; reason: string };

export interface MatchRow {
  offer: StoredOffer;
  state: OfferState;
  /** Null without a wallet: the preview is a question about an acceptor. */
  preview: AcceptPreview | null;
  ltv: Ltv;
  blocked: NotTakeable | null;
}

export interface UnreadRow {
  id: bigint;
  reason: string;
}

export interface Matches {
  rows: MatchRow[];
  unread: UnreadRow[];
  /** Offers on the pair the guided flow does not take, by why. */
  skipped: Readonly<Record<Exclude<OfferFit, 'fits'>, number>>;
  /** How many open offers the protocol's pair index holds. */
  total: bigint;
  /** How many of them this read looked at. */
  scanned: number;
}

function message(e: unknown): string {
  return refusalFromError(e).reason;
}

export async function readMatches(client: PublicClient, diamond: Hex, lending: Hex, collateral: Hex, account: Hex | null): Promise<Matches> {
  const { ids, total } = await readPairOfferIds(client, diamond, lending, collateral, MATCH_PAGE);
  const skipped = { own: 0, 'not-lender': 0, 'not-erc20': 0 };
  const rows: MatchRow[] = [];
  const unread: UnreadRow[] = [];
  await Promise.all(
    ids.map(async (id) => {
      let offer: StoredOffer;
      try {
        offer = await readOffer(client, diamond, id);
      } catch (e) {
        unread.push({ id, reason: message(e) });
        return;
      }
      const fit = borrowFit(offer, account ?? '0x0000000000000000000000000000000000000000');
      if (fit !== 'fits') {
        skipped[fit] += 1;
        return;
      }
      try {
        const [state, preview, ltv] = await Promise.all([
          readOfferState(client, diamond, id),
          account ? readPreview(client, diamond, id, account) : Promise.resolve(null),
          readPairLtvBps(client, diamond, offer.lendingAsset, offer.amountMax, offer.collateralAsset, offer.collateralAmount).then(
            (bps): Ltv => ({ kind: 'bps', bps }),
            (e): Ltv => ({ kind: 'not-worked-out', reason: message(e) }),
          ),
        ]);
        const blocked = account ? notTakeable(state, preview, null) : state === 'open' ? null : { kind: 'state' as const, state };
        rows.push({ offer, state, preview, ltv, blocked });
      } catch (e) {
        unread.push({ id, reason: message(e) });
      }
    }),
  );
  unread.sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    rows: rankForBorrower(rows),
    unread,
    skipped,
    total,
    scanned: ids.length,
  };
}

/** A row's place in the list: ended offers (accepted, cancelled, expired,
 *  consumed by a sale) are counted and not shown as actionable. */
export function ended(row: MatchRow): boolean {
  return row.state !== 'open';
}
