/**
 * #3246 — the flows that remove a Telegram alert chat, with the protected-mode
 * wait (see `alertChannelChange.ts` for the rule and the storage).
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
  pendingChangeStatements,
  protectionByRow,
  pruneClosedChanges,
  shortWallet,
  type LinkedRow,
  type ProtectionReader,
} from './alertChannelChange';
import { channelCopy, handshakeLinked } from './i18n';

export interface ChannelDeps {
  db: D1Database;
  /** Send a Telegram message; null when no bot is configured (notices are
   *  skipped, changes still recorded and applied). */
  send: ((chatId: string, text: string) => Promise<unknown>) | null;
  read: ProtectionReader;
  now: number;
}

/** One pending change as the HTTP reply reports it. */
export interface PendingReport {
  chain_id: number;
  effective_at: number;
}

/** Group rows by the chat they would silence, so each chat gets one notice. */
function byChat(rows: readonly LinkedRow[]): Map<string, LinkedRow[]> {
  const m = new Map<string, LinkedRow[]>();
  for (const r of rows) m.set(r.chatId, [...(m.get(r.chatId) ?? []), r]);
  return m;
}

/**
 * An owner asked to unlink Telegram, wallet-wide (`chainId` null) or for one
 * chain. Rows whose account is not protected are cleared at once by
 * `unlinkNow`; protected rows get a pending change and their chat a notice.
 * Returns 'unknown' when any row's protection could not be read: then nothing
 * is changed at all, so a failed read never silences a protected account.
 */
export async function requestUnlink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number | null,
  unlinkNow: (chainIds: number[] | 'all') => Promise<void>,
): Promise<{ kind: 'done'; pending: PendingReport[] } | { kind: 'unknown' }> {
  const rows = await linkedRows(deps.db, wallet, chainId);
  if (rows.length === 0) {
    // Nothing linked: the immediate path still revokes handshake codes.
    await unlinkNow(chainId === null ? 'all' : [chainId]);
    return { kind: 'done', pending: [] };
  }
  const delays = await protectionByRow(deps.read, wallet, rows);
  if (delays === null) return { kind: 'unknown' };
  const waiting = rows.filter((r) => delays.get(r.chainId) != null);
  const open = rows.filter((r) => delays.get(r.chainId) == null);
  if (waiting.length === 0) {
    await unlinkNow(chainId === null ? 'all' : [chainId]);
    return { kind: 'done', pending: [] };
  }
  if (open.length > 0) await unlinkNow(open.map((r) => r.chainId));
  const statements = waiting.flatMap((r) =>
    pendingChangeStatements(deps.db, wallet, r.chainId, 'unlink', r.chatId, null, deps.now, deps.now + delays.get(r.chainId)!),
  );
  await deps.db.batch(statements);
  const pending = waiting.map((r) => ({ chain_id: r.chainId, effective_at: deps.now + delays.get(r.chainId)! }));
  if (deps.send) {
    for (const [chat, list] of byChat(waiting)) {
      const last = Math.max(...list.map((r) => deps.now + delays.get(r.chainId)!));
      const entries = list.map((r) => ({ walletShort: shortWallet(wallet), chainId: r.chainId }));
      await deps.send(chat, channelCopy.removalPending(list[0]!.locale, entries, formatUtc(last)));
    }
  }
  return { kind: 'done', pending };
}

/**
 * A chat completed the link handshake for (`wallet`, `chainId`). Linking where
 * no chat is linked, or the same chat again, is immediate (`linkNow`). Linking a
 * DIFFERENT chat in place of the one linked now waits the account's delay when
 * the account is protected on that chain: the chat linked now keeps the alerts
 * and is told, and the new chat is told when it takes over.
 */
export async function requestRelink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number,
  newChatId: string,
  locale: string,
  linkNow: () => Promise<void>,
): Promise<'linked' | 'pending' | 'unknown'> {
  const [current] = await linkedRows(deps.db, wallet, chainId);
  if (!current || current.chatId === newChatId) {
    await linkNow();
    return 'linked';
  }
  const delays = await protectionByRow(deps.read, wallet, [current]);
  if (delays === null) {
    if (deps.send) await deps.send(newChatId, channelCopy.protectionUnknown(locale));
    return 'unknown';
  }
  const delay = delays.get(chainId);
  if (delay == null) {
    await linkNow();
    return 'linked';
  }
  const effectiveAt = deps.now + delay;
  await deps.db.batch(
    pendingChangeStatements(deps.db, wallet, chainId, 'replace', current.chatId, newChatId, deps.now, effectiveAt),
  );
  if (deps.send) {
    const entries = [{ walletShort: shortWallet(wallet), chainId }];
    await deps.send(current.chatId, channelCopy.movePending(current.locale, entries, formatUtc(effectiveAt)));
    await deps.send(newChatId, channelCopy.moveIncoming(locale, entries, formatUtc(effectiveAt)));
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
    if (deps.send) await deps.send(chatId, channelCopy.cancelPrivateOnly(locale));
    return 0;
  }
  const cancelled = await cancelPendingForChat(deps.db, chatId, deps.now);
  if (deps.send) {
    await deps.send(
      chatId,
      cancelled.length === 0
        ? channelCopy.cancelNone(locale)
        : channelCopy.cancelDone(
            locale,
            cancelled.map((c) => ({ walletShort: shortWallet(c.wallet), chainId: c.chainId })),
          ),
    );
  }
  return cancelled.length;
}

/** The scheduled step: apply every change that is due, tell the chats, and
 *  prune old closed rows. Returns how many it applied. */
export async function applyDueChannelChanges(deps: ChannelDeps): Promise<number> {
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
      // The new chat was told when it would take over; this confirms it.
      if (c.newChatId) await deps.send(c.newChatId, handshakeLinked(c.locale, shortWallet(c.wallet), c.chainId));
    }
  }
  await pruneClosedChanges(deps.db, deps.now);
  return applied;
}
