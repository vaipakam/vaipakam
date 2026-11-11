/**
 * #1722 — the Durable Object that holds the agent's Telegram state.
 *
 * One SQLite-backed object for the whole Worker (`stateStub` names it
 * `global`), bound only to the agent. It owns no logic of its own: each RPC
 * method is one {@link TelegramStateStore} call, run inside the object's
 * single-threaded request loop, so a method's reads and writes are one
 * atomic step. The flows that read the chain (the protected-mode delay, the
 * keeper's LOCK outcome) do their async work in the Worker and hand the
 * object a guarded write ({@link TelegramStateStore.commit} refuses one whose
 * rows moved in between).
 *
 * WHY A DURABLE OBJECT: Cloudflare offers no API that reads or writes a
 * Durable Object's storage from outside its own Worker, so the account-wide
 * D1 token the keeper machine holds cannot reach these rows (owner decision
 * 2026-11-11). The shared D1 tables this replaces are dropped by a later
 * release, once the keeper no longer reads them.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  TelegramStateStore,
  type ChannelOp,
  type CommitResult,
  type LinkedRow,
  type LockLink,
  type LockRequest,
  type PendingChange,
  type SqlLike,
  type UnansweredLock,
} from './store';

/** The binding name in `wrangler.jsonc`. */
export interface TelegramStateBinding {
  TG_STATE: DurableObjectNamespace<TelegramState>;
}

/** The one object every request reaches. */
export function stateStub(env: TelegramStateBinding): DurableObjectStub<TelegramState> {
  return env.TG_STATE.get(env.TG_STATE.idFromName('global'));
}

export class TelegramState extends DurableObject {
  private readonly store: TelegramStateStore;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    const storage = ctx.storage;
    this.store = new TelegramStateStore(storage.sql as unknown as SqlLike, (fn) => storage.transactionSync(fn));
  }

  // ─── Handshake codes ──────────────────────────────────────────────────
  issueLinkCode(code: string, wallet: string, chainId: number, expiresAt: number): boolean {
    return this.store.issueLinkCode(code, wallet, chainId, expiresAt);
  }
  consumeLinkCode(code: string, now: number): { wallet: string; chainId: number } | null {
    return this.store.consumeLinkCode(code, now);
  }
  sweepExpiredCodes(now: number): number {
    return this.store.sweepExpiredCodes(now);
  }

  // ─── Links ────────────────────────────────────────────────────────────
  linkedRows(wallet: string, chainId: number | null): LinkedRow[] {
    return this.store.linkedRows(wallet, chainId);
  }
  chatsOf(pairs: { wallet: string; chainId: number }[]): (string | null)[] {
    return this.store.chatsOf(pairs);
  }
  linkedWallets(chainId: number): string[] {
    return this.store.linkedWallets(chainId);
  }
  linksOfChat(chatId: string): { wallet: string; chainId: number }[] {
    return this.store.linksOfChat(chatId);
  }

  // ─── Channel changes (#3246) ──────────────────────────────────────────
  commit(wallet: string, chainId: number | null, observed: LinkedRow[], ops: ChannelOp[], now: number): CommitResult {
    return this.store.commit(wallet, chainId, observed, ops, now);
  }
  markNotified(ids: number[], now: number): void {
    this.store.markNotified(ids, now);
  }
  markNoticeAttempt(ids: number[], now: number): void {
    this.store.markNoticeAttempt(ids, now);
  }
  unnotifiedChanges(retryBefore: number, limit: number): PendingChange[] {
    return this.store.unnotifiedChanges(retryBefore, limit);
  }
  dueChanges(now: number, limit: number): PendingChange[] {
    return this.store.dueChanges(now, limit);
  }
  cancelPendingForChat(chatId: string, now: number): { wallet: string; chainId: number; kind: 'unlink' | 'replace' }[] {
    return this.store.cancelPendingForChat(chatId, now);
  }
  applyChange(id: number, now: number): { change: PendingChange; applied: boolean } | null {
    return this.store.applyChange(id, now);
  }
  pruneClosed(now: number): void {
    this.store.pruneClosed(now);
  }

  // ─── Telegram LOCK (#3088) ────────────────────────────────────────────
  recordLockRequests(chatId: string, updateId: number, requestedAt: number | null, freshFrom: number): LockLink[] {
    return this.store.recordLockRequests(chatId, updateId, requestedAt, freshFrom);
  }
  keeperPoll(chainId: number, now: number, limit: number): LockRequest[] {
    return this.store.keeperPoll(chainId, now, limit);
  }
  pendingLockWallets(chainId: number, since: number): string[] {
    return this.store.pendingLockWallets(chainId, since);
  }
  markLockHandled(chainId: number, wallet: string, upToId: number, outcome: string, at: number): { chatId: string | null } | undefined {
    return this.store.markLockHandled(chainId, wallet, upToId, outcome, at);
  }
  takeUnansweredLocks(sentBefore: number, now: number, limit: number): UnansweredLock[] {
    return this.store.takeUnansweredLocks(sentBefore, now, limit);
  }
}
