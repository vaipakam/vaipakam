/**
 * LN-31 — the receipt a top-up is confirmed against (RB-CONFIDENCE): the
 * amount added, the collateral before and after, where it is held, the
 * loan's health factor and loan-to-value now (the protocol's own figures
 * after come on the finish card), what the approval lets the protocol take,
 * and every consequence: the top-up cannot be taken back except within the
 * protocol's withdrawal limit, a loan in fallback is cured only when the
 * top-up restores its opening limits, and the protocol pause does not hold
 * a top-up.
 */
import type { CopyAccess } from '../copy/useCopy';
import { figured, type Receipt } from '../receipt/types';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatScaled, shortAddress } from '../ui/format';
import { addPromptCount, inFallback, type AddReview } from './addReview';

export function addReceipt(r: AddReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const loan = r.loan;
  const asset = loan.collateralAsset;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };

  const approval = figured((x) =>
    r.approvalSteps === 0
      ? format('addColl.approvalCovers', { amount: x ? exactTokenAmount(r.amount, asset, meta, format) : tokenAmount(r.amount, asset, meta, format) })
      : format('addColl.approvalNeeded', { amount: x ? exactTokenAmount(r.amount, asset, meta, format) : tokenAmount(r.amount, asset, meta, format) }),
  );

  const rows: Receipt['rows'] = [
    { label: text('addColl.rowAmount'), value: { kind: 'amount', asset, amount: r.amount }, binding: true, movesOut: true },
    { label: text('addColl.rowBefore'), value: { kind: 'amount', asset, amount: loan.collateralAmount }, binding: false },
    { label: text('addColl.rowAfter'), value: { kind: 'amount', asset, amount: loan.collateralAmount + r.amount }, binding: true },
    { label: text('addColl.rowHeld'), value: { kind: 'text', text: heldText(r, copy) }, binding: true },
    { label: text('addColl.rowHfNow'), value: r.healthFactor === null ? unknown : { kind: 'text', text: formatScaled(r.healthFactor) }, binding: false },
    { label: text('addColl.rowLtvNow'), value: r.ltvBps === null ? unknown : { kind: 'text', text: format('position.ltv', { rate: formatBps(r.ltvBps) }) }, binding: false },
    { label: text('repay.rowBalance'), value: { kind: 'amount', asset, amount: r.balance }, binding: false },
    {
      label: text('repay.rowApproval'),
      value: typeof approval === 'string' ? { kind: 'text', text: approval } : { kind: 'text', text: approval.text, exact: approval.exact },
      binding: false,
      movesOut: r.approvalSteps > 0,
    },
  ];

  const consequences = [
    text('addColl.canLose'),
    text('addColl.afterFigures'),
    text('addColl.takeBackLimit'),
    ...(inFallback(r) ? [text('addColl.fallbackCure')] : []),
    text(r.paused === null ? 'addColl.pauseUnread' : r.paused ? 'addColl.pausedOpen' : 'addColl.pauseOpen'),
    ...(r.approvalSteps > 0 ? [text('addColl.approvalBack')] : []),
  ];

  return {
    title: format('addColl.title', { id: r.loanId.toString() }),
    rows,
    consequences,
    prompts: addPromptCount(r),
    readAt: r.readAt,
  };
}

/** Where the top-up lands. The protocol deposits into the vault of the
 *  borrower the loan records. A running loan first moves to the current
 *  holder (consolidation), so that is the reader's own vault; a loan in
 *  fallback is not moved while the episode lasts, so a position that changed
 *  hands keeps the top-up in the recorded borrower's vault unless the top-up
 *  returns the loan to running. */
export function heldText(r: AddReview, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  const recorded = r.loan.borrower;
  const moved = r.borrowerHolder !== null && recorded.toLowerCase() !== r.borrowerHolder.toLowerCase();
  if (inFallback(r) && moved) return copy.format('addColl.heldRecorded', { vault: shortAddress(recorded) });
  if (inFallback(r) && r.borrowerHolder === null) return copy.format('addColl.heldRecordedUnread', { vault: shortAddress(recorded) });
  return copy.text('addColl.held');
}
