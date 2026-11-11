// apps/keeper/src/protectedTelegram.ts
//
// #3088 — the two Telegram steps of the protected account pass
// (`protectedAccount.ts`), each armed by its own flag. Since #1722 both reach
// Telegram only through the agent (`agentClient.ts`): the agent alone holds
// the bot token, the wallet-to-chat links and the LOCK requests, and the
// keeper says what happened as data, which the agent renders in the owner's
// language and sends to the chat linked now.
//
//   LOCK (PROTECTED_LOCK_ENABLED) — an owner whose wallet is linked to a
//   Telegram chat sends LOCK there; the agent records one request per linked
//   wallet and chain and signs nothing. This step asks the agent for the
//   requests not handled yet, oldest first (asking also tells the agent a
//   keeper able to sign is working the chain, so it is asked only by a keeper
//   that can sign), and for each one calls
//   `ProtectedAccountFacet.lockVaultFor(wallet)` when the chain allows it:
//   protected mode on, not locked already. The owner must have granted the
//   keeper `KEEPER_ACTION_LOCK_VAULT`; without it the protocol refuses
//   (`KeeperAccessRequired`) and the chat is told so. Each request's outcome
//   is reported to the agent, which records it and answers in the chat the
//   wallet is linked to then (none once the owner has unlinked Telegram). A
//   request reached more than an hour after it was made is dropped, and the
//   chat is told; one more than a day old is dropped silently, so a backlog
//   found late never messages owners about old requests. The step runs first
//   in the pass, before any release: a lock cancels every queued row.
//   `lockVaultFor` works during a pause.
//
//   ALERTS (PROTECTED_ALERTS_ENABLED) — the owner of a protected account is
//   told, on every channel they have (Telegram through the agent, Push from
//   here), when their vault is locked, when a payout from it is queued (with
//   its request code, which the app shows for the same payout, and its asset,
//   amount, recipient and release time) and when a replacement of the
//   primary wallet is proposed. Read from the indexer's event ledger after
//   the step's own cursor. An event more than an hour old when first read is
//   not alerted (stale news is not a warning); the run counts those. A payout
//   alert waits for its request code: a run that cannot read it stops there
//   and the next run tries again. So does an alert no channel accepted but
//   one may on another try (a rate limit, a server fault, a send that may not
//   have gone): the step stops on it without moving its cursor, and an alert
//   that every channel refused for good is counted undelivered and passed
//   over.
//
// Neither step moves value; the lock pays only gas. Every alert goes through
// `AlertDelivery`, so the epoch fence holds for them as for every other
// alert, and the agent refuses any request naming another Diamond than the
// one it serves (`AgentDiamondMismatch`, a kind of the fence's refusal).

import { erc20Abi, formatUnits, type Address } from 'viem';
import { EpochFenceRefusal } from './epochFence';
import { delivered, worthRetrying, type Alert, type DeliveryOutcome } from './alertDelivery';
import { lockReason, type AgentClient, type AgentLockOutcome, type LockHandledAnswer } from './agentClient';
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
import { plainField, renderTelegramAlert, type AddressedAlert, type TelegramAlert } from '@vaipakam/lib/telegramAlerts/message';
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
  /** When the newest of them was made, in Unix seconds (the agent's clock). */
  requestedAt: number;
}

/** One owner's Push subscription and language on one chain. Whether they
 *  linked Telegram only the agent knows. */
export interface Subscriber {
  push: boolean;
  locale: string | null;
}

/** Where these steps read and report. Each call throws on failure. */
export interface ProtectedStore {
  /** At most `limit` wallets with requests on `chainId` not handled yet,
   *  one entry per wallet, in the order of each wallet's oldest open request.
   *  Asking tells the agent a keeper able to sign works LOCK requests on the
   *  chain now (it records a LOCK only while that is fresh), so only a keeper
   *  that can sign asks. */
  lockRequests(chainId: number, limit: number): Promise<LockRequest[]>;
  /** Report that `wallet`'s open requests on `chainId` up to `upToId` are
   *  finished, and how. The agent records it and answers in the chat. */
  markHandled(chainId: number, wallet: Address, upToId: number, outcome: LockOutcome): Promise<LockHandledAnswer>;
  /** `wallet`'s Push subscription on `chainId`, if it has one. */
  subscriber(chainId: number, wallet: Address): Promise<Subscriber | null>;
  /** The wallets with a LOCK request on `chainId` made at or after
   *  `sinceSec` that is not handled yet. */
  pendingLockWallets(chainId: number, sinceSec: number): Promise<Set<Address>>;
}

