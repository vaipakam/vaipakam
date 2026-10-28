/**
 * Batch close-out on offer-grouped loans (#126) — the pure half.
 *
 * Loans group by the offer they came from. A group is the connected
 * wallet's OWN borrower positions only: one offer can fill into loans
 * with different counterparties, and the contract checks the position
 * holder per call anyway, so offering another borrower's loan would only
 * produce a refusal.
 *
 * Each loan is planned through the shared close-out plan
 * (`closeOutPlan.ts`), and the calls go to the Diamond's multicall with
 * `allowFailure` set, so a loan that fails is skipped while the others
 * close. Outcomes are read back from the chain, never assumed from the
 * receipt.
 */
import { AssetType } from '../lib/types';
import type { CloseOutPlan, CloseOutPull } from './closeOutPlan';

/** The fields grouping reads from a Positions row. */
export interface GroupableLoan {
  loanId: number;
  offerId: number;
  role: 'lender' | 'borrower';
  status: string;
  assetType: number;
  lendingAsset: string;
}

export interface OfferGroup<T extends GroupableLoan> {
  offerId: number;
  loans: T[];
}

/** The borrower's live ERC-20 loans, grouped by originating offer, for
 *  every offer that filled into two or more of them. Ordered by offer id,
 *  loans by loan id, so the card does not reshuffle on refetch. */
export function borrowerOfferGroups<T extends GroupableLoan>(rows: readonly T[]): OfferGroup<T>[] {
  const byOffer = new Map<number, T[]>();
  for (const r of rows) {
    if (r.role !== 'borrower' || r.status !== 'active') continue;
    if (r.assetType !== AssetType.ERC20 || r.offerId <= 0) continue;
    const list = byOffer.get(r.offerId) ?? [];
    // The same loan can arrive twice (chain and indexer legs); keep one.
    if (!list.some((l) => l.loanId === r.loanId)) list.push(r);
    byOffer.set(r.offerId, list);
  }
  return [...byOffer.entries()]
    .filter(([, loans]) => loans.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([offerId, loans]) => ({
      offerId,
      loans: [...loans].sort((a, b) => a.loanId - b.loanId),
    }));
}

/**
 * The groups to render: the live ones, plus every group whose card is
 * mid-batch or showing results. A batch that closes loans can leave its
 * offer with fewer than two open loans, which drops the group from the
 * live list; without this the card would unmount and take the outcomes
 * and the approval note with it. A held group renders as it was when its
 * batch started, until it is dismissed.
 */
export function withHeldGroups<T extends GroupableLoan>(
  live: readonly OfferGroup<T>[],
  held: ReadonlyMap<number, OfferGroup<T>>,
): OfferGroup<T>[] {
  const byOffer = new Map(live.map((g) => [g.offerId, g]));
  for (const [offerId, g] of held) byOffer.set(offerId, g);
  return [...byOffer.values()].sort((a, b) => a.offerId - b.offerId);
}

/** What the ready loans will take, summed per token. */
export function pullTotals(plans: readonly CloseOutPlan[]): CloseOutPull[] {
  const byToken = new Map<string, CloseOutPull>();
  for (const p of plans) {
    if (p.kind !== 'ready' || !p.pull) continue;
    const key = p.pull.token.toLowerCase();
    const prev = byToken.get(key);
    byToken.set(
      key,
      prev
        ? { token: prev.token, due: prev.due + p.pull.due, approve: prev.approve + p.pull.approve }
        : { ...p.pull },
    );
  }
  return [...byToken.values()];
}

/** A loan's outcome, decided by reading it back after the batch.
 *  `closed` is Repaid, the status both calls leave; any other status a
 *  loan left Active for (a default, a liquidation) is `changed`, never
 *  reported as this batch's close. */
export type BatchOutcome =
  | { loanId: number; kind: 'closed' }
  | { loanId: number; kind: 'changed' }
  | { loanId: number; kind: 'open'; reason: string }
  | { loanId: number; kind: 'left-out'; reason: string }
  | { loanId: number; kind: 'unknown' };
