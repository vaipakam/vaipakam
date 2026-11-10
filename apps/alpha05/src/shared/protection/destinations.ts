/**
 * ACC-41 / #3415 — the protected account's payout destinations: the
 * addresses besides the wallet itself that a protected payout may go to.
 * Each change is its own call on `ProtectedAccountFacet`:
 *
 * - `add`: `addAllowlisted(account, destination)`, by the manager. Refused
 *   during a pause, a new primary's cool-down and while the account is
 *   locked. It only ASKS: the destination becomes usable after the
 *   account's delay, through `apply`, unless someone cancels it first.
 *   Asking again for an address already waiting restarts its wait.
 * - `cancel`: `cancelAddAllowlisted(account, destination)`, by the manager
 *   or a secondary signer. Open during a pause.
 * - `apply`: `finalizeAddAllowlisted(account, destination)`, by anyone,
 *   once the wait is over and within one further delay (after that the
 *   request has expired and must be asked again). Refused during a pause
 *   and while the account is locked.
 * - `remove`: `removeAllowlisted(account, destination)`, by the manager or
 *   a secondary signer, at once and open during a pause. Every payout
 *   queued to that destination is cancelled; its assets stay in the vault.
 *
 * The page offers `add` only for an address from the reader's saved book
 * (`shared/address/book.ts`), so a payout destination is always one the
 * reader proved they control or saved, labelled, as an exchange's.
 */
import { parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { AdminFacetABI } from '@vaipakam/contracts/abis';
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess } from '../copy/useCopy';
import { refusalFromError } from '../eligibility/refusal';
import type { Refusal } from '../eligibility/types';
import { answerOrNull, isContractAnswer } from '../reads/answer';
import { frozenState, readSanctionsPosture, type FrozenState } from '../sanctions/posture';
import type { LegOutcome } from '../tx/outcome';
import { askThrough } from '../tx/simulate';
import { formatSpan, formatUtc } from '../ui/format';
import { PAYOUT, ROW_QUEUED, readQueueRow } from './queue';
import { PROTECTED } from './safety';

type Hex = `0x${string}`;
type Copy = Pick<CopyAccess, 'text' | 'format'>;
const ADMIN = AdminFacetABI as Abi;

export type DestinationAction = 'add' | 'cancel' | 'apply' | 'remove';

export const DESTINATION_FUNCTION = {
  add: 'addAllowlisted',
  cancel: 'cancelAddAllowlisted',
  apply: 'finalizeAddAllowlisted',
  remove: 'removeAllowlisted',
} as const satisfies Record<DestinationAction, string>;

/** `LibProtectedAccount.MAX_ALLOWLIST`: at most this many destinations,
 *  and at most this many waiting. */
export const MAX_DESTINATIONS = 5;

/** The parts of the account's mode the destination rules read. */
export interface DestinationMode {
  enabled: boolean;
  locked: boolean;
  retired: boolean;
  delaySeconds: number;
  cooldownUntil: number;
  controller: Hex;
}

export interface PendingDestination {
  destination: Hex;
  /** When the wait ends (unix seconds). */
  maturesAt: number;
}

/** Everything the Protection page and a review read, at one block. */
export interface DestinationFacts {
  account: Hex;
  /** The mode; 'absent' when this Diamond has no protected-account feature;
   *  null when unread. */
  mode: DestinationMode | 'absent' | null;
  destinations: readonly Hex[] | null;
  pending: readonly PendingDestination[] | null;
  signers: readonly Hex[] | null;
  paused: boolean | null;
  /** Payouts waiting in the queue, by destination (lower-case), queued
   *  rows only; null when the queue was unread. */
  queuedTo: Readonly<Record<string, number>> | null;
  chainNow: number | null;
  readAt: number;
}

type RawMode = { enabled: boolean; locked: boolean; retired: boolean; delaySeconds: number | bigint; cooldownUntil: number | bigint; controller: Hex };

export async function readDestinationFacts(c: PublicClient, diamond: Hex, account: Hex): Promise<DestinationFacts> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const at = { blockNumber: block.number };
  const read = <T>(abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    answerOrNull(c.readContract({ address: diamond, abi, functionName, args, ...at }) as Promise<T>);
  const [mode, destinations, pending, signers, paused, ids] = await Promise.all([
    readModeOrAbsent(c, diamond, account, block.number),
    read<readonly Hex[]>(PROTECTED, 'getAllowlist', [account]),
    read<readonly [readonly Hex[], readonly bigint[]]>(PROTECTED, 'getPendingAllowlistAdditions', [account]),
    read<readonly Hex[]>(PROTECTED, 'getProtectedSigners', [account]),
    read<boolean>(ADMIN, 'paused'),
    read<readonly bigint[]>(PAYOUT, 'getPendingPayoutIds', [account]),
  ]);
  let queuedTo: Record<string, number> | null = null;
  if (ids !== null) {
    const rows = await Promise.all(ids.map((id) => readQueueRow(c, diamond, id)));
    if (rows.every((r) => r.payout !== null)) {
      queuedTo = {};
      for (const r of rows) {
        if (r.payout!.state !== ROW_QUEUED) continue;
        const k = r.payout!.recipient.toLowerCase();
        queuedTo[k] = (queuedTo[k] ?? 0) + 1;
      }
    }
  }
  return {
    account,
    mode,
    destinations,
    pending: pending === null ? null : pending[0].map((d, i) => ({ destination: d, maturesAt: Number(pending[1][i] ?? 0n) })),
    signers,
    paused,
    queuedTo,
    chainNow: Number(block.timestamp),
    readAt: Date.now(),
  };
}

