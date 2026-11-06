/**
 * #3246 — the flows that remove a Telegram alert chat, with the protected-mode
 * wait (see `alertChannelChange.ts` for the rule and the storage).
 *
 * The one rule every flow keeps: a removal's wait starts only once the chat
 * it would remove has ACCEPTED the notice about it. A notice Telegram did not
 * accept is retried by the scheduled tick; until one is, the change is never
 * due. So a Telegram outage, or a failed send, can delay a removal but never
 * let it pass unseen.
 *
 * Each flow takes its dependencies as arguments (the database, a send, the
 * protection reader, the clock), so the tests drive them without a network.
 */
import {
  applyChange,
  cancelPendingForChat,
  dueChanges,
  formatUtc,
  linkedRows,
  markNoticeAttempt,
  markNotified,
  pendingChangeStatements,
  protectionByRow,
  pruneClosedChanges,
  shortWallet,
  supersedeStatement,
  unnotifiedChanges,
  type LinkedRow,
  type PendingChange,
  type ProtectionReader,
} from './alertChannelChange';
import { channelCopy, handshakeLinked } from './i18n';

/** What a send reports; only `accepted` counts as the chat being told. */
export type SendOutcome = 'accepted' | 'refused' | 'transient' | 'unknown';

export interface ChannelDeps {
  db: D1Database;
  /** Send a Telegram message; null when the bot token is not available now
   *  (unset, or its secret could not be read). Protection is read either
   *  way: without a sender a protected removal still waits, untold, and the
   *  tick tells the chat once a sender is back, so a missing secret can never
   *  turn a protected removal into an immediate one. */
  send: ((chatId: string, text: string) => Promise<SendOutcome>) | null;
  read: ProtectionReader;
  now: number;
}

/** How long a notice that was not accepted waits before the tick retries it. */
export const NOTICE_RETRY_SECONDS = 30 * 60;

/** One pending change as the HTTP reply reports it. `effective_at` is null
 *  while the chat has not yet been told (the wait has not started). */
export interface PendingReport {
  chain_id: number;
  effective_at: number | null;
}

/** Group rows under one key, so each group gets one notice. */
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

/** Tell `oldChatId` about the pending changes of `wallet` on `chains`, and,
 *  only when Telegram accepted it, start their wait. For a move, the new chat
 *  is told when it takes over once the wait has started. Returns whether the
 *  old chat was told. */
async function notifyOldChat(
  deps: ChannelDeps,
  wallet: string,
  oldChatId: string,
  kind: 'unlink' | 'replace',
  chains: readonly { chainId: number; delaySeconds: number }[],
  locale: string,
  newChat: { chatId: string; locale: string } | null,
): Promise<boolean> {
  if (!deps.send || chains.length === 0) return false;
  // Callers group by delay, so every chain in one notice has this deadline:
  // the time each row's wait ends once `markNotified` starts it now.
  const when = formatUtc(deps.now + chains[0]!.delaySeconds);
  const entries = chains.map((c) => ({ walletShort: shortWallet(wallet), chainId: c.chainId }));
  const text =
    kind === 'unlink'
      ? channelCopy.removalPending(locale, entries, when)
      : channelCopy.movePending(locale, entries, when);
  const ids = chains.map((c) => c.chainId);
  if ((await deps.send(oldChatId, text)) !== 'accepted') {
    await markNoticeAttempt(deps.db, wallet, ids, oldChatId, deps.now);
    return false;
  }
  await markNotified(deps.db, wallet, ids, oldChatId, deps.now);
  if (newChat) await deps.send(newChat.chatId, channelCopy.moveIncoming(newChat.locale, entries, when));
  return true;
}

/**
 * An owner asked to unlink Telegram, wallet-wide (`chainId` null) or for one
 * chain. Rows whose account is not protected are cleared at once by
 * `unlinkNow`; protected rows get a pending change and their chat a notice.
 * Every handshake code in the request's scope is revoked at once either way:
 * a code only links, so revoking it can silence nothing, and leaving one would
 * let another tab reverse the unlink. Returns 'unknown' when any row's
 * protection could not be read: then nothing is changed at all, so a failed
 * read never silences a protected account.
 */
export async function requestUnlink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number | null,
  unlinkNow: (chainIds: number[] | 'all') => Promise<void>,
): Promise<{ kind: 'done'; pending: PendingReport[] } | { kind: 'unknown' }> {
  const w = wallet.toLowerCase();
  const rows = await linkedRows(deps.db, w, chainId);
  const delays = rows.length > 0 ? await protectionByRow(deps.read, w, rows) : new Map<number, number | null>();
  if (delays === null) return { kind: 'unknown' };
  const waiting = rows.filter((r) => delays.get(r.chainId) != null);
  const open = rows.filter((r) => delays.get(r.chainId) == null);
  if (waiting.length === 0) {
    // The immediate path, as before; it also revokes the handshake codes.
    await deps.db.batch([supersedeStatement(deps.db, w, chainId, deps.now)]);
    await unlinkNow(chainId === null ? 'all' : [chainId]);
    return { kind: 'done', pending: [] };
  }
  if (open.length > 0) {
    await deps.db.batch(open.map((r) => supersedeStatement(deps.db, w, r.chainId, deps.now)));
    await unlinkNow(open.map((r) => r.chainId));
  }
  await deps.db.batch([
    ...waiting.flatMap((r) =>
      pendingChangeStatements(deps.db, w, r.chainId, 'unlink', r.chatId, null, deps.now, delays.get(r.chainId)!),
    ),
    chainId === null
      ? deps.db.prepare(`DELETE FROM telegram_links WHERE wallet = ?`).bind(w)
      : deps.db.prepare(`DELETE FROM telegram_links WHERE wallet = ? AND chain_id = ?`).bind(w, chainId),
  ]);
  const told = new Set<number>();
  // One notice per (chat, delay), so each states its own chains' deadline.
  for (const list of groupBy(waiting, (r) => `${r.chatId}|${delays.get(r.chainId)}`).values()) {
    const chains = list.map((r) => ({ chainId: r.chainId, delaySeconds: delays.get(r.chainId)! }));
    if (await notifyOldChat(deps, w, list[0]!.chatId, 'unlink', chains, list[0]!.locale, null)) {
      for (const r of list) told.add(r.chainId);
    }
  }
  const pending = waiting.map((r) => ({
    chain_id: r.chainId,
    effective_at: told.has(r.chainId) ? deps.now + delays.get(r.chainId)! : null,
  }));
  return { kind: 'done', pending };
}

