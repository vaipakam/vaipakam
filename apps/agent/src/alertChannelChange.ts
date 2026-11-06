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
 *     pending change (`alert_channel_changes`) that takes effect after the
 *     account's own delay;
 *   - the chat linked now keeps every alert until then, is told at once, and
 *     may reply CANCEL (or LOCK);
 *   - the scheduled tick applies a change once it is due.
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

/** One `user_thresholds` row with a chat linked. */
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
  effectiveAt: number;
  /** The row's locale, for the notices. */
  locale: string;
}

/** Longest protected delay the contracts allow (`LibProtectedAccount.MAX_DELAY`).
 *  A read above it is not trusted and is clamped, so a misread can never hold a
 *  change for longer than the account could. */
export const MAX_PROTECTED_DELAY_SECONDS = 5 * 24 * 60 * 60;

/** Most due changes one tick applies; the rest wait for the next tick. */
export const APPLY_BATCH = 50;

/** Closed rows are kept this long for the record, then pruned. */
export const CLOSED_RETENTION_SECONDS = 90 * 24 * 60 * 60;

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

/** The rows of `wallet` with a chat linked, on `chainId` or on every chain. */
export async function linkedRows(
  db: D1Database,
  wallet: string,
  chainId: number | null,
): Promise<LinkedRow[]> {
  const w = wallet.toLowerCase();
  const stmt =
    chainId === null
      ? db
          .prepare(
            `SELECT chain_id, tg_chat_id, locale FROM user_thresholds
              WHERE wallet = ? AND tg_chat_id IS NOT NULL ORDER BY chain_id`,
          )
          .bind(w)
      : db
          .prepare(
            `SELECT chain_id, tg_chat_id, locale FROM user_thresholds
              WHERE wallet = ? AND chain_id = ? AND tg_chat_id IS NOT NULL`,
          )
          .bind(w, chainId);
  const res = await stmt.all<{ chain_id: number; tg_chat_id: string; locale: string | null }>();
  return (res.results ?? []).map((r) => ({
    chainId: Number(r.chain_id),
    chatId: String(r.tg_chat_id),
    locale: r.locale ?? 'en',
  }));
}

/** Record a pending change for one row, superseding any pending one for the
 *  same (wallet, chain). Returns when it takes effect. */
