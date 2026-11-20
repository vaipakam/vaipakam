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
import { channelCopy, handshakeLinked, phraseCopy } from './i18n';

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
  /** #3346 — a Push notice to `wallet`, when it gets Push alerts, that its
   *  Telegram alert chat on `chainId` changed. Best effort; absent in tests
   *  and where the agent has no Push rail. */
  pushChange?: (wallet: string, chainId: number) => Promise<void>;
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
  if ((await sendMarked(deps, oldChatId, wallet, chains.map((c) => c.chainId), locale, text)) !== 'accepted') {
    await deps.state.markNoticeAttempt(ids, deps.now);
    return false;
  }
  await deps.state.markNotified(ids, deps.now);
  // The new chat is not linked yet, so it is not shown the phrase (#3346).
  if (newChat) await deps.send(newChat.chatId, channelCopy.moveIncoming(newChat.locale, entries, when));
  return true;
}

/** How often a notice Telegram did not accept is tried again: a chat-change
 *  notice for up to an hour (`CHAT_NOTICE_TTL_SECONDS`), a phrase notice
 *  until it is accepted. */
export const SHORT_NOTICE_RETRY_SECONDS = 10 * 60;

/** One #3346 notice to a chat about a change that needed no wait. */
interface ChatNotice {
  chatId: string;
  kind: 'unlink' | 'replace' | 'added';
  wallet: string;
  chainIds: number[];
  locale: string;
  /** What the chat was last told of the wallet's phrase on each of
   *  `chainIds`, read BEFORE the change (after it, a chat no longer linked
   *  has forgotten it). */
  phrases: (string | null)[];
}

function chatNoticeText(n: ChatNotice): string {
  const entries = n.chainIds.map((chainId) => ({ walletShort: shortWallet(n.wallet), chainId }));
  const body =
    n.kind === 'unlink'
      ? channelCopy.removalNow(n.locale, entries)
      : n.kind === 'replace'
        ? channelCopy.moveNow(n.locale, entries)
        : channelCopy.addedNow(n.locale, entries);
  return phraseCopy.mark(n.locale, n.phrases, body);
}

/**
 * #3346 — the ops that queue `notices`, one per (chat, network), to go in
 * the same commit as the change they report: a notice exists exactly when
 * its change does, so a failure after the commit cannot leave a chat
 * untold, and a commit that writes nothing queues nothing.
 */
function chatNoticeOps(notices: readonly ChatNotice[]): ChannelOp[] {
  return notices.flatMap((n) =>
    n.chainIds.map((chainId, i) => ({ op: 'chatNotice', chatId: n.chatId, chainId, kind: n.kind, phrase: n.phrases[i] ?? null }) as const),
  );
}

/**
 * #3346 — tell chats about a change that took effect at once (an unprotected
 * account's unlink or move, or another chat linked for the wallet): nothing
 * told them beforehand. The commit that made the change queued each notice
 * ({@link chatNoticeOps}); `noticeIds` are its ids, in op order. Each is
 * tried once now and retried by the tick for up to an hour; the record (and
 * the chat id in it) goes once it is accepted or dropped. The change stands
 * either way.
 */
async function tellChats(deps: ChannelDeps, notices: readonly ChatNotice[], noticeIds: readonly number[]): Promise<void> {
  let next = 0;
  for (const n of notices) {
    const ids = noticeIds.slice(next, next + n.chainIds.length);
    next += n.chainIds.length;
    if (ids.length === 0 || !deps.send) continue;
    const accepted = (await deps.send(n.chatId, chatNoticeText(n))) === 'accepted';
    for (const id of ids) await deps.state.chatNoticeSent(id, accepted, deps.now);
  }
}

/** The phrase line each chat would carry for `wallet`, read now. */
async function marksOf(
  deps: ChannelDeps,
  wallet: string,
  pairs: readonly { chatId: string; chainId: number }[],
): Promise<Map<string, string | null>> {
  const unique = [...new Map(pairs.map((p) => [markKey(p.chatId, p.chainId), p])).values()];
  const marks = unique.length > 0 ? await deps.state.phraseMarksOf(unique.map((p) => ({ wallet, chatId: p.chatId, chainId: p.chainId }))) : [];
  return new Map(unique.map((p, i) => [markKey(p.chatId, p.chainId), marks[i] ?? null]));
}

/** The key {@link marksOf} files a (chat, network) pair's phrase under. */
function markKey(chatId: string, chainId: number): string {
  return `${chatId}|${chainId}`;
}

/**
 * #3346 — send `text` to `chatId`, a chat linked for `wallet`, led by the
 * phrase that chat was last told (none for a group, or a chat not yet told).
 * A chat still waiting to take over is not linked, so it is never shown one.
 * `refused` when no bot can send.
 */
