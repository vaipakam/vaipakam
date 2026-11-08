/**
 * LN-32 — the receipt taking back collateral is confirmed against
 * (RB-CONFIDENCE): the amount taken back, the collateral before and after,
 * where it goes, the protocol's most that can be taken back now, the loan's
 * health factor and loan-to-value now, and every consequence: the loan moves
 * closer to liquidation, the protocol checks its limits again when the
 * withdrawal confirms (so a price move before then can refuse it, with
 * nothing moved), and the finish card states the protocol's own figures
 * after.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import type { TokenMetaMap } from '../reads/tokens';
import { formatBps, formatScaled, formatSpan } from '../ui/format';
import type { TakeBackReview } from './takeBackReview';

export function takeBackReceipt(r: TakeBackReview, _meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const loan = r.loan;
  const asset = loan.collateralAsset;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: Receipt['rows'] = [
    { label: text('takeBack.rowAmount'), value: { kind: 'amount', asset, amount: r.amount }, binding: true },
    { label: text('addColl.rowBefore'), value: { kind: 'amount', asset, amount: loan.collateralAmount }, binding: false },
    { label: text('addColl.rowAfter'), value: { kind: 'amount', asset, amount: loan.collateralAmount - r.amount }, binding: true },
    { label: text('takeBack.rowTo'), value: { kind: 'text', text: destination(r, copy) }, binding: true },
    { label: text('takeBack.rowMax'), value: r.maxWithdrawable === null ? unknown : { kind: 'amount', asset, amount: r.maxWithdrawable }, binding: false },
    { label: text('addColl.rowHfNow'), value: r.healthFactor === null ? unknown : { kind: 'text', text: formatScaled(r.healthFactor) }, binding: false },
    { label: text('addColl.rowLtvNow'), value: r.ltvBps === null ? unknown : { kind: 'text', text: format('position.ltv', { rate: formatBps(r.ltvBps) }) }, binding: false },
  ];
  const consequences = [
    text('takeBack.closer'),
    ...(r.protection === null
      ? [text('takeBack.protectionUnread')]
      : r.protection.enabled
        ? [text('takeBack.queuedNote'), ...(r.protection.requireCosign ? [text('takeBack.cosignNote')] : [])]
        : []),
    text('takeBack.limitMoves'),
    text('takeBack.afterFigures'),
    text('takeBack.pauseHolds'),
  ];
  return { title: format('takeBack.title', { id: r.loanId.toString() }), rows, consequences, prompts: 1, readAt: r.readAt };
}

/** Where the collateral goes: the wallet at once, or, for a wallet running
 *  protected account mode, the account's payout queue for its delay (and,
 *  while the account requires it, a secondary signer's approval of the
 *  release, which the protocol checks when the payout is released). */
export function destination(r: TakeBackReview, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  if (r.protection?.enabled) return copy.format(r.protection.requireCosign ? 'takeBack.toQueuedCosign' : 'takeBack.toQueued', { delay: formatSpan(r.protection.delaySeconds) });
  return copy.text('takeBack.to');
}
