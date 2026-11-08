/**
 * LN-48 / LN-49 — the receipt collecting a loan's claim is confirmed against
 * (RB-CONFIDENCE): every payout the claim makes, each named the same way
 * everywhere (the claim row, funds held for the lender, a rented NFT coming
 * back, a held surplus, collateral still under the loan's lien), what past
 * sellers of a lender position take first, where the payment lands, and
 * every consequence: the position closes, a loan in fallback ends with the
 * lender's claim, and a pause before it confirms refuses it.
 *
 * A lender claim the close-out recorded at nothing still runs: it pays
 * nothing and closes the position, and the receipt says exactly that.
 */
import type { CopyAccess } from '../copy/useCopy';
import { assetAmount } from '../positions/assetAmount';
import type { Receipt, ReceiptRow } from '../receipt/types';
import type { TokenMetaMap } from '../reads/tokens';
import { routedDestination, routeNotes } from '../protection/payoutCopy';
import { ASSET_ERC20, isFallback, type ClaimLane, type LaneKind } from './loanClaim';
import type { LoanClaimReview } from './loanClaimReview';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** `LibVaipakam.LoanStatus.Defaulted`. */
const DEFAULTED = 2;

/** The label every surface gives a payout of this kind. */
export function laneLabel(kind: LaneKind, side: LoanClaimReview['side'], copy: Copy): string {
  const { text } = copy;
  switch (kind) {
    case 'row':
      return text(side === 'lender' ? 'loanClaim.laneLender' : 'loanClaim.laneCollateral');
    case 'held':
      return text('loanClaim.laneHeld');
    case 'rentalReturn':
      return text('loanClaim.laneRental');
    case 'surplus':
      return text('loanClaim.laneSurplus');
    case 'liened':
      return text('loanClaim.laneLiened');
  }
}

/** One payout as a receipt value: a token amount, or an NFT in words. */
function laneValue(l: ClaimLane, meta: TokenMetaMap | null, copy: Copy): ReceiptRow['value'] {
  if (l.assetType === ASSET_ERC20) return { kind: 'amount', asset: l.asset, amount: l.amount };
  return { kind: 'text', text: assetAmount({ asset: l.asset, assetType: l.assetType, amount: 0n, tokenId: l.tokenId, quantity: l.amount }, meta, copy.format) };
}

/** Where the payment lands: the wallet, or where protected account mode
 *  routes it (RB-PAYOUT-ROUTE); null when the mode could not be read. */
export function claimDestination(r: Pick<LoanClaimReview, 'route' | 'protection'>, copy: Copy): string | null {
  return r.route === 'wallet' ? copy.text('loanClaim.toWallet') : routedDestination(r.route, r.protection, copy);
}

export function loanClaimReceipt(r: LoanClaimReview, meta: TokenMetaMap | null, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: ReceiptRow[] = r.lanes.map((l): ReceiptRow => ({ label: laneLabel(l.kind, r.side, copy), value: laneValue(l, meta, copy), binding: true }));
  // Zero is said only of a claim read open with nothing in it; a claim that
  // could not be read is unknown, never zero.
  if (r.claim === null) rows.push({ label: text('loanClaim.rowReceive'), value: unknown, binding: true });
  else if (r.lanes.length === 0 && !r.claim.claimed) rows.push({ label: text('loanClaim.rowReceive'), value: { kind: 'text', text: text('loanClaim.zeroClaim') }, binding: true });
  if (r.side === 'lender' && r.sellersShare !== null && r.sellersShare > 0n && r.claim)
    rows.push({ label: text('loanClaim.rowSellers'), value: { kind: 'amount', asset: r.claim.asset, amount: r.sellersShare }, binding: false });
  if (r.side === 'lender' && Number(r.loan.status) === DEFAULTED && Number(r.loan.assetType) === ASSET_ERC20)
    rows.push({ label: text('loanClaim.rowPrincipal'), value: { kind: 'amount', asset: r.loan.principalAsset, amount: r.loan.principal }, binding: false });
  const to = claimDestination(r, copy);
  rows.push({ label: text('takeBack.rowTo'), value: to === null ? unknown : { kind: 'text', text: to }, binding: true });

  const fallback = r.side === 'lender' && isFallback(Number(r.loan.status));
  const consequences = [
    text('loanClaim.closes'),
    ...(fallback ? [text('loanClaim.fallbackEnds')] : []),
    ...(r.side === 'lender' && r.sellersShare !== null && r.sellersShare > 0n ? [text('loanClaim.sellersNote')] : []),
    ...routeNotes(r.route, r.protection, copy),
    ...(r.route === 'queued' ? [text('loanClaim.queueFullNote')] : []),
    text('loanClaim.pauseHolds'),
  ];
  return {
    title: format(r.side === 'lender' ? 'loanClaim.titleLender' : 'loanClaim.titleBorrower', { id: r.loanId.toString() }),
    rows,
    consequences,
    prompts: 1,
    readAt: r.readAt,
  };
}
