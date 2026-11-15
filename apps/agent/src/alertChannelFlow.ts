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
 * Each flow takes its dependencies as arguments (the Telegram state, the
 * locale reader, a send, the protection reader, the clock), so the tests drive
 * them without a network.
 *
 * Every decision is written through one guarded `commit`: the state object
 * writes it only while the rows the flow read before deciding are unchanged,
 * and otherwise writes nothing, so the flow reads and decides again. That is
 * what keeps a chain read in between (the protection status) from letting a
 * stale decision skip a wait.
 */
import {
  APPLY_BATCH,
  chatLocale,
  formatUtc,
  linkedRows,
  protectionByRow,
  shortWallet,
  withLocales,
  type LocaleReader,
  type PendingChange,
  type ProtectionReader,
  type TelegramStatePort,
} from './alertChannelChange';
import type { ChannelOp } from './telegramState/store';
import { channelCopy, handshakeLinked } from './i18n';

/** What a send reports; only `accepted` counts as the chat being told. */
export type SendOutcome = 'accepted' | 'refused' | 'transient' | 'unknown';

export interface ChannelDeps {
  state: TelegramStatePort;
  locales: LocaleReader;
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
  chains: readonly { id: number; chainId: number; delaySeconds: number }[],
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
  // The change ids this notice names: only these may start their wait.
  const ids = chains.map((c) => c.id);
  if ((await deps.send(oldChatId, text)) !== 'accepted') {
    await deps.state.markNoticeAttempt(ids, deps.now);
    return false;
  }
  await deps.state.markNotified(ids, deps.now);
  if (newChat) await deps.send(newChat.chatId, channelCopy.moveIncoming(newChat.locale, entries, when));
  return true;
}

/** How many times a request decides again when another request moved the
 *  rows between its read and its write. */
const DECIDE_ATTEMPTS = 3;

/**
 * An owner asked to unlink Telegram, wallet-wide (`chainId` null) or for one
 * chain. Rows whose account is not protected are cleared at once; protected
 * rows get a pending change and their chat a notice. Every handshake code in
 * the request's scope is revoked at once either way: a code only links, so
 * revoking it can silence nothing, and leaving one would let another tab
 * reverse the unlink.
 *
 * The decision and all its writes are one guarded commit: if any row in
 * scope changed after the read (a chat linked concurrently, say), it writes
 * nothing and the request reads and decides again. Returns 'unknown' when any row's protection could not be
 * read, or the rows kept moving: then nothing is changed at all, so neither a
 * failed read nor a race ever silences a protected account.
 */
