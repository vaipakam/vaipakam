// apps/keeper/src/protectedRecoveryClaim.ts
//
// #3756 — the recovery claim's alerts (RecoveryClaimDesign 4.6). A request
// by an account's recovery address is announced to the owner and to every
// signer at the request, at the half-way point of the wait, seven days and
// one day before the claim may run; a cancellation, a drop, a run and a lapse
// are announced too. Part of the protected-account pass, under its owner
// alerts step (`PROTECTED_ALERTS_ENABLED`), which ships unset.
//
// The claim lives in the account's vault, and the vault's events are not in
// the indexer's ledger (#3379 B2 limit, until B4). So the step is driven by
// the vault's own view, `protectionRecoveryClaim()`, read for the protected
// accounts the ledger names (the Diamond's `ProtectionApplied`), a slice of
// them per scan in address order. What the step has announced is kept per
// account in its cursor rows: the claim it saw (its request time, which
// identifies it), the last stage announced and the recipients that still owe
// a delivery. A claim that is gone from the view has ended: the reason is the
// vault's own `RecoveryClaimEnded` event when it can be read in the blocks
// since the claim was last seen open, else what the view shows (recovered,
// past its lapse, or a pause in force), else stated as not read.
//
// A reminder is sent only near its time (`STAGE_GRACE_SEC`): a keeper that
// was down past a reminder does not send a "7 days left" three days before
// the run. Every message carries the claim's own times, which never move.

import type { Abi, Address } from 'viem';
import { VaultRecoveryABI } from '@vaipakam/contracts/abis';
import { renderTelegramAlert, type AddressedAlert, type TelegramAlert } from '@vaipakam/lib/telegramAlerts/message';
import { CLAIM_STAGES, type ClaimEnd } from '@vaipakam/lib/telegramAlerts/recoveryClaimCopy';
import type { DiamondProtection, VaultProtectionPending, VaultProtectionState } from '@vaipakam/lib/protectedAccountView';
import { delivered, worthRetrying, type Alert, type DeliveryOutcome } from './alertDelivery';
import { PastRunDeadline } from './batchRead';
import { shortErr } from './callErrors';
import { EpochFenceRefusal } from './epochFence';
import type { PassReader } from './passReader';
import { accountFrom } from './protectedVault';
import type { ScanCursors } from './scanCursors';

/** How often the accounts are read (the pass runs every minute). */
export const CLAIM_SCAN_INTERVAL_SEC = 600;
/** Accounts read per scan; the rest wait for the next, in address order. */
export const CLAIM_ACCOUNTS_PER_SCAN = 200;
/** The widest block range searched for the event that ended a claim. A
 *  wider gap (the keeper was down) falls back to what the view shows. */
export const CLAIM_LOG_SPAN = 50_000n;
/** A seven-day or one-day reminder is sent only this long after its time. */
export const STAGE_GRACE_SEC = 12 * 3600;
/** An end alert a channel keeps refusing is given up after this long. */
export const END_RETRY_SEC = 24 * 3600;

export const LAST_ITEM = 'claim-last';
export const AFTER_ITEM = 'claim-after';
export const stateItem = (account: string) => `claim:${account.toLowerCase()}`;

const DAY = 86400;
const isZero = (a: string): boolean => /^0x0{40}$/i.test(a);
const lower = (a: string) => a.toLowerCase() as Address;

/** One account's claim as the chain shows it at the head. */
export interface ClaimView {
  vault: Address;
  /** Whom the account's alerts go to: its own wallet, or the wallet that
   *  replaced it. */
  manager: Address;
  signers: Address[];
  /** The open claim (`requestedAt` 0 = none). */
  requestedAt: number;
  runnableAt: number;
  lapsesAt: number;
  recovery: Address;
  pauseUntil: number;
  recovered: boolean;
  recoveredAt: number;
}

/** The vault's `RecoveryClaimEnded` for a claim. */
export interface ClaimEndEvent {
  reason: number;
  by: Address | null;
}

export interface ClaimReads {
  /** The head block number. */
  head(): Promise<bigint>;
  /** Each account's view; null where it could not be read, `none` where the
   *  account has no vault. */
  views(accounts: readonly Address[]): Promise<(ClaimView | 'none' | null)[]>;
  /** The event that ended the claim asked at `requestedAt`, from `from` to
   *  `to`; null when there is none in the range. Throws when unread. */
  endEvent(vault: Address, account: Address, requestedAt: number, from: bigint, to: bigint): Promise<ClaimEndEvent | null>;
}