async function sendMarked(
  deps: ChannelDeps,
  chatId: string,
  wallet: string,
  chainIds: readonly number[],
  locale: string,
  text: string,
): Promise<SendOutcome> {
  if (!deps.send) return 'refused';
  const phrases = await deps.state.phraseMarksOf(chainIds.map((chainId) => ({ wallet, chatId, chainId })));
  return deps.send(chatId, phraseCopy.mark(locale, phrases, text));
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
 *
 * `issuedAt` is when the wallet signed the request (#3836). The commit
 * applies it only when no later-signed link or unlink request was applied
 * to its scope, and raises the scope's mark in the same step: an unlink for
 * every chain raises the mark on every chain. 'superseded' means nothing
 * was changed.
 */
export async function requestUnlink(
  deps: ChannelDeps,
  wallet: string,
  chainId: number | null,
  issuedAt: number,
): Promise<{ kind: 'done'; pending: PendingReport[] } | { kind: 'unknown' } | { kind: 'superseded' }> {
  const w = wallet.toLowerCase();
  for (let attempt = 0; attempt < DECIDE_ATTEMPTS; attempt++) {
    const { observed, rows } = await linkedRows(deps.state, deps.locales, w, chainId);
    const delays = rows.length > 0 ? await protectionByRow(deps.read, w, rows) : new Map<number, number | null>();
    if (delays === null) return { kind: 'unknown' };
    const waiting = rows.filter((r) => delays.get(r.chainId) != null);
    const open = rows.filter((r) => delays.get(r.chainId) == null);
    // #3346 — what each chat cleared at once was told of the phrase, read
    // before the commit makes it forget. The rows cleared at once had no
    // earlier notice, so each chat is told it no longer gets them.
    const marks = await marksOf(deps, w, open.map((r) => ({ chatId: r.chatId, chainId: r.chainId })));
    const notices: ChatNotice[] = [...groupBy(open, (r) => r.chatId).values()].map((list) => ({
      chatId: list[0]!.chatId,
      kind: 'unlink' as const,
      wallet: w,
      chainIds: list.map((r) => r.chainId),
      locale: list[0]!.locale,
      phrases: list.map((r) => marks.get(markKey(r.chatId, r.chainId)) ?? null),
    }));
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
      ...chatNoticeOps(notices),
    ];
    const result = await deps.state.commit(w, chainId, observed, ops, deps.now, { issuedAt, scope: chainId });
    // A later-signed request was already applied: nothing was written.
    if (!result.ok && result.superseded) return { kind: 'superseded' };
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
    // Best effort: the unlink stands, and the tick retries.
    await tellChats(deps, notices, result.noticeIds);
    for (const r of open) await deps.pushChange?.(w, r.chainId);
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
  const immediate = async (notices: readonly ChatNotice[] = []): Promise<'linked' | 'moved'> => {
    const r = await deps.state.commit(
      w,
      chainId,
      observed,
      [{ op: 'supersede', chainId }, { op: 'link', chainId, chatId: newChatId }, ...chatNoticeOps(notices)],
      deps.now,
    );
    if (!r.ok) return 'moved';
    await tellChats(deps, notices, r.noticeIds);
    return 'linked';
  };
  const [current] = rows;
  /** Link now and (#3346) tell the chats that were not asked: the chat this
   *  replaces, if any, and every other chat linked for the wallet. */
  const linkAndTell = async (): Promise<'linked' | 'moved'> => {
    if (current?.chatId === newChatId) return immediate();
    const all = (await linkedRows(deps.state, deps.locales, w, null)).rows;
    const others = all.filter((r) => r.chatId !== newChatId && r.chatId !== current?.chatId);
    const marks = await marksOf(
      deps,
      w,
      [...(current ? [current.chatId] : []), ...others.map((r) => r.chatId)].map((chatId) => ({ chatId, chainId })),
    );
    const notices: ChatNotice[] = [];
    if (current) {
      notices.push({ chatId: current.chatId, kind: 'replace', wallet: w, chainIds: [chainId], locale: current.locale, phrases: [marks.get(markKey(current.chatId, chainId)) ?? null] });
    }
    for (const list of groupBy(others, (r) => r.chatId).values()) {
      notices.push({ chatId: list[0]!.chatId, kind: 'added', wallet: w, chainIds: [chainId], locale: list[0]!.locale, phrases: [marks.get(markKey(list[0]!.chatId, chainId)) ?? null] });
    }
    const outcome = await immediate(notices);
    if (outcome !== 'linked') return outcome;
    await deps.pushChange?.(w, chainId);
    return outcome;
  };
  if (!current || current.chatId === newChatId) return linkAndTell();
  const delays = await protectionByRow(deps.read, w, [current]);
  if (delays === null) {
    await deps.send?.(newChatId, channelCopy.protectionUnknown(locale));
    return 'unknown';
  }
  const delay = delays.get(chainId);
  if (delay == null) return linkAndTell();
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
  if (cancelled.length === 0) {
    await deps.send?.(chatId, channelCopy.cancelNone(locale));
  } else if (deps.send) {
    const text = channelCopy.cancelDone(
      locale,
      cancelled.map((c) => ({ walletShort: shortWallet(c.wallet), chainId: c.chainId })),
    );
    // The chat stays linked for every wallet it cancelled for (#3346).
    const phrases = await deps.state.phraseMarksOf(cancelled.map((c) => ({ wallet: c.wallet, chatId, chainId: c.chainId })));
    await deps.send(chatId, phraseCopy.mark(locale, phrases, text));
  }
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
    // #3346 — what the old chat was told, read before the change makes it
    // forget, so the notice that it no longer gets alerts carries it.
    const [oldPhrase] = await deps.state.phraseMarksOf([{ wallet: c.wallet, chatId: c.oldChatId, chainId: c.chainId }]);
    const r = await deps.state.applyChange(c.id, deps.now);
    if (!r?.applied) continue;
    applied += 1;
    if (!deps.send) continue;
    const entries = [{ walletShort: shortWallet(c.wallet), chainId: c.chainId }];
    if (c.kind === 'unlink') {
      await deps.send(c.oldChatId, phraseCopy.mark(c.locale, [oldPhrase ?? null], channelCopy.removalApplied(c.locale, entries)));
    } else {
      await deps.send(c.oldChatId, phraseCopy.mark(c.locale, [oldPhrase ?? null], channelCopy.moveApplied(c.locale, entries)));
      // Linked now, so it gets the phrase like every chat that is (#3346).
      if (c.newChatId) await sendMarked(deps, c.newChatId, c.wallet, [c.chainId], c.locale, handshakeLinked(c.locale, shortWallet(c.wallet), c.chainId));
    }
  }
  await retryChatNotices(deps);
  await sendPhraseNotices(deps);
  await deps.state.pruneClosed(deps.now);
  return applied;
}

/** #3346 — retry the chat-change notices Telegram has not accepted yet; the
 *  store drops any older than an hour. */
async function retryChatNotices(deps: ChannelDeps): Promise<void> {
  const due = await deps.state.dueChatNotices(deps.now - SHORT_NOTICE_RETRY_SECONDS, deps.now, APPLY_BATCH);
  if (!deps.send || due.length === 0) return;
  const locales = await deps.locales(due.map((n) => ({ wallet: n.wallet, chainId: n.chainId })));
  const groups = groupBy(
    due.map((n, i) => ({ ...n, locale: locales[i] ?? 'en' })),
    (n) => `${n.chatId}|${n.wallet}|${n.kind}|${n.phrase ?? ''}|${n.locale}`,
  );
  for (const list of groups.values()) {
    const first = list[0]!;
    const notice: ChatNotice = {
      chatId: first.chatId,
      kind: first.kind,
      wallet: first.wallet,
      chainIds: list.map((n) => n.chainId),
      locale: first.locale,
      phrases: list.map((n) => n.phrase),
    };
    const accepted = (await deps.send(first.chatId, chatNoticeText(notice))) === 'accepted';
    for (const n of list) await deps.state.chatNoticeSent(n.id, accepted, deps.now);
  }
}

/**
 * #3346 — send the phrase notices due: to each private chat linked for a
 * wallet whose phrase changed, led by the phrase that chat was last told and
 * stating the phrase now in force (or that it was removed). The chat moves to
 * the new phrase only once Telegram accepted the notice; until then the tick
 * tries again, and the chat's messages keep the phrase it was last told.
 */
export async function sendPhraseNotices(deps: ChannelDeps): Promise<void> {
  if (!deps.send) return;
  const due = await deps.state.duePhraseNotices(deps.now - SHORT_NOTICE_RETRY_SECONDS, APPLY_BATCH);
  for (const n of due) {
    if (n.chainIds.length === 0) continue;
    const [locale] = await deps.locales([{ wallet: n.wallet, chainId: n.chainIds[0]! }]);
    // The lock advice only where the account can be locked; a read that
    // failed gives the plain advice.
    let protectedAccount = false;
    for (const chainId of n.chainIds) {
      const p = await deps.read(n.wallet, chainId);
      if (p?.enabled) protectedAccount = true;
    }
    const entries = n.chainIds.map((chainId) => ({ walletShort: shortWallet(n.wallet), chainId }));
    const text = phraseCopy.mark(locale, n.told, phraseCopy.changed(locale, entries, n.target, protectedAccount));
    const accepted = (await deps.send(n.chatId, text)) === 'accepted';
    await deps.state.phraseNoticeSent(n.wallet, n.chatId, n.chainId, n.id, accepted, deps.now);
  }
}
