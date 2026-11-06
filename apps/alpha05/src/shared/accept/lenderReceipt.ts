/**
 * OFF-50 — the receipt a lender signs against when taking a borrow request
 * (RB-CONFIDENCE): what leaves the wallet, what the borrower receives and
 * the fee taken on the way, the collateral held for the lender, the
 * interest owed at the due date and the protocol's share of it, and every
 * consequence. Every amount is the protocol's preview for this wallet, or
 * the protocol's published interest rule applied to it; a figure that
 * rests on today's setting says so.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { ASSET_ERC20 } from '../offers/acceptTerms';
import { lenderFigures, refinancePayoff } from '../offers/model';
import { figured, textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan } from '../ui/format';
import { cadenceText, needsApproval, promptCount, ZERO, ZERO_HASH, type AcceptReview } from './acceptReview';

type Hex = `0x${string}`;

export function lenderReceipt(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const o = r.offer;
  // Read for a lender review; zero only if a borrower review reaches here.
  const shareBps = r.protocolShareBps ?? 0n;
  const f = lenderFigures(r.preview, o.durationDays, r.matcherBps, shareBps);
  const lending = o.lendingAsset;
  const collateral = o.collateralAsset;
  const amount = (asset: Hex, value: bigint) => ({ kind: 'amount' as const, asset, amount: value });
  const cadence = cadenceText(o.periodicInterestCadence, copy);
  // A refinance request pays the old loan's lender, not the borrower.
  const payoff = refinancePayoff(o);
  const textRow = (label: CopyKey, value: ReceiptText, binding: boolean) => ({ label: text(label), value: textValue(value), binding });

  const rows: Receipt['rows'] = [
    { label: text('lendAccept.rowPay'), value: amount(lending, f.principal), binding: true, movesOut: true },
    {
      label: payoff === null ? text('lendAccept.rowBorrowerGets') : format('lendAccept.rowPaysOff', { id: payoff.toString() }),
      value: amount(lending, f.principal - f.fee),
      binding: true,
    },
    { label: text('lendAccept.rowFee'), value: amount(lending, f.fee), binding: true },
    ...(f.feeBack > 0n ? [{ label: text('lendAccept.rowFeeBack'), value: amount(lending, f.feeBack), binding: true }] : []),
    // The borrower's own Full tariff is confirmed only as the loan opens,
    // and it lowers the fee (and the share paid back), never raises it.
    ...(o.creatorFull ? [textRow('lendAccept.rowFeeTariff', text('lendAccept.feeTariff'), false)] : []),
    { label: text('lendAccept.rowCollateral'), value: amount(collateral, f.collateral), binding: true },
    textRow('accept.rowRate', format('accept.rate', { rate: formatBps(f.rateBps) }), true),
    { label: text(cadence ? 'lendAccept.rowInterestTotal' : 'lendAccept.rowInterestDue'), value: amount(lending, f.interest), binding: true },
    // Today's setting: the loan fixes the share in force when it opens, and
    // a fee-discount tier can lower it when interest is paid.
    textRow(
      'lendAccept.rowShare',
      figured((x) => format('lendAccept.share', { rate: formatBps(shareBps), amount: tokenAmount(f.protocolShare, lending, meta, format, x) })),
      false,
    ),
    { label: text('lendAccept.rowBack'), value: amount(lending, f.backAtDue), binding: false },
    textRow('accept.rowDue', format('accept.due', { days: o.durationDays.toString() }), true),
    // Not bound by the loan: the protocol reads the grace period from the
    // live configuration when it applies it, so this is today's figure.
    textRow('accept.rowGrace', format('accept.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    textRow('accept.rowInterest', text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'lendAccept.fullTermPartial' : 'lendAccept.fullTerm') : 'lendAccept.proRata'), true),
    textRow('accept.rowSchedule', cadence ? format('accept.scheduleEvery', { cadence }) : text('accept.scheduleNone'), true),
    // The lifecycle terms the signature binds, each stated even when it is
    // the default (the acceptance review states every term it signs).
    textRow('accept.rowPartial', text(o.allowsPartialRepay ? 'lendAccept.partialYes' : 'lendAccept.partialNo'), true),
    textRow(
      'accept.rowPrepayListing',
      text(!o.allowsPrepayListing ? 'accept.prepayListingNo' : o.collateralAssetType === ASSET_ERC20 ? 'accept.prepayListingNotNft' : 'lendAccept.prepayListingYes'),
      true,
    ),
    textRow(
      'accept.rowParallelSale',
      text(
        !o.allowsParallelSale
          ? 'accept.parallelNo'
          : o.collateralAssetType === ASSET_ERC20
            ? 'accept.parallelNotNft'
            : o.parallelSaleOrderHash === ZERO_HASH
              ? 'accept.parallelYes'
              : 'accept.parallelLive',
      ),
      true,
    ),
    textRow('lendAccept.rowRefinance', payoff === null ? text('accept.refinanceNone') : format('lendAccept.refinanceLoan', { id: payoff.toString() }), true),
    textRow('accept.rowLinked', r.linkedLoanId === 0n ? text('accept.linkedNone') : format('lendAccept.linkedSale', { id: r.linkedLoanId.toString() }), true),
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    textRow('lendAccept.rowBorrower', o.creator, false),
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: needsApproval(r)
          ? format(r.approvalSteps === 2 ? 'accept.approvalZeroFirst' : 'accept.approvalNeeded', { amount: exactTokenAmount(f.principal, lending, meta, format) })
          : text('accept.approvalEnough'),
      },
      binding: false,
      // An approval lets the protocol pull from the wallet; none asked, none marked.
      movesOut: needsApproval(r),
    },
  ];

  const consequences = [
    text('lendAccept.loseDefault'),
    // Each illiquid leg is named for what it is; either one rules out the
    // price-based liquidation, so that line shows only when both are liquid.
    ...(r.lendingClass === 'illiquid' ? [text('lendAccept.loseIlliquidLending')] : []),
    ...(r.collateralClass === 'illiquid' ? [text('lendAccept.loseIlliquidCollateral')] : []),
    ...(r.lendingClass !== 'illiquid' && r.collateralClass !== 'illiquid' ? [text('lendAccept.loseLiquidation')] : []),
    text('lendAccept.loseLocked'),
    text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'lendAccept.loseFullTermPartial' : 'lendAccept.loseFullTerm') : 'lendAccept.loseProRata'),
    ...(cadence ? [format('lendAccept.loseCadence', { cadence })] : []),
    text('lendAccept.loseShare'),
    text('lendAccept.losePosition'),
    text('lendAccept.losePause'),
    text('accept.loseBinding'),
  ];

  return {
    title: format('lendAccept.title', { id: r.offerId.toString() }),
    rows,
    consequences,
    prompts: promptCount(r),
    readAt: r.readAt,
  };
}