export interface ClaimSubscriber {
  push: boolean;
  locale: string | null;
}

export interface ClaimAlertDeps {
  reads: ClaimReads;
  cursors: ScanCursors;
  chainId: number;
  diamond: Address;
  /** At most `limit` protected accounts after `after`, in address order. */
  accounts: (after: string, limit: number) => Promise<Address[]>;
  subscriber: (wallet: Address) => Promise<ClaimSubscriber | null>;
  notify: (alert: Alert) => Promise<DeliveryOutcome>;
  appOrigin: string;
  nowSec: number;
  /** The step's cutoff (ms): no send starts at or past it. */
  cutoff: number;
}

export interface ClaimAlertReport {
  waiting: boolean;
  scanned: number;
  open: number;
  sent: number;
  ended: number;
  retrying: number;
  unread: number;
}

/** What the step keeps per account while a claim is open or its end is owed. */
interface ClaimState {
  at: number;
  run: number;
  lapse: number;
  recovery: Address;
  /** The last stage announced (index in CLAIM_STAGES), -1 none. */
  sent: number;
  /** Recipients the last stage is still owed to. */
  todo: Address[];
  /** Everyone told of the claim, who hears of its end. */
  to: Address[];
  /** The head block when the claim was last seen open. */
  block: string;
  end?: { kind: ClaimEnd; by: Address | null; pause: number | null; todo: Address[]; since: number };
}

function parseState(raw: string | undefined): ClaimState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as ClaimState;
    return typeof s.at === 'number' && Array.isArray(s.to) ? s : null;
  } catch {
    return null;
  }
}

/**
 * The stage due now (an index in CLAIM_STAGES), or -1. A stage whose time is
 * not after the one before it (a short wait) is skipped. Once the claim may
 * run no reminder is due; a seven-day or one-day reminder is due only within
 * `STAGE_GRACE_SEC` of its time.
 */
export function dueStage(at: number, run: number, now: number): number {
  const times = [at, at + Math.floor((run - at) / 2), run - 7 * DAY, run - DAY];
  let due = 0;
  let prev = at;
  for (let i = 1; i < times.length; i++) {
    const t = times[i];
    if (t <= prev) continue;
    prev = t;
    if (now < t || now >= run) break;
    if (i >= 2 && now >= t + STAGE_GRACE_SEC) continue;
    due = i;
  }
  return now < at ? -1 : due;
}

/** The end's kind from the vault's own reason (CLAIM_END_*). */
export function endFromReason(reason: number): ClaimEnd {
  return (['cancelled', 'ownerCall', 'switchedOff', 'locked', 'replaced', 'recovered', 'protectionOff', 'recoveryChanged'] as const)[reason] ?? 'unknown';
}