export function pendingChangeStatements(
  db: D1Database,
  wallet: string,
  chainId: number,
  kind: 'unlink' | 'replace',
  oldChatId: string,
  newChatId: string | null,
  now: number,
  effectiveAt: number,
): D1PreparedStatement[] {
  const w = wallet.toLowerCase();
  return [
    db
      .prepare(
        `UPDATE alert_channel_changes SET state = 'superseded', closed_at = ?
          WHERE wallet = ? AND chain_id = ? AND state = 'pending'`,
      )
      .bind(now, w, chainId),
    db
      .prepare(
        `INSERT INTO alert_channel_changes
           (wallet, chain_id, kind, old_chat_id, new_chat_id, requested_at, effective_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .bind(w, chainId, kind, oldChatId, newChatId, now, effectiveAt),
  ];
}

/** Cancel every pending change whose chat being removed is `chatId`. Only
 *  that chat may cancel: it is the one the change would silence. */
export async function cancelPendingForChat(
  db: D1Database,
  chatId: string,
  now: number,
): Promise<{ wallet: string; chainId: number; kind: 'unlink' | 'replace' }[]> {
  const res = await db
    .prepare(
      `UPDATE alert_channel_changes SET state = 'cancelled', closed_at = ?
        WHERE old_chat_id = ? AND state = 'pending'
        RETURNING wallet, chain_id, kind`,
    )
    .bind(now, chatId)
    .all<{ wallet: string; chain_id: number; kind: 'unlink' | 'replace' }>();
  return (res.results ?? []).map((r) => ({ wallet: r.wallet, chainId: Number(r.chain_id), kind: r.kind }));
}

/** The pending changes due at `now`, oldest first. */
export async function dueChanges(db: D1Database, now: number, limit = APPLY_BATCH): Promise<PendingChange[]> {
  const res = await db
    .prepare(
      `SELECT c.id, c.wallet, c.chain_id, c.kind, c.old_chat_id, c.new_chat_id, c.effective_at, t.locale
         FROM alert_channel_changes c
         LEFT JOIN user_thresholds t ON t.wallet = c.wallet AND t.chain_id = c.chain_id
        WHERE c.state = 'pending' AND c.effective_at <= ?
        ORDER BY c.effective_at, c.id LIMIT ?`,
    )
    .bind(now, limit)
    .all<{
      id: number;
      wallet: string;
      chain_id: number;
      kind: 'unlink' | 'replace';
      old_chat_id: string;
      new_chat_id: string | null;
      effective_at: number;
      locale: string | null;
    }>();
  return (res.results ?? []).map((r) => ({
    id: Number(r.id),
    wallet: r.wallet,
    chainId: Number(r.chain_id),
    kind: r.kind,
    oldChatId: r.old_chat_id,
    newChatId: r.new_chat_id,
    effectiveAt: Number(r.effective_at),
    locale: r.locale ?? 'en',
  }));
}

/** Apply one due change, atomically with marking it applied. Returns false
 *  when it was no longer pending (cancelled or applied meanwhile). */
export async function applyChange(db: D1Database, c: PendingChange, now: number): Promise<boolean> {
  // The mark goes first and the row updates are guarded on it, so a change
  // cancelled between the read and this batch changes nothing.
  const applied = `EXISTS (SELECT 1 FROM alert_channel_changes WHERE id = ? AND state = 'applied' AND closed_at = ?)`;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE alert_channel_changes SET state = 'applied', closed_at = ? WHERE id = ? AND state = 'pending'`)
      .bind(now, c.id),
  ];
  if (c.kind === 'unlink') {
    // Only the chat the change was asked about: a chat linked since then by
    // an immediate path is not this change's to remove.
    stmts.push(
      db
        .prepare(
          `UPDATE user_thresholds SET tg_chat_id = NULL, updated_at = ?
            WHERE wallet = ? AND chain_id = ? AND tg_chat_id = ? AND ${applied}`,
        )
        .bind(now, c.wallet, c.chainId, c.oldChatId, c.id, now),
      // As the immediate unlink does: an unexpired handshake code for the row
      // could otherwise re-link it at once.
      db
        .prepare(`DELETE FROM telegram_links WHERE wallet = ? AND chain_id = ? AND ${applied}`)
        .bind(c.wallet, c.chainId, c.id, now),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `UPDATE user_thresholds SET tg_chat_id = ?, updated_at = ?
            WHERE wallet = ? AND chain_id = ? AND ${applied}`,
        )
        .bind(c.newChatId, now, c.wallet, c.chainId, c.id, now),
    );
  }
  const results = await db.batch(stmts);
  return Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) > 0;
}

/** Drop closed rows older than the retention window. */
export async function pruneClosedChanges(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(`DELETE FROM alert_channel_changes WHERE state <> 'pending' AND closed_at < ?`)
    .bind(now - CLOSED_RETENTION_SECONDS)
    .run();
}

/** The locale stored for a chat's linked rows, for a reply to that chat. */
export async function chatLocale(db: D1Database, chatId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT locale FROM user_thresholds WHERE tg_chat_id = ? AND locale IS NOT NULL LIMIT 1`)
    .bind(chatId)
    .first<{ locale: string }>();
  return row?.locale ?? 'en';
}

/** A unix time as the notices print it: `2026-11-09 11:40 UTC`. */
export function formatUtc(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `0x12345678…abcdef`, as the other notices print a wallet. */
export function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 8)}…${wallet.slice(-6)}`;
}
