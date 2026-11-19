/**
 * #3771 — the receipt a holder gives a loan's lender side against: what the
 * receiver gets (after anything still owed to earlier sellers), what stays
 * with the giver, the fee discount that will apply to the receiver, and that
 * the platform cannot undo the transfer. A figure the review could not read
 * is said to be unread, never stated.
 */
import type { CopyAccess } from '../copy/useCopy';
import { figured, textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps } from '../ui/format';
import type { GiveReview } from './giveReview';

export function giveReceipt(r: GiveReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const asset = r.loan.principalAsset;
  const amt = (v: bigint) => figured((x) => tokenAmount(v, asset, meta, format, x));
  const row = (label: string, value: ReceiptText, binding: boolean) => ({ label, value: textValue(value), binding });

  const gets: ReceiptText =
    r.owed === null
      ? text('give.getsUnread')
      : r.owed.gross === 0n
        ? text('give.getsNoneAhead')
        : figured((x) => format('give.getsAfterOwed', { amount: tokenAmount(r.owed!.net, asset, meta, format, x), sellers: String(r.owed!.claims.length) }));

  const discount: ReceiptText =
    r.discount === null
      ? text('give.discountUnread')
      : r.discount === 'absent'
        ? text('give.discountAbsent')
        : format('give.discount', {
            applies: formatBps(BigInt(r.discount.appliesBps)),
            loan: formatBps(BigInt(r.discount.loanBps)),
            receiver: formatBps(BigInt(r.discount.receiverNowBps)),
          });

  const rows: Receipt['rows'][number][] = [
    row(text('give.rowGive'), format('give.give', { id: r.loanId.toString(), token: r.tokenId.toString() }), true),
    row(text('give.rowTo'), r.receiver, true),
    row(text('give.rowGets'), gets, true),
    row(text('give.rowHeld'), r.heldForLender === null ? text('give.heldUnread') : r.heldForLender === 0n ? text('give.heldNone') : figured((x) => format('give.held', { amount: tokenAmount(r.heldForLender!, asset, meta, format, x) })), true),
    row(text('give.rowStays'), text('give.stays'), false),
    row(text('give.rowDiscount'), discount, false),
  ];
  if (r.owed !== null && r.owed.gross > 0n) rows.push(row(text('give.rowOwed'), amt(r.owed.gross), false));

  const consequences: ReceiptText[] = [text('give.loseFinal'), text('give.loseRights'), text('give.receiverCollects'), ...(r.owed !== null && r.owed.gross > 0n ? [text('give.sellersFirst')] : [])];

  return { title: format('give.title', { id: r.loanId.toString() }), rows, consequences, prompts: 1, readAt: r.readAt };
}