export async function recoveryClaimAlerts(d: ClaimAlertDeps): Promise<ClaimAlertReport> {
  const report: ClaimAlertReport = { waiting: false, scanned: 0, open: 0, sent: 0, ended: 0, retrying: 0, unread: 0 };
  const stored = await d.cursors.get([LAST_ITEM, AFTER_ITEM]);
  const last = Number(stored.get(LAST_ITEM) ?? 0);
  if (d.nowSec - last < CLAIM_SCAN_INTERVAL_SEC) {
    report.waiting = true;
    return report;
  }
  const after = stored.get(AFTER_ITEM) ?? '';
  const accounts = (await d.accounts(after, CLAIM_ACCOUNTS_PER_SCAN)).map(lower);
  const head = await d.reads.head();
  const views = await d.reads.views(accounts);
  const states = await d.cursors.get(accounts.map(stateItem));
  report.scanned = accounts.length;

  let stopped = false;
  for (let i = 0; i < accounts.length && !stopped; i++) {
    const account = accounts[i];
    const v = views[i];
    if (v === null) {
      report.unread += 1;
      continue;
    }
    const before = states.get(stateItem(account)) ?? '';
    let st = parseState(before);
    const open = v === 'none' ? 0 : v.requestedAt;
    if (st === null && open === 0) continue;
    try {
      // The claim this step announced is gone, or replaced by a newer one.
      if (st !== null && st.at !== open) {
        if (!st.end) {
          st.end = { ...(await endOf(d, st, account, v, head)), todo: st.to, since: d.nowSec };
          report.ended += 1;
        }
        const alert: TelegramAlert = { kind: 'recoveryClaimEnded', end: st.end.kind, requestedAt: st.at, by: st.end.by, pauseUntil: st.end.pause };
        st.end.todo = await deliverAll(d, account, alert, st.end.todo, report);
        if (st.end.todo.length === 0 || d.nowSec - st.end.since >= END_RETRY_SEC) st = null;
      }
      if (open !== 0 && v !== 'none' && st?.end === undefined) {
        report.open += 1;
        const recipients = recipientsOf(v);
        if (st === null) {
          st = { at: open, run: v.runnableAt, lapse: v.lapsesAt, recovery: lower(v.recovery), sent: -1, todo: [], to: [], block: head.toString() };
        }
        st.block = head.toString();
        st.to = [...new Set([...st.to, ...recipients])];
        const due = dueStage(st.at, st.run, d.nowSec);
        if (due > st.sent) {
          st.sent = due;
          st.todo = recipients;
        }
        if (st.todo.length > 0 && st.sent >= 0) {
          const alert: TelegramAlert = {
            kind: 'recoveryClaim',
            stage: CLAIM_STAGES[st.sent],
            recovery: st.recovery,
            requestedAt: st.at,
            runnableAt: st.run,
            lapsesAt: st.lapse,
          };
          st.todo = await deliverAll(d, account, alert, st.todo, report);
        }
      }
    } catch (err) {
      if (!(err instanceof PastRunDeadline)) throw err;
      stopped = true;
    }
    const now = st === null ? '' : JSON.stringify(st);
    if (now !== before) await d.cursors.put(stateItem(account), now);
  }
  if (!stopped) {
    await d.cursors.put(AFTER_ITEM, accounts.length < CLAIM_ACCOUNTS_PER_SCAN ? '' : accounts[accounts.length - 1]);
    await d.cursors.put(LAST_ITEM, String(d.nowSec));
  }
  return report;
}

/** The owner (the account's manager) and every signer, once each. */
function recipientsOf(v: ClaimView): Address[] {
  return [...new Set([lower(v.manager), ...v.signers.map(lower)])].filter((a) => !isZero(a));
}

/** How the claim in `st` ended: the vault's own event when it can be read in
 *  the blocks since the claim was last seen open, else what the view shows. */
async function endOf(d: ClaimAlertDeps, st: ClaimState, account: Address, v: ClaimView | 'none', head: bigint): Promise<Omit<NonNullable<ClaimState['end']>, 'todo' | 'since'>> {
  const pause = v !== 'none' && v.pauseUntil > d.nowSec ? v.pauseUntil : null;
  if (v === 'none') return { kind: 'unknown', by: null, pause: null };
  if (v.recovered && v.recoveredAt >= st.at) return { kind: 'recovered', by: null, pause };
  const from = BigInt(st.block);
  if (head >= from && head - from <= CLAIM_LOG_SPAN) {
    try {
      const ev = await d.reads.endEvent(v.vault, account, st.at, from, head);
      if (ev !== null) return { kind: endFromReason(ev.reason), by: ev.reason === 0 ? ev.by : null, pause };
    } catch (err) {
      if (err instanceof PastRunDeadline) throw err;
      console.warn(`[keeper] recovery claim alerts: the end of ${account}'s claim could not be read (${shortErr(err)})`);
    }
  }
  if (d.nowSec > st.lapse) return { kind: 'lapsed', by: null, pause };
  if (pause !== null) return { kind: 'cancelledOrDropped', by: null, pause };
  return { kind: 'unknown', by: null, pause };
}

/** Send `alert` about `account` to each of `todo`; returns those still owed
 *  (a channel that may take it on another try). */
