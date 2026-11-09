/**
 * ACC-32 — what a row says and what withdrawing it says before the
 * signature: the asset, what it lets the protocol move now, what still lets
 * it move the asset afterwards (another approval of the same asset, read
 * with it), that it moves nothing, and what may rely on it.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt } from '../receipt/types';
import { assetName, exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatUtc } from '../ui/format';
import { isUnlimited, type ApprovalRow, type Overlap } from './approvals';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** The asset a row names, in words. */
export function rowAsset(r: ApprovalRow, meta: TokenMetaMap | null, copy: Copy): string {
  const name = assetName(r.asset, meta);
  return r.kind === 'token' ? copy.format('approvals.tokenOf', { id: r.tokenId.toString(), collection: name }) : name;
}

/** What a row lets the protocol move now, in words. */
export function rowReach(r: ApprovalRow, meta: TokenMetaMap | null, copy: Copy, exact = false): string {
  const { text, format } = copy;
  switch (r.kind) {
    case 'erc20':
      return isUnlimited(r) ? text('approvals.unlimited') : format('approvals.upTo', { amount: exact ? exactTokenAmount(r.amount, r.asset, meta, format) : tokenAmount(r.amount, r.asset, meta, format) });
    case 'permit2':
      return format('approvals.permit2Reach', {
        amount: isUnlimited(r) ? text('approvals.unlimited') : exact ? exactTokenAmount(r.amount, r.asset, meta, format) : tokenAmount(r.amount, r.asset, meta, format),
        when: formatUtc(Number(r.expiration)),
      });
    case 'collection':
      return text('approvals.collectionReach');
    case 'token':
      return text('approvals.tokenReach');
  }
}

/** What still lets the protocol move the asset once `r` is withdrawn: the
 *  other approvals read with it, unknown when one did not answer, and
 *  nothing only when every one of them was read and none stands. */
export function afterRevoke(overlap: Overlap, meta: TokenMetaMap | null, copy: Copy): string {
  const { text, format } = copy;
  if (overlap.rows.length > 0) return format('approvals.afterOther', { what: overlap.rows.map((x) => `${rowAsset(x, meta, copy)}: ${rowReach(x, meta, copy, true)}`).join('; ') });
  if (overlap.unread) return text('approvals.afterUnread');
  return text('approvals.after');
}

export function revokeReceipt(r: ApprovalRow, overlap: Overlap, meta: TokenMetaMap | null, copy: Copy, opts: { chain: string; readAt: number }): Receipt {
  const { text, format } = copy;
  const consequences = [text('approvals.relyOn')];
  if (r.kind === 'permit2') consequences.push(text('approvals.permit2Kept'));
  if (overlap.rows.length > 0) consequences.push(text('approvals.otherStays'));
  return {
    title: text('approvals.revokeTitle'),
    rows: [
      { label: text('approvals.rowAsset'), value: { kind: 'text', text: rowAsset(r, meta, copy) }, binding: true },
      { label: text('approvals.rowNow'), value: { kind: 'text', text: rowReach(r, meta, copy, true) }, binding: true },
      { label: text('approvals.rowAfter'), value: { kind: 'text', text: afterRevoke(overlap, meta, copy) }, binding: true },
      { label: text('approvals.rowWhere'), value: { kind: 'text', text: format('approvals.where', { chain: opts.chain }) }, binding: true },
      { label: text('risk.rowMoves'), value: { kind: 'text', text: text('approvals.movesNone') }, binding: true },
    ],
    consequences,
    prompts: 1,
    readAt: opts.readAt,
  };
}
