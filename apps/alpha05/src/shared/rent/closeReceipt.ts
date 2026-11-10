/**
 * NFT-05 — the receipt a renter closes a rental against (RB-CONFIDENCE,
 * rental vocabulary): nothing leaves the wallet; the rent owed and any late
 * fee are paid out of the rent and buffer already in the renter's own
 * vault, stated now and at the latest moment the review reaches; what comes
 * back as a claim; what the owner receives; and every consequence. The late
 * fee is the protocol's own quote; the rent is counted by the settler's
 * rule (closeReview), which the receipt names.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { assetAmount } from '../positions/assetAmount';
import { treasuryShareBps } from '../positions/loanView';
import { figured, textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatUtc } from '../ui/format';
import type { CloseFigures, CloseReview } from './closeReview';
import { settledDays } from './closeReview';

export function closeReceipt(r: CloseReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const l = r.loan;
  const pay = l.prepayAsset;
  const by = formatUtc(Number(r.late.by));
  const nft = (x: boolean) => assetAmount({ asset: l.principalAsset, assetType: l.assetType, amount: 0n, tokenId: l.tokenId, quantity: l.quantity }, meta, format, x);
  const amt = (v: bigint, x: boolean) => tokenAmount(v, pay, meta, format, x);
  const textRow = (label: CopyKey | string, value: ReceiptText, binding: boolean) => ({ label, value: textValue(value), binding });
  const rentLine = (f: CloseFigures) => figured((x) => format('rentClose.rent', { amount: amt(f.rent, x), days: f.days.toString() }));
  const backLine = (f: CloseFigures) => (f.refund === null ? text('rentClose.backShort') : figured((x) => format('rentClose.back', { amount: amt(f.refund!, x) })));
  const share = treasuryShareBps(l);

  const rows: Receipt['rows'] = [
    textRow(text('rentClose.rowWallet'), text('rentClose.wallet'), true),
    textRow(text('rentClose.rowRentNow'), rentLine(r.now), true),
    textRow(format('rentClose.rowRentBy', { time: by }), rentLine(r.atBy), true),
    textRow(text('rentClose.rowRule'), text(l.useFullTermInterest ? 'rentClose.ruleFullTerm' : 'rentClose.ruleProRata'), true),
    textRow(text('rentClose.rowSettled'), format('rentClose.settled', { days: settledDays(l).toString(), term: l.durationDays.toString() }), false),
    { label: text('rentClose.rowLateNow'), value: { kind: 'amount', asset: pay, amount: r.now.lateFee }, binding: true },
    { label: format('rentClose.rowLateBy', { time: by }), value: { kind: 'amount', asset: pay, amount: r.atBy.lateFee }, binding: true },
    textRow(text('rentClose.rowPrepaid'), figured((x) => format('rentClose.prepaid', { rent: amt(l.prepayAmount, x), buffer: amt(l.bufferAmount, x) })), false),
    textRow(text('rentClose.rowBackNow'), backLine(r.now), true),
    textRow(format('rentClose.rowBackBy', { time: by }), backLine(r.atBy), true),
    textRow(text('rentClose.rowUse'), figured((x) => format('rentClose.useEnds', { nft: nft(x) })), true),
    textRow(
      text('rentClose.rowOwner'),
      format(share.legacy ? 'rentClose.ownerLegacy' : 'rentClose.owner', { rate: formatBps(BigInt(share.bps)) }),
      true,
    ),
  ];

  const consequences: ReceiptText[] = [
    text('rentClose.loseUse'),
    text('rentClose.loseClaim'),
    text(l.useFullTermInterest ? 'rentClose.loseFullTerm' : 'rentClose.loseDayCount'),
    ...(r.maturity !== null && r.late.chainNow > r.maturity ? [text('rentClose.loseLate')] : [text('rentClose.loseLateLater')]),
    ...(r.capped ? [format('rentClose.loseGraceEnd', { time: by })] : []),
    ...(r.now.refund !== null && r.atBy.refund === null ? [format('rentClose.loseShortBy', { time: by })] : []),
    format('rentClose.loseNoLimit', { time: by }),
  ];

  return {
    title: format('rentClose.title', { id: r.loanId.toString() }),
    rows,
    consequences,
    prompts: 1,
    readAt: r.readAt,
  };
}
