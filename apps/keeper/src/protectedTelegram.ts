// apps/keeper/src/protectedTelegram.ts
//
// #3088 — the two Telegram steps of the protected account pass
// (`protectedAccount.ts`), each armed by its own flag:
//
//   LOCK (PROTECTED_LOCK_ENABLED) — an owner whose wallet is linked to a
//   Telegram chat sends LOCK there; the agent records one request per linked
//   wallet and chain (`protected_lock_requests`) and signs nothing. This step
//   reads the requests it has not handled yet, oldest first, and for each one
//   calls `ProtectedAccountFacet.lockVaultFor(wallet)` when the chain allows
//   it: protected mode on, not locked already. The owner must have granted
//   the keeper `KEEPER_ACTION_LOCK_VAULT`; without it the protocol refuses
//   (`KeeperAccessRequired`) and the chat is told so. Every request gets one
//   answer in the chat the wallet is linked to when it answers (none once
//   the owner has unlinked Telegram), naming what the keeper saw, and the
//   row records when it was handled and how (its progress lives on the row,
//   never in a cursor of its own that a rebuilt table could leave behind).
//   A request
//   reached more than an hour after it was made is dropped, and the chat is
//   told; one more than a day old is dropped silently, so a backlog found late
//   never messages owners about old requests. The
//   step runs first in the pass, before any release: a lock cancels every
//   queued row. `lockVaultFor` works during a pause.
//
//   ALERTS (PROTECTED_ALERTS_ENABLED) — the owner of a protected account is
//   told, on every channel they subscribed (Telegram, Push), when their vault
//   is locked, when a payout from it is queued (with its request code, which
//   the app shows for the same payout, and its asset, amount, recipient and
//   release time) and when a replacement of the primary wallet is proposed.
//   Read from the indexer's event ledger after the step's own cursor. An
//   event more than an hour old when first read is not alerted (stale news
//   is not a warning); the run counts those. A payout alert waits for its
//   request code: a run that cannot read it stops there and the next run
//   tries again. So does an alert no channel accepted but one may on another
//   try (a rate limit, a server fault, a Push send that may not have gone):
//   the step stops on it without moving its cursor, and an alert that every
//   channel refused for good is counted undelivered and passed over.
//
// Neither step moves value; the lock pays only gas. Every message goes
// through `AlertDelivery`, so the epoch fence holds for them as for every
// other alert.

