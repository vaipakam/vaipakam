/**
 * LN-55 / LN-56 — one action on one queued payout (release, cancel or
 * co-sign): what it stands on, read in one go through the wallet's
 * connection (the account's queue facts, the row itself in whatever state it
 * is, and the protocol's own dry run of the call), the receipt it is
 * confirmed against, and its outcome, measured from the transaction's own
 * logs. None of the three moves anything out of the wallet or asks an
 * approval: a release pays from the account's vault to the row's recorded
 * destination.
 */
import type { Log, PublicClient } from 'viem';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal, Verdict } from '../eligibility/types';
import { figured, textValue, type Receipt, type ReceiptRow, type ReceiptText } from '../receipt/types';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { shortAddress } from '../ui/format';
import {
  PAYOUT,
  QUEUE_FUNCTION,
  ROW_QUEUED,
  destinationAllowed,
  queueClock,
  queueLogs,
  queueManager,
  queueVerdict,
  readAccountQueue,
  readQueueRow,
  releaseCancels,
  type AccountQueue,
  type QueueAction,
  type QueueRow,
} from './queue';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;

export interface QueueReview {
  identity: string;
  action: QueueAction;
  /** The protected account the row belongs to. */
  account: Hex;
  id: bigint;
  queue: AccountQueue;
  /** The row as read now, in whatever state it is. */
  row: QueueRow;
  /** Release only: whether it cancels instead of paying. */
  cancels: boolean | null;
  verdict: Verdict;
  /** The protocol's dry run now: null when it passes, its refusal, or
   *  'unread'. Asked only when the app's own rule is open. */
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

export async function readQueueReview(
  own: OwnStateClient,
  diamond: Hex,
  account: Hex,
  id: bigint,
  action: QueueAction,
  identity: string,
  copy: Pick<CopyAccess, 'text'>,
): Promise<QueueReview> {
  const viewer = own.account;
  const { queue, row } = await own
    .read(async (c: PublicClient) => {
      const [queue, row] = await Promise.all([readAccountQueue(c, diamond, account), readQueueRow(c, diamond, id)]);
      return { queue, row };
    })
    .then((x) => x.value);
  // A row that is not this account's is never acted on as if it were.
  const ownRow: QueueRow = row.payout !== null && row.payout.user.toLowerCase() !== account.toLowerCase() ? { ...row, payout: null } : row;
  const verdict = queueVerdict(action, queue, ownRow, viewer, queueClock(queue, Date.now()), copy);
  let dryRun: QueueReview['dryRun'] = null;
  if (verdict.state === 'open') {
    const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, abi: PAYOUT, functionName: QUEUE_FUNCTION[action], args: [id], account: viewer }));
    dryRun = dry.kind === 'reverted' ? refusalFromError(dry.error) : dry.kind === 'unreadable' ? 'unread' : null;
  }
  return {
    identity,
    action,
    account,
    id,
    queue,
    row: ownRow,
    cancels: action === 'release' ? releaseCancels(queue, ownRow) : null,
    verdict,
    dryRun,
    readAt: Date.now(),
  };
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function queueChanged(a: QueueReview, b: QueueReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  const pa = a.row.payout;
  const pb = b.row.payout;
  const rowKey = (p: typeof pa) =>
    p === null ? 'unread' : [p.state, p.kind, p.asset.toLowerCase(), p.tokenId, p.amount, p.recipient.toLowerCase(), p.releaseAt, p.cosigned].join(':');
  if (rowKey(pa) !== rowKey(pb) || a.row.code !== b.row.code) return text('queue.changedRow');
  const ma = a.queue.mode;
  const mb = b.queue.mode;
  const modeKey = (m: typeof ma) => (m === null ? 'unread' : [m.locked, m.requireCosign, m.retired, m.controller.toLowerCase()].join(':'));
  if (modeKey(ma) !== modeKey(mb) || a.cancels !== b.cancels) return text('queue.changedAccount');
  if (a.queue.paused !== b.queue.paused || a.queue.escapeOpen !== b.queue.escapeOpen) return text('repay.changedHolders');
  if (a.verdict.state !== b.verdict.state || a.verdict.refusals[0]?.code !== b.verdict.refusals[0]?.code) return text('repay.changedVerdict');
  return null;
}

