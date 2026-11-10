/**
 * NFT-02 — the receipt a renter posts a rental request against
 * (RB-CONFIDENCE, rental vocabulary, never a loan's): what moves from the
 * wallet into the renter's own vault now (the whole term's rent plus the
 * buffer), the NFT asked for and what the renter gets once an owner takes
 * the request (the right to use it, never the NFT), the daily fee, term and
 * rent rule the request binds, where the buffer and any unused rent go, how
 * long the request stays open, and every consequence. The buffer share is
 * the protocol's setting at the moment the request is posted, which the
 * request records; the grace period is today's figure, named as such.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { exactTokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan, formatUtc } from '../ui/format';
import { listedNftName } from './listReceipt';
import { requestCost, requestNeedsApproval, requestPromptCount, requestTokenNote, type RequestReview } from './requestReview';

type Hex = `0x${string}`;

const ZERO: Hex = '0x0000000000000000000000000000000000000000';

export function requestReceipt(r: RequestReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const d = r.draft;
  const pay = d.payment;
  const cost = requestCost(r);
  const nft = listedNftName(r, meta, format);
  const exact = (v: bigint) => exactTokenAmount(v, pay, meta, format);
  const amount = (value: bigint) => ({ kind: 'amount' as const, asset: pay, amount: value });
  const textRow = (label: CopyKey, value: ReceiptText, binding: boolean) => ({ label: text(label), value: textValue(value), binding });
  const note = requestTokenNote(r);

  const rows: Receipt['rows'] = [
    // The rent is bound by the request; the buffer is the protocol's setting
    // when the request lands, so the total and the buffer are today's figures
    // (rentRequest.loseBufferRace states the race).
    { label: text('rent.rowPay'), value: amount(cost.total), binding: false, movesOut: true },
    textRow('rentRequest.rowNft', note === 'no-token' ? format('rentRequest.nftMissing', { nft }) : nft, true),
    textRow('rent.rowUse', text('rentRequest.use'), true),
    { label: text('rent.rowDailyFee'), value: amount(cost.dailyFee), binding: true },
    textRow('rent.rowTerm', format('rentRequest.term', { days: d.days.toString() }), true),
    { label: text('rent.rowRent'), value: amount(cost.rent), binding: true },
    textRow('rent.rowBuffer', format('rentRequest.buffer', { rate: formatBps(cost.bufferBps), amount: exact(cost.buffer) }), false),
    textRow('rent.rowRule', text(d.fullTerm ? 'rent.ruleFullTerm' : 'rent.ruleProRata'), true),
    textRow('rent.rowBack', text(d.fullTerm ? 'rent.backFullTerm' : 'rent.backProRata'), true),
    // Not bound by the request: the protocol reads the grace period from the
    // live configuration when it applies it, so this is today's figure.
    textRow('rent.rowGrace', format('rent.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    textRow('rent.rowLateFee', text('rent.lateFee'), true),
    textRow('rent.rowCollateral', text('rent.noCollateral'), true),
    textRow('rent.rowPositions', text('rentRequest.positions'), false),
    d.expiresAt === 0n
      ? textRow('rentRequest.rowExpiry', text('request.expiryNever'), true)
      : textRow('rentRequest.rowExpiry', format('request.expiryAt', { time: formatUtc(Number(d.expiresAt)) }), true),
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: requestNeedsApproval(r) ? format(r.approvalSteps === 2 ? 'accept.approvalZeroFirst' : 'accept.approvalNeeded', { amount: exact(cost.total) }) : text('accept.approvalEnough'),
      },
      binding: false,
      movesOut: requestNeedsApproval(r),
    },
  ];

  const consequences: ReceiptText[] = [
    text('rentRequest.loseHeld'),
    text('rentRequest.loseCancel'),
    text(d.expiresAt === 0n ? 'rentRequest.loseOpen' : 'rentRequest.loseLapse'),
    text('rentRequest.loseStart'),
    text('rentRequest.loseBufferRace'),
    text('rent.loseNotYours'),
    text('rent.loseNoAutoClose'),
    text('rent.loseLate'),
    text('rent.loseDefault'),
    text('rent.losePause'),
  ];

  return {
    title: text('rentRequest.title'),
    rows,
    consequences,
    prompts: requestPromptCount(r),
    readAt: r.readAt,
  };
}