async function deliverAll(d: ClaimAlertDeps, account: Address, alert: TelegramAlert, todo: readonly Address[], report: ClaimAlertReport): Promise<Address[]> {
  const left: Address[] = [];
  for (const to of todo) {
    if (Date.now() >= d.cutoff) {
      left.push(to);
      report.retrying += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const sub = await d.subscriber(to);
    const message: AddressedAlert = { chainId: d.chainId, wallet: account, ...(to !== account ? { to } : {}), alert };
    const rendered = renderTelegramAlert(message, { locale: sub?.locale ?? null, chainName: String(d.chainId), appOrigin: d.appOrigin });
    let outcome: DeliveryOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await d.notify({
        telegram: { diamond: d.diamond, message },
        pushSubscriber: sub?.push ? to : null,
        text: rendered.text,
        pushTitle: rendered.title,
        deepLinkUrl: d.appOrigin,
      });
    } catch (err) {
      if (err instanceof PastRunDeadline || err instanceof EpochFenceRefusal) throw err;
      outcome = { telegram: 'retry', push: 'off' };
    }
    if (delivered(outcome)) report.sent += 1;
    else if (worthRetrying(outcome)) {
      report.retrying += 1;
      left.push(to);
    }
  }
  return left;
}

export function describeClaimReport(r: ClaimAlertReport): string {
  if (r.waiting) return 'recovery-claims=waiting';
  return `recovery-claims=scanned ${r.scanned}, open ${r.open}, ended ${r.ended}, sent ${r.sent}, retrying ${r.retrying}, unread ${r.unread}`;
}

// ─── Chain reads ────────────────────────────────────────────────────────────

const END_EVENT = (VaultRecoveryABI as Abi).find((x) => x.type === 'event' && x.name === 'RecoveryClaimEnded');

type RecoveryClaimTuple = readonly [boolean, number, number, bigint, Address, bigint, bigint, bigint, bigint];
type RecoveryTuple = readonly [Address, Address, bigint, boolean, bigint];

/** The reads through the pass's reader (`r`'s ABI carries the vault views). */
export function chainClaimReads(r: PassReader): ClaimReads {
  return {
    head: () => r.call('the head block', (c) => c.getBlockNumber()),
    async views(accounts) {
      const prot = await r.many(
        accounts.map((a) => ({ functionName: 'getProtection', args: [a] })),
        'recovery-claim protections',
      );
      const withVault = accounts.flatMap((a, i) => {
        const p = prot[i] as DiamondProtection | undefined;
        return p === undefined || isZero(p[0]) ? [] : [{ i, a, p }];
      });
      const groups = await r.groups(
        withVault.map(({ p }) => [
          { functionName: 'protectionState', args: [], address: p[0] },
          { functionName: 'vaultOwner', args: [], address: p[0] },
          { functionName: 'protectionPending', args: [], address: p[0] },
          { functionName: 'protectionRecoveryClaim', args: [], address: p[0] },
          { functionName: 'protectionRecovery', args: [], address: p[0] },
        ]),
        'recovery-claim views',
      );
      const out: (ClaimView | 'none' | null)[] = accounts.map((_, i) => {
        const p = prot[i] as DiamondProtection | undefined;
        if (p === undefined) return null;
        return isZero(p[0]) ? 'none' : null;
      });
      withVault.forEach(({ i, a, p }, k) => {
        const [state, owner, pending, claim, rec] = groups[k] as [VaultProtectionState?, Address?, VaultProtectionPending?, RecoveryClaimTuple?, RecoveryTuple?];
        if (!state || !owner || !pending || !claim || !rec) return;
        const record = accountFrom(a, p, state, owner, pending);
        out[i] = {
          vault: p[0],
          manager: record.retired ? record.controller : a,
          signers: [...state[5]],
          requestedAt: Number(claim[5]),
          runnableAt: Number(claim[6]),
          lapsesAt: Number(claim[7]),
          recovery: claim[4],
          pauseUntil: Number(claim[8]),
          recovered: rec[3],
          recoveredAt: Number(rec[4]),
        };
      });
      return out;
    },
    async endEvent(vault, account, requestedAt, from, to) {
      if (!END_EVENT) throw new Error('RecoveryClaimEnded is not in the vault ABI');
      const logs = await r.call('the claim end event', (c) =>
        c.getLogs({ address: vault, event: END_EVENT as never, args: { account } as never, fromBlock: from, toBlock: to }),
      );
      for (const log of logs as unknown as { args: { requestedAt?: bigint; by?: Address; reason?: number } }[]) {
        if (Number(log.args.requestedAt ?? 0n) !== requestedAt) continue;
        const by = log.args.by && !isZero(log.args.by) ? lower(log.args.by) : null;
        return { reason: Number(log.args.reason ?? 255), by };
      }
      return null;
    },
  };
}