export async function requestUnlink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number | null,
): Promise<{ kind: 'done'; pending: PendingReport[] } | { kind: 'unknown' }> {
  const w = wallet.toLowerCase();
  for (let attempt = 0; attempt < DECIDE_ATTEMPTS; attempt++) {
    const { observed, rows } = await linkedRows(deps.state, deps.locales, w, chainId);
    const delays = rows.length > 0 ? await protectionByRow(deps.read, w, rows) : new Map<number, number | null>();
    if (delays === null) return { kind: 'unknown' };
    const waiting = rows.filter((r) => delays.get(r.chainId) != null);
    const open = rows.filter((r) => delays.get(r.chainId) == null);
    const ops: ChannelOp[] = [
      // A request with nothing waiting closes every pending change in its
      // scope, as the immediate unlink always did.
      ...(waiting.length === 0 ? [{ op: 'supersede', chainId } as const] : []),
      ...open.flatMap((r) => [{ op: 'supersede', chainId: r.chainId } as const, { op: 'clear', chainId: r.chainId } as const]),
      ...waiting.map(
        (r) =>
          ({
            op: 'pend',
            chainId: r.chainId,
            kind: 'unlink',
            oldChatId: r.chatId,
            newChatId: null,
            delaySeconds: delays.get(r.chainId)!,
          }) as const,
      ),
      { op: 'revokeCodes', chainId },
    ];
    const result = await deps.state.commit(w, chainId, observed, ops, deps.now);
    // The rows moved after the read: nothing was written; decide again.
    if (!result.ok) continue;
    // One id per waiting row, in order.
    const idOf = new Map(waiting.map((r, i) => [r.chainId, result.ids[i]!]));
    const told = new Set<number>();
    // One notice per (chat, delay), so each states its own chains' deadline.
    for (const list of groupBy(waiting, (r) => `${r.chatId}|${delays.get(r.chainId)}`).values()) {
      const chains = list.map((r) => ({ id: idOf.get(r.chainId)!, chainId: r.chainId, delaySeconds: delays.get(r.chainId)! }));
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
  return { kind: 'unknown' };
}

/**
 * A chat completed the link handshake for (`wallet`, `chainId`). Linking where
 * no chat is linked, or the same chat again, is immediate and supersedes any
 * pending change of the row. Linking a DIFFERENT chat in place of the one
 * linked now waits the account's delay when the account is protected on that
 * chain: the chat linked now keeps the alerts and is told, and the new chat is
 * told when it takes over once the wait has started.
 *
 * Every write is guarded on the rows the decision read, so two handshakes
 * completing together can never let the second overwrite the first without
 * the protection check: when the row moved, the decision is taken again from
 * the new state.
 */
export async function requestRelink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number,
  newChatId: string,
  locale: string,
): Promise<'linked' | 'pending' | 'unknown'> {
  const w = wallet.toLowerCase();
  for (let attempt = 0; attempt < DECIDE_ATTEMPTS; attempt++) {
    const outcome = await decideRelink(deps, w, chainId, newChatId, locale);
    if (outcome !== 'moved') return outcome;
  }
  // The row kept moving under us: change nothing and say so.
  await deps.send?.(newChatId, channelCopy.protectionUnknown(locale));
  return 'unknown';
}

async function decideRelink(
  deps: ChannelDeps,
  w: string,
  chainId: number,
  newChatId: string,
  locale: string,
): Promise<'linked' | 'pending' | 'unknown' | 'moved'> {
  const { observed, rows } = await linkedRows(deps.state, deps.locales, w, chainId);
  /** Link now if the row is still exactly `observed`; 'moved' when it moved. */
  const immediate = async (): Promise<'linked' | 'moved'> => {
    const r = await deps.state.commit(
      w,
      chainId,
      observed,
      [
        { op: 'supersede', chainId },
        { op: 'link', chainId, chatId: newChatId },
      ],
      deps.now,
    );
    return r.ok ? 'linked' : 'moved';
  };
  const [current] = rows;
  if (!current || current.chatId === newChatId) return immediate();
  const delays = await protectionByRow(deps.read, w, [current]);
  if (delays === null) {
    await deps.send?.(newChatId, channelCopy.protectionUnknown(locale));
    return 'unknown';
  }
  const delay = delays.get(chainId);
  if (delay == null) return immediate();
  // The pending move is written only while the chat linked now is still the
  // one it moves away from, so a scheduled move or unlink that landed during
  // the protection read is never overwritten by a stale decision.
  const result = await deps.state.commit(
    w,
    chainId,
    observed,
    [{ op: 'pend', chainId, kind: 'replace', oldChatId: current.chatId, newChatId, delaySeconds: delay }],
    deps.now,
  );
  if (!result.ok) return 'moved';
  const [id] = result.ids;
  const told = await notifyOldChat(deps, w, current.chatId, 'replace', [{ id: id!, chainId, delaySeconds: delay }], current.locale, {
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
export async function cancelFromChat(deps: ChannelDeps, chatId: string, isPrivate: boolean): Promise<number> {
  const locale = await chatLocale(deps.state, deps.locales, chatId);
  if (!isPrivate) {
    // A group's other members must not be able to keep or stop a change.
    await deps.send?.(chatId, channelCopy.cancelPrivateOnly(locale));
    return 0;
  }
  const cancelled = await deps.state.cancelPendingForChat(chatId, deps.now);
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
    const untold = await withLocales(
      deps.locales,
      await deps.state.unnotifiedChanges(deps.now - NOTICE_RETRY_SECONDS, APPLY_BATCH),
    );
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
          batch.map((x) => ({ id: x.id, chainId: x.chainId, delaySeconds: x.delaySeconds })),
          first.locale,
          c.newChatId ? { chatId: c.newChatId, locale: c.locale } : null,
        );
      }
    }
  }
  const due = await withLocales(deps.locales, await deps.state.dueChanges(deps.now, APPLY_BATCH));
  let applied = 0;
  for (const c of due) {
    // The object re-checks that the change is still pending and due, and
    // applies it only while the chat it moves away from is still linked.
    const r = await deps.state.applyChange(c.id, deps.now);
    if (!r?.applied) continue;
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
  await deps.state.pruneClosed(deps.now);
  return applied;
}