import { erc20Abi, formatUnits, type Address } from 'viem';
import { assertGuardedWriteLanded, EpochFenceRefusal, epochWriteGuard } from './epochFence';
import { delivered, worthRetrying, type Alert, type DeliveryOutcome } from './alertDelivery';
import { PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { decodePos, encodePos, type EventLedger, type LedgerPos } from './eventLedger';
import { boundedCall, type PassReader } from './passReader';
import { protectedCopy, shortAddress } from './protectedCopy';
import { RUN_DEADLINE_MARGIN_MS } from './runWindow';
import type { ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

/** A request dropped (and the chat told) when reached later than this after
 *  it was sent: the one limit the agent also applies before recording it. */
import { LOCK_REQUEST_TTL_SEC } from '@vaipakam/lib/protectedLock';
import { formatRequestCode } from '@vaipakam/lib/requestCode';
export { LOCK_REQUEST_TTL_SEC };
/** A request dropped without a message when older than this. */
export const LOCK_REQUEST_SILENT_SEC = 24 * 60 * 60;
/** Requests read per chain per run. */
export const LOCK_PAGE = 20;
/** Ledger rows read per chain per run for the alerts. */
export const ALERT_PAGE = 50;
export const ALERT_NEXT_ITEM = 'alert-next';
/** An event older than this when first read is not alerted. */
export const ALERT_MAX_AGE_SEC = 60 * 60;
export const ALERT_EVENTS = ['VaultLocked', 'PayoutQueued', 'ReplacementProposed'] as const;
/** The refusal of a keeper the owner has not granted the lock bit. */
export const NOT_GRANTED = 'KeeperAccessRequired';

/** One wallet's open LOCK requests on a chain, as one: an owner who sends
 *  LOCK again before the keeper answers asks for the same thing, and one
 *  lock answers every one of them. */
export interface LockRequest {
  /** The newest of the wallet's open requests: every open one up to it is
   *  handled together. */
  id: number;
  wallet: Address;
  /** The chat the wallet is linked to NOW, where the answer goes; null once
   *  the owner has unlinked Telegram (the lock is still made, unanswered). */
  chatId: string | null;
  /** When the newest of them was made, in Unix seconds. */
  requestedAt: number;
  locale: string | null;
}

/** One owner's subscription on one chain. */
export interface Subscriber {
  tgChatId: string | null;
  push: boolean;
  locale: string | null;
}

/** The shared database, as these steps read it. Each read throws on failure. */
export interface ProtectedStore {
  /** At most `limit` wallets with requests on `chainId` not handled yet,
   *  one entry per wallet, in the order of each wallet's oldest open request. */
  lockRequests(chainId: number, limit: number): Promise<LockRequest[]>;
  /** Record that `wallet`'s open requests on `chainId` up to `upToId` are
   *  finished, and how. Throws when the write did not land (the epoch guard
   *  refused it). */
  markHandled(chainId: number, wallet: Address, upToId: number, outcome: LockOutcome, atSec: number): Promise<void>;
  /** `wallet`'s subscription on `chainId`, if it has one. */
  subscriber(chainId: number, wallet: Address): Promise<Subscriber | null>;
  /** Say that a keeper able to sign is working LOCK requests on `chainId`
   *  now; the agent records a LOCK only while this is fresh. */
  publishLockReadiness(chainId: number, nowSec: number): Promise<void>;
  /** The wallets with a LOCK request on `chainId` made at or after
   *  `sinceSec` that is not handled yet. */
  pendingLockWallets(chainId: number, sinceSec: number): Promise<Set<Address>>;
}

export function d1ProtectedStore(db: D1Database): ProtectedStore {
  return {
    async lockRequests(chainId, limit) {
      const rows = await db
        .prepare(
          `SELECT g.last_id AS id, g.wallet, t.tg_chat_id AS chat_id, g.requested_at, t.locale FROM (
              SELECT wallet, MIN(id) AS first_id, MAX(id) AS last_id, MAX(requested_at) AS requested_at
                FROM protected_lock_requests
               WHERE chain_id = ?1 AND handled_at IS NULL
               GROUP BY wallet
            ) g
             LEFT JOIN user_thresholds t ON t.wallet = g.wallet AND t.chain_id = ?1
            ORDER BY g.first_id ASC LIMIT ?2`,
        )
        .bind(chainId, limit)
        .all<{ id: number; wallet: string; chat_id: string | null; requested_at: number; locale: string | null }>();
      return (rows.results ?? []).map((r) => ({
        id: Number(r.id),
        wallet: r.wallet.toLowerCase() as Address,
        chatId: r.chat_id === null ? null : String(r.chat_id),
        requestedAt: Number(r.requested_at),
        locale: r.locale,
      }));
    },
    async markHandled(chainId, wallet, upToId, outcome, atSec) {
      // The table is chain-scoped and the indexer resets it on a new Diamond:
      // the guard keeps a keeper serving the old Diamond from writing into
      // the new epoch (epochFence.ts). Only this keeper (one runner, by the
      // lease) handles a request, and it read the row unhandled this run, so
      // no change means the guard refused the write.
      const guard = epochWriteGuard(chainId);
      const result = await db
        .prepare(
          `UPDATE protected_lock_requests SET handled_at = ?, outcome = ?
            WHERE chain_id = ? AND wallet = ? AND id <= ? AND handled_at IS NULL AND ${guard.where}`,
        )
        .bind(atSec, outcome, chainId, wallet.toLowerCase(), upToId, ...guard.binds)
        .run();
      assertGuardedWriteLanded(result, `the record of the LOCK requests of ${wallet} for chain ${chainId}`);
    },
    async publishLockReadiness(chainId, nowSec) {
      const guard = epochWriteGuard(chainId);
      const result = await db
        .prepare(
          `INSERT INTO protected_lock_readiness (chain_id, seen_at) SELECT ?, ? WHERE ${guard.where}
           ON CONFLICT (chain_id) DO UPDATE SET seen_at = excluded.seen_at`,
        )
        .bind(chainId, nowSec, ...guard.binds)
        .run();
      assertGuardedWriteLanded(result, `the LOCK readiness of chain ${chainId}`);
    },
    async pendingLockWallets(chainId, sinceSec) {
      const rows = await db
        .prepare(
          `SELECT DISTINCT wallet FROM protected_lock_requests
            WHERE chain_id = ?1 AND handled_at IS NULL AND requested_at >= ?2`,
        )
        .bind(chainId, sinceSec)
        .all<{ wallet: string }>();
      return new Set((rows.results ?? []).map((r) => r.wallet.toLowerCase() as Address));
    },
    async subscriber(chainId, wallet) {
      const r = await db
        .prepare(`SELECT tg_chat_id, push_channel, locale FROM user_thresholds WHERE wallet = ?1 AND chain_id = ?2`)
        .bind(wallet.toLowerCase(), chainId)
        .first<{ tg_chat_id: string | null; push_channel: string | null; locale: string | null }>();
      if (!r) return null;
      return { tgChatId: r.tg_chat_id, push: r.push_channel === 'subscribed', locale: r.locale };
    },
  };
}

/** How each LOCK request ended this run. */
export type LockOutcome = 'locked' | 'locked-again' | 'already-locked' | 'not-protected' | 'not-allowed' | 'expired' | 'dropped-old' | `refused: ${string}`;

/** What the Telegram steps share with the pass. */
export interface TelegramStepDeps {
  r: PassReader;
  sender: StepSender;
  cursors: ScanCursors;
  store: ProtectedStore;
  ledger: EventLedger;
  chainId: number;
  /** One message to one subscriber (`AlertDelivery.deliver`), and what
   *  each channel did with it. */
  notify: (alert: Alert) => Promise<DeliveryOutcome>;
  /** Whether this keeper has a signing key for the chain: without one it
   *  can lock nothing, so it does not say it is working LOCK requests. */
  canSign: () => boolean;
  /** The app's origin, for the link in a Push alert. */
  appOrigin: string;
  /** Wall-clock seconds now (injected for tests). */
  nowSec: () => number;
  /** The account's lock as this run last read or set it, so the release
   *  step does not try an account the lock step just locked. */
  markLocked: (wallet: Address) => void;
  /** The run's send deadline (ms); the run ends `RUN_DEADLINE_MARGIN_MS`
   *  after it, and a request's record may be written until then. */
  sendDeadline: number;
}

interface AccountLock {
  enabled: boolean;
  locked: boolean;
  /** When the current lock was first set (a repeat lock keeps it). */
  lockedAt: bigint;
}

// ─── LOCK ───────────────────────────────────────────────────────────────────

/** Work this run's LOCK requests; returns each one's outcome. No lock starts
 *  at or past `sendCutoff`: the pass gives the step a share of the read
 *  window, so its receipt waits cannot use the time every release after it
 *  needs (Codex #3092 r10). A request not reached waits for the next run,
 *  and its account's releases are held meanwhile (`holdForLockRequests`). */
export async function lockFromTelegram(d: TelegramStepDeps, sendCutoff: number = d.r.cutoff): Promise<LockResult[]> {
  const out: LockResult[] = [];
  // The heartbeat first, and only from a keeper that can sign: the agent
  // takes a LOCK only while it is fresh, so an owner is told a lock is coming
  // only when something here will make it. A failed write is said; the
  // heartbeat then ages out and the agent sends the owner to the app.
  if (d.canSign()) {
    try {
      await boundedCall(d.r.cutoff, 'the LOCK readiness', () => d.store.publishLockReadiness(d.chainId, d.nowSec()));
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      d.sender.noteUnread('lock', `the LOCK readiness write (${shortErr(err)}); the agent stops taking LOCK on this chain once the last one ages out`);
    }
  } else {
    d.sender.noteUnread('lock', 'a signing key for this chain, so LOCK requests are not taken here (the agent tells owners to lock from the app)');
  }
  let reqs: LockRequest[];
  try {
    reqs = await boundedCall(d.r.cutoff, 'the lock requests', () => d.store.lockRequests(d.chainId, LOCK_PAGE));
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    d.sender.noteUnread('lock', `the LOCK requests (${shortErr(err)})`);
    return out;
  }
  // A request's record is written after its lock, which may have waited for
  // its receipt past the read cutoff: it is bounded by the run's end instead.
  // A lock starts only before the read cutoff (`lockOne`), which is the send
  // reserve ahead of the deadline, so even a receipt that takes its whole
  // wait (`RECEIPT_TIMEOUT_MS`) leaves the record time before the run ends.
  const recordCutoff = d.sendDeadline + RUN_DEADLINE_MARGIN_MS;
  for (const q of reqs) {
    // eslint-disable-next-line no-await-in-loop
    const done = await lockOne(d, q, sendCutoff);
    if (done === null) break; // not finished: the next run starts here
    let recorded = true;
    try {
      // The record before the answer: a slow chat cannot use the time the
      // record needs, and a request the chain has acted on is never acted on
      // again because its answer was slow.
      // eslint-disable-next-line no-await-in-loop
      await boundedCall(recordCutoff, 'the lock request record', () => d.store.markHandled(d.chainId, q.wallet, q.id, done.outcome, d.nowSec()));
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      // Unrecorded, the requests are read again next run; a lock made since
      // they were sent is then answered as already locked, not made again.
      d.sender.noteUnread(`lock:${q.wallet}`, `the record of its LOCK request (${shortErr(err)})`);
      recorded = false;
    }
    // eslint-disable-next-line no-await-in-loop
    out.push({ wallet: q.wallet, outcome: done.outcome, answered: await answer(d, q, done.text) });
    // Stop at a failing write so it does not repeat for the whole page.
    if (!recorded) break;
  }
  return out;
}

/** One request's end: what the keeper did, and whether its answer reached
 *  the chat (null when it sent none: a request dropped silently, or a wallet
 *  no longer linked to a chat). */
export interface LockResult {
  wallet: Address;
  outcome: LockOutcome;
  answered: boolean | null;
}

/** Send `text` (null: none) to the chat the wallet is linked to now. True
 *  when it was taken, false when not, null when nothing was sent. */
async function answer(d: TelegramStepDeps, q: LockRequest, text: string | null): Promise<boolean | null> {
  // Unlinked since: no chat to answer in, and none is kept for it.
  if (text === null || q.chatId === null) return null;
  try {
    return delivered(await d.notify({ tgChatId: q.chatId, text, pushTitle: protectedCopy(q.locale).pushTitle, deepLinkUrl: d.appOrigin }));
  } catch (err) {
    if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
    return false;
  }
}

/** What a wallet's open requests came to, and the answer to send (null: none),
 *  or null when this run cannot finish them. The outcome is recorded whether
 *  or not the answer arrives: the row says what was done, and the run line
 *  counts an answer that did not reach the chat. */
async function lockOne(d: TelegramStepDeps, q: LockRequest, sendCutoff: number): Promise<{ outcome: LockOutcome; text: string | null } | null> {
  const copy = protectedCopy(q.locale);
  const w = shortAddress(q.wallet);
  const end = (outcome: LockOutcome, text: string) => ({ outcome, text });
  const age = d.nowSec() - q.requestedAt;
  if (age > LOCK_REQUEST_SILENT_SEC) return { outcome: 'dropped-old', text: null };
  if (age > LOCK_REQUEST_TTL_SEC) return end('expired', copy.lockExpired(w, d.chainId));
  let a: AccountLock;
  try {
    a = await d.r.one<AccountLock>('getProtectedAccount', [q.wallet]);
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    d.sender.noteUnread(`lock:${q.wallet}`, `its account's settings (${shortErr(err)})`);
    return null;
  }
  if (!a.enabled) return end('not-protected', copy.lockNotProtected(w, d.chainId));
  // A lock set since the newest request already did everything they asked:
  // a lock drops every loosening change pending when it is set, and one
  // asked for after it is newer than the request, so it is not the
  // keeper's to cancel. (The request's time is the agent's clock and the
  // lock's the chain's; they agree to within seconds.)
  if (a.locked && a.lockedAt >= BigInt(q.requestedAt)) {
    d.markLocked(q.wallet);
    return end('already-locked', copy.lockAlready(w, d.chainId));
  }
  // Locked before the request, the vault is locked again: the chain drops
  // every pending loosening change on a repeat lock too, and answering
  // "already locked" without the call would leave an unlock asked for since
  // the first lock to mature, perhaps in this very run.
  const wasLocked = a.locked;
  // A lock starts only inside the step's share of the read window (never
  // past the read cutoff), so its record fits in the run and the releases
  // after it keep their time.
  if (Date.now() >= Math.min(sendCutoff, d.r.cutoff)) return null;
  const res = await d.sender.call('lock', q.wallet, 'lockVaultFor', [q.wallet]);
  if (res === 'landed') {
    d.markLocked(q.wallet);
    return wasLocked ? end('locked-again', copy.lockAgain(w, d.chainId)) : end('locked', copy.lockDone(w, d.chainId));
  }
  if (res === 'skipped' || res === 'idle') return null;
  if (res === NOT_GRANTED) return end('not-allowed', copy.lockNotAllowed(w, d.chainId));
  if (res === 'ProtectedModeOff') return end('not-protected', copy.lockNotProtected(w, d.chainId));
  return end(`refused: ${res}`, copy.lockRefused(w, d.chainId, res));
}

// ─── Alerts ─────────────────────────────────────────────────────────────────

/** What the alert step did this run. */
export interface AlertReport {
  /** Alerts at least one channel accepted. */
  sent: number;
  /** Alerts every channel refused for good (a chat that blocked the bot, a
   *  Push rail that cannot send): passed over, never retried. */
  undelivered: number;
  /** Alerts no channel accepted this run but one may on another try: the
   *  step stopped there, and the next run sends it again (until it is
   *  `ALERT_MAX_AGE_SEC` old, when it is counted stale). */
  retrying: number;
  /** Events past `ALERT_MAX_AGE_SEC` when first read. */
  stale: number;
  /** Events whose account has no subscription on this chain. */
  unsubscribed: number;
}

/**
 * Alert the owners of this run's page of events. `d.r` bounds the step: the
 * pass gives it a share of the read window (`runWindow.leadStageCutoffMs`),
 * so a slow channel cannot use the time the LOCK step and the releases after
 * it need. Its reads stop there, and so do its sends: none starts at or past
 * the stage's cutoff. Where the step stopped is written after every alert
 * that went out, by `writeCutoff` (the pass's own, later read cutoff), so a
 * run cut short never repeats the alerts it already sent.
 */
export async function alertOwners(d: TelegramStepDeps, writeCutoff: number = d.r.cutoff): Promise<AlertReport> {
  const report: AlertReport = { sent: 0, undelivered: 0, retrying: 0, stale: 0, unsubscribed: 0 };
  let stored: Map<string, string>;
  let page: Awaited<ReturnType<EventLedger['page']>>;
  try {
    stored = await boundedCall(d.r.cutoff, 'the alert cursor', () => d.cursors.get([ALERT_NEXT_ITEM]));
    page = await boundedCall(d.r.cutoff, 'the event ledger', () => d.ledger.page(d.chainId, ALERT_EVENTS, decodePos(stored.get(ALERT_NEXT_ITEM)), ALERT_PAGE));
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    d.sender.noteUnread('alert', `the alert cursor or the event ledger by the step's cutoff (${shortErr(err)})`);
    return report;
  }
  if (page === null) {
    d.sender.noteUnread('alert', 'the event ledger of protected-account events');
    return report;
  }
  let done: LedgerPos | null = null;
  let written: LedgerPos | null = null;
  const checkpoint = async () => {
    if (done === null || done === written) return;
    const at = done;
    try {
      await boundedCall(writeCutoff, 'the alert cursor', () => d.cursors.put(ALERT_NEXT_ITEM, encodePos(at)));
      written = at;
    } catch {
      // Unwritten, the next run sends from the last place written.
    }
  };
  // Whom each account's alerts go to: its manager at the head, read once per
  // account this step (see `managerOf`).
  const managers = new Map<Address, Address>();
  try {
    for (const row of page.rows) {
      const account = lower(row.args.account);
      let finished = true;
      let wentOut = false;
      if (account === null) {
        // A row it cannot read alerts nobody, and keeps its place.
      } else if (d.nowSec() - row.blockAt > ALERT_MAX_AGE_SEC) {
        report.stale += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        const manager = await managerOf(d, managers, account);
        if (manager === null) {
          d.sender.noteUnread('alert', `whom ${account}'s alerts go to (its protected-account settings)`);
          break;
        }
        let sub: Subscriber | null;
        try {
          // eslint-disable-next-line no-await-in-loop
          sub = await boundedCall(d.r.cutoff, 'the subscription', () => d.store.subscriber(d.chainId, manager));
        } catch (err) {
          if (err instanceof PastRunDeadline) throw err;
          d.sender.noteUnread('alert', `the owner's subscription (${shortErr(err)})`);
          break;
        }
        if (sub === null || (sub.tgChatId === null && !sub.push)) {
          report.unsubscribed += 1;
        } else {
          // eslint-disable-next-line no-await-in-loop
          const text = await composeAlert(d, row.kind, row.args, account, manager, sub.locale);
          if (text === null) {
            finished = false;
          } else {
            // A send is not bounded once started, so none starts past the
            // step's cutoff: the rest waits for the next run.
            if (Date.now() >= d.r.cutoff) throw new PastRunDeadline('owner alerts: the step reached its cutoff');
            let outcome: DeliveryOutcome;
            try {
              // eslint-disable-next-line no-await-in-loop
              outcome = await d.notify({
                tgChatId: sub.tgChatId,
                pushSubscriber: sub.push ? manager : null,
                text,
                pushTitle: protectedCopy(sub.locale).pushTitle,
                deepLinkUrl: d.appOrigin,
              });
            } catch (err) {
              if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
              // A send that threw (the network) may go on another try.
              outcome = { telegram: 'retry', push: 'off' };
            }
            if (delivered(outcome)) {
              // One channel is enough: an owner told once is warned, and a
              // second try would repeat it on the channel that worked.
              report.sent += 1;
              wentOut = true;
            } else if (worthRetrying(outcome)) {
              // Keep its place: the next run sends it again, and the events
              // after it wait behind it rather than overtake it.
              report.retrying += 1;
              finished = false;
            } else {
              report.undelivered += 1;
              wentOut = true;
            }
          }
        }
      }
      if (!finished) break;
      done = { block: row.block, log: row.log };
      // eslint-disable-next-line no-await-in-loop
      if (wentOut) await checkpoint();
    }
  } catch (err) {
    if (!(err instanceof PastRunDeadline)) throw err;
    d.sender.noteUnread('alert', `the rest of the page, past the step's cutoff (${shortErr(err)}); sent next run`);
  }
  await checkpoint();
  return report;
}

/**
 * The wallet that manages `account` now, which is whom its alerts go to: the
 * account's own wallet, or its controller once a replacement retired it
 * (`LibProtectedAccount.manager`). A retired account's events still name the
 * old wallet, which lost every right over it, so alerting that wallet's
 * channels would warn the wrong person and leave the owner unwarned (Codex
 * #3092 r9). Read at the head, once per account a step; null when it could
 * not be read, and the alert then waits.
 */
async function managerOf(d: TelegramStepDeps, seen: Map<Address, Address>, account: Address): Promise<Address | null> {
  if (seen.has(account)) return seen.get(account)!;
  let manager: Address | null;
  try {
    const a = await d.r.one<{ retired: boolean; controller: Address }>('getProtectedAccount', [account]);
    manager = a.retired ? lower(a.controller) : account;
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    return null;
  }
  if (manager !== null) seen.set(account, manager);
  return manager;
}

/** The alert's text, or null when a read it needs is not available yet. The
 *  text names the vault (`account`); `manager` is who receives it. */
async function composeAlert(
  d: TelegramStepDeps,
  kind: string,
  args: Record<string, unknown>,
  account: Address,
  manager: Address,
  locale: string | null,
): Promise<string | null> {
  const copy = protectedCopy(locale);
  const w = shortAddress(account);
  switch (kind) {
    case 'VaultLocked': {
      const by = lower(args.by);
      return by === null || by === account || by === manager ? copy.alertLockedByOwner(w, d.chainId) : copy.alertLockedBy(w, d.chainId, by);
    }
    case 'ReplacementProposed':
      return copy.alertReplacement(w, d.chainId, String(lower(args.nominee) ?? args.nominee), String(lower(args.by) ?? args.by));
    case 'PayoutQueued': {
      const id = uint(args.id);
      if (id === null) return null;
      let code: bigint;
      try {
        code = BigInt(await d.r.one<number | bigint>('requestCode', [id]));
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        d.sender.noteUnread(`alert:${id}`, `its request code (${shortErr(err)})`);
        return null;
      }
      const what = await describeAsset(d, Number(args.kind), lower(args.asset), uint(args.tokenId) ?? 0n, uint(args.amount) ?? 0n);
      const when = new Date(Number(uint(args.releaseAt) ?? 0n) * 1000).toISOString().slice(0, 16).replace('T', ' ');
      // The app's own rendering of the code (`formatRequestCode`), so the two
      // match; a value it will not render is not printed as a code.
      const shown = formatRequestCode(code);
      if (shown === null) {
        d.sender.noteUnread(`alert:${id}`, 'its request code (not a 30-bit value)');
        return null;
      }
      return copy.alertPayout(w, d.chainId, what, String(lower(args.recipient) ?? args.recipient), when, shown, manager === account);
    }
    default:
      return null;
  }
}

/** The asset and amount, from the token's own decimals and symbol; the raw
 *  amount and the token address when those cannot be read. */
async function describeAsset(d: TelegramStepDeps, kind: number, asset: Address | null, tokenId: bigint, amount: bigint): Promise<string> {
  const token = asset === null ? '?' : shortAddress(asset);
  if (kind === 1) return `NFT ${token} #${tokenId}`;
  if (kind === 2) return `${amount} × ${token} #${tokenId}`;
  if (asset === null) return `${amount} (raw) ?`;
  try {
    const [decimals, symbol] = await Promise.all([
      d.r.one<number>('decimals', [], asset, erc20Abi),
      d.r.one<string>('symbol', [], asset, erc20Abi),
    ]);
    return `${formatUnits(amount, Number(decimals))} ${symbol} (${token})`;
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    return `${amount} (raw units) ${token}`;
  }
}

const lower = (a: unknown): Address | null => {
  const s = String(a ?? '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as Address) : null;
};
const uint = (v: unknown): bigint | null => {
  const s = String(v ?? '');
  return /^\d+$/.test(s) ? BigInt(s) : null;
};
