/**
 * OFF-50 — the receipt a borrower signs against when taking a lender's
 * offer (RB-CONFIDENCE): what arrives, what is locked, what is owed and
 * when, the fee and its rule, and every consequence. Every figure is the
 * protocol's preview for this wallet.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { ASSET_ERC20 } from '../offers/acceptTerms';
import { acceptFigures, listFee } from '../offers/model';
import type { Receipt } from '../receipt/types';
import { exactTokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan } from '../ui/format';
import { cadenceText, needsApproval, promptCount, valueRows, ZERO, ZERO_HASH, type AcceptReview } from './acceptReview';

type Hex = `0x${string}`;

/** The receipt (RB-CONFIDENCE): what arrives, what is locked, what is
 *  owed and when, the fee and its rule, and every consequence. */
export function borrowerReceipt(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const o = r.offer;
  const f = acceptFigures(r.preview, o.durationDays, r.matcherBps);
  const lending = o.lendingAsset;
  const collateral = o.collateralAsset;
  const amount = (asset: Hex, value: bigint) => ({
    kind: 'amount' as const,
    asset,
    amount: value,
  });
  const cadence = cadenceText(o.periodicInterestCadence, copy);
  const discounted = f.fee < listFee(f.principal, r.lifBps);
  const textRow = (label: CopyKey, value: string, binding: boolean) => ({
    label: text(label),
    value: { kind: 'text' as const, text: value },
    binding,
  });

  const rows: Receipt['rows'] = [
    {
      label: text('accept.rowReceive'),
      value: amount(lending, f.toVault),
      binding: true,
    },
    {
      label: text('accept.rowFee'),
      value: amount(lending, f.fee),
      binding: true,
    },
    ...(f.feeBack > 0n
      ? [
          {
            label: text('accept.rowFeeBack'),
            value: amount(lending, f.feeBack),
            binding: true,
          },
        ]
      : []),
    {
      label: text('accept.rowFeeRule'),
      value: {
        kind: 'text',
        text: format(discounted ? 'accept.feeDiscounted' : 'accept.feeRule', {
          rate: formatBps(r.lifBps),
        }),
      },
      binding: false,
    },
    {
      label: text('accept.rowPrincipal'),
      value: amount(lending, f.principal),
      binding: true,
    },
    {
      label: text('accept.rowLock'),
      value: amount(collateral, f.collateral),
      binding: true,
      movesOut: true,
    },
    ...(f.refund > 0n
      ? [
          {
            label: text('accept.rowRefund'),
            value: amount(collateral, f.refund),
            binding: true,
          },
        ]
      : []),
    ...valueRows(r, meta, copy),
    {
      label: text('accept.rowRate'),
      value: {
        kind: 'text',
        text: format('accept.rate', { rate: formatBps(f.rateBps) }),
      },
      binding: true,
    },
    {
      // With an interest schedule, part of this is paid at each checkpoint
      // and credited, so the figure is the term's total, not the last payment.
      label: text(cadence ? 'accept.rowOweTotal' : 'accept.rowOwe'),
      value: amount(lending, f.owedAtDue),
      binding: true,
    },
    {
      label: text('accept.rowDue'),
      value: {
        kind: 'text',
        text: format('accept.due', { days: o.durationDays.toString() }),
      },
      binding: true,
    },
    {
      label: text('accept.rowGrace'),
      value: {
        kind: 'text',
        text: format('accept.grace', {
          span: formatSpan(Number(r.graceSeconds)),
        }),
      },
      // Not bound by the loan: the protocol reads the grace period from the
      // live configuration when it applies it, so this is today's figure.
      binding: false,
    },
    {
      label: text('accept.rowInterest'),
      value: {
        kind: 'text',
        text: text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'accept.fullTermPartial' : 'accept.fullTerm') : 'accept.proRata'),
      },
      binding: true,
    },
    {
      label: text('accept.rowSchedule'),
      value: {
        kind: 'text',
        text: cadence ? format('accept.scheduleEvery', { cadence }) : text('accept.scheduleNone'),
      },
      binding: true,
    },
    // The lifecycle terms the signature binds, each stated even when it is
    // the default (the acceptance review states every term it signs).
    textRow('accept.rowPartial', text(o.allowsPartialRepay ? 'accept.partialYes' : 'accept.partialNo'), true),
    // Both sale routes list the collateral as an NFT: on token collateral a
    // permission the terms grant is stated as one this loan cannot use.
    textRow(
      'accept.rowPrepayListing',
      text(!o.allowsPrepayListing ? 'accept.prepayListingNo' : o.collateralAssetType === ASSET_ERC20 ? 'accept.prepayListingNotNft' : 'accept.prepayListingYes'),
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
    textRow(
      'accept.rowRefinance',
      o.refinanceTargetLoanId === 0n ? text('accept.refinanceNone') : format('accept.refinanceLoan', { id: o.refinanceTargetLoanId.toString() }),
      true,
    ),
    textRow('accept.rowLinked', r.linkedLoanId === 0n ? text('accept.linkedNone') : format('accept.linkedLoan', { id: r.linkedLoanId.toString() }), true),
    {
      label: text('accept.rowVault'),
      value: {
        kind: 'text',
        text: r.vault === ZERO ? text('accept.vaultNew') : r.vault,
      },
      binding: false,
    },
    {
      label: text('accept.rowLender'),
      value: { kind: 'text', text: o.creator },
      binding: false,
    },
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: needsApproval(r)
          ? format(r.approvalSteps === 2 ? 'accept.approvalZeroFirst' : 'accept.approvalNeeded', {
              amount: exactTokenAmount(f.collateral, collateral, meta, format),
            })
          : text('accept.approvalEnough'),
      },
      binding: false,
      // An approval lets the protocol pull from the wallet; none asked, none marked.
      movesOut: needsApproval(r),
    },
  ];

  const consequences = [
    text('accept.loseDefault'),
    // Each illiquid leg is named for what it is; either one rules out the
    // price-based liquidation, so that line shows only when both are liquid.
    ...(r.lendingClass === 'illiquid' ? [text('accept.loseIlliquidLending')] : []),
    ...(r.collateralClass === 'illiquid' ? [text('accept.loseIlliquidCollateral')] : []),
    ...(r.lendingClass !== 'illiquid' && r.collateralClass !== 'illiquid' ? [text('accept.loseLiquidation')] : []),
    text('accept.loseLocked'),
    text('accept.afterVault'),
    text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'accept.loseFullTermPartial' : 'accept.loseFullTerm') : 'accept.loseProRata'),
    ...(cadence ? [format('accept.loseCadence', { cadence })] : []),
    text('accept.losePause'),
    text('accept.loseBinding'),
  ];

  return {
    title: format('accept.title', { id: r.offerId.toString() }),
    rows,
    consequences,
    prompts: promptCount(r),
    readAt: r.readAt,
  };
}
