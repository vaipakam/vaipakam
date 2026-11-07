/**
 * LN-21 / LN-16 — the receipt a full repayment is confirmed against
 * (RB-CONFIDENCE): what leaves the wallet now and at most, what the
 * approval lets the protocol take, where the collateral goes, and every
 * consequence. Every amount is the protocol's own settlement figure.
 */
import { maxUint256 } from 'viem';
import type { CopyAccess } from '../copy/useCopy';
import { figured, textValue, type Receipt } from '../receipt/types';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatUtc } from '../ui/format';
import { STATUS_FALLBACK_PENDING } from '../eligibility/repay';
import { paysAsBorrower, promptCount, type RepayReview } from './repayReview';

type Hex = `0x${string}`;

/** An allowance in words: the largest value, which a wallet's "unlimited"
 *  approval sets, is named as such rather than printed as 78 digits. */
export function allowanceFigure(v: bigint, asset: Hex, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  return v === maxUint256 ? copy.text('repay.unlimited') : exactTokenAmount(v, asset, meta, copy.format);
}

export function repayReceipt(r: RepayReview, account: Hex, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const loan = r.loan;
  const asset = loan.principalAsset;
  const exact = (v: bigint) => exactTokenAmount(v, asset, meta, format);
  const by = formatUtc(Number(r.payoff.by));
  const borrower = paysAsBorrower(r, account);
  const collateral = (x: boolean) => tokenAmount(loan.collateralAmount, loan.collateralAsset, meta, format, x);

  const rows: Receipt['rows'] = [
    { label: text('repay.rowNow'), value: { kind: 'amount', asset, amount: r.payoff.now }, binding: true, movesOut: true },
    { label: format('repay.rowBy', { time: by }), value: { kind: 'amount', asset, amount: r.payoff.atBy }, binding: true, movesOut: true },
    { label: text('repay.rowPrincipal'), value: { kind: 'amount', asset, amount: loan.principal }, binding: false },
    {
      label: text('repay.rowInterest'),
      value: { kind: 'text', text: text(loan.useFullTermInterest ? 'repay.interestFull' : 'repay.interestProRata') },
      binding: false,
    },
    {
      label: text('repay.rowCollateral'),
      value: textValue(figured((x) => format('repay.collateralTo', { amount: collateral(x), id: loan.borrowerTokenId.toString() }))),
      binding: true,
    },
    { label: text('repay.rowLender'), value: { kind: 'text', text: text('repay.lenderGets') }, binding: false },
    { label: text('repay.rowBalance'), value: { kind: 'amount', asset, amount: r.balance }, binding: false },
    {
      label: text('repay.rowApproval'),
      value: {
        kind: 'text',
        text:
          r.approvalSteps === 0
            ? format('repay.approvalEnough', { amount: exact(r.allowance) })
            : r.approvalSteps === 2
              ? format('repay.approvalZeroFirst', { amount: exact(r.payoff.atBy) })
              : r.allowance > r.payoff.atBy
                ? format('repay.approvalLower', { prior: allowanceFigure(r.allowance, asset, meta, copy), amount: exact(r.payoff.atBy) })
                : format('repay.approvalNeeded', { amount: exact(r.payoff.atBy) }),
      },
      binding: false,
      movesOut: r.approvalSteps > 0,
    },
  ];

  const consequences = [
    text(loan.useFullTermInterest ? 'repay.loseFull' : 'repay.loseGrows'),
    format(r.capped ? 'repay.loseGraceEnds' : 'repay.loseLate', { time: by }),
    ...(r.approvalSteps > 0 ? [format('repay.losePutBack', { amount: allowanceFigure(r.allowance, asset, meta, copy) })] : []),
    ...(borrower ? [] : [format('repay.loseThirdParty', { id: loan.borrowerTokenId.toString() })]),
    ...(loan.status === STATUS_FALLBACK_PENDING ? [text('repay.cure')] : []),
    ...(r.refinanceOffer === null ? [text('repay.refinanceUnread')] : r.refinanceOffer > 0n ? [format('repay.refinanceStays', { id: r.refinanceOffer.toString() })] : []),
    ...(r.balance >= r.payoff.now && r.balance < r.payoff.atBy ? [figured((x) => format('repay.loseBalance', { amount: tokenAmount(r.balance, asset, meta, format, x) }))] : []),
  ];

  return {
    title: format('repay.title', { id: r.loanId.toString() }),
    rows,
    consequences,
    prompts: promptCount(r),
    readAt: r.readAt,
  };
}
