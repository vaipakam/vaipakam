/**
 * #1722 — the agent's Telegram link and LOCK steps, over its Telegram state
 * object (`telegramState/`). These replaced the shared-database helpers in
 * `db.ts`: the rows they read and write are reachable only through this
 * Worker's code, never through a D1 binding or token.
 *
 * Each step takes the state (the object's stub, or the store in tests) and,
 * where it answers a chat, the locale reader: the language is the owner's
 * display preference and stays on the shared `user_thresholds` row.
 */
import { lockRequestIsStale } from '@vaipakam/lib/protectedLock';
import type { LocaleReader } from './alertChannelChange';
import type { ChainDeployment, LockLink, PendingChange, UnansweredLock, LockRequest } from './telegramState/store';
import { lockUnanswered } from './i18n';
import { newLinkCode, type TelegramOutcome } from './telegram';
import { shortWallet } from './alertChannelChange';

/** A keeper poll older than this means no keeper is working LOCK requests on
 *  that chain now: the request is not recorded, and the owner is told to lock
 *  from the app instead. The keeper polls every run. */
export const LOCK_READINESS_FRESH_SEC = 5 * 60;

/** How long a handshake code stays good. */
export const LINK_CODE_TTL_SEC = 600;

/** The state methods these steps use. */
export interface LinkStatePort {
  issueLinkCode(code: string, wallet: string, chainId: number, expiresAt: number): Promise<boolean>;
  consumeLinkCode(code: string, now: number): Promise<{ wallet: string; chainId: number } | null>;
  chatsOf(pairs: { wallet: string; chainId: number }[]): Promise<(string | null)[]>;
  recordLockRequests(
    chatId: string,
    updateId: number,
    requestedAt: number | null,
    freshFrom: number,
    diamonds: Record<number, string>,
  ): Promise<LockLink[]>;
}

/** The keeper-facing state methods (`keeperRoutes.ts`). */
export interface KeeperStatePort {
  keeperPoll(dep: ChainDeployment, now: number, limit: number): Promise<LockRequest[]>;
  pendingLockWallets(dep: ChainDeployment, since: number): Promise<string[]>;
  markLockHandled(dep: ChainDeployment, wallet: string, upToId: number, outcome: string, at: number): Promise<{ chatId: string | null } | undefined>;
  takeUnansweredLocks(sentBefore: number, now: number, limit: number): Promise<UnansweredLock[]>;
  chatsOf(pairs: { wallet: string; chainId: number }[]): Promise<(string | null)[]>;
}

/** A recorded LOCK no keeper has answered within this long gets one warning
 *  in its chat: the owner may be counting on a lock that has not happened. */
export const LOCK_UNANSWERED_SEC = 60 * 60;
/** Warnings sent per tick. */
export const LOCK_UNANSWERED_BATCH = 20;

export type { PendingChange };

/** Issue a handshake code for (`wallet`, `chainId`), good for ten minutes.
 *  The code is the 120-bit `newLinkCode()` (#2753), so a collision is not a
 *  practical event; one retry stays so a clash reads as a retry, never as a
 *  failed link.
 *
 *  `ensureRow` makes the wallet's `user_thresholds` row first, the row the
 *  keeper's watchers and the pre-notify lane find a wallet through. It runs
 *  BEFORE any code exists and its failure throws, so no code is issued for a
 *  wallet whose alerts would have nowhere to start from: the handshake's
 *  "alerts will arrive" is never sent for a link nothing would serve (#1722,
 *  Codex #3571 r1). */
export async function issueTelegramLinkCode(
  state: LinkStatePort,
  ensureRow: (wallet: string, chainId: number) => Promise<void>,
  wallet: string,
  chainId: number,
  now: number,
): Promise<string> {
  await ensureRow(wallet, chainId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = newLinkCode();
    if (await state.issueLinkCode(code, wallet, chainId, now + LINK_CODE_TTL_SEC)) return code;
  }
  throw new Error('link code collision twice');
}

