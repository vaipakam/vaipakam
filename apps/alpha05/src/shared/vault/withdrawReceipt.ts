/**
 * ACC-23 — the receipt a withdrawal is confirmed against (RB-CONFIDENCE):
 * what leaves the vault, from which vault, where it goes (the connected
 * wallet at once, or the account's payout queue for its delay, with a
 * secondary signer's approval where the account requires one), the
 * protocol's own figure for what is free now, and every consequence: only
 * what is free moves, the app pays the signing wallet only, a queued payout
 * can be cancelled while it waits, and what the review could not read.
 */
import type { CopyAccess } from '../copy/useCopy';
import { routedDestination, routeNotes } from '../protection/payoutCopy';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { vpfiWithdrawNotes } from '../rewards/vpfiNotes';
import { pauseStops, withdrawAmount, type WithdrawDraft, type WithdrawReview } from './withdraw';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** The asset as the receipt names it: "WETH", "Test NFT #7", or "5 of
 *  vMULTI #2". */
export function withdrawName(d: WithdrawDraft, meta: TokenMetaMap | null, copy: Copy): string {
  const name = assetName(d.asset, meta);
  if (d.standard === 'erc721') return copy.format('asset.nft', { asset: name, id: d.tokenId.toString() });
  if (d.standard === 'erc1155')
    return copy.format('vaultDeposit.units', { count: d.amount.toString(), token: copy.format('asset.nftToken', { asset: name, id: d.tokenId.toString() }) });
  return name;
}

/** Where the withdrawal goes, in words; null when the mode was unread. */
export function withdrawDestination(r: Pick<WithdrawReview, 'route' | 'protection' | 'via'>, copy: Copy): string | null {
  if (r.route === 'wallet') return copy.text(r.via === 'escape' ? 'vaultWithdraw.toWalletEscape' : 'vaultWithdraw.toWallet');
  return routedDestination(r.route, r.protection, copy);
}

export function withdrawReceipt(r: WithdrawReview, meta: TokenMetaMap | null, copy: Copy): Receipt {
  const { text } = copy;
  const d = r.draft;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const to = withdrawDestination(r, copy);
  const nft = d.standard !== 'erc20';
  const rows: ReceiptRow[] = [
    d.standard === 'erc20'
      ? { label: text('vaultWithdraw.rowAmount'), value: { kind: 'amount', asset: d.asset, amount: d.amount }, binding: true }
      : { label: text('vaultWithdraw.rowToken'), value: { kind: 'text', text: withdrawName(d, meta, copy) }, binding: true },
    { label: text('vaultDeposit.rowAsset'), value: { kind: 'text', text: d.asset }, binding: true },
    { label: text('vaultWithdraw.rowFrom'), value: r.vault === null ? unknown : { kind: 'text', text: r.vault }, binding: true },
    { label: text('vaultWithdraw.rowTo'), value: to === null ? unknown : { kind: 'text', text: to }, binding: true },
    {
      label: text('vaultWithdraw.rowFree'),
      value: r.withdrawable === null ? unknown : nft ? { kind: 'text', text: r.withdrawable.toString() } : { kind: 'amount', asset: d.asset, amount: r.withdrawable },
      binding: false,
    },
  ];
  if (r.withdrawable !== null && r.withdrawable >= withdrawAmount(d))
    rows.push({
      label: text('vaultWithdraw.rowFreeAfter'),
      value: nft ? { kind: 'text', text: (r.withdrawable - withdrawAmount(d)).toString() } : { kind: 'amount', asset: d.asset, amount: r.withdrawable - d.amount },
      binding: false,
    });

  const consequences: string[] = [
    text('vaultWithdraw.onlyFree'),
    text('vaultWithdraw.onlyThisWallet'),
    ...routeNotes(r.route, r.protection, copy),
    ...(r.route === 'queued' ? [text('vaultWithdraw.queueCancel')] : []),
    ...(r.paused === true && pauseStops(r) === false ? [text(r.via === 'escape' ? 'vaultWithdraw.escapeRoute' : 'vaultWithdraw.escapeOpen')] : []),
    ...(pauseStops(r) === null ? [text('vaultWithdraw.pauseUnread')] : []),
    ...(r.frozen === 'unknown' || r.frozen === 'outage' ? [text('vaultDeposit.screenUnread')] : []),
    ...(r.withdrawable === null ? [text('vaultWithdraw.freeUnread')] : []),
    ...(r.dryRun === 'unread' ? [text('vaultWithdraw.dryRunUnread')] : []),
    ...(r.vpfi !== null ? vpfiWithdrawNotes(r.vpfi, d.amount, copy) : []),
    text('vaultWithdraw.noApproval'),
  ];
  return { title: text('vaultWithdraw.title'), rows, consequences, prompts: 1, readAt: r.readAt };
}
