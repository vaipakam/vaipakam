/**
 * ACC-41 / #3415 — the receipt each signer change is confirmed against
 * (RB-CONFIDENCE): the signer in full, the name it is saved under, what a
 * signer can and cannot do, when the change takes effect and until when it
 * may be applied, how it is undone, and every fact the review could not
 * read.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt, ReceiptRow } from '../receipt/types';
import type { SavedAddress } from '../address/book';
import { formatSpan, formatUtc } from '../ui/format';
import { signerTitle, type SignerReview } from './signers';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

export function signerReceipt(r: SignerReview, saved: SavedAddress | null, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const f = r.facts;
  const m = f.mode === null || f.mode === 'absent' ? null : f.mode;
  const delay = m === null ? null : formatSpan(m.delaySeconds);
  const cosign = r.action === 'cosignOn' || r.action === 'cosignOff';
  const rows: ReceiptRow[] = [];
  if (r.action === 'accept') rows.push({ label: text('signer.rowAccount'), value: { kind: 'text', text: f.account }, binding: true });
  if (!cosign) rows.push({ label: text('signer.rowSigner'), value: { kind: 'text', text: r.signer }, binding: true });
  if (saved !== null && !cosign) rows.push({ label: text('dest.rowSavedAs'), value: { kind: 'text', text: saved.label }, binding: false });
  const consequences: string[] = [];
  const unread: string[] = [];
  if (f.mode === null) unread.push(text('signer.modeUnread'));
  if (r.dryRun === 'unread') unread.push(text('safety.dryRunUnread'));
  const pend = f.pending?.find((p) => p.signer.toLowerCase() === r.signer.toLowerCase()) ?? null;
  const active = f.signers?.find((s) => s.signer.toLowerCase() === r.signer.toLowerCase()) ?? null;

  switch (r.action) {
    case 'add':
      rows.push({
        label: text('signer.rowActiveFrom'),
        value: delay === null ? unknown : { kind: 'text', text: format('dest.afterDelay', { delay }) },
        binding: true,
      });
      consequences.push(
        delay === null ? text('signer.modeUnread') : format('signer.addWaits', { delay }),
        text('signer.addAccept'),
        text('signer.powers'),
        text('signer.limits'),
        text('signer.addCancel'),
        text('dest.addVoided'),
      );
      break;
    case 'accept':
      rows.push({ label: text('signer.rowActiveFrom'), value: pend === null ? unknown : { kind: 'text', text: formatUtc(pend.maturesAt) }, binding: false });
      consequences.push(text('signer.acceptWhat'), text('signer.powers'), text('signer.limits'), text('signer.acceptLeave'));
      break;
    case 'cancelAdd':
      consequences.push(text('signer.cancelAddWhat'));
      break;
    case 'applyAdd':
      rows.push({
        label: text('dest.rowWindow'),
        value: pend === null || m === null ? unknown : { kind: 'text', text: formatUtc(pend.maturesAt + m.delaySeconds) },
        binding: false,
      });
      consequences.push(text('signer.applyAddWhat'), text('signer.powers'), text('signer.limits'));
      break;
    case 'remove':
      rows.push({
        label: text('signer.rowLeavesFrom'),
        value: delay === null ? unknown : { kind: 'text', text: format('dest.afterDelay', { delay }) },
        binding: true,
      });
      consequences.push(delay === null ? text('signer.modeUnread') : format('signer.removeDelay', { delay }), text('signer.removeCancel'));
      if (m?.requireCosign && f.signers?.length === 1) consequences.push(text('signer.removeLastCosign'));
      break;
    case 'cancelRemove':
      consequences.push(text('signer.cancelRemoveWhat'));
      break;
    case 'applyRemove':
      rows.push({ label: text('signer.rowRemovable'), value: active === null ? unknown : { kind: 'text', text: formatUtc(active.removeAt) }, binding: false });
      consequences.push(text('signer.applyRemoveWhat'));
      if (m?.requireCosign && f.signers?.length === 1) consequences.push(text('signer.removeLastCosign'));
      break;
    case 'cosignOn':
      consequences.push(text('signer.cosignOnWhat'), text('signer.cosignOnUndo'));
      break;
    case 'cosignOff':
      rows.push({
        label: text('signer.rowCosignOffFrom'),
        value: delay === null ? unknown : { kind: 'text', text: format('dest.afterDelay', { delay }) },
        binding: true,
      });
      consequences.push(delay === null ? text('signer.modeUnread') : format('signer.cosignOffWaits', { delay }), text('signer.cosignOffCancel'));
      break;
  }
  if (f.signers === null && r.action !== 'accept') unread.push(text('signer.listUnread'));
  consequences.push(...unread, text('vaultWithdraw.noApproval'));
  return { title: text(signerTitle(r.action)), rows, consequences, prompts: 1, readAt: r.readAt };
}
