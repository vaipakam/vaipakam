/**
 * #3246 — removing a Telegram alert chat waits while protected mode is on.
 *
 * Protected account mode makes every payout wait a delay; its alerts are how
 * the owner sees a payout or a loosening change in time to lock the vault,
 * from the app or with the Telegram LOCK command. A thief holding only the
 * owner key could otherwise silence them first, by unlinking the chat or by
 * linking their own chat in its place. So, for a (wallet, chain) row whose
 * account is protected on that chain:
 *
 *   - an unlink, or a handshake from a DIFFERENT chat, is recorded as a
 *     pending change (in the agent's Telegram state object, #1722);
 *   - its wait (the account's own delay) STARTS ONLY ONCE THE CHAT LINKED NOW
 *     HAS ACCEPTED THE NOTICE about it. A notice Telegram did not accept is
 *     retried by the scheduled tick, and until one is accepted the change
 *     never becomes due, so an outage cannot let a removal pass unseen;
 *   - that chat keeps every alert until the change applies, and may reply
 *     CANCEL (or lock the vault);
 *   - the scheduled tick applies a change once it is due;
 *   - any immediate change to the row (an unprotected unlink or link)
 *     supersedes a pending one, and a move applies only while the chat it
 *     moves away from is still the linked one.
 *
 * Adding a chat where none is linked, re-linking the same chat, and every
 * change for an account that is not protected stay immediate. When the
 * protection status cannot be read, nothing is removed: the request is
 * refused and the owner is asked to try again (fail closed toward keeping
 * alerts on).
 *
 * The agent signs nothing and moves no funds here; this is only who receives
 * alerts.
 */
import { createPublicClient, http, type Address } from 'viem';
import { ProtectedAccountFacetABI } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { getChainConfigs, type Env } from './env';
import type {
  ChannelOp,
  CommitResult,
  LinkedRow as StoreLinkedRow,
  PendingChange as StorePendingChange,
} from './telegramState/store';

/** One (wallet, chain) with a chat linked, and the locale its notices use. */
export interface LinkedRow {
  chainId: number;
  chatId: string;
  locale: string;
}

/** One chain's read: null when it could not be read. */
export type ProtectionReader = (
  wallet: string,
  chainId: number,
) => Promise<{ enabled: boolean; delaySeconds: number } | null>;

/** A pending change, as the tick and the notices need it. */
export interface PendingChange {
  id: number;
  wallet: string;
  chainId: number;
  kind: 'unlink' | 'replace';
  oldChatId: string;
  newChatId: string | null;
  delaySeconds: number;
  /** Null until the old chat accepted the notice; then notice time + delay. */
  effectiveAt: number | null;
  /** The row's locale, for the notices. */
  locale: string;
}

/** Longest protected delay the contracts allow (`LibProtectedAccount.MAX_DELAY`).
 *  A read above it is not trusted and is clamped, so a misread can never hold a
 *  change for longer than the account could. */
export const MAX_PROTECTED_DELAY_SECONDS = 5 * 24 * 60 * 60;

/** Most due changes one tick applies; the rest wait for the next tick. */
export const APPLY_BATCH = 50;

/** The default reader: `getProtectedAccount` on the chain's Diamond. A
 *  chain with no Diamond reads as not protected; an unreadable one as null. */
export function chainProtectionReader(env: Env): ProtectionReader {
  const chains = new Map(getChainConfigs(env).map((c) => [c.id, c]));
  return async (wallet, chainId) => {
    // A chain with no Vaipakam Diamond has no protected accounts at all, so a
    // row left on it is not protected. A chain WITH a Diamond that this agent
    // cannot read (no RPC bound, or the read fails) is unknown: fail closed.
    if (!getDeployment(chainId)) return { enabled: false, delaySeconds: 0 };
    const chain = chains.get(chainId);
    if (!chain) return null;
    try {
      const client = createPublicClient({ transport: http(chain.rpc) });
      const a = (await client.readContract({
        address: chain.diamond as Address,
        abi: ProtectedAccountFacetABI,
        functionName: 'getProtectedAccount',
        args: [wallet as Address],
      })) as { enabled: boolean; delaySeconds: number | bigint };
      return { enabled: Boolean(a.enabled), delaySeconds: Number(a.delaySeconds) };
    } catch {
      return null;
    }
  };
}