/** Consume a handshake code: good once, and only before it expires. Returns
 *  the linked wallet and chain with the owner's locale, or null. */
export async function consumeTelegramLinkCode(
  state: LinkStatePort,
  locales: LocaleReader,
  code: string,
  now: number,
): Promise<{ wallet: string; chainId: number; locale: string } | null> {
  const match = await state.consumeLinkCode(code, now);
  if (!match) return null;
  const [locale] = await locales([match]);
  return { ...match, locale: locale ?? 'en' };
}

/** The chat linked to (`wallet`, `chainId`) and its locale, or null. */
export async function getTelegramChatId(
  state: LinkStatePort,
  locales: LocaleReader,
  wallet: string,
  chainId: number,
): Promise<{ chatId: string; locale: string } | null> {
  const [chatId] = await state.chatsOf([{ wallet: wallet.toLowerCase(), chainId }]);
  if (!chatId) return null;
  const [locale] = await locales([{ wallet, chainId }]);
  return { chatId, locale: locale ?? 'en' };
}

/**
 * #3088 — record a Telegram LOCK from `chatId` for every wallet and chain the
 * chat is linked to on which a keeper is working LOCK requests now (it polled
 * within {@link LOCK_READINESS_FRESH_SEC}), and return every link with whether
 * it was recorded. The keeper takes the open requests through its route and
 * makes the lock call; the agent signs nothing. A redelivered update records
 * nothing new.
 *
 * The request carries the time the owner SENT the LOCK (the Telegram
 * message's own date), never the time it reached the webhook, so the keeper's
 * age limit measures the request the owner made. A LOCK already past that
 * limit, or with no send time, records nothing: the links come back
 * unrecorded and the caller says why. A send time a little ahead of this
 * clock is recorded as now, so clock skew never extends the age limit.
 */
export async function recordLockRequests(
  state: LinkStatePort,
  locales: LocaleReader,
  chatId: string,
  updateId: number,
  sentAt: number | null,
  nowSec: number,
  diamonds: Record<number, string>,
): Promise<{ wallet: string; chainId: number; locale: string; recorded: boolean }[]> {
  const requestedAt = lockRequestIsStale(sentAt, nowSec) ? null : Math.min(sentAt as number, nowSec);
  const links = await state.recordLockRequests(chatId, updateId, requestedAt, nowSec - LOCK_READINESS_FRESH_SEC, diamonds);
  const loc = await locales(links);
  return links.map((l, i) => ({ ...l, locale: loc[i] ?? 'en' }));
}

/**
 * #1722 — warn each chat whose recorded LOCK has had no answer from a keeper
 * for {@link LOCK_UNANSWERED_SEC}: the keeper polled when the LOCK was
 * recorded, then stopped (or cannot reach the agent), and the owner would
 * otherwise wait for a lock that never comes. Each request is warned once;
 * the store marks it before the send, so a failed send is not retried and
 * a retried tick never warns twice. Returns the warnings accepted.
 */
export async function warnUnansweredLocks(
  state: Pick<KeeperStatePort, 'takeUnansweredLocks'>,
  locales: LocaleReader,
  send: ((chatId: string, text: string) => Promise<TelegramOutcome>) | null,
  nowSec: number,
): Promise<number> {
  // Without a bot token nothing can be said, so nothing is taken: the
  // requests stay unwarned for a tick that can send.
  if (!send) return 0;
  const due = await state.takeUnansweredLocks(nowSec - LOCK_UNANSWERED_SEC, nowSec, LOCK_UNANSWERED_BATCH);
  if (due.length === 0) return 0;
  const loc = await locales(due);
  let sent = 0;
  for (let i = 0; i < due.length; i++) {
    const u = due[i]!;
    const outcome = await send(u.chatId, lockUnanswered(loc[i] ?? 'en', shortWallet(u.wallet), u.chainId));
    if (outcome === 'accepted') sent++;
  }
  return sent;
}
