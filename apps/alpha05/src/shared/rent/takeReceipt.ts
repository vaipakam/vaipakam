/**
 * NFT-01 / NFT-02 — the receipt an owner signs against when taking a
 * renter's request (RB-CONFIDENCE, rental vocabulary, never a loan's): what
 * moves from the wallet into the owner's own vault (the NFT), who becomes
 * its user and for how long, the daily fee, term and rent rule the request
 * binds, the rent and buffer the renter has already put in the renter's
 * vault, what the owner receives and when, what a default does, and every
 * consequence. The buffer share is the request's own record; the grace
 * period is today's figure, and the protocol's share is today's figure,
 * which the rental fixes when it starts, named as such.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { offerAmount } from '../offers/offerLine';
import { textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { assetName, exactTokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan } from '../ui/format';
import { takeApprovalPrompts, takeCost, takeNeedsApproval, takePromptCount, type TakeReview } from './takeReview';

type Hex = `0x${string}`;

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

export function takeReceipt(r: TakeReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const o = r.offer;
  const cost = takeCost(r);
  const pay = o.prepayAsset;
  const nft = offerAmount(o, o.amount, meta, format);
  const collection = assetName(o.lendingAsset, meta);
  const exact = (v: bigint) => exactTokenAmount(v, pay, meta, format);
  const amount = (value: bigint) => ({ kind: 'amount' as const, asset: pay, amount: value });
  const textRow = (label: CopyKey, value: ReceiptText, binding: boolean, movesOut = false) => ({ label: text(label), value: textValue(value), binding, movesOut });
  const multi = r.holding.kind === 'erc1155';
  const approval = !takeNeedsApproval(r)
    ? multi
      ? format('request.approvalOperatorEnough', { collection })
      : text('request.approvalTokenEnough')
    : multi
      ? format('rentTake.approvalOperator', { collection })
      : format('rentList.approvalToken', { token: nft });

  const rows: Receipt['rows'] = [
    textRow('rentList.rowLock', nft, true, true),
    textRow('rentTake.rowRenter', o.creator, true),
    textRow('rentTake.rowUse', text('rentTake.use'), true),
    { label: text('rent.rowDailyFee'), value: amount(cost.dailyFee), binding: true },
    textRow('rent.rowTerm', format('rentTake.term', { days: o.durationDays.toString() }), true),
    textRow('rent.rowRule', text(o.useFullTermInterest ? 'rentList.ruleFullTerm' : 'rentList.ruleProRata'), true),
    textRow('rentTake.rowHeld', format('rentTake.held', { total: exact(cost.total), rent: exact(cost.rent), buffer: exact(cost.buffer) }), true),
    textRow(
      'rent.rowBuffer',
      format(cost.bufferFrom === 'listing' ? 'rentTake.bufferRequest' : 'rent.bufferToday', { rate: formatBps(cost.bufferBps), amount: exact(cost.buffer) }),
      cost.bufferFrom === 'listing',
    ),
    textRow('rentList.rowEarn', r.protocolShareBps === null ? text('rentTake.earnUnread') : format('rentTake.earn', { rate: formatBps(r.protocolShareBps) }), r.protocolShareBps !== null),
    // Not bound by the rental: the protocol reads the grace period from the
    // live configuration when it applies it, so this is today's figure.
    textRow('rent.rowGrace', format('rent.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    textRow('rentList.rowDefault', text('rentList.default'), true),
    textRow('rent.rowCollateral', text('rent.noCollateral'), true),
    textRow('rent.rowPositions', text('rentTake.positions'), false),
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    textRow('accept.rowApproval', approval, false, takeNeedsApproval(r)),
  ];

  const consequences: ReceiptText[] = [
    text('rentTake.loseHeld'),
    text('rentList.loseUse'),
    text('rentList.loseNoAutoClose'),
    ...(cost.bufferFrom === 'today' ? [text('rentTake.loseBufferToday')] : []),
    ...(takeApprovalPrompts(r) === 2 ? [format('rentTake.loseOperator', { collection })] : []),
    text('rent.loseBinding'),
  ];

  return {
    title: format('rentTake.title', { id: r.offerId.toString() }),
    rows,
    consequences,
    prompts: takePromptCount(r),
    readAt: r.readAt,
  };
}