/** Per-row protection: which of `rows` are protected, and each one's delay.
 *  Null when any row's chain could not be read. */
export async function protectionByRow(
  read: ProtectionReader,
  wallet: string,
  rows: readonly LinkedRow[],
): Promise<Map<number, number | null> | null> {
  const out = new Map<number, number | null>();
  for (const row of rows) {
    const r = await read(wallet, row.chainId);
    if (r === null) return null;
    out.set(
      row.chainId,
      r.enabled ? Math.min(Math.max(r.delaySeconds, 0), MAX_PROTECTED_DELAY_SECONDS) : null,
    );
  }
  return out;
}

// ─── Storage ─────────────────────────────────────────────────────────
//
// The rows live in the agent's Telegram state object (#1722,
// `telegramState/`); the flows reach it through {@link TelegramStatePort},
// which the object's stub satisfies and the tests satisfy with the same store
// on Node's SQLite. The locale a notice is written in stays on the shared
// `user_thresholds` row (the owner's display preference), read through
// {@link LocaleReader}.

/** The Telegram state the flows use: the object's RPC methods. */
export interface TelegramStatePort {
  linkedRows(wallet: string, chainId: number | null): Promise<StoreLinkedRow[]>;
  linksOfChat(chatId: string): Promise<{ wallet: string; chainId: number }[]>;
  commit(wallet: string, chainId: number | null, observed: StoreLinkedRow[], ops: ChannelOp[], now: number): Promise<CommitResult>;
  markNotified(ids: number[], now: number): Promise<void>;
  markNoticeAttempt(ids: number[], now: number): Promise<void>;
  unnotifiedChanges(retryBefore: number, limit: number): Promise<StorePendingChange[]>;
  dueChanges(now: number, limit: number): Promise<StorePendingChange[]>;
  cancelPendingForChat(chatId: string, now: number): Promise<{ wallet: string; chainId: number; kind: 'unlink' | 'replace' }[]>;
  applyChange(id: number, now: number): Promise<{ change: StorePendingChange; applied: boolean } | null>;
  pruneClosed(now: number): Promise<void>;
}

/** The locale of each (wallet, chain), in input order ('en' when none). */
export type LocaleReader = (pairs: readonly { wallet: string; chainId: number }[]) => Promise<string[]>;

/** The production reader: the shared `user_thresholds` row. A failed read is
 *  English, never a lost notice. */
export function d1LocaleReader(db: D1Database): LocaleReader {
  return async (pairs) => {
    const out: string[] = [];
    for (const p of pairs) {
      try {
        const row = await db
          .prepare(`SELECT locale FROM user_thresholds WHERE wallet = ? AND chain_id = ?`)
          .bind(p.wallet.toLowerCase(), p.chainId)
          .first<{ locale: string | null }>();
        out.push(row?.locale ?? 'en');
      } catch {
        out.push('en');
      }
    }
    return out;
  };
}

/** The rows of `wallet` with a chat linked, each with its locale. */
export async function linkedRows(
  state: TelegramStatePort,
  locales: LocaleReader,
  wallet: string,
  chainId: number | null,
): Promise<{ observed: StoreLinkedRow[]; rows: LinkedRow[] }> {
  const observed = await state.linkedRows(wallet, chainId);
  const loc = await locales(observed.map((r) => ({ wallet, chainId: r.chainId })));
  return { observed, rows: observed.map((r, i) => ({ ...r, locale: loc[i] ?? 'en' })) };
}

/** Pending changes with the locale each notice is written in. */
export async function withLocales(locales: LocaleReader, changes: readonly StorePendingChange[]): Promise<PendingChange[]> {
  const loc = await locales(changes.map((c) => ({ wallet: c.wallet, chainId: c.chainId })));
  return changes.map((c, i) => ({ ...c, locale: loc[i] ?? 'en' }));
}

/** The locale for a reply to a chat: that of its first linked row. */
export async function chatLocale(state: TelegramStatePort, locales: LocaleReader, chatId: string): Promise<string> {
  const [first] = await state.linksOfChat(chatId);
  if (!first) return 'en';
  return (await locales([first]))[0] ?? 'en';
}

/** A unix time as the notices print it: `2026-11-09 11:40 UTC`. */
export function formatUtc(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `0x12345678…abcdef`, as the other notices print a wallet. */
export function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 8)}…${wallet.slice(-6)}`;
}