/**
 * A chat completed the link handshake for (`wallet`, `chainId`). Linking where
 * no chat is linked, or the same chat again, is immediate (`linkNow`) and
 * supersedes any pending change of the row. Linking a DIFFERENT chat in place
 * of the one linked now waits the account's delay when the account is
 * protected on that chain: the chat linked now keeps the alerts and is told,
 * and the new chat is told when it takes over once the wait has started.
 */
export async function requestRelink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number,
  newChatId: string,
  locale: string,
  linkNow: () => Promise<void>,
): Promise<'linked' | 'pending' | 'unknown'> {
  const w = wallet.toLowerCase();
  const immediate = async () => {
    await deps.db.batch([supersedeStatement(deps.db, w, chainId, deps.now)]);
    await linkNow();
    return 'linked' as const;
  };
  const [current] = await linkedRows(deps.db, w, chainId);
  if (!current || current.chatId === newChatId) return immediate();
  const delays = await protectionByRow(deps.read, w, [current]);
  if (delays === null) {
    await deps.send?.(newChatId, channelCopy.protectionUnknown(locale));
    return 'unknown';
  }
  const delay = delays.get(chainId);
  if (delay == null) return immediate();
  await deps.db.batch(
    pendingChangeStatements(deps.db, w, chainId, 'replace', current.chatId, newChatId, deps.now, delay),
  );
  const told = await notifyOldChat(deps, w, current.chatId, 'replace', [{ chainId, delaySeconds: delay }], current.locale, {
    chatId: newChatId,
    locale,
  });
  if (!told) {
    // The wait has not started; the new chat learns its start time when the
    // tick's retry reaches the chat linked now.
    await deps.send?.(newChatId, channelCopy.moveWaitingForNotice(locale, [{ walletShort: shortWallet(w), chainId }]));
  }
  return 'pending';
}

/** CANCEL from `chatId`: stop every pending removal of that chat, and answer. */
export async function cancelFromChat(
  deps: ChannelDeps,
  chatId: string,
  isPrivate: boolean,
  locale: string,
): Promise<number> {
  if (!isPrivate) {
    // A group's other members must not be able to keep or stop a change.
    await deps.send?.(chatId, channelCopy.cancelPrivateOnly(locale));
    return 0;
  }
  const cancelled = await cancelPendingForChat(deps.db, chatId, deps.now);
  await deps.send?.(
    chatId,
    cancelled.length === 0
      ? channelCopy.cancelNone(locale)
      : channelCopy.cancelDone(
          locale,
          cancelled.map((c) => ({ walletShort: shortWallet(c.wallet), chainId: c.chainId })),
        ),
  );
  return cancelled.length;
}

/** The scheduled step: retry the notices not yet accepted (starting their
 *  wait once one is), apply every change that is due, tell the chats, and
 *  prune old closed rows. Returns how many changes it applied. */
export async function applyDueChannelChanges(deps: ChannelDeps): Promise<number> {
  if (deps.send) {
    const untold = await unnotifiedChanges(deps.db, deps.now - NOTICE_RETRY_SECONDS);
    // One notice per (chat, wallet, kind, delay): each states its deadline.
    const groups = groupBy(untold, (c: PendingChange) => `${c.oldChatId}|${c.wallet}|${c.kind}|${c.delaySeconds}`);
    for (const list of groups.values()) {
      const first = list[0]!;
      for (const c of first.kind === 'replace' ? list : [first]) {
        // A move names one new chat per row, so each is told on its own.
        const batch = first.kind === 'replace' ? [c] : list;
        await notifyOldChat(
          deps,
          first.wallet,
          first.oldChatId,
          first.kind,
          batch.map((x) => ({ chainId: x.chainId, delaySeconds: x.delaySeconds })),
          first.locale,
          c.newChatId ? { chatId: c.newChatId, locale: c.locale } : null,
        );
      }
    }
  }
  const due = await dueChanges(deps.db, deps.now);
  let applied = 0;
  for (const c of due) {
    if (!(await applyChange(deps.db, c, deps.now))) continue;
    applied += 1;
    if (!deps.send) continue;
    const entries = [{ walletShort: shortWallet(c.wallet), chainId: c.chainId }];
    if (c.kind === 'unlink') {
      await deps.send(c.oldChatId, channelCopy.removalApplied(c.locale, entries));
    } else {
      await deps.send(c.oldChatId, channelCopy.moveApplied(c.locale, entries));
      if (c.newChatId) await deps.send(c.newChatId, handshakeLinked(c.locale, shortWallet(c.wallet), c.chainId));
    }
  }
  await pruneClosedChanges(deps.db, deps.now);
  return applied;
}
