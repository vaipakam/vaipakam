/**
 * RB-CONFIDENCE — a loan claim's measured outcome, one leg per thing the
 * review promised: the claim record itself, each token the claim paid
 * (grouped by token, since the claim row and funds held for the lender can be
 * the same token), each NFT, and whether the loan settled.
 *
 * Where a payment landed follows the wallet's protected mode: paid to the
 * wallet (its transfers to the wallet are summed), or queued, kept in the
 * vault, or paid into the vault (the Diamond's own payout records say which).
 * A figure that differs from the review is stated beside it, never hidden;
 * on a loan in fallback a match at claim time can change what the claim row
 * pays, so the protocol's own record is the figure compared, and the
 * claimant, as that match's matcher, is paid a reward in the principal token
 * of each loan the match paid, which is measured with the rest.
 */
import type { Log } from 'viem';
import type { CopyAccess } from '../copy/useCopy';
import { moved } from '../offers/acceptOutcome';
import { payoutOutcomes } from '../protection/payout';
import { payoutLegs, routedLeg } from '../protection/payoutCopy';
import type { LegOutcome } from '../tx/outcome';
import { claimRecorded, loanSettled, matchedInTx, nftArrived, surplusPaid } from './claimLog';
import { ASSET_ERC20, type ClaimLane } from './loanClaim';
import { laneLabel } from './loanClaimReceipt';
import type { LoanClaimReview } from './loanClaimReview';

type Hex = `0x${string}`;

export interface OutcomeText {
  copy: Pick<CopyAccess, 'text' | 'format'>;
  /** A token amount in short and in exact figures. */
  amount: (asset: Hex, v: bigint) => string;
  exact: (asset: Hex, v: bigint) => string;
  /** An NFT payout in words. */
  nft: (lane: ClaimLane) => string;
}

/** A matching reward this claim's transaction paid the claimant, with its
 *  token resolved from the leg's loan (null when that read failed). */
export interface PaidIncentive {
  loanId: bigint;
  asset: Hex | null;
  amount: bigint;
}

export function measureLoanClaim(r: LoanClaimReview, logs: readonly Log[], diamond: Hex, account: Hex, t: OutcomeText, incentives: readonly PaidIncentive[] = []): LegOutcome[] {
  const { text, format } = t.copy;
  const legs: LegOutcome[] = [];
  const record = claimRecorded(logs, diamond, r.loanId, r.side);
  if (record === null) {
    legs.push({
      status: 'not-done',
      label: format(r.side === 'lender' ? 'loanClaim.titleLender' : 'loanClaim.titleBorrower', { id: r.loanId.toString() }),
      reason: text('loanClaim.notClaimed'),
    });
    return legs;
  }
  legs.push({ status: 'done', label: format('loanClaim.legRecorded', { id: r.loanId.toString() }) });

  // What each payout should come to: the claim row as the protocol recorded
  // paying it (a claim-time match can rewrite it), the rest as reviewed.
  const lanes = r.lanes.map((l): ClaimLane => (l.kind === 'row' && l.assetType === ASSET_ERC20 ? { ...l, asset: record.asset, amount: record.amount } : l));
  const reviewedRow = r.lanes.find((l) => l.kind === 'row' && l.assetType === ASSET_ERC20);
  const nftRow = r.lanes.some((l) => l.kind === 'row' && l.assetType !== ASSET_ERC20);
  // A row the review found empty that the protocol paid all the same (a
  // claim-time match recorded one) is measured too.
  if (!reviewedRow && !nftRow && record.amount > 0n) lanes.unshift({ kind: 'row', asset: record.asset, assetType: ASSET_ERC20, tokenId: 0n, amount: record.amount });
  const rowMoved = reviewedRow ? reviewedRow.amount !== record.amount || reviewedRow.asset.toLowerCase() !== record.asset.toLowerCase() : !nftRow && record.amount > 0n;
  // On a loan in fallback the claim runs the protocol's match first; when
  // the logs show that match, the rewritten row is the match's doing, said so.
  const matched = matchedInTx(logs, diamond, r.loanId);
  if (rowMoved && matched) legs.push({ status: 'done', label: format('loanClaim.legRowMatched', { amount: t.amount(record.asset, record.amount) }) });
  else if (rowMoved)
    legs.push({
      status: 'unknown',
      label: format('loanClaim.legRowPaid', { amount: t.amount(record.asset, record.amount) }),
      reason: format('loanClaim.rowOther', {
        amount: t.exact(record.asset, record.amount),
        expected: reviewedRow ? t.exact(reviewedRow.asset, reviewedRow.amount) : t.exact(record.asset, 0n),
      }),
    });
  const surplus = r.lanes.find((l) => l.kind === 'surplus');
  if (surplus && surplusPaid(logs, diamond, r.loanId) === null)
    legs.push({ status: 'not-done', label: laneLabel('surplus', r.side, t.copy), reason: text('loanClaim.surplusNotPaid') });

  // Tokens, grouped: the claim row and held funds can share one.
  const byToken = new Map<string, { asset: Hex; amount: bigint }>();
  for (const l of lanes) {
    if (l.assetType !== ASSET_ERC20 || l.amount === 0n) continue;
    const k = l.asset.toLowerCase();
    byToken.set(k, { asset: l.asset, amount: (byToken.get(k)?.amount ?? 0n) + l.amount });
  }
  // The matcher's reward a claim-time match paid the claimant: stated, and
  // counted in its token's total (the collateral token's too), so it is
  // neither dropped nor read as a mismatch.
  for (const i of incentives) {
    if (i.asset === null) {
      legs.push({ status: 'unknown', label: text('loanClaim.legIncentiveUnread'), reason: format('loanClaim.incentiveUnread', { id: i.loanId.toString() }) });
      continue;
    }
    legs.push({ status: 'done', label: format('loanClaim.legIncentive', { amount: t.amount(i.asset, i.amount) }) });
    const k = i.asset.toLowerCase();
    byToken.set(k, { asset: byToken.get(k)?.asset ?? i.asset, amount: (byToken.get(k)?.amount ?? 0n) + i.amount });
  }
  for (const { asset, amount: expected } of byToken.values())
    legs.push(
      ...payoutLegs(
        {
          outcomes: payoutOutcomes(logs, diamond, account, asset),
          wallet: moved(logs, asset, null, account),
          expected,
          protection: r.protection,
          what: (v) => t.amount(asset, v),
          exact: (v) => t.exact(asset, v),
          walletLeg: (what) => format('loanClaim.legArrived', { amount: what }),
          walletOther: (got, want) => format('loanClaim.arrivedOther', { amount: got, expected: want }),
        },
        t.copy,
      ),
    );

  for (const l of lanes) {
    if (l.assetType === ASSET_ERC20) continue;
    const routed = payoutOutcomes(logs, diamond, account, l.asset);
    if (routed.length > 0) {
      for (const o of routed) legs.push({ status: 'done', label: routedLeg(o, t.nft(l), r.protection, t.copy) });
      continue;
    }
    const arrived = nftArrived(logs, l.asset, l.assetType, l.tokenId, account);
    legs.push(
      arrived >= l.amount
        ? { status: 'done', label: format('loanClaim.legNft', { nft: t.nft(l) }) }
        : { status: 'not-done', label: format('loanClaim.legNft', { nft: t.nft(l) }), reason: text('loanClaim.nftNotArrived') },
    );
  }

  if (loanSettled(logs, diamond, r.loanId)) legs.push({ status: 'done', label: text('loanClaim.legSettled') });
  return legs;
}
