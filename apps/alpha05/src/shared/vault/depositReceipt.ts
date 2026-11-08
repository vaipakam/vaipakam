/**
 * ACC-22 — the receipt a deposit is confirmed against (RB-CONFIDENCE): what
 * leaves the wallet, into which vault (or that the deposit creates it), the
 * wallet's holding of the asset, what the approval lets the protocol take,
 * and every consequence: the deposit is counted as the wallet's and free to
 * withdraw, the protocol refuses a token that does not arrive in full, no
 * token-safety screening runs, and what happens to an approval.
 */
import type { CopyAccess } from '../copy/useCopy';
import { figured, textValue, type Receipt, type ReceiptRow, type ReceiptText } from '../receipt/types';
import { assetName, exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { depositPromptCount, type DepositReview } from './deposit';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** The asset as the receipt names it: "WETH", or "Test NFT #7", or
 *  "5 of vMULTI #2". */
export function depositName(r: DepositReview, meta: TokenMetaMap | null, copy: Copy): string {
  const d = r.draft;
  const name = assetName(d.asset, meta);
  if (d.standard === 'erc721') return copy.format('asset.nft', { asset: name, id: d.tokenId.toString() });
  if (d.standard === 'erc1155')
    return copy.format('vaultDeposit.units', { count: d.amount.toString(), token: copy.format('asset.nftToken', { asset: name, id: d.tokenId.toString() }) });
  return name;
}

export function depositReceipt(r: DepositReview, meta: TokenMetaMap | null, copy: Copy): Receipt {
  const { text, format } = copy;
  const d = r.draft;
  const h = r.holding;
  const amountText = (exact: boolean) => (exact ? exactTokenAmount(d.amount, d.asset, meta, format) : tokenAmount(d.amount, d.asset, meta, format));

  const rows: ReceiptRow[] = [];
  if (d.standard === 'erc20') rows.push({ label: text('vaultDeposit.rowAmount'), value: { kind: 'amount', asset: d.asset, amount: d.amount }, binding: true, movesOut: true });
  else rows.push({ label: text('vaultDeposit.rowToken'), value: { kind: 'text', text: depositName(r, meta, copy) }, binding: true, movesOut: true });
  rows.push({ label: text('vaultDeposit.rowAsset'), value: { kind: 'text', text: d.asset }, binding: true });
  rows.push({
    label: text('vaultDeposit.rowInto'),
    value: { kind: 'text', text: r.vault === null ? text('vaultDeposit.intoNew') : r.vault },
    binding: true,
  });
  if (h.kind === 'erc20') rows.push({ label: text('repay.rowBalance'), value: { kind: 'amount', asset: d.asset, amount: h.balance }, binding: false });
  if (h.kind === 'erc1155') rows.push({ label: text('vaultDeposit.rowHeld'), value: { kind: 'text', text: h.state.balance.toString() }, binding: false });

  let approval: ReceiptText;
  if (h.kind === 'erc20') approval = figured((x) => format(h.approvalSteps === 0 ? 'vaultDeposit.approvalCovers' : 'vaultDeposit.approvalNeeded', { amount: amountText(x) }));
  else if (h.kind === 'erc721') approval = text(h.approvalSteps === 0 ? 'vaultDeposit.approvalNftCovers' : 'vaultDeposit.approvalNft');
  else approval = format(h.approvalSteps === 0 ? 'vaultDeposit.approvalOperatorKept' : 'vaultDeposit.approvalOperator', { collection: assetName(d.asset, meta) });
  rows.push({ label: text('repay.rowApproval'), value: textValue(approval), binding: false, movesOut: h.approvalSteps > 0 });

  const consequences: ReceiptText[] = [
    text('vaultDeposit.afterCounted'),
    ...(d.standard === 'erc20' ? [text('vaultDeposit.afterExact')] : []),
    ...(r.vault === null ? [text('vaultDeposit.afterCreate')] : []),
    text('vaultDeposit.noScreening'),
    ...(r.paused === null ? [text('vaultDeposit.pauseUnread')] : []),
    ...(r.frozen === 'unknown' || r.frozen === 'outage' ? [text('vaultDeposit.screenUnread')] : []),
    ...(h.kind === 'erc20' && h.approvalSteps > 0 ? [text('vaultDeposit.approvalBack')] : []),
    ...(h.kind === 'erc721' && h.approvalSteps > 0 ? [text('vaultDeposit.approvalNftBack')] : []),
    ...(h.kind === 'erc1155' && h.approvalSteps > 0 ? [format('vaultDeposit.approvalOperatorBack', { collection: assetName(d.asset, meta) })] : []),
  ];

  return { title: text('vaultDeposit.title'), rows, consequences, prompts: depositPromptCount(r), readAt: r.readAt };
}
