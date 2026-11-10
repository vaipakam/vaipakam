/**
 * ACC-41 / #3415 — the receipt each destination change is confirmed against
 * (RB-CONFIDENCE): the destination in full, the name it is saved under,
 * when it becomes usable and until when it may be applied, what a removal
 * cancels, how the change is undone, and every fact the review could not
 * read.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt, ReceiptRow } from '../receipt/types';
import type { SavedAddress } from '../address/book';
import { formatSpan, formatUtc } from '../ui/format';
import type { DestinationReview } from './destinations';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

const TITLE = { add: 'dest.titleAdd', cancel: 'dest.titleCancel', apply: 'dest.titleApply', remove: 'dest.titleRemove' } as const;

export function destinationReceipt(r: DestinationReview, saved: SavedAddress | null, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const f = r.facts;
  const m = f.mode === null || f.mode === 'absent' ? null : f.mode;
  const rows: ReceiptRow[] = [{ label: text('dest.rowDestination'), value: { kind: 'text', text: r.destination }, binding: true }];
  const consequences: string[] = [];
  const unread: string[] = [];
  if (saved !== null)
    rows.push({
      label: text('dest.rowSavedAs'),
      value: {
        kind: 'text',
        text: saved.kind === 'exchange' ? `${saved.label} · ${format('book.exchangeOf', { exchange: saved.exchange ?? '' })}` : `${saved.label} · ${text('book.kindWallet')}`,
      },
      binding: false,
    });
  if (f.mode === null) unread.push(text('dest.modeUnread'));
  if (r.dryRun === 'unread') unread.push(text('safety.dryRunUnread'));
  const pend = f.pending?.find((p) => p.destination.toLowerCase() === r.destination.toLowerCase()) ?? null;

  if (r.action === 'add') {
    const delay = m === null ? null : formatSpan(m.delaySeconds);
    rows.push({
      label: text('dest.rowUsableFrom'),
      value: delay === null ? unknown : { kind: 'text', text: format('dest.afterDelay', { delay }) },
      binding: true,
    });
    consequences.push(
      delay === null ? text('dest.modeUnread') : format('dest.addWaits', { delay }),
      text('dest.addCancel'),
      text('dest.addStill'),
      text('dest.addAgain'),
      text('dest.addVoided'),
    );
    if (saved?.kind === 'exchange') consequences.push(format('dest.addExchange', { exchange: saved.exchange ?? '' }));
    if (r.screen === 'unknown' || r.screen === 'outage') unread.push(text('dest.screenUnread'));
  } else if (r.action === 'cancel') {
    consequences.push(text('dest.cancelWhat'));
  } else if (r.action === 'apply') {
    rows.push({
      label: text('dest.rowWindow'),
      value: pend === null || m === null ? unknown : { kind: 'text', text: formatUtc(pend.maturesAt + m.delaySeconds) },
      binding: false,
    });
    consequences.push(text('dest.applyWhat'), text('dest.addStill'));
    // Activation is what makes the address usable, after a wait in which an
    // exchange may have reassigned it, so its risks are stated again here.
    if (saved?.kind === 'exchange') consequences.push(format('dest.addExchange', { exchange: saved.exchange ?? '' }));
  } else {
    const queued = f.queuedTo === null ? null : (f.queuedTo[r.destination.toLowerCase()] ?? 0);
    rows.push({
      label: text('dest.rowCancels'),
      value: queued === null ? unknown : { kind: 'text', text: format('safety.payoutCount', { count: String(queued) }) },
      binding: true,
    });
    consequences.push(text('dest.removeWhat'), text('dest.removeCancels'));
    if (queued === null) unread.push(text('dest.queueUnread'));
  }
  consequences.push(...unread, text('vaultWithdraw.noApproval'));
  return { title: text(TITLE[r.action]), rows, consequences, prompts: 1, readAt: r.readAt };
}