/** What stops the review here, in words (empty when nothing does). */
export function queueBlockers(r: QueueReview, copy: Copy): string[] {
  if (r.verdict.state !== 'open') return [r.verdict.refusals[0]?.reason ?? ''];
  if (r.dryRun === 'unread') return [copy.text('queue.dryRunUnread')];
  if (r.dryRun !== null) return [copy.format('repay.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** The row's request code, or its number when the code was unread. */
export function rowName(row: QueueRow, copy: Copy): string {
  return row.code ?? copy.format('queue.rowNumber', { id: row.id.toString() });
}

/** Where a row pays, in words: the viewer's own wallet, the account's
 *  manager wallet, an allowlisted destination, or an address the account no
 *  longer allows (or whose standing could not be read), never "allowlisted"
 *  without the allowlist saying so. */
export function destinationWords(q: AccountQueue, recipient: Hex, viewer: Hex, copy: Copy): string {
  const { text, format } = copy;
  const address = shortAddress(recipient);
  const allowed = destinationAllowed(q, recipient);
  const manager = queueManager(q);
  if (recipient.toLowerCase() === viewer.toLowerCase() && allowed !== false) return text('queue.toYourWallet');
  if (manager !== null && recipient.toLowerCase() === manager.toLowerCase()) return format('queue.toManager', { address });
  if (allowed === true) return format('queue.toOther', { address });
  return format(allowed === false ? 'queue.toDisallowed' : 'queue.toUnread', { address });
}

/** A payout's size in words: `what(exact)` names it with short or exact
 *  figures (an NFT reads the same either way). */
export type PayoutWords = (exact: boolean) => string;

export function queueReceipt(r: QueueReview, viewer: Hex, what: PayoutWords, copy: Copy): Receipt {
  const { text, format } = copy;
  const p = r.row.payout;
  const name = rowName(r.row, copy);
  const title = format(r.action === 'release' ? 'queue.titleRelease' : r.action === 'cancel' ? 'queue.titleCancel' : 'queue.titleCosign', { code: name });
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const rows: ReceiptRow[] = [];
  rows.push({ label: text('queue.rowCode'), value: r.row.code === null ? unknown : { kind: 'text', text: r.row.code }, binding: false });
  if (r.account.toLowerCase() !== viewer.toLowerCase()) rows.push({ label: text('queue.rowAccount'), value: { kind: 'text', text: shortAddress(r.account) }, binding: false });
  if (p === null) {
    rows.push({ label: text('queue.rowPayout'), value: unknown, binding: true });
  } else {
    rows.push({ label: text('queue.rowPayout'), value: textValue(figured(what)), binding: true });
    rows.push({ label: text('queue.rowDestination'), value: { kind: 'text', text: destinationWords(r.queue, p.recipient, viewer, copy) }, binding: r.action === 'release' });
    rows.push({ label: text('queue.rowDue'), value: { kind: 'time', unixSeconds: p.releaseAt }, binding: false });
    const cosign = r.queue.mode === null ? null : !r.queue.mode.requireCosign ? text('queue.cosignOff') : p.cosigned ? text('queue.cosignGiven') : text('queue.cosignMissing');
    rows.push({ label: text('queue.rowCosign'), value: cosign === null ? unknown : { kind: 'text', text: cosign }, binding: false });
  }
  const consequences: ReceiptText[] = [];
  const words = (key: CopyKey) => figured((exact) => format(key, { what: what(exact) }));
  if (r.action === 'release') {
    if (r.cancels === true) consequences.push(words('queue.releaseCancels'));
    else if (p !== null)
      consequences.push(figured((exact) => format('queue.releasePays', { what: what(exact), destination: destinationWords(r.queue, p.recipient, viewer, copy) })));
    if (r.cancels === null) consequences.push(text('queue.allowUnread'));
    consequences.push(text(r.queue.paused && r.queue.escapeOpen ? 'queue.escapeNote' : 'queue.pauseNote'));
  } else if (r.action === 'cancel') {
    consequences.push(words('queue.cancelNote'));
  } else {
    consequences.push(text('queue.cosignNote'));
  }
  return { title, rows, consequences, prompts: 1, readAt: r.readAt };
}

/** The transaction's outcome for the reviewed action, from its own logs. */
export function measureQueueAction(r: QueueReview, logs: readonly Log[], diamond: Hex, viewer: Hex, what: (amount: bigint, exact: boolean) => string, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const seen = queueLogs(logs, diamond, r.id);
  const name = rowName(r.row, copy);
  const p = r.row.payout;
  const reviewed = p?.amount ?? 0n;
  if (r.action === 'release') {
    if (seen.released) {
      const destination = destinationWords(r.queue, seen.released.recipient, viewer, copy);
      const label = format('queue.legReleased', { what: what(seen.released.delivered, false), destination });
      // The review said this release would cancel; it paid instead.
      if (r.cancels === true) return [{ status: 'unknown', label, reason: text('queue.paidUnexpected') }];
      if (seen.released.delivered === seen.released.amount) return [{ status: 'done', label }];
      return [{ status: 'unknown', label, reason: format('queue.deliveredOther', { amount: what(seen.released.delivered, true), expected: what(seen.released.amount, true) }) }];
    }
    if (seen.cancelled) {
      const label = format('queue.legCancelledInstead', { what: what(reviewed, false) });
      return r.cancels === true ? [{ status: 'done', label }] : [{ status: 'unknown', label, reason: text('queue.cancelledUnexpected') }];
    }
    return [{ status: 'not-done', label: format('queue.titleRelease', { code: name }), reason: text('queue.notReleased') }];
  }
  if (r.action === 'cancel') {
    if (seen.cancelled) return [{ status: 'done', label: format('queue.legCancelled', { what: what(reviewed, false) }) }];
    return [{ status: 'not-done', label: format('queue.titleCancel', { code: name }), reason: text('queue.notCancelled') }];
  }
  if (seen.cosigned) return [{ status: 'done', label: format('queue.legCosigned', { code: name }) }];
  return [{ status: 'not-done', label: format('queue.titleCosign', { code: name }), reason: text('queue.notCosigned') }];
}

/** Whether a row can still be acted on at all (it is queued). */
export const stillQueued = (row: QueueRow) => row.payout?.state === ROW_QUEUED;
