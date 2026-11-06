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
 *     pending change (`alert_channel_changes`);
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

/** Statements that record a pending change for one row, superseding any
 *  pending one for the same (wallet, chain). Its wait has not started: that
 *  needs the old chat to accept the notice ({@link markNotified}). */
export function pendingChangeStatements(
  db: D1Database,
  wallet: string,
  chainId: number,
  kind: 'unlink' | 'replace',
  oldChatId: string,
  newChatId: string | null,
  now: number,
  delaySeconds: number,
): D1PreparedStatement[] {
  const w = wallet.toLowerCase();
  return [
    supersedeStatement(db, w, chainId, now),
    db
      .prepare(
        `INSERT INTO alert_channel_changes
           (wallet, chain_id, kind, old_chat_id, new_chat_id, requested_at, delay_seconds, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
         RETURNING id`,
      )
      .bind(w, chainId, kind, oldChatId, newChatId, now, delaySeconds),
  ];
}

/** Supersede the pending change of (wallet, chain), or of every chain of the
 *  wallet when `chainId` is null. Every immediate change to a row runs it, so
 *  an older request can never undo a later unlink or link. */
export function supersedeStatement(
  db: D1Database,
  wallet: string,
  chainId: number | null,
  now: number,
): D1PreparedStatement {
  const w = wallet.toLowerCase();
  return chainId === null
    ? db
        .prepare(`UPDATE alert_channel_changes SET state = 'superseded', closed_at = ? WHERE wallet = ? AND state = 'pending'`)
        .bind(now, w)
    : db
        .prepare(
          `UPDATE alert_channel_changes SET state = 'superseded', closed_at = ?
            WHERE wallet = ? AND chain_id = ? AND state = 'pending'`,
        )
        .bind(now, w, chainId);
}

/**
 * The first statement of a batch whose writes were decided on `observed`, the
 * linked rows of `wallet` in scope (`chainId` null = every chain) as read just
 * before. It FAILS when the rows in scope are no longer exactly `observed`
 * (a chat linked, changed or cleared meanwhile), and a D1 batch is one
 * transaction, so a failure rolls every write of it back: the caller then
 * reads again and decides again. This is what makes a decision and its writes
 * one atomic step, so a concurrent link can never be cleared, or a moved chat
 * pended, on a stale read.
 *
 * SQLite raises no error from plain SQL on demand; `json()` of a non-JSON
 * string does ("malformed JSON"), so the guard evaluates `json('0')` when
 * the state matches and `json('alert-chat-state-moved')` when it does not.
 */
export function observedStateGuard(
  db: D1Database,
  wallet: string,
  chainId: number | null,
  observed: readonly LinkedRow[],
): D1PreparedStatement {
  const w = wallet.toLowerCase();
  const scope = chainId === null ? '' : ' AND chain_id = ?';
  const scopeArgs = chainId === null ? [] : [chainId];
  const match = observed.length === 0 ? '0' : observed.map(() => '(chain_id = ? AND tg_chat_id = ?)').join(' OR ');
  return db
    .prepare(
      `SELECT json(CASE WHEN
          (SELECT COUNT(*) FROM user_thresholds WHERE wallet = ?${scope} AND tg_chat_id IS NOT NULL) = ?
          AND (SELECT COUNT(*) FROM user_thresholds WHERE wallet = ? AND (${match})) = ?
        THEN '0' ELSE 'alert-chat-state-moved' END) AS state_guard`,
    )
    .bind(
      w,
      ...scopeArgs,
      observed.length,
      w,
      ...observed.flatMap((r) => [r.chainId, r.chatId]),
      observed.length,
    );
}

/** Whether a batch failed on `observedStateGuard` (SQLite's "malformed JSON"
 *  from the guard's deliberate `json()` of a non-JSON string), rather than
 *  on anything else, which the caller must not retry as a race. */
export function isStateGuardFailure(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
  return /malformed JSON/i.test(text);
}

/** Clear the chat of (wallet, chain) now: the immediate unlink of a row whose
 *  account is not protected. Only ever run behind `observedStateGuard`. */
export function clearChatStatement(db: D1Database, wallet: string, chainId: number, now: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE user_thresholds SET tg_chat_id = NULL, updated_at = ? WHERE wallet = ? AND chain_id = ?`)
    .bind(now, wallet.toLowerCase(), chainId);
}

/** Revoke every handshake code in scope (`chainId` null = the whole wallet).
 *  A code only links, so revoking it silences nothing; leaving one would let
 *  another tab reverse the unlink. */
export function revokeCodesStatement(db: D1Database, wallet: string, chainId: number | null): D1PreparedStatement {
  const w = wallet.toLowerCase();
  return chainId === null
    ? db.prepare(`DELETE FROM telegram_links WHERE wallet = ?`).bind(w)
    : db.prepare(`DELETE FROM telegram_links WHERE wallet = ? AND chain_id = ?`).bind(w, chainId);
}

/** The ids the INSERTs of a `pendingChangeStatements` batch returned, in
 *  statement order (an INSERT carries `RETURNING id`; others return none). */
export function insertedIds(results: readonly D1Result[]): number[] {
  return results.flatMap((r) =>
    (r.results ?? []).flatMap((row) => (row && typeof row === 'object' && 'id' in row ? [Number((row as { id: unknown }).id)] : [])),
  );
}

/** The old chat accepted the notice for the changes `ids`: their wait starts
 *  now. Bound to the ids the notice named, so a notice accepted after a newer
 *  request replaced its change can never start the newer change's wait. */
export async function markNotified(db: D1Database, ids: readonly number[], now: number): Promise<void> {
  if (ids.length === 0) return;
  await db
    .prepare(
      `UPDATE alert_channel_changes
          SET notified_at = ?1, effective_at = ?1 + delay_seconds, notice_attempt_at = ?1
        WHERE state = 'pending' AND notified_at IS NULL
          AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(now, ...ids)
    .run();
}

