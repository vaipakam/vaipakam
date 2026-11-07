/**
 * LN-22 / LN-64 — the receipt a partial repayment is confirmed against
 * (RB-CONFIDENCE): the principal part chosen, the interest it adds now and
 * at most, what leaves the wallet, the principal left afterwards, what the
 * approval lets the protocol take, and every consequence. The interest is
 * stated as exact only when the protocol's settlement figure is exactly a
 * part payment's interest (partialReview); otherwise every interest and
 * total figure reads "at most", and a consequence says why.
 */
import type { CopyAccess } from '../copy/useCopy';
import { figured, textValue, type Receipt, type ReceiptValue } from '../receipt/types';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatUtc } from '../ui/format';
import { allowanceFigure, approvalRowText, lateConfirmationLines } from './approvalCap';
import { partialPromptCount, partialPutBackPromptCount, type PartialReview } from './partialReview';

export function partialReceipt(r: PartialReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const loan = r.loan;
  const asset = loan.principalAsset;
  const by = formatUtc(Number(r.payoff.by));
  /** An amount, or "At most {amount}" when the figure is an upper bound. */
  const figure = (v: bigint): ReceiptValue =>
    r.interestExact ? { kind: 'amount', asset, amount: v } : textValue(figured((x) => format('partial.interestAtMost', { amount: tokenAmount(v, asset, meta, format, x) })));

  const rows: Receipt['rows'] = [
    { label: text('partial.rowPart'), value: { kind: 'amount', asset, amount: r.amount }, binding: true, movesOut: true },
    { label: text('partial.rowInterestNow'), value: figure(r.interestNow), binding: false, movesOut: true },
    { label: format('partial.rowInterestBy', { time: by }), value: figure(r.interestBy), binding: false, movesOut: true },
    { label: text('partial.rowTotalNow'), value: figure(r.amount + r.interestNow), binding: true, movesOut: true },
    { label: format('partial.rowTotalBy', { time: by }), value: { kind: 'amount', asset, amount: r.totalBy }, binding: true, movesOut: true },
    { label: text('partial.rowAfter'), value: { kind: 'amount', asset, amount: loan.principal - r.amount }, binding: true },
    {
      label: text('partial.rowDue'),
      value: r.maturity === null ? { kind: 'unknown', why: text('receipt.unknown') } : { kind: 'text', text: format('partial.dueSame', { time: formatUtc(Number(r.maturity)) }) },
      binding: false,
    },
    { label: text('partial.rowLender'), value: { kind: 'text', text: text('partial.lenderPaid') }, binding: false },
    { label: text('repay.rowBalance'), value: { kind: 'amount', asset, amount: r.balance }, binding: false },
    {
      label: text('repay.rowApproval'),
      value: {
        kind: 'text',
        text: approvalRowText({ allowance: r.allowance, steps: r.approvalSteps, cap: r.totalBy }, asset, meta, copy),
      },
      binding: false,
      movesOut: r.approvalSteps > 0,
    },
  ];

  const consequences = [
    text(r.interestExact ? 'partial.interestExact' : loan.useFullTermInterest ? 'partial.interestBoundFull' : 'partial.interestBoundLate'),
    ...lateConfirmationLines({ capped: r.capped, time: by, totalNow: r.amount + r.interestNow, totalBy: r.totalBy }, copy),
    ...(loan.useFullTermInterest ? [text('partial.fullTermRestarts')] : []),
    ...(r.period ? [format('partial.periodCounts', { time: formatUtc(Number(r.period.periodEndAt)) })] : r.periodUnread ? [text('partial.periodUnread')] : []),
    ...(r.maturity !== null ? [format('partial.dueStays', { time: formatUtc(Number(r.maturity)) })] : []),
    ...(r.approvalSteps > 0 ? [format('repay.losePutBack', { amount: allowanceFigure(r.allowance, asset, meta, copy) })] : []),
    ...(r.balance >= r.amount + r.interestNow && r.balance < r.totalBy
      ? [figured((x) => format('partial.loseBalance', { amount: tokenAmount(r.balance, asset, meta, format, x) }))]
      : []),
  ];

  return {
    title: format('partial.title', { id: r.loanId.toString() }),
    rows,
    consequences,
    prompts: partialPromptCount(r),
    afterPrompts: partialPutBackPromptCount(r),
    readAt: r.readAt,
  };
}
