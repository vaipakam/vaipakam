/**
 * NFT-02 — the receipt a renter signs against when renting a listed NFT
 * (RB-CONFIDENCE, rental vocabulary, never a loan's): what moves from the
 * wallet into the renter's own vault (the whole term's rent plus the
 * buffer), what the renter gets (the right to use the NFT, never the NFT),
 * the rent rule, the term and grace, where the buffer and any unused rent
 * go, and every consequence. The daily fee is the protocol's preview; the
 * rent and buffer are the protocol's published rule on the listing's own
 * figures, and the buffer share says where it comes from.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { offerAmount } from '../offers/offerLine';
import { textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { exactTokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan } from '../ui/format';
import { needsApproval, promptCount, reviewCost, type RentReview } from './rentReview';

type Hex = `0x${string}`;

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

export function rentReceipt(r: RentReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const o = r.offer;
  const cost = reviewCost(r);
  const pay = o.prepayAsset;
  const nft = offerAmount(o, o.amount, meta, format);
  const amount = (value: bigint) => ({ kind: 'amount' as const, asset: pay, amount: value });
  const textRow = (label: CopyKey, value: ReceiptText, binding: boolean) => ({ label: text(label), value: textValue(value), binding });

  const rows: Receipt['rows'] = [
    { label: text('rent.rowPay'), value: amount(cost.total), binding: true, movesOut: true },
    textRow('rent.rowUse', format('rent.use', { nft }), true),
    { label: text('rent.rowDailyFee'), value: amount(cost.dailyFee), binding: true },
    textRow('rent.rowTerm', format('rent.term', { days: o.durationDays.toString() }), true),
    { label: text('rent.rowRent'), value: amount(cost.rent), binding: true },
    textRow(
      'rent.rowBuffer',
      format(cost.bufferFrom === 'listing' ? 'rent.bufferListing' : 'rent.bufferToday', { rate: formatBps(cost.bufferBps), amount: exactTokenAmount(cost.buffer, pay, meta, format) }),
      cost.bufferFrom === 'listing',
    ),
    textRow('rent.rowRule', text(o.useFullTermInterest ? 'rent.ruleFullTerm' : 'rent.ruleProRata'), true),
    textRow('rent.rowBack', text(o.useFullTermInterest ? 'rent.backFullTerm' : 'rent.backProRata'), true),
    // Not bound by the rental: the protocol reads the grace period from the
    // live configuration when it applies it, so this is today's figure.
    textRow('rent.rowGrace', format('rent.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    textRow('rent.rowLateFee', text('rent.lateFee'), true),
    textRow('rent.rowCollateral', text('rent.noCollateral'), true),
    textRow('rent.rowPositions', text('rent.positions'), false),
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    textRow('rent.rowOwner', o.creator, false),
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: needsApproval(r)
          ? format(r.approvalSteps === 2 ? 'accept.approvalZeroFirst' : 'accept.approvalNeeded', { amount: exactTokenAmount(cost.total, pay, meta, format) })
          : text('accept.approvalEnough'),
      },
      binding: false,
      movesOut: needsApproval(r),
    },
  ];

  const consequences: ReceiptText[] = [
    text('rent.loseNotYours'),
    text('rent.loseHeld'),
    text('rent.loseNoAutoClose'),
    text('rent.loseLate'),
    text('rent.loseDefault'),
    text('rent.losePause'),
    ...(cost.bufferFrom === 'today' ? [text('rent.loseBufferToday')] : []),
    text('rent.loseBinding'),
  ];

  return {
    title: format('rent.title', { id: r.offerId.toString() }),
    rows,
    consequences,
    prompts: promptCount(r),
    readAt: r.readAt,
  };
}