async function readModeOrAbsent(c: PublicClient, diamond: Hex, account: Hex, blockNumber: bigint): Promise<DestinationMode | 'absent' | null> {
  try {
    const m = (await c.readContract({ address: diamond, abi: PROTECTED, functionName: 'getProtectedAccount', args: [account], blockNumber })) as RawMode;
    return {
      enabled: m.enabled,
      locked: m.locked,
      retired: m.retired,
      delaySeconds: Number(m.delaySeconds),
      cooldownUntil: Number(m.cooldownUntil),
      controller: m.controller,
    };
  } catch (e) {
    // A failed source is thrown, so the own rail tries the next one.
    if (!isContractAnswer(e)) throw e;
    return refusalFromError(e).code === 'FunctionDoesNotExist' ? 'absent' : null;
  }
}

/** The chain's clock now: the block time at the read plus what has passed. */
export function destinationClock(f: Pick<DestinationFacts, 'chainNow' | 'readAt'>, nowMs: number): number | null {
  return f.chainNow === null ? null : f.chainNow + Math.max(0, Math.floor((nowMs - f.readAt) / 1000));
}

const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** Where a waiting addition stands at `now`. */
export type PendingState = 'waiting' | 'ready' | 'expired';

export function pendingState(p: PendingDestination, delaySeconds: number, now: number): PendingState {
  if (now < p.maturesAt) return 'waiting';
  return now > p.maturesAt + delaySeconds ? 'expired' : 'ready';
}

export interface DestinationReview {
  identity: string;
  action: DestinationAction;
  destination: Hex;
  facts: DestinationFacts;
  /** The destination's own screen (`add` only): a flagged address is refused. */
  screen: FrozenState;
  dryRun: Refusal | null | 'unread';
  readAt: number;
}

export function destinationCall(action: DestinationAction, account: Hex, destination: Hex) {
  return { abi: PROTECTED, functionName: DESTINATION_FUNCTION[action], args: [account, destination] as const };
}

export async function readDestinationReview(
  own: OwnStateClient,
  diamond: Hex,
  action: DestinationAction,
  destination: Hex,
  identity: string,
  copy: Copy,
): Promise<DestinationReview> {
  const account = own.account;
  const [facts, screen] = await own
    .read(async (c: PublicClient) => {
      const f = await readDestinationFacts(c, diamond, account);
      const s = action === 'add' ? frozenState(await readSanctionsPosture(c, diamond, destination)) : null;
      return [f, s] as const;
    })
    .then((x) => x.value);
  const base: DestinationReview = { identity, action, destination, facts, screen, dryRun: null, readAt: Date.now() };
  if (destinationBlockers(base, copy).length > 0) return base;
  const call = destinationCall(action, account, destination);
  const dry = await askThrough(own, (c) => c.simulateContract({ address: diamond, ...call, account }));
  return { ...base, dryRun: dry.kind === 'answered' ? null : dry.kind === 'reverted' ? refusalFromError(dry.error) : 'unread', readAt: Date.now() };
}

/** What stops the action, in words (empty when nothing does), most
 *  fundamental first. The viewer is the account itself: this page manages
 *  the connected wallet's own account. */
