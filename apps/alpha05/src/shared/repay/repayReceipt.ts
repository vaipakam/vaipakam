/**
 * LN-21 / LN-16 — the receipt a full repayment is confirmed against
 * (RB-CONFIDENCE): what leaves the wallet now and at most, what the
 * approval lets the protocol take, where the collateral goes, and every
 * consequence. Every amount is the protocol's own settlement figure.
 */
import type { CopyAccess } from '../copy/useCopy';
import { figured, textValue, type Receipt } from '../receipt/types';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { assetAmount } from '../positions/assetAmount';
import { formatUtc } from '../ui/format';
import { allowanceFigure, approvalRowText, lateConfirmationLines } from './approvalCap';
import { STATUS_FALLBACK_PENDING } from '../eligibility/repay';
import { paysAsBorrower, promptCount, putBackPromptCount, type RepayReview } from './repayReview';

type Hex = `0x${string}`;

export function repayReceipt(r: RepayReview, account: Hex, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const loan = r.loan;
  const asset = loan.principalAsset;
  const by = formatUtc(Number(r.payoff.by));
  const borrower = paysAsBorrower(r, account);
  const collateral = (x: boolean) =>
    assetAmount(
      { asset: loan.collateralAsset, assetType: loan.collateralAssetType, amount: loan.collateralAmount, tokenId: loan.collateralTokenId, quantity: loan.collateralQuantity },
      meta,
      format,
      x,
    );

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
        text: approvalRowText({ allowance: r.allowance, steps: r.approvalSteps, cap: r.payoff.atBy }, asset, meta, copy),
      },
      binding: false,
      movesOut: r.approvalSteps > 0,
    },
  ];

  const consequences = [
    text(loan.useFullTermInterest ? 'repay.loseFull' : 'repay.loseGrows'),
    ...lateConfirmationLines({ capped: r.capped, time: by, totalNow: r.payoff.now, totalBy: r.payoff.atBy }, copy),
    ...(r.approvalSteps > 0 ? [format('repay.losePutBack', { amount: allowanceFigure(r.allowance, asset, meta, copy) })] : []),
    ...(borrower ? [] : [format('repay.loseThirdParty', { id: loan.borrowerTokenId.toString() })]),
    ...(loan.status === STATUS_FALLBACK_PENDING ? [text('repay.cure')] : []),
    ...(r.refinance === null ? [text('repay.refinanceUnread')] : r.refinance.live ? [format('repay.refinanceStays', { id: r.refinance.offerId.toString() })] : []),
    ...(r.balance >= r.payoff.now && r.balance < r.payoff.atBy ? [figured((x) => format('repay.loseBalance', { amount: tokenAmount(r.balance, asset, meta, format, x) }))] : []),
  ];

  return {
    title: format('repay.title', { id: r.loanId.toString() }),
    rows,
    consequences,
    prompts: promptCount(r),
    afterPrompts: putBackPromptCount(r),
    readAt: r.readAt,
  };
}