/** The LOCK requests through the agent, for the chain whose Diamond is
 *  `diamond`; the Push subscriptions from the shared database. With no agent
 *  configured every LOCK call throws (the pass does not arm the LOCK step
 *  then, `runProtectedAccount`). */
export function protectedStoreOf(agent: AgentClient | null, db: D1Database, diamond: Address, unconfigured = 'no agent is configured'): ProtectedStore {
  const need = (): AgentClient => {
    if (agent === null) throw new Error(`the agent is not reachable: ${unconfigured}`);
    return agent;
  };
  return {
    async lockRequests(chainId, limit) {
      const reqs = await need().lockPoll(chainId, diamond, limit);
      return reqs.map((q) => ({ id: q.id, wallet: q.wallet.toLowerCase() as Address, requestedAt: q.requestedAt }));
    },
    async markHandled(chainId, wallet, upToId, outcome) {
      const refused = outcome.startsWith('refused: ');
      const kind: AgentLockOutcome = refused ? 'refused' : (outcome as AgentLockOutcome);
      return need().lockHandled(chainId, diamond, wallet.toLowerCase(), upToId, kind, refused ? lockReason(outcome.slice('refused: '.length)) : undefined);
    },
    async pendingLockWallets(chainId, sinceSec) {
      const wallets = await need().lockPending(chainId, diamond, sinceSec);
      return new Set(wallets.map((w) => w.toLowerCase() as Address));
    },
    async subscriber(chainId, wallet) {
      const r = await db
        .prepare(`SELECT push_channel, locale FROM user_thresholds WHERE wallet = ?1 AND chain_id = ?2`)
        .bind(wallet.toLowerCase(), chainId)
        .first<{ push_channel: string | null; locale: string | null }>();
      if (!r) return null;
      return { push: r.push_channel === 'subscribed', locale: r.locale };
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
  /** The Diamond this keeper serves on the chain, which every message to the
   *  agent names. */
  diamond: Address;
  /** One message to one subscriber (`AlertDelivery.deliver`), and what
   *  each channel did with it. */
  notify: (alert: Alert) => Promise<DeliveryOutcome>;
  /** Whether this keeper has a signing key for the chain: without one it
   *  can lock nothing, so it does not say it is working LOCK requests. */
  canSign: () => boolean;
  /** Whether this run works LOCK requests on this chain (the LOCK duty is
   *  armed). With it off, LOCK from Telegram locks nothing here, so no alert
   *  suggests it (Codex #3092 r11). */
  lockOn: boolean;
  /** The app's origin, for the link in a Push alert and its text. */
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
  // Only a keeper that can sign asks: asking tells the agent a keeper is
  // working LOCK requests here, and the agent takes a LOCK only while that
  // is fresh, so an owner is told a lock is coming only when something here
  // will make it. Without asking, the agent's record of it ages out and it
  // sends owners to the app.
  if (!d.canSign()) {
    d.sender.noteUnread('lock', 'a signing key for this chain, so LOCK requests are not taken here (the agent tells owners to lock from the app)');
    return out;
  }
  let reqs: LockRequest[];
  try {
    reqs = await boundedCall(d.r.cutoff, 'the lock requests', () => d.store.lockRequests(d.chainId, LOCK_PAGE));
  } catch (err) {
    if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
    d.sender.noteUnread('lock', `the LOCK requests (${shortErr(err)}); the agent stops taking LOCK on this chain once the last answered request ages out`);
    return out;
  }
  // A request's report is made after its lock, which may have waited for its
  // receipt past the read cutoff: it is bounded by the run's end instead. A
  // lock starts only before the read cutoff (`lockOne`), which is the send
  // reserve ahead of the deadline, so even a receipt that takes its whole
  // wait (`RECEIPT_TIMEOUT_MS`) leaves the report time before the run ends.
  const recordCutoff = d.sendDeadline + RUN_DEADLINE_MARGIN_MS;
  for (const q of reqs) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await lockOne(d, q, sendCutoff);
    if (outcome === null) break; // not finished: the next run starts here
    let answer: LockHandledAnswer;
    try {
      // The agent records the outcome first and answers in the chat after,
      // so a request the chain has acted on is never acted on again because
      // its answer was slow, and a repeated report sends nothing twice.
      // eslint-disable-next-line no-await-in-loop
      answer = await boundedCall(recordCutoff, 'the lock request report', () => d.store.markHandled(d.chainId, q.wallet, q.id, outcome));
    } catch (err) {
      if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
      // Unreported, the requests are read again next run; a lock made since
      // they were sent is then answered as already locked, not made again.
      d.sender.noteUnread(`lock:${q.wallet}`, `the report of its LOCK request (${shortErr(err)})`);
      out.push({ wallet: q.wallet, outcome, answered: null, recorded: null });
      // Stop at a failing report so it does not repeat for the whole page.
      break;
    }
    out.push({ wallet: q.wallet, outcome, answered: answeredBy(answer), recorded: answer.recorded });
  }
  return out;
}

/** Whether the agent's answer reached the chat: null when none was sent (a
 *  request dropped silently, a wallet no longer linked, or a report the agent
 *  already had, which it does not answer twice). An answer not delivered is
 *  not sent later: the outcome is on record, so the run line says so once. */
function answeredBy(a: LockHandledAnswer): boolean | null {
  if (!a.recorded || a.telegram === 'off') return null;
  return a.telegram === 'sent';
}

/** One request's end: what the keeper did, whether the agent recorded it,
 *  and whether its answer reached the chat (`answeredBy`). */
export interface LockResult {
  wallet: Address;
  outcome: LockOutcome;
  answered: boolean | null;
  /** True when the agent recorded the outcome, false when it had it already
   *  (an earlier report whose answer was lost), null when the report did not
   *  land (the requests are read again next run). */
  recorded: boolean | null;
}

/** What a wallet's open requests came to, or null when this run cannot
 *  finish them. The agent answers each outcome in the chat but a silent one
 *  (`dropped-old`). */
async function lockOne(d: TelegramStepDeps, q: LockRequest, sendCutoff: number): Promise<LockOutcome | null> {
  const age = d.nowSec() - q.requestedAt;
  if (age > LOCK_REQUEST_SILENT_SEC) return 'dropped-old';
  if (age > LOCK_REQUEST_TTL_SEC) return 'expired';
  let a: AccountLock;
  try {
    a = await d.r.one<AccountLock>('getProtectedAccount', [q.wallet]);
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    d.sender.noteUnread(`lock:${q.wallet}`, `its account's settings (${shortErr(err)})`);
    return null;
  }
  if (!a.enabled) return 'not-protected';
  // A lock set since the newest request already did everything they asked:
  // a lock drops every loosening change pending when it is set, and one
  // asked for after it is newer than the request, so it is not the
  // keeper's to cancel. (The request's time is the agent's clock and the
  // lock's the chain's; they agree to within seconds.)
  if (a.locked && a.lockedAt >= BigInt(q.requestedAt)) {
    d.markLocked(q.wallet);
    return 'already-locked';
  }
  // Locked before the request, the vault is locked again: the chain drops
  // every pending loosening change on a repeat lock too, and answering
  // "already locked" without the call would leave an unlock asked for since
  // the first lock to mature, perhaps in this very run.
  const wasLocked = a.locked;
  // A lock starts only inside the step's share of the read window (never
  // past the read cutoff), so its report fits in the run and the releases
  // after it keep their time.
  if (Date.now() >= Math.min(sendCutoff, d.r.cutoff)) return null;
  const res = await d.sender.call('lock', q.wallet, 'lockVaultFor', [q.wallet]);
  if (res === 'landed') {
    d.markLocked(q.wallet);
    return wasLocked ? 'locked-again' : 'locked';
  }
  if (res === 'skipped' || res === 'idle') return null;
  if (res === NOT_GRANTED) return 'not-allowed';
  if (res === 'ProtectedModeOff') return 'not-protected';
  return `refused: ${res}`;
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
  /** Events whose owner has no chat linked and no Push subscription. */
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
        // eslint-disable-next-line no-await-in-loop
        const alert = await composeAlert(d, row.kind, row.args, account, manager);
        if (alert === 'wait') {
          finished = false;
        } else if (alert === 'skip') {
          // An event this step cannot put into words alerts nobody.
          report.undelivered += 1;
        } else {
          // A send is not bounded once started, so none starts past the
          // step's cutoff: the rest waits for the next run.
          if (Date.now() >= d.r.cutoff) throw new PastRunDeadline('owner alerts: the step reached its cutoff');
          // Telegram always: only the agent knows whether the owner linked a
          // chat, and it answers `off` when not. Push only to a subscriber,
          // and without the LOCK hint, which only a linked chat can act on.
          const message: AddressedAlert = { chainId: d.chainId, wallet: account, ...(manager !== account ? { to: manager } : {}), alert };
          const push = alert.kind === 'payout' ? { ...message, alert: { ...alert, lockHint: false } } : message;
          const rendered = renderTelegramAlert(push, { locale: sub?.locale ?? null, chainName: String(d.chainId), appOrigin: d.appOrigin });
          let outcome: DeliveryOutcome;
          try {
            // eslint-disable-next-line no-await-in-loop
            outcome = await d.notify({
              telegram: { diamond: d.diamond, message },
              pushSubscriber: sub?.push ? manager : null,
              text: rendered.text,
              pushTitle: rendered.title,
              deepLinkUrl: d.appOrigin,
            });
          } catch (err) {
            if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
            // A send that threw (the network) may go on another try.
            outcome = { telegram: 'retry', push: 'off' };
          }
          wentOut = true;
          if (outcome.telegram === 'off' && outcome.push === 'off') {
            // No chat linked and no Push subscription: nobody to tell.
            report.unsubscribed += 1;
          } else if (delivered(outcome)) {
            // One channel is enough: an owner told once is warned, and a
            // second try would repeat it on the channel that worked.
            report.sent += 1;
          } else if (worthRetrying(outcome)) {
            // Keep its place: the next run sends it again, and the events
            // after it wait behind it rather than overtake it.
            report.retrying += 1;
            finished = false;
            wentOut = false;
          } else {
            report.undelivered += 1;
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

/** The alert as data, `wait` when a read it needs is not available yet, or
 *  `skip` for an event it cannot put into words. It names the vault
 *  (`account`); `manager` is who receives it. */
async function composeAlert(
  d: TelegramStepDeps,
  kind: string,
  args: Record<string, unknown>,
  account: Address,
  manager: Address,
): Promise<TelegramAlert | 'wait' | 'skip'> {
  switch (kind) {
    case 'VaultLocked':
      return { kind: 'locked', by: lower(args.by) };
    case 'ReplacementProposed': {
      const nominee = lower(args.nominee);
      const by = lower(args.by);
      return nominee === null || by === null ? 'skip' : { kind: 'replacement', nominee, by };
    }
    case 'PayoutQueued': {
      const id = uint(args.id);
      const recipient = lower(args.recipient);
      if (id === null || recipient === null) return 'skip';
      let code: bigint;
      try {
        code = BigInt(await d.r.one<number | bigint>('requestCode', [id]));
      } catch (err) {
        if (err instanceof PastRunDeadline) throw err;
        d.sender.noteUnread(`alert:${id}`, `its request code (${shortErr(err)})`);
        return 'wait';
      }
      // The app's own rendering of the code (`formatRequestCode`), so the two
      // match; a value it will not render is not printed as a code.
      const shown = formatRequestCode(code);
      if (shown === null) {
        d.sender.noteUnread(`alert:${id}`, 'its request code (not a 30-bit value)');
        return 'wait';
      }
      const what = await describeAsset(d, Number(args.kind), lower(args.asset), uint(args.tokenId) ?? 0n, uint(args.amount) ?? 0n);
      const releaseAt = Number(uint(args.releaseAt) ?? 0n);
      return { kind: 'payout', what, recipient, releaseAt, code: shown, lockHint: await lockWouldWork(d, account, manager) };
    }
    default:
      return 'skip';
  }
}

/**
 * Whether a LOCK the subscriber sends from Telegram now would lock this vault,
 * so a payout alert may suggest it (Codex #3092 r10–r12). Every condition is
 * here, in one place, and anything not known reads as no: the alert then
 * gives the app-only advice, which is always true.
 *
 * The off-chain conditions are checked first: this run works LOCK requests
 * (the duty is armed and the keeper can sign); the alert goes to the vault's
 * own wallet (a retired account's go to its controller, whose LOCK would lock
 * the controller's vault). Whether that wallet is linked to a Telegram chat
 * only the agent knows; the hint is in the Telegram message alone, which
 * reaches only a linked chat. The on-chain part is the protocol's own answer:
 * `lockVaultFor(account)` simulated from this keeper, so the grant, protected
 * mode and the global keeper pause are read from the contract rather than
 * from a copy of its rules.
 */
async function lockWouldWork(d: TelegramStepDeps, account: Address, manager: Address): Promise<boolean> {
  if (!d.lockOn || !d.canSign() || manager !== account) return false;
  try {
    return (await boundedCall(d.r.cutoff, 'the lock simulation', () => d.sender.wouldTake('lockVaultFor', [account]))) === true;
  } catch (err) {
    if (err instanceof PastRunDeadline) throw err;
    return false;
  }
}

/** The asset and amount, from the token's own decimals and symbol; the raw
 *  amount and the token address when those cannot be read. Reduced to what a
 *  message's free field accepts (`plainField`): a symbol is the deployer's
 *  choice, and may hold anything. */
async function describeAsset(d: TelegramStepDeps, kind: number, asset: Address | null, tokenId: bigint, amount: bigint): Promise<string> {
  return plainField(await assetWords(d, kind, asset, tokenId, amount)) ?? '?';
}

async function assetWords(d: TelegramStepDeps, kind: number, asset: Address | null, tokenId: bigint, amount: bigint): Promise<string> {
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
