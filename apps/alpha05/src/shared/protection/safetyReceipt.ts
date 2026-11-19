/**
 * ACC-37 / ACC-43 — the receipt each safety action is confirmed against
 * (RB-CONFIDENCE): what the account's protected mode becomes, what the
 * action cancels or drops, what it never touches, how it is undone and how
 * long that takes, and every fact the review could not read.
 */
import type { CopyAccess } from '../copy/useCopy';
import type { Receipt, ReceiptRow } from '../receipt/types';
import { formatSpan } from '../ui/format';
import { recoveryWaitSeconds } from './recovery';
import { changeText, pendingChanges, safetySteps, type SafetyReview } from './safety';

type Copy = Pick<CopyAccess, 'text' | 'format'>;

export function safetyReceipt(r: SafetyReview, copy: Copy): Receipt {
  const { text, format } = copy;
  const unknown = { kind: 'unknown' as const, why: text('receipt.unknown') };
  const f = r.facts;
  const m = f.mode === null || f.mode === 'absent' ? null : f.mode;
  const rows: ReceiptRow[] = [];
  const consequences: string[] = [];
  const unread: string[] = [];
  if (f.mode === null) unread.push(text('safety.modeUnread'));
  if (f.paused === null && r.action !== 'lock' && r.action !== 'recovery' && r.action !== 'recoveryCancel') unread.push(text('safety.pauseUnread'));
  if (r.dryRun === 'unread') unread.push(text('safety.dryRunUnread'));

  if (r.action === 'recovery') {
    const p = r.proof;
    const rec = f.recovery;
    rows.push({ label: text('recovery.rowAddress'), value: p === null ? unknown : { kind: 'text', text: p.recovery }, binding: true });
    rows.push({
      label: text('recovery.rowInForce'),
      value:
        rec === null || m === null || f.bounds === null
          ? unknown
          : { kind: 'text', text: format('recovery.afterWait', { wait: formatSpan(recoveryWaitSeconds(rec, m.enabled, m.delaySeconds, f.bounds.min)) }) },
      binding: true,
    });
    if (rec !== null && rec.inForce !== null) rows.push({ label: text('recovery.rowReplaces'), value: { kind: 'text', text: rec.inForce }, binding: true });
    if (rec !== null && rec.pending !== null) rows.push({ label: text('recovery.rowDropsPending'), value: { kind: 'text', text: rec.pending }, binding: true });
    consequences.push(text('recovery.whatFor'), text('recovery.onlyPlace'), text('recovery.cancelWhilePending'), text('recovery.changeWaits'));
    if (rec === null) unread.push(text('recovery.unread'));
    if (f.bounds === null) unread.push(text('safety.boundsUnread'));
  } else if (r.action === 'recoveryCancel') {
    const rec = f.recovery;
    rows.push({ label: text('recovery.rowCancels'), value: rec === null || rec.pending === null ? unknown : { kind: 'text', text: rec.pending }, binding: true });
    rows.push({
      label: text('recovery.rowAfterCancel'),
      value: rec === null ? unknown : { kind: 'text', text: rec.inForce === null ? text('recovery.noneAfterCancel') : rec.inForce },
      binding: true,
    });
    consequences.push(text('recovery.cancelKeeps'));
    if (rec !== null && rec.inForce === null) consequences.push(text('recovery.cancelLeavesNone'));
    if (rec === null) unread.push(text('recovery.unread'));
  } else if (r.action === 'enable') {
    const d = r.draft;
    rows.push({ label: text('safety.rowDelay'), value: d === null ? unknown : { kind: 'text', text: formatSpan(d.delaySeconds) }, binding: true });
    rows.push({ label: text('safety.rowWaits'), value: { kind: 'text', text: text('safety.waitsWhat') }, binding: true });
    rows.push({ label: text('safety.rowNfts'), value: d === null ? unknown : { kind: 'text', text: text(d.protectNfts ? 'safety.nftsOn' : 'safety.nftsOff') }, binding: true });
    consequences.push(
      d === null ? text('safety.enableWaitsUnread') : format('safety.enableWaits', { delay: formatSpan(d.delaySeconds) }),
      text('safety.enableInbound'),
      text('safety.enableNeverOthers'),
      text(d?.protectNfts ? 'safety.enableNftsOn' : 'safety.enableNftsOff'),
      text('safety.enableLoosen'),
      text('safety.enableLock'),
      text('safety.enableVault'),
      text('safety.enableVoidsPin'),
    );
    if (f.bounds === null) unread.push(text('safety.boundsUnread'));
    if (f.frozen === 'unknown' || f.frozen === 'outage') unread.push(text('vaultDeposit.screenUnread'));
  } else if (r.action === 'lock') {
    const pending = m === null ? null : pendingChanges(m).length;
    rows.push({
      label: text('safety.rowCancels'),
      value: f.openRows === null ? unknown : { kind: 'text', text: format('safety.payoutCount', { count: String(f.openRows) }) },
      binding: true,
    });
    rows.push({
      label: text('safety.rowDrops'),
      value: pending === null ? unknown : { kind: 'text', text: format('safety.changeCount', { count: String(pending) }) },
      binding: true,
    });
    rows.push({ label: text('safety.rowUnlockWaits'), value: m === null ? unknown : { kind: 'text', text: formatSpan(m.delaySeconds) }, binding: false });
    consequences.push(
      text('safety.lockCancels'),
      text('safety.lockStops'),
      text('safety.lockServicing'),
      text('safety.lockDrops'),
      text('safety.lockReplacement'),
      text('safety.lockUnlock'),
      text('safety.lockPause'),
    );
    if (f.openRows === null) unread.push(text('safety.rowsUnread'));
  } else if (r.action === 'lockNfts') {
    rows.push({ label: text('safety.rowNfts'), value: { kind: 'text', text: text('safety.nftsOn') }, binding: true });
    rows.push({ label: text('safety.rowUnlockWaits'), value: m === null ? unknown : { kind: 'text', text: formatSpan(m.delaySeconds) }, binding: false });
    consequences.push(text('safety.enableNftsOn'), text('safety.lockNftsNoMoney'));
  } else if (r.action === 'unlock') {
    rows.push({
      label: text('safety.rowTakesEffect'),
      value: m === null ? unknown : { kind: 'text', text: format('safety.afterDelay', { delay: formatSpan(m.delaySeconds) }) },
      binding: true,
    });
    consequences.push(text('safety.unlockWaits'), text('safety.unlockStill'), text('safety.unlockLockAgain'));
  } else {
    rows.push({
      label: text('safety.rowApplies'),
      value: r.due.length === 0 ? unknown : { kind: 'text', text: r.due.map((c) => changeText(c, m, copy)).join(' · ') },
      binding: true,
    });
    if (r.due.includes('lowerDelay'))
      rows.push({
        label: text('safety.rowDelayAfter'),
        value:
          m === null || m.pendingDelay === 0 ? unknown : { kind: 'text', text: format('safety.delayFromTo', { to: formatSpan(m.pendingDelay), from: formatSpan(m.delaySeconds) }) },
        binding: true,
      });
    consequences.push(text('safety.finalizeAll'));
    if (r.due.includes('unlock')) consequences.push(text('safety.finalizeUnlock'));
    if (r.due.includes('disable')) consequences.push(text('safety.finalizeDisable'), text('safety.finalizeDisableClears'));
    if (r.due.includes('lowerDelay') || r.due.includes('cosignOff')) consequences.push(text('safety.finalizeLoosens'));
  }
  consequences.push(...unread, text('vaultWithdraw.noApproval'));
  const title = text(
    r.action === 'recovery' ? 'recovery.title' : r.action === 'recoveryCancel' ? 'recovery.cancelTitle' : r.action === 'enable' ? 'safety.titleEnable' : r.action === 'lock' ? 'safety.titleLock' : r.action === 'unlock' ? 'safety.titleUnlock' : r.action === 'lockNfts' ? 'safety.titleLockNfts' : 'safety.titleFinalize',
  );
  // #3379 B2: an action can be several transactions (the vault's write, then
  // the Diamond applying it), each its own wallet prompt.
  const prompts = Math.max(1, safetySteps(r.action, f.account, f.vault, r.draft, r.due, r.proof).length);
  return { title, rows, consequences, prompts, readAt: r.readAt };
}
