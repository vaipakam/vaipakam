/**
 * NFT-01 — the receipt an owner posts a listing against (RB-CONFIDENCE,
 * rental vocabulary, never a loan's): what moves from the wallet into the
 * owner's own vault (the NFT), the daily fee, term and rent rule the listing
 * binds, what a renter pays up front, the buffer share the listing fixes
 * now, what the owner receives and when, what a default does, and every
 * consequence. The buffer share is the protocol's setting at the moment the
 * listing is posted, which the listing records; the grace period and the
 * protocol's share are today's figures, named as such.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { assetName, exactTokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan, formatUtc } from '../ui/format';
import { listApprovalPrompts, listCost, listNeedsApproval, listPromptCount, type ListReview } from './listReview';

type Hex = `0x${string}`;

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

/** The NFT a listing names, in words. */
export function listedNftName(r: Pick<ListReview, 'draft'>, meta: TokenMetaMap | null, format: CopyAccess['format']): string {
  const d = r.draft;
  const asset = assetName(d.nft, meta);
  return d.standard === 'erc721' ? format('asset.nft', { asset, id: String(d.tokenId) }) : format('asset.nft1155', { asset, id: String(d.tokenId), amount: String(d.quantity) });
}

export function listReceipt(r: ListReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const d = r.draft;
  const pay = d.payment;
  const cost = listCost(r);
  const nft = listedNftName(r, meta, format);
  const exact = (v: bigint) => exactTokenAmount(v, pay, meta, format);
  const textRow = (label: CopyKey, value: ReceiptText, binding: boolean, movesOut = false) => ({ label: text(label), value: textValue(value), binding, movesOut });
  const collection = assetName(d.nft, meta);
  const approval = !listNeedsApproval(r)
    ? d.standard === 'erc721'
      ? text('request.approvalTokenEnough')
      : format('request.approvalOperatorEnough', { collection })
    : d.standard === 'erc721'
      ? format('rentList.approvalToken', { token: nft })
      : format('rentList.approvalOperator', { collection });

  const rows: Receipt['rows'] = [
    textRow('rentList.rowLock', nft, true, true),
    { label: text('rent.rowDailyFee'), value: { kind: 'amount', asset: pay, amount: d.dailyFee }, binding: true },
    textRow('rent.rowTerm', format('rentList.term', { days: d.days.toString() }), true),
    textRow('rent.rowRule', text(d.fullTerm ? 'rentList.ruleFullTerm' : 'rentList.ruleProRata'), true),
    textRow('rentList.rowRenterPays', format('rentList.renterPays', { total: exact(cost.total), rent: exact(cost.rent), buffer: exact(cost.buffer) }), true),
    textRow('rent.rowBuffer', format('rentList.buffer', { rate: formatBps(cost.bufferBps) }), true),
    textRow(
      'rentList.rowEarn',
      r.protocolShareBps === null ? text('rentList.earnUnread') : format('rentList.earn', { rate: formatBps(r.protocolShareBps) }),
      false,
    ),
    // Not bound by the listing: the protocol reads the grace period from the
    // live configuration when it applies it, so this is today's figure.
    textRow('rent.rowGrace', format('rent.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    textRow('rentList.rowDefault', text('rentList.default'), true),
    textRow('rent.rowCollateral', text('rent.noCollateral'), true),
    textRow('rent.rowPositions', text('rentList.positions'), false),
    d.expiresAt === 0n
      ? textRow('rentList.rowExpiry', text('request.expiryNever'), true)
      : textRow('rentList.rowExpiry', format('request.expiryAt', { time: formatUtc(Number(d.expiresAt)) }), true),
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    textRow('accept.rowApproval', approval, false, listNeedsApproval(r)),
  ];

  const consequences: ReceiptText[] = [
    text('rentList.loseHeld'),
    text('rentList.loseCancel'),
    text(d.expiresAt === 0n ? 'rentList.loseOpen' : 'rentList.loseLapse'),
    text('rentList.loseUse'),
    text('rentList.loseNoAutoClose'),
    ...(listApprovalPrompts(r) === 2 ? [format('rentList.loseOperator', { collection })] : []),
  ];

  return {
    title: text('rentList.title'),
    rows,
    consequences,
    prompts: listPromptCount(r),
    readAt: r.readAt,
  };
}