/** A notice attempt for `ids` that Telegram did not accept: recorded so the
 *  retry waits, and so the retry order rotates past it. */
export async function markNoticeAttempt(db: D1Database, ids: readonly number[], now: number): Promise<void> {
  if (ids.length === 0) return;
  await db
    .prepare(
      `UPDATE alert_channel_changes SET notice_attempt_at = ?1
        WHERE state = 'pending' AND notified_at IS NULL
          AND id IN (${ids.map(() => '?').join(', ')})`,
    )
    .bind(now, ...ids)
    .run();
}

/** Pending changes whose notice still has to reach the old chat, last tried
 *  before `retryBefore` (or never). */
export async function unnotifiedChanges(
  db: D1Database,
  retryBefore: number,
  limit = APPLY_BATCH,
): Promise<PendingChange[]> {
  return readChanges(
    db,
    `c.state = 'pending' AND c.notified_at IS NULL AND (c.notice_attempt_at IS NULL OR c.notice_attempt_at <= ?)`,
    retryBefore,
    limit,
    // Least recently tried first: every attempt stamps `notice_attempt_at`,
    // so chats that keep refusing rotate to the back and can never starve
    // other requests out of the batch.
    'COALESCE(c.notice_attempt_at, 0), c.id',
  );
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

/** The pending changes due at `now` (told, and their wait passed), oldest first. */
export async function dueChanges(db: D1Database, now: number, limit = APPLY_BATCH): Promise<PendingChange[]> {
  return readChanges(db, `c.state = 'pending' AND c.effective_at IS NOT NULL AND c.effective_at <= ?`, now, limit);
}

async function readChanges(
  db: D1Database,
  where: string,
  arg: number,
  limit: number,
  orderBy = 'c.id',
): Promise<PendingChange[]> {
  const res = await db
    .prepare(
      `SELECT c.id, c.wallet, c.chain_id, c.kind, c.old_chat_id, c.new_chat_id, c.delay_seconds, c.effective_at, t.locale
         FROM alert_channel_changes c
         LEFT JOIN user_thresholds t ON t.wallet = c.wallet AND t.chain_id = c.chain_id
        WHERE ${where}
        ORDER BY ${orderBy} LIMIT ?`,
    )
    .bind(arg, limit)
    .all<{
      id: number;
      wallet: string;
      chain_id: number;
      kind: 'unlink' | 'replace';
      old_chat_id: string;
      new_chat_id: string | null;
      delay_seconds: number;
      effective_at: number | null;
      locale: string | null;
    }>();
  return (res.results ?? []).map((r) => ({
    id: Number(r.id),
    wallet: r.wallet,
    chainId: Number(r.chain_id),
    kind: r.kind,
    oldChatId: r.old_chat_id,
    newChatId: r.new_chat_id,
    delaySeconds: Number(r.delay_seconds),
    effectiveAt: r.effective_at === null ? null : Number(r.effective_at),
    locale: r.locale ?? 'en',
  }));
}

/** Apply one due change, atomically with marking it applied. Returns false
 *  when nothing changed (cancelled or applied meanwhile, or, for a move, the
 *  chat it moves away from is no longer the linked one). */
export async function applyChange(db: D1Database, c: PendingChange, now: number): Promise<boolean> {
  // The batch opens with a guard that FAILS unless this change is still
  // pending, so the whole batch, mark and row updates alike, is this pass's
  // claim on the change: a second pass that read the same due change (or a
  // CANCEL that landed meanwhile) aborts it and writes nothing, whatever the
  // timestamps. Both kinds act only while the old chat is still the linked
  // one: anything else means a later immediate change already decided it.
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT json(CASE WHEN EXISTS (SELECT 1 FROM alert_channel_changes WHERE id = ? AND state = 'pending')
           THEN '0' ELSE 'alert-chat-state-moved' END) AS state_guard`,
      )
      .bind(c.id),
    db
      .prepare(`UPDATE alert_channel_changes SET state = 'applied', closed_at = ? WHERE id = ? AND state = 'pending'`)
      .bind(now, c.id),
  ];
  if (c.kind === 'unlink') {
    stmts.push(
      db
        .prepare(
          `UPDATE user_thresholds SET tg_chat_id = NULL, updated_at = ?
            WHERE wallet = ? AND chain_id = ? AND tg_chat_id = ?`,
        )
        .bind(now, c.wallet, c.chainId, c.oldChatId),
      // As the immediate unlink does: an unexpired handshake code for the row
      // could otherwise re-link it at once.
      db.prepare(`DELETE FROM telegram_links WHERE wallet = ? AND chain_id = ?`).bind(c.wallet, c.chainId),
    );
  } else {
    stmts.push(
      db
        .prepare(
          `UPDATE user_thresholds SET tg_chat_id = ?, updated_at = ?
            WHERE wallet = ? AND chain_id = ? AND tg_chat_id = ?`,
        )
        .bind(c.newChatId, now, c.wallet, c.chainId, c.oldChatId),
    );
  }
  let results: D1Result[];
  try {
    results = await db.batch(stmts);
  } catch (err) {
    // Not pending any more: another pass applied it, or it was cancelled.
    if (isStateGuardFailure(err)) return false;
    throw err;
  }
  // Applied only when the chat row actually changed (the old chat was still
  // the linked one).
  return Number(results[2]?.meta?.changes ?? 0) > 0;
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