export function destinationBlockers(r: DestinationReview, copy: Copy): string[] {
  const { text, format } = copy;
  const f = r.facts;
  const m = f.mode;
  if (m === 'absent') return [text('safety.unavailable')];
  if (m !== null) {
    if (m.retired) return [text('safety.retired')];
    if (!m.enabled) return [text('dest.modeOff')];
  }
  const now = destinationClock(f, Date.now());
  const pend = f.pending?.find((p) => same(p.destination, r.destination)) ?? null;
  const listed = f.destinations === null ? null : f.destinations.some((d) => same(d, r.destination));
  const pauseCloses = r.action === 'add' || r.action === 'apply';
  if (pauseCloses && f.paused === true) return [text('dest.paused')];
  if (r.action === 'add') {
    if (same(r.destination, f.account)) return [text('dest.isSelf')];
    if (listed === true) return [text('dest.alreadyListed')];
    if (m !== null && m.locked) return [text('dest.locked')];
    if (m !== null && now !== null && now < m.cooldownUntil) return [format('safety.cooldown', { at: formatUtc(m.cooldownUntil) })];
    if (pend !== null && m !== null && now !== null && pendingState(pend, m.delaySeconds, now) !== 'expired')
      return [format('dest.alreadyWaiting', { at: formatUtc(pend.maturesAt) })];
    if (f.destinations !== null && f.destinations.length >= MAX_DESTINATIONS) return [format('dest.full', { max: String(MAX_DESTINATIONS) })];
    if (pend === null && f.pending !== null && f.pending.length >= MAX_DESTINATIONS) return [format('dest.pendingFull', { max: String(MAX_DESTINATIONS) })];
    if (r.screen === 'flagged') return [text('dest.flagged')];
  } else if (r.action === 'cancel') {
    if (f.pending !== null && pend === null) return [text('dest.notWaiting')];
  } else if (r.action === 'apply') {
    if (f.pending !== null && pend === null) return [text('dest.notWaiting')];
    if (m !== null && m.locked) return [text('dest.locked')];
    if (pend !== null && m !== null && now !== null) {
      const s = pendingState(pend, m.delaySeconds, now);
      if (s === 'waiting') return [format('dest.notYet', { at: formatUtc(pend.maturesAt) })];
      if (s === 'expired') return [format('dest.expired', { at: formatUtc(pend.maturesAt + m.delaySeconds) })];
    }
    if (f.destinations !== null && f.destinations.length >= MAX_DESTINATIONS) return [format('dest.full', { max: String(MAX_DESTINATIONS) })];
  } else if (listed === false) return [text('dest.notListed')];
  if (r.dryRun !== null && r.dryRun !== 'unread') return [format('safety.dryRunRefused', { reason: r.dryRun.reason })];
  return [];
}

/** What a re-read found changed, in words, or null when nothing the review
 *  states moved. */
export function destinationChanged(a: DestinationReview, b: DestinationReview, copy: Pick<CopyAccess, 'text'>): string | null {
  const { text } = copy;
  const key = (r: DestinationReview) =>
    JSON.stringify([r.facts.mode, r.facts.destinations, r.facts.pending, r.facts.queuedTo?.[r.destination.toLowerCase()] ?? null, r.screen]);
  if (key(a) !== key(b)) return text('dest.changed');
  if (a.facts.paused !== b.facts.paused) return text('repay.changedVerdict');
  if ((a.dryRun === null) !== (b.dryRun === null) || (a.dryRun === 'unread') !== (b.dryRun === 'unread')) return text('repay.changedVerdict');
  return null;
}

type Args = Record<string, unknown>;

/** The action's outcome, from the Diamond's own logs for this account. */
export function measureDestination(r: DestinationReview, logs: readonly Log[], diamond: Hex, copy: Copy): LegOutcome[] {
  const { text, format } = copy;
  const account = r.facts.account.toLowerCase();
  const own = logs.filter((l) => l.address.toLowerCase() === diamond.toLowerCase());
  const events = (parseEventLogs({ abi: [...PROTECTED, ...PAYOUT] as Abi, logs: [...own], strict: false }) as unknown as { eventName: string; args: Args }[]).filter(
    (e) => String(e.args.account ?? '').toLowerCase() === account,
  );
  const forDest = (name: string) => events.filter((e) => e.eventName === name && String(e.args.destination ?? '').toLowerCase() === r.destination.toLowerCase());
  const address = r.destination;
  if (r.action === 'add') {
    const asked = forDest('AllowlistAddRequested')[0];
    if (!asked) return [{ status: 'not-done', label: text('dest.titleAdd'), reason: text('dest.notRecorded') }];
    return [{ status: 'done', label: format('dest.legAsked', { address, at: formatUtc(BigInt(asked.args.effectiveAt as bigint)) }) }];
  }
  if (r.action === 'cancel') {
    if (forDest('AllowlistAddCancelled').length === 0) return [{ status: 'not-done', label: text('dest.titleCancel'), reason: text('dest.notRecorded') }];
    return [{ status: 'done', label: format('dest.legCancelled', { address }) }];
  }
  if (r.action === 'apply') {
    if (forDest('AllowlistAdded').length === 0) return [{ status: 'not-done', label: text('dest.titleApply'), reason: text('dest.notRecorded') }];
    return [{ status: 'done', label: format('dest.legAdded', { address }) }];
  }
  if (forDest('AllowlistRemoved').length === 0) return [{ status: 'not-done', label: text('dest.titleRemove'), reason: text('dest.notRecorded') }];
  const legs: LegOutcome[] = [{ status: 'done', label: format('dest.legRemoved', { address }) }];
  const cancelled = events.filter((e) => e.eventName === 'PayoutCancelled').length;
  if (cancelled > 0) legs.push({ status: 'done', label: format('safety.legCancelled', { count: String(cancelled) }) });
  return legs;
}

/** The delay in words, for copy that names it. */
export function delayWords(m: DestinationMode | 'absent' | null): string | null {
  return m === null || m === 'absent' ? null : formatSpan(m.delaySeconds);
}
