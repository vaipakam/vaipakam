/**
 * ACC-25, ACC-26 — the receipts an adoption and a disowning are confirmed
 * against (RB-CONFIDENCE): what is counted (or recorded as not claimed),
 * in which vault, the source the adoption declares, the protocol's figure
 * for what sits uncounted, and every consequence: nothing moves, the
 * asset then leaves only through an ordinary withdrawal, the declaration
 * the wallet signs, and what the review could not read.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { assetName, type TokenMetaMap } from '../reads/tokens';
import { adoptAmount, type AdoptReview, type RecoverFacts, type RecoverSubject } from './adopt';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

/** The asset as a receipt names it: "WETH", "Test NFT #7", or "5 of
 *  vMULTI #2". */
export function recoverName(s: RecoverSubject, amount: bigint, meta: TokenMetaMap | null, copy: Copy): string {
  const name = assetName(s.asset, meta);
  if (s.standard === 'erc721') return copy.format('asset.nft', { asset: name, id: s.tokenId.toString() });
  if (s.standard === 'erc1155')
    return copy.format('vaultDeposit.units', { count: amount.toString(), token: copy.format('asset.nftToken', { asset: name, id: s.tokenId.toString() }) });
  return name;
}

/** The asset with no amount: "WETH" or "Test NFT #7". */
export function subjectName(s: RecoverSubject, meta: TokenMetaMap | null, copy: Copy): string {
  const name = assetName(s.asset, meta);
  return s.standard === 'erc20' ? name : copy.format('asset.nftToken', { asset: name, id: s.tokenId.toString() });
}

function amountRow(s: RecoverSubject, amount: bigint, meta: TokenMetaMap | null, copy: Copy): ReceiptRow {
  return s.standard === 'erc20'
    ? { label: copy.text('vaultWithdraw.rowAmount'), value: { kind: 'amount', asset: s.asset, amount }, binding: true }
    : { label: copy.text('vaultWithdraw.rowToken'), value: { kind: 'text', text: recoverName(s, amount, meta, copy) }, binding: true };
}

function untrackedRow(f: RecoverFacts, copy: Copy): ReceiptRow {
  const unknown = { kind: 'unknown' as const, why: copy.text('receipt.unknown') };
  const s = f.subject;
  return {
    label: copy.text('recover.rowUntracked'),
    value:
      f.untracked === null
        ? unknown
        : s.standard === 'erc20'
          ? { kind: 'amount', asset: s.asset, amount: f.untracked }
          : { kind: 'text', text: f.untracked.toString() },
    binding: false,
  };
}

export function adoptReceipt(r: AdoptReview, meta: TokenMetaMap | null, copy: Copy): Receipt {
  const { text } = copy;
  const d = r.draft;
  const f = r.facts;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: ReceiptRow[] = [
    amountRow(d.subject, adoptAmount(d), meta, copy),
    { label: text('vaultDeposit.rowAsset'), value: { kind: 'text', text: d.subject.asset }, binding: true },
    { label: text('recover.rowVault'), value: f.vault === null ? unknown : { kind: 'text', text: f.vault }, binding: true },
    { label: text('recover.rowSource'), value: { kind: 'text', text: d.source }, binding: true },
    untrackedRow(f, copy),
  ];
  const consequences: string[] = [
    text('recover.nothingMoves'),
    text(f.protection?.enabled ? 'recover.leavesProtected' : 'recover.leaves'),
    text('recover.declaration'),
    text('recover.screenAgain'),
    ...(f.protection === null ? [text('recover.modeUnreadNote')] : []),
  ];
  return { title: text('recover.adoptTitle'), rows, consequences, prompts: 2, readAt: f.readAt };
}

export function disownReceipt(f: RecoverFacts, meta: TokenMetaMap | null, copy: Copy): Receipt {
  const { text } = copy;
  const s = f.subject;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: ReceiptRow[] = [
    { label: text('vaultWithdraw.rowToken'), value: { kind: 'text', text: subjectName(s, meta, copy) }, binding: true },
    { label: text('vaultDeposit.rowAsset'), value: { kind: 'text', text: s.asset }, binding: true },
    { label: text('recover.rowVault'), value: f.vault === null ? unknown : { kind: 'text', text: f.vault }, binding: true },
    untrackedRow(f, copy),
  ];
  return {
    title: text('recover.disownTitle'),
    rows,
    consequences: [text('recover.disownMovesNothing'), text('recover.disownPublic')],
    prompts: 1,
    readAt: f.readAt,
  };
}
